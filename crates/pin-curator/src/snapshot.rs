//! Mirror the whole doc to Sia, and keep the pointer to it published.
//!
//! This is the identity's durability floor. A browser's replica is in memory, so a tab
//! that closes keeps nothing; a fresh device holds nothing at all. Both get their state
//! back by downloading this snapshot and putting the records back, which makes it the
//! single artifact standing between a recovery phrase and an account.
//!
//! ONE WRITER, and that is the point of moving it here. It ran as a side effect of two
//! separate React effects — the settings mirror and the pin mirror — each on its own
//! debounce with its own in-flight flag and no knowledge of the other. A settings change
//! and a pin inside the same window therefore produced two concurrent whole-doc uploads
//! racing on one pointer, either of which could finish last and leave the published
//! locator naming the older snapshot. The same shape the identity record had before its
//! publisher was made singular.
//!
//! It reads the DOC, never a UI store — which is what makes one writer possible at all.
//! Whatever is in the doc is what gets mirrored, so who put it there stops mattering.
//!
//! FINGERPRINTED so a quiet pass is free. Uploading is a Sia object plus a DHT publish
//! plus a prune of the object it supersedes; doing that when nothing moved would make
//! every idle cadence expensive. The fingerprint travels in the publish state rather
//! than in memory, so restarting doesn't re-upload an unchanged doc — and so a second
//! device reading the synced doc knows the mirror is current without taking its own.
//!
//! And it EXCLUDES publish state from what it covers, which is the one thing to keep
//! straight here: the record carrying the fingerprint cannot be inside the fingerprint.
//! See `fingerprint_of`, which has the reasoning and the rule for where a new collection
//! belongs.

use std::sync::Arc;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, store::Query, AuthorId};
use n0_future::StreamExt as _;
use pin_derive::{
    published_channel_rkey, RecordKey, PUBLISHED_SETTINGS_RKEY, SETTINGS_POINTER_PREFIX,
};

use crate::{read_record, write_published, PublishedState};

/// Everything a pass needs, gathered by whichever engine is running it.
pub struct SnapshotContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// A connected Sia session — the snapshot is an upload, and superseding one is a
    /// delete.
    pub sia: Arc<pin_sia::Session>,
    /// The Sia AppKey: the snapshot key, the publish-state key and the locator seed all
    /// derive from it.
    pub app_key: [u8; 32],
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SnapshotOutcome {
    /// True when the doc was unchanged since the last snapshot, so nothing was
    /// uploaded. The steady state.
    pub unchanged: bool,
    /// Records mirrored, when one was taken.
    pub records: usize,
    /// The share URL of the snapshot now current — whether this pass wrote it or a
    /// previous one did. The frontend caches this so its boot read stays a plain
    /// download.
    pub url: Option<String>,
    /// Whether the locator was republished this pass. Best-effort: a snapshot the DHT
    /// hasn't heard about is still readable on any device holding the pointer, and the
    /// keep-alive loop republishes it regardless.
    pub published: bool,
    /// Whether the superseded object was reclaimed. Best-effort for the same reason a
    /// failed prune is survivable: the new snapshot is already pointed at, so what's
    /// left behind is a reclaimable orphan rather than a broken pointer.
    pub pruned: bool,
}

/// One record in the snapshot: collection, rkey, value.
///
/// Short field names keep the JSON compact — a snapshot carries every record an
/// identity holds. The names and the base64 are a contract with the frontend's reader,
/// which is the only thing that opens these; a rename here doesn't error, it produces a
/// snapshot that restores nothing.
#[derive(serde::Serialize, serde::Deserialize)]
struct SnapshotEntry {
    c: String,
    k: String,
    v: String,
}

