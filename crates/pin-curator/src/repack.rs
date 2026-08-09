//! Consolidate half-empty slabs, so storage stops costing more than it holds.
//!
//! Sia allocates in slabs of 10 data shards x 4 MiB, and an object gets a whole one
//! whether it fills it or not — a 281-byte note costs the same 40 MiB as a 40 MiB
//! video. Publish a few small things and the account is mostly air. Repack downloads
//! the contents of several under-full slabs, uploads them packed into one, rewrites
//! every reference to point at the new bytes, and deletes the old.
//!
//! Three rules keep it from thrashing. It leaves slabs that are already mostly full
//! alone, because the reclaim wouldn't pay for the work. It leaves slabs whose newest
//! object is minutes old alone, because that's someone mid-publish. And it won't run
//! at all unless it can collapse at least three slabs into one, since the reclaim is
//! (count - 1) slabs and collapsing two is barely worth a round trip.
//!
//! The rewrite is the part that has to be right. Every reference to a moved object
//! has to move with it — a manifest's item body, that item's attachments, a channel's
//! avatar and cover, a pin record — because the old object is deleted at the end of
//! the pass, with no grace window. A reference left behind points at nothing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_manifest::ChannelManifest;

use crate::{list_rkeys, read_record, read_settings, write_record};

/// Where an owned channel's manifest is recorded — the same collection the commit
/// path writes, and the reason a Curator-side rewrite can reach the screen at all.
const OWN_COLLECTION: &str = "channel";

/// 10 data shards x 4 MiB. The same figure the publish path uses for shard math.
const SLAB_DATA_BYTES: f64 = 10.0 * 4.0 * 1024.0 * 1024.0;
/// Pack to ~95% of a slab, so a rounding edge can't spill into a second one.
const SLAB_PACK_TARGET_BYTES: f64 = SLAB_DATA_BYTES * 0.95;
/// Below this many slabs, the reclaim doesn't pay for the work.
const MIN_BATCH_SLABS: usize = 3;
/// Leave slabs this full alone — marginal gain, full cost.
const FULL_THRESHOLD: f64 = 0.8;
/// And leave slabs this new alone: a burst of publishing is still in progress.
const MIN_SLAB_AGE_SECS: i64 = 2 * 60;

/// Where a reference to an object lives, so the rewrite knows what to update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// An item body, attachment, or image in a channel this identity publishes.
    Channel {
        channel_id: String,
        channel_key: String,
    },
    /// Something kept — a library item or a pin from someone else's channel. Both
    /// are pin records; they differ only in where they came from, which the rewrite
    /// doesn't care about.
    Pinned { rkey: String },
}

/// One object in scope, and what points at it.
#[derive(Debug, Clone)]
pub struct ScopeRef {
    pub object_id: String,
    pub item_url: String,
    pub source: Source,
}

/// The slabs one object occupies, as the Sia session reports them.
#[derive(Debug, Clone)]
pub struct ObjectSlabs {
    pub object_id: String,
    /// Seconds since the epoch. Taken as a number rather than a timestamp type so
    /// this stays testable without a clock — and wasm has no system clock anyway.
    pub created_at_secs: i64,
    pub slabs: Vec<SlabPiece>,
}

/// One slab's contribution to one object.
#[derive(Debug, Clone)]
pub struct SlabPiece {
    /// The slab's identity, as far as grouping is concerned.
    pub encryption_key: String,
    pub length: u64,
    pub min_shards: u64,
}

/// A slab, with everything of ours that sits in it.
#[derive(Debug, Clone)]
pub struct SlabAggregate {
    pub encryption_key: String,
    pub bytes_used: u64,
    pub capacity: u64,
    pub objects: Vec<SlabObject>,
}

#[derive(Debug, Clone)]
pub struct SlabObject {
    pub id: String,
    pub created_at_secs: i64,
}