/// One pass: mirror the doc if it has moved since the last one.
pub async fn snapshot_once(ctx: &SnapshotContext) -> Result<SnapshotOutcome, String> {
    let entries = read_all(ctx).await?;
    let json = serde_json::to_string(&entries).map_err(|e| format!("snapshot encode: {e}"))?;
    let fingerprint = fingerprint_of(&entries)?;

    let rkey = published_channel_rkey(PUBLISHED_SETTINGS_RKEY);
    let published_key = pin_derive::published_key(&ctx.app_key);
    let previous =
        crate::read_published(&ctx.doc, &ctx.blobs, ctx.author_id, &published_key, &rkey).await;
    if already_mirrored(
        previous.as_ref().and_then(|p| p.fp.as_deref()),
        &fingerprint,
    ) {
        return Ok(SnapshotOutcome {
            unchanged: true,
            url: previous.and_then(|p| p.url),
            ..Default::default()
        });
    }

    let key = pin_derive::snapshot_key(&ctx.app_key);
    let ciphertext = pin_crypto::encrypt(&key, json.as_bytes())?;
    let uploaded = ctx
        .sia
        .upload_item(ciphertext.into_bytes(), None)
        .await
        .map_err(|e| format!("snapshot upload: {e}"))?;

    // Record before advertising, and advertise before reclaiming. Each step is only
    // safe once the one before it landed: a pointer to bytes that didn't upload names
    // nothing, and an object reclaimed before its replacement is pointed at is a
    // snapshot nobody can read.
    write_published(
        &ctx.doc,
        ctx.author_id,
        &published_key,
        &rkey,
        &PublishedState {
            id: uploaded.id.clone(),
            url: Some(uploaded.item_url.clone()),
            older_id: previous.as_ref().map(|p| p.id.clone()),
            fp: Some(fingerprint),
        },
    )
    .await;

    let seed = pin_derive::settings_locator_seed(&ctx.app_key);
    let records = pin_pkarr::chunk_txt(SETTINGS_POINTER_PREFIX, &uploaded.item_url);
    let published = pin_pkarr::publish(&seed, &records).await.is_ok();

    let mut pruned = false;
    if let Some(old) = previous.as_ref().map(|p| p.id.as_str()) {
        if !old.is_empty() && old != uploaded.id {
            pruned = ctx.sia.delete_object(old).await.is_ok();
        }
    }

    Ok(SnapshotOutcome {
        unchanged: false,
        records: entries.len(),
        url: Some(uploaded.item_url),
        published,
        pruned,
    })
}

/// The fingerprint a pass compares against, over every record EXCEPT publish state.
///
/// A SELF-EXCLUDING CHECKSUM, the same construction TCP zeroes its checksum field for and
/// X.509 signs `tbsCertificate` for: the thing carrying the checksum cannot be inside it.
/// Publishing writes `published/<rkey>` — the object id, the generation it supersedes, and
/// this very fingerprint — so a hash that covered publish state would be a hash of a value
/// derived from itself. There is no fixed point, and the loop re-uploaded every ~17s
/// forever: hash, upload, record the hash, observe that recording it changed the doc.
///
/// The rule, stated so the next collection lands on the right side of it: THE FINGERPRINT
/// MUST EXCLUDE EVERYTHING THE ACT OF PUBLISHING MUTATES, or publishing is its own
/// trigger. That is the whole record and not merely its `fp` field — the object ids move
/// on every pass too, so omitting only the hash would spin just as fast on those.
///
/// Publish state is still MIRRORED; it is only excluded from the comparison. A restored
/// device keeps its reclaim pointers, and two snapshots differing only in publish state
/// hash alike — which is exactly what a checksum that excludes itself means, and is why
/// this is the standard shape rather than a carve-out.
///
/// One field is dropped for a DIFFERENT reason — see `covered_value`. Publish state moves
/// because we published; an instance's `at` moves because time passed. Both are noise the
/// hash should not see, but they are not the same rule, and a third collection should be
/// judged against whichever it actually resembles rather than added to a list.
///
/// Substance still triggers a pass: a manifest lives in `channel/<id>` and settings in
/// `settings/self`, both covered here.
///
/// SORTED, so the answer never depends on the order the doc happened to stream records in.
/// An ordering that varied between passes would be a second way to see a change that
/// wasn't one, and it would look exactly like the bug this function exists to fix.
fn fingerprint_of(entries: &[SnapshotEntry]) -> Result<String, String> {
    let mut covered: Vec<SnapshotEntry> = entries
        .iter()
        .filter(|e| e.c != pin_derive::PUBLISHED_COLLECTION)
        .map(|e| SnapshotEntry {
            c: e.c.clone(),
            k: e.k.clone(),
            v: covered_value(e),
        })
        .collect();
    covered.sort_by(|a, b| (&a.c, &a.k).cmp(&(&b.c, &b.k)));
    let json = serde_json::to_string(&covered).map_err(|e| format!("snapshot encode: {e}"))?;
    Ok(pin_crypto::content_hash(json.as_bytes()))
}