/// Group the objects in scope by the slabs they occupy.
///
/// An object can span several slabs, and a slab can hold several objects — this is
/// the join that turns "what do I hold" into "what does each slab cost me".
pub fn aggregate_slabs(objects: &[ObjectSlabs]) -> Vec<SlabAggregate> {
    let mut groups: Vec<SlabAggregate> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();

    for obj in objects {
        for piece in &obj.slabs {
            let at = match index.get(piece.encryption_key.as_str()) {
                Some(i) => *i,
                None => {
                    groups.push(SlabAggregate {
                        encryption_key: piece.encryption_key.clone(),
                        bytes_used: 0,
                        capacity: piece.min_shards * 4 * 1024 * 1024,
                        objects: Vec::new(),
                    });
                    index.insert(&piece.encryption_key, groups.len() - 1);
                    groups.len() - 1
                }
            };
            groups[at].bytes_used += piece.length;
            groups[at].objects.push(SlabObject {
                id: obj.object_id.clone(),
                created_at_secs: obj.created_at_secs,
            });
        }
    }

    groups
}

/// Choose the slabs to collapse into one, or nothing when it isn't worth doing.
///
/// Greedy smallest-first: the emptiest slabs are the ones costing the most per byte
/// held, and taking them in that order fits the most of them into one slab's worth.
pub fn pick_batch(slabs: &[SlabAggregate], now_secs: i64) -> Vec<SlabAggregate> {
    let mut eligible: Vec<&SlabAggregate> = slabs
        .iter()
        .filter(|s| {
            if s.objects.is_empty() || s.capacity == 0 {
                return false;
            }
            if s.bytes_used as f64 / s.capacity as f64 > FULL_THRESHOLD {
                return false;
            }
            let newest = s
                .objects
                .iter()
                .map(|o| o.created_at_secs)
                .max()
                .unwrap_or(0);
            now_secs - newest >= MIN_SLAB_AGE_SECS
        })
        .collect();

    if eligible.len() < MIN_BATCH_SLABS {
        return Vec::new();
    }
    eligible.sort_by_key(|s| s.bytes_used);

    let mut batch = Vec::new();
    let mut total: u64 = 0;
    for s in eligible {
        if (total + s.bytes_used) as f64 > SLAB_PACK_TARGET_BYTES {
            break;
        }
        total += s.bytes_used;
        batch.push(s.clone());
    }

    if batch.len() >= MIN_BATCH_SLABS {
        batch
    } else {
        Vec::new()
    }
}

/// One object's move, from the bytes it was to the bytes it is.
#[derive(Debug, Clone)]
pub struct Move {
    pub old_object_id: String,
    pub old_item_url: String,
    pub new_object_id: String,
    pub new_item_url: String,
    pub new_content_hash: String,
    pub source: Source,
}

/// Rewrite every reference in one manifest that points at a moved object.
///
/// Item bodies, their attachments, and the channel's avatar and cover — an object can
/// be any of them, and one missed reference is a dangling pointer once the old object
/// is deleted. Returns true when anything changed, so a caller can skip committing a
/// manifest that didn't.
///
/// The manifest's own `published_at` is deliberately NOT touched here; the caller
/// stamps it, because it needs a clock and this doesn't.
pub fn rewrite_manifest(manifest: &mut ChannelManifest, moves: &[Move]) -> bool {
    let by_url: HashMap<&str, &Move> = moves.iter().map(|m| (m.old_item_url.as_str(), m)).collect();
    let mut changed = false;

    for item in &mut manifest.items {
        if let Some(m) = by_url.get(item.item_url.as_str()) {
            item.item_url = m.new_item_url.clone();
            item.content_hash = Some(m.new_content_hash.clone());
            item.id = m.new_object_id.clone();
            changed = true;
        }
        if let Some(attachments) = item.attachments.as_mut() {
            for att in attachments.iter_mut() {
                if let Some(m) = by_url.get(att.url.as_str()) {
                    att.url = m.new_item_url.clone();
                    att.content_hash = Some(m.new_content_hash.clone());
                    att.object_id = Some(m.new_object_id.clone());
                    changed = true;
                }
            }
        }
    }

    for image in [manifest.avatar.as_mut(), manifest.cover.as_mut()]
        .into_iter()
        .flatten()
    {
        if let Some(m) = by_url.get(image.item_url.as_str()) {
            image.item_url = m.new_item_url.clone();
            image.content_hash = Some(m.new_content_hash.clone());
            changed = true;
        }
    }

    changed
}

/// Everything a pass needs, gathered by whichever engine is running it.
pub struct RepackContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// A connected Sia session — every leg of a pass is a Sia call.
    pub sia: Arc<pin_sia::Session>,
    pub app_key: [u8; 32],
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RepackOutcome {
    /// Slabs collapsed into one. The reclaim is this minus one.
    pub reclaimed_slabs: usize,
    /// Objects moved to the new slab.
    pub moved: usize,
    /// Channel manifests rewritten and republished.
    pub channels: usize,
    /// Pin records rewritten.
    pub pins: usize,
}

/// One pass: gather the scope, pick a batch, move it, rewrite everything that pointed
/// at it, and drop the old bytes.
///
/// `Ok(None)` means there was nothing worth doing, which is the ordinary case and not
/// a failure — most passes over a tidy account find no batch. Everything after the
/// upload is a rewrite of a reference, and every one of them has to land, because the
/// old objects are deleted at the end.
pub async fn repack_once(
    ctx: &RepackContext,
    now_secs: i64,
    now_iso: &str,
) -> Result<Option<RepackOutcome>, String> {
    let scope = build_scope(ctx).await?;
    if scope.is_empty() {
        return Ok(None);
    }

    let mut objects = Vec::new();
    for r in &scope {
        // One object we can't inspect shouldn't cost the pass — we just won't
        // consider whatever slab it sits in.
        if let Ok(Some(info)) = ctx.sia.get_object_slabs(&r.object_id).await {
            objects.push(ObjectSlabs {
                object_id: info.id,
                created_at_secs: parse_iso_secs(&info.created_at),
                slabs: info
                    .slabs
                    .iter()
                    .map(|s| SlabPiece {
                        encryption_key: pin_sia::slab_key_string(s),
                        length: s.length as u64,
                        min_shards: s.min_shards as u64,
                    })
                    .collect(),
            });
        }
    }

    let batch = pick_batch(&aggregate_slabs(&objects), now_secs);
    if batch.is_empty() {
        return Ok(None);
    }

    // The refs whose objects sit in the chosen slabs.
    let chosen: std::collections::HashSet<&str> = batch
        .iter()
        .flat_map(|s| s.objects.iter().map(|o| o.id.as_str()))
        .collect();
    let refs: Vec<&ScopeRef> = scope
        .iter()
        .filter(|r| chosen.contains(r.object_id.as_str()))
        .collect();
    if refs.is_empty() {
        return Ok(None);
    }

    let mut bytes = Vec::with_capacity(refs.len());
    for r in &refs {
        bytes.push(ctx.sia.download_item(&r.item_url).await?);
    }
    let uploaded = ctx.sia.upload_items_packed(bytes, None).await?;
    if uploaded.len() != refs.len() {
        return Err("packed upload returned a different number of objects".into());
    }

    let moves: Vec<Move> = refs
        .iter()
        .zip(uploaded)
        .map(|(r, up)| Move {
            old_object_id: r.object_id.clone(),
            old_item_url: r.item_url.clone(),
            new_object_id: up.id,
            new_item_url: up.item_url,
            new_content_hash: up.content_hash,
            source: r.source.clone(),
        })
        .collect();

    let channels = rewrite_channels(ctx, &moves, now_iso).await?;
    let pins = rewrite_pins(ctx, &moves).await?;

    // Only now that every reference points at the new bytes. Best-effort per object:
    // a failed delete leaves a reclaimable orphan, where failing the pass here would
    // leave the rewrites half-applied.
    for m in &moves {
        let _ = ctx.sia.delete_object(&m.old_object_id).await;
    }
    // Without this the emptied slabs stay allocated and the pass is a net LOSS — one
    // new slab and none released.
    ctx.sia.prune_slabs().await?;

    Ok(Some(RepackOutcome {
        reclaimed_slabs: batch.len(),
        moved: moves.len(),
        channels,
        pins,
    }))
}