/// A record's value as the fingerprint sees it — verbatim, except that an instance
/// registration's `at` is dropped.
///
/// `at` is a LIVENESS heartbeat and nothing else. Its one consumer is `live_instances`,
/// which keeps registrations under an hour old so `identity` advertises only endpoints a
/// peer could actually reach — so it is rewritten every 15 minutes whether or not anything
/// about this instance moved, and covering it made a timer re-upload the whole doc ~96
/// times a day.
///
/// It is also the one field that cannot survive the trip it would be making. A snapshot
/// restored more than an hour later has every `at` aged out and pruned; restored sooner,
/// the instances are still running and re-registering, so the doc already carries the
/// live value. Either way the mirrored heartbeat is never what answers.
///
/// The REST of the record stays covered, which is the point of cutting at the field rather
/// than the collection: a new instance appearing or an endpoint's home relay moving is
/// real news about where this identity can be reached, and still takes a snapshot.
///
/// Plaintext, so this can read it — the registration is written unsealed (its rkey is the
/// node id, already in the clear). An unparseable value falls through verbatim: that costs
/// the redundant uploads this exists to stop, where guessing at a shape we don't recognise
/// could drop a field that mattered.
fn covered_value(entry: &SnapshotEntry) -> String {
    if entry.c != pin_derive::INSTANCE_COLLECTION {
        return entry.v.clone();
    }
    let stripped = pin_crypto::b64_decode(&entry.v)
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|mut value| {
            value.as_object_mut()?.remove("at");
            serde_json::to_vec(&value).ok()
        });
    match stripped {
        Some(bytes) => pin_crypto::b64_encode(&bytes),
        None => entry.v.clone(),
    }
}

/// Whether the doc is already mirrored — the guard that keeps a quiet pass free.
///
/// The fingerprint lives in the publish state rather than in memory precisely so this
/// answers correctly after a restart: a loop that forgot would re-upload an unchanged
/// doc on every launch, mint an object, publish a record, and reclaim the one it just
/// replaced, all for a document nobody touched.
///
/// No recorded fingerprint means mirror it. That covers a first run and an identity
/// whose publish state predates the field, and erring the other way would leave a
/// snapshot that never gets taken.
fn already_mirrored(recorded: Option<&str>, current: &str) -> bool {
    recorded == Some(current)
}

/// Every record in the doc, in the snapshot's wire shape.
///
/// Keys that aren't record keys are skipped rather than failing the pass: a whole-doc
/// snapshot shouldn't be lost over one stray key.
async fn read_all(ctx: &SnapshotContext) -> Result<Vec<SnapshotEntry>, String> {
    let mut stream = Box::pin(
        ctx.doc
            .get_many(Query::all().build())
            .await
            .map_err(|e| format!("list doc: {e}"))?,
    );
    let mut keys = Vec::new();
    while let Some(res) = stream.next().await {
        let entry = res.map_err(|e| format!("list doc: {e}"))?;
        if let Some(parsed) = RecordKey::parse(&String::from_utf8_lossy(entry.key())) {
            keys.push(parsed);
        }
    }

    let mut entries = Vec::with_capacity(keys.len());
    for key in keys {
        let Some(value) = read_record(
            &ctx.doc,
            &ctx.blobs,
            ctx.author_id,
            &key.collection,
            &key.rkey,
        )
        .await?
        else {
            continue;
        };
        entries.push(SnapshotEntry {
            c: key.collection,
            k: key.rkey,
            v: pin_crypto::b64_encode(&value),
        });
    }
    Ok(entries)
}

/// Snapshot when the doc moves, and on a cadence regardless — forever.
///
/// Woken by the doc's own change stream so a write is mirrored promptly, then held for
/// `settle` so a burst (a channel pin fans out one write per item) costs one upload
/// rather than one each. The cadence is the backstop for a signal that never arrives.
///
/// Returned rather than spawned, for the same reason the other loops are: the caller
/// owns the executor.
pub async fn run_snapshot_loop(
    ctx: SnapshotContext,
    cadence: Duration,
    settle: Duration,
    on_pass: impl Fn(Result<SnapshotOutcome, String>),
) -> ! {
    let mut events = ctx.doc.subscribe().await.ok().map(Box::pin);
    loop {
        on_pass(snapshot_once(&ctx).await);

        // Wait for something to change, or for the cadence to come round. A doc whose
        // stream is unavailable falls back to the cadence alone, which is slower but
        // never wrong.
        match events.as_mut() {
            Some(stream) => {
                let woken = async {
                    let _ = stream.next().await;
                    n0_future::time::sleep(settle).await;
                };
                n0_future::future::race(woken, n0_future::time::sleep(cadence)).await;
            }
            None => n0_future::time::sleep(cadence).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_shape_is_the_one_the_frontend_reads() {
        // Captured by RUNNING `lib/docsMirror.ts`'s writer, which is now only a
        // reader — not written by hand from reading it. A
        // rename here wouldn't error — it would produce a snapshot that restores
        // nothing, on the one artifact that stands between a recovery phrase and an
        // account.
        let entry = SnapshotEntry {
            c: "settings".into(),
            k: "self".into(),
            v: pin_crypto::b64_encode(b"hi"),
        };
        assert_eq!(
            serde_json::to_string(&vec![entry]).unwrap(),
            r#"[{"c":"settings","k":"self","v":"aGk="}]"#
        );
    }

    #[test]
    fn an_unchanged_doc_is_not_re_uploaded() {
        assert!(already_mirrored(Some("cid-1"), "cid-1"));
        assert!(!already_mirrored(Some("cid-1"), "cid-2"));
        // No record yet: a first run, or publish state written before the field
        // existed. Mirror it — a snapshot taken twice costs an object; one never
        // taken costs the account.
        assert!(!already_mirrored(None, "cid-1"));
    }

    fn entry(c: &str, k: &str, v: &str) -> SnapshotEntry {
        SnapshotEntry {
            c: c.into(),
            k: k.into(),
            v: v.into(),
        }
    }

    #[test]
    fn publishing_does_not_change_the_fingerprint_it_records() {
        // THE regression. A pass hashes the doc, uploads, then writes the object id, the
        // superseded generation and this very hash into `published/…`. If that write is
        // covered, the next pass sees a doc that differs BECAUSE it recorded the hash —
        // no fixed point exists, and the loop re-uploads forever (observed: every ~17s).
        let before = vec![
            entry("settings", "self", "sealed-settings"),
            entry("published", "channel:settings", r#"{"id":"X","fp":"H0"}"#),
        ];
        let after = vec![
            entry("settings", "self", "sealed-settings"),
            // What publishing writes: new object, new supersession, new hash.
            entry(
                "published",
                "channel:settings",
                r#"{"id":"Y","older":"X","fp":"H1"}"#,
            ),
        ];
        assert_eq!(
            fingerprint_of(&before).unwrap(),
            fingerprint_of(&after).unwrap()
        );
    }

    #[test]
    fn omitting_only_the_hash_field_would_not_have_been_enough() {
        // Worth pinning as its own case, because the obvious reading of a self-excluding
        // checksum is "leave out the hash" — and here that still spins. The record also
        // carries the object ids, and publishing moves those on every pass, so the unit
        // to omit is the RECORD, not the field.
        let a = vec![entry("published", "channel:settings", r#"{"id":"X"}"#)];
        let b = vec![entry(
            "published",
            "channel:settings",
            r#"{"id":"Y","older":"X"}"#,
        )];
        assert_eq!(fingerprint_of(&a).unwrap(), fingerprint_of(&b).unwrap());
    }

    #[test]
    fn a_real_change_still_triggers_a_pass() {
        // The other half, and the one that would make this fix a data-loss bug rather
        // than a performance one: excluding too much would leave real edits unmirrored.
        let before = vec![entry("settings", "self", "sealed-v1")];
        let after = vec![entry("settings", "self", "sealed-v2")];
        assert_ne!(
            fingerprint_of(&before).unwrap(),
            fingerprint_of(&after).unwrap()
        );

        // A new channel is substance too, not bookkeeping.
        let added = vec![
            entry("settings", "self", "sealed-v1"),
            entry("channel", "abc", "sealed-manifest"),
        ];
        assert_ne!(
            fingerprint_of(&before).unwrap(),
            fingerprint_of(&added).unwrap()
        );
    }

    fn instance(node: &str, at: u64, relay: Option<&str>) -> SnapshotEntry {
        let json = serde_json::json!({
            "at": at,
            "durable": true,
            "relay": relay,
        });
        entry(
            "instance",
            node,
            &pin_crypto::b64_encode(&serde_json::to_vec(&json).unwrap()),
        )
    }

    #[test]
    fn a_heartbeat_alone_does_not_take_a_snapshot() {
        // `at` is rewritten every 15 minutes whether or not anything moved, and covering
        // it made a timer re-upload the whole doc ~96 times a day.
        let before = vec![instance("node-a", 1_700_000_000, Some("https://relay/"))];
        let after = vec![instance("node-a", 1_700_000_900, Some("https://relay/"))];
        assert_eq!(
            fingerprint_of(&before).unwrap(),
            fingerprint_of(&after).unwrap()
        );
    }

    #[test]
    fn everything_about_an_instance_except_its_heartbeat_still_does() {
        // The half that makes this a field cut rather than a collection cut. A relay that
        // moved or an instance that appeared is real news about where this identity can be
        // reached, and excluding the whole collection would have lost both.
        let base = vec![instance("node-a", 1_700_000_000, Some("https://relay/"))];

        let moved_relay = vec![instance("node-a", 1_700_000_000, Some("https://other/"))];
        assert_ne!(
            fingerprint_of(&base).unwrap(),
            fingerprint_of(&moved_relay).unwrap()
        );

        let joined = vec![
            instance("node-a", 1_700_000_000, Some("https://relay/")),
            instance("node-b", 1_700_000_000, Some("https://relay/")),
        ];
        assert_ne!(
            fingerprint_of(&base).unwrap(),
            fingerprint_of(&joined).unwrap()
        );

        // And a relay that moved is still seen when the heartbeat moved in the same pass,
        // which is the ordinary case — both fields change on one write.
        let both = vec![instance("node-a", 1_700_000_900, Some("https://other/"))];
        assert_ne!(
            fingerprint_of(&base).unwrap(),
            fingerprint_of(&both).unwrap()
        );
    }

    #[test]
    fn an_unreadable_instance_record_is_covered_verbatim() {
        // Falls toward redundant uploads rather than toward dropping a field we failed to
        // recognise — the same direction the denylist errs in.
        let a = vec![entry("instance", "node-a", "not-base64-json")];
        let b = vec![entry("instance", "node-a", "something-else")];
        assert_ne!(fingerprint_of(&a).unwrap(), fingerprint_of(&b).unwrap());
    }

    #[test]
    fn only_an_instance_records_at_is_dropped() {
        // `at` is not a reserved word anywhere else. A record in another collection that
        // happens to carry one is substance, and losing it would be silent.
        let payload = pin_crypto::b64_encode(br#"{"at":1,"body":"x"}"#);
        let other = pin_crypto::b64_encode(br#"{"at":2,"body":"x"}"#);
        let a = vec![entry("comment", "c1", &payload)];
        let b = vec![entry("comment", "c1", &other)];
        assert_ne!(fingerprint_of(&a).unwrap(), fingerprint_of(&b).unwrap());
    }

    #[test]
    fn the_order_records_arrive_in_does_not_change_the_answer() {
        // The doc streams records; relying on that order would be a second way to see a
        // change that wasn't one, and it would present exactly as the bug above.
        let one = vec![
            entry("channel", "b", "2"),
            entry("settings", "self", "1"),
            entry("channel", "a", "3"),
        ];
        let other = vec![
            entry("settings", "self", "1"),
            entry("channel", "a", "3"),
            entry("channel", "b", "2"),
        ];
        assert_eq!(
            fingerprint_of(&one).unwrap(),
            fingerprint_of(&other).unwrap()
        );
    }

    #[test]
    fn base64_matches_what_javascript_writes() {
        // Standard alphabet, padded — captured from the same run. This is `btoa`'s
        // output, and what every snapshot written before this loop existed used; a
        // padding or alphabet difference would decode to the wrong bytes rather than
        // fail loudly.
        assert_eq!(pin_crypto::b64_encode(&[0xff, 0xfe, 0xfd]), "//79");
        assert_eq!(pin_crypto::b64_encode(b"a"), "YQ==");
        assert_eq!(pin_crypto::b64_decode("YQ==").as_deref(), Some(&b"a"[..]));
    }
}