/// A pin record, as the frontend writes it.
///
/// Only the fields a rewrite touches are named; the rest ride through as `extra` so a
/// pin comes back out exactly as it went in. Dropping a field the frontend cares about
/// would quietly strip it from every pin the Curator ever repacked.
#[derive(serde::Serialize, serde::Deserialize)]
struct PinnedRecord {
    item: pin_manifest::ItemRef,
    #[serde(rename = "objectID")]
    object_id: String,
    #[serde(
        default,
        rename = "attachmentObjectIDs",
        skip_serializing_if = "Option::is_none"
    )]
    attachment_object_ids: Option<Vec<String>>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

/// An owned channel's manifest, out of the doc record the commit path writes.
async fn read_own_manifest(
    ctx: &RepackContext,
    channel_id: &str,
    k: &[u8; 32],
) -> Option<ChannelManifest> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        OWN_COLLECTION,
        channel_id,
    )
    .await
    .ok()
    .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let json = pin_channel::open_blob(k, &blob).ok()?;
    serde_json::from_str(&json).ok()
}

/// Put the rewritten manifest back, so the screen sees what the Curator did. This is
/// the whole reason the record exists — without it a tab keeps rendering item URLs
/// whose objects this pass is about to delete.
async fn write_own_manifest(
    ctx: &RepackContext,
    channel_id: &str,
    k: &[u8; 32],
    json: &str,
) -> Result<(), String> {
    let sealed = pin_crypto::encrypt(k, json.as_bytes())?;
    write_record(
        &ctx.doc,
        ctx.author_id,
        OWN_COLLECTION,
        channel_id,
        sealed.into_bytes(),
    )
    .await
}

async fn read_pin(ctx: &RepackContext, rkey: &str) -> Option<PinnedRecord> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        pin_derive::PINNED_COLLECTION,
        rkey,
    )
    .await
    .ok()
    .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let json = pin_crypto::decrypt(&pin_derive::pinned_key(&ctx.app_key), &blob).ok()?;
    serde_json::from_slice(&json).ok()
}

/// Every pin this identity holds, with the rkey each came from — the rewrite needs the
/// key to write the record back. A pin that won't open is skipped: it can't be
/// repacked, but it mustn't cost the rest of the pass.
async fn read_pins(ctx: &RepackContext) -> Result<Vec<(String, PinnedRecord)>, String> {
    let mut out = Vec::new();
    for rkey in list_rkeys(&ctx.doc, ctx.author_id, pin_derive::PINNED_COLLECTION).await? {
        if let Some(pin) = read_pin(ctx, &rkey).await {
            out.push((rkey, pin));
        }
    }
    Ok(out)
}

/// Everything of this identity's that occupies a Sia object, and what points at it.
///
/// Two sources, both read from the doc. The channels it publishes — item bodies, their
/// attachments, and the channel's avatar and cover — and the pins it keeps. Anything
/// missing an object id is skipped rather than guessed at: repack deletes what it
/// moves, so moving something we can't name a reference for would be destroying it.
async fn build_scope(ctx: &RepackContext) -> Result<Vec<ScopeRef>, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let mut scope: Vec<ScopeRef> = Vec::new();
    // An attachment can also be held as a library pin — the same object, two
    // references. Feeding it to the packed upload twice would duplicate the bytes.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |object_id: String, item_url: String, source: Source| {
        if object_id.is_empty() || item_url.is_empty() || !seen.insert(object_id.clone()) {
            return;
        }
        scope.push(ScopeRef {
            object_id,
            item_url,
            source,
        });
    };

    for owned in &settings.my_channels {
        let Some(k) = pin_crypto::channel_key_from_base64(&owned.channel_key) else {
            continue;
        };
        let Some(manifest) = read_own_manifest(ctx, &owned.channel_id, &k).await else {
            continue;
        };
        let source = Source::Channel {
            channel_id: owned.channel_id.clone(),
            channel_key: owned.channel_key.clone(),
        };
        for item in &manifest.items {
            push(item.id.clone(), item.item_url.clone(), source.clone());
            for att in item.attachments.iter().flatten() {
                // Attachments predating the objectID field can't be named, and the
                // manifest rewrite matches on URL anyway — but without an id there's
                // nothing to inspect or delete, so leave them where they are.
                if let Some(id) = &att.object_id {
                    push(id.clone(), att.url.clone(), source.clone());
                }
            }
        }
        // Channel images are addressed by URL only, so their object id has to be
        // resolved. A failure just means this pass leaves that image alone.
        for image in [manifest.avatar.as_ref(), manifest.cover.as_ref()]
            .into_iter()
            .flatten()
        {
            if let Ok(id) = ctx.sia.resolve_object_id(&image.item_url).await {
                push(id, image.item_url.clone(), source.clone());
            }
        }
    }

    // A pin's own attachments are deliberately absent: the record names them by object
    // id but not by URL, and without a URL there's nothing to download, so they can't
    // be moved. They travel when their post's manifest moves them.
    for (rkey, pin) in read_pins(ctx).await? {
        push(
            pin.object_id.clone(),
            pin.item.item_url.clone(),
            Source::Pinned { rkey },
        );
    }

    Ok(scope)
}

/// Rewrite and republish every owned manifest touched by this batch.
async fn rewrite_channels(
    ctx: &RepackContext,
    moves: &[Move],
    now_iso: &str,
) -> Result<usize, String> {
    let mut by_channel: HashMap<(&str, &str), Vec<Move>> = HashMap::new();
    for m in moves {
        if let Source::Channel {
            channel_id,
            channel_key,
        } = &m.source
        {
            by_channel
                .entry((channel_id, channel_key))
                .or_default()
                .push(m.clone());
        }
    }

    let mut count = 0;
    for ((channel_id, channel_key), channel_moves) in by_channel {
        let Some(k) = pin_crypto::channel_key_from_base64(channel_key) else {
            continue;
        };
        let Some(mut manifest) = read_own_manifest(ctx, channel_id, &k).await else {
            // The manifest we built the scope from is gone. Refuse rather than
            // guess: the alternative is publishing a manifest we can't see.
            return Err(format!("repack: {channel_id} manifest no longer readable"));
        };
        if !rewrite_manifest(&mut manifest, &channel_moves) {
            continue;
        }
        // The manifest record itself is genuinely new; the items keep their own
        // timestamps, so nothing reorders.
        manifest.published_at = now_iso.to_string();
        let json = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
        pin_channel::publish(&ctx.sia, &k, &json).await?;
        write_own_manifest(ctx, channel_id, &k, &json).await?;
        count += 1;
    }
    Ok(count)
}

/// Point every pin record at the bytes its item now lives in.
async fn rewrite_pins(ctx: &RepackContext, moves: &[Move]) -> Result<usize, String> {
    let key = pin_derive::pinned_key(&ctx.app_key);
    let mut count = 0;
    for m in moves {
        let Source::Pinned { rkey } = &m.source else {
            continue;
        };
        let Some(mut pin) = read_pin(ctx, rkey).await else {
            continue;
        };
        pin.object_id = m.new_object_id.clone();
        pin.item.id = m.new_object_id.clone();
        pin.item.item_url = m.new_item_url.clone();
        pin.item.content_hash = Some(m.new_content_hash.clone());
        let json = serde_json::to_string(&pin).map_err(|e| e.to_string())?;
        let sealed = pin_crypto::encrypt(&key, json.as_bytes())?;
        write_record(
            &ctx.doc,
            ctx.author_id,
            pin_derive::PINNED_COLLECTION,
            rkey,
            sealed.into_bytes(),
        )
        .await?;
        count += 1;
    }
    Ok(count)
}

/// Pass, wait, repeat — forever.
///
/// One batch per wake rather than looping until clean: a pass moves real bytes over
/// the network, and draining the whole account in one go would monopolise the Sia
/// connection that publishing and reading also need. Waste accumulates slowly, so
/// clearing it slowly is the right shape.
pub async fn run_repack_loop(
    ctx: RepackContext,
    cadence: Duration,
    now_secs: impl Fn() -> i64,
    now_iso: impl Fn() -> String,
    on_pass: impl Fn(Result<Option<RepackOutcome>, String>),
) -> ! {
    loop {
        on_pass(repack_once(&ctx, now_secs(), &now_iso()).await);
        n0_future::time::sleep(cadence).await;
    }
}

/// Seconds since the epoch from an ISO-8601 timestamp, or 0 when it won't parse.
///
/// 0 reads as "very old", which makes an unparseable timestamp ELIGIBLE for repack
/// rather than exempt. That's the safe direction: the age check exists to avoid
/// churning a burst of fresh publishes, and a timestamp we can't read is far more
/// likely to be old than to be from the last two minutes.
fn parse_iso_secs(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.timestamp())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slab(key: &str, used: u64, age_secs: i64) -> SlabAggregate {
        SlabAggregate {
            encryption_key: key.into(),
            bytes_used: used,
            capacity: 40 * 1024 * 1024,
            objects: vec![SlabObject {
                id: format!("obj-{key}"),
                created_at_secs: 1_000_000 - age_secs,
            }],
        }
    }

    const NOW: i64 = 1_000_000;
    const MB: u64 = 1024 * 1024;

    #[test]
    fn an_object_spanning_slabs_lands_in_each_of_them() {
        let objects = vec![
            ObjectSlabs {
                object_id: "big".into(),
                created_at_secs: 1,
                slabs: vec![
                    SlabPiece {
                        encryption_key: "a".into(),
                        length: 40 * MB,
                        min_shards: 10,
                    },
                    SlabPiece {
                        encryption_key: "b".into(),
                        length: 10 * MB,
                        min_shards: 10,
                    },
                ],
            },
            ObjectSlabs {
                object_id: "small".into(),
                created_at_secs: 2,
                slabs: vec![SlabPiece {
                    encryption_key: "b".into(),
                    length: 1 * MB,
                    min_shards: 10,
                }],
            },
        ];

        let mut got = aggregate_slabs(&objects);
        got.sort_by(|x, y| x.encryption_key.cmp(&y.encryption_key));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].bytes_used, 40 * MB);
        // Slab b holds part of one object and all of another: 11 MiB between them.
        assert_eq!(got[1].bytes_used, 11 * MB);
        assert_eq!(got[1].objects.len(), 2);
    }

    #[test]
    fn nothing_is_repacked_below_the_worthwhile_threshold() {
        // Two collapsible slabs saves one slab — not worth the downloads.
        let slabs = vec![slab("a", MB, 3600), slab("b", MB, 3600)];
        assert!(pick_batch(&slabs, NOW).is_empty());
    }

    #[test]
    fn full_and_fresh_slabs_are_left_alone() {
        let mut slabs = vec![slab("a", MB, 3600), slab("b", MB, 3600)];
        // Nearly full: the reclaim wouldn't pay for moving it.
        slabs.push(slab("full", 39 * MB, 3600));
        // Minutes old: someone may still be publishing into it.
        slabs.push(slab("fresh", MB, 5));
        assert!(pick_batch(&slabs, NOW).is_empty());

        // A third eligible slab is what tips it over.
        slabs.push(slab("c", MB, 3600));
        let batch = pick_batch(&slabs, NOW);
        let keys: Vec<&str> = batch.iter().map(|s| s.encryption_key.as_str()).collect();
        assert_eq!(keys, vec!["a", "b", "c"]);
    }

    #[test]
    fn a_batch_never_exceeds_one_slab_of_content() {
        // Four slabs at 12 MiB: three fit under the ~38 MiB target, the fourth would
        // overflow it — and overflowing defeats the point, since the packed upload
        // would spill into a second slab and reclaim one less than intended.
        let slabs: Vec<SlabAggregate> = ["a", "b", "c", "d"]
            .iter()
            .map(|k| slab(k, 12 * MB, 3600))
            .collect();
        let batch = pick_batch(&slabs, NOW);
        assert_eq!(batch.len(), 3);
        assert!(batch.iter().map(|s| s.bytes_used).sum::<u64>() as f64 <= SLAB_PACK_TARGET_BYTES);
    }

    #[test]
    fn a_batch_that_packs_to_fewer_than_three_is_dropped() {
        // Four big slabs: only two fit under the target, which saves a single slab —
        // below the threshold, so the pass does nothing rather than churn for it.
        let slabs: Vec<SlabAggregate> = ["a", "b", "c", "d"]
            .iter()
            .map(|k| slab(k, 15 * MB, 3600))
            .collect();
        assert!(pick_batch(&slabs, NOW).is_empty());
    }

    fn moved(old_url: &str, new_url: &str) -> Move {
        Move {
            old_object_id: "old".into(),
            old_item_url: old_url.into(),
            new_object_id: "new-id".into(),
            new_item_url: new_url.into(),
            new_content_hash: "new-hash".into(),
            source: Source::Pinned { rkey: "r".into() },
        }
    }

    #[test]
    fn every_kind_of_reference_moves_with_its_bytes() {
        // The one that matters: the old object is deleted at the end of the pass, so
        // a reference this misses becomes a dangling pointer — a broken image, or a
        // post whose body won't load.
        let json = r#"{
            "version": 1,
            "name": "Mine",
            "description": "",
            "authorPubkey": "ed25519:aa",
            "publishedAt": "2026-08-09T12:00:00.000Z",
            "avatar": { "itemURL": "old-avatar", "mimeType": "image/png" },
            "cover": { "itemURL": "untouched", "mimeType": "image/png" },
            "items": [{
                "id": "old", "itemURL": "old-body", "type": "text", "title": "t",
                "publishedAt": "2026-08-09T12:00:00.000Z",
                "mimeType": "text/markdown", "byteSize": 4,
                "attachments": [
                    { "url": "old-att", "mimeType": "image/png", "byteSize": 9 },
                    { "url": "untouched-att", "mimeType": "image/png", "byteSize": 9 }
                ]
            }]
        }"#;
        let mut manifest: ChannelManifest = serde_json::from_str(json).unwrap();

        let changed = rewrite_manifest(
            &mut manifest,
            &[
                moved("old-body", "new-body"),
                moved("old-att", "new-att"),
                moved("old-avatar", "new-avatar"),
            ],
        );

        assert!(changed);
        assert_eq!(manifest.items[0].item_url, "new-body");
        assert_eq!(manifest.items[0].id, "new-id");
        let attachments = manifest.items[0].attachments.as_ref().unwrap();
        assert_eq!(attachments[0].url, "new-att");
        assert_eq!(attachments[0].object_id.as_deref(), Some("new-id"));
        // Untouched references stay exactly as they were.
        assert_eq!(attachments[1].url, "untouched-att");
        assert_eq!(manifest.avatar.as_ref().unwrap().item_url, "new-avatar");
        assert_eq!(manifest.cover.as_ref().unwrap().item_url, "untouched");
    }

    #[test]
    fn a_manifest_with_nothing_moved_reports_unchanged() {
        // So a caller doesn't publish a new generation of a manifest that is identical
        // to the one already out there.
        let json = r#"{
            "version": 1, "name": "Mine", "description": "",
            "authorPubkey": "ed25519:aa",
            "publishedAt": "2026-08-09T12:00:00.000Z",
            "items": []
        }"#;
        let mut manifest: ChannelManifest = serde_json::from_str(json).unwrap();
        assert!(!rewrite_manifest(&mut manifest, &[moved("a", "b")]));
    }
}
