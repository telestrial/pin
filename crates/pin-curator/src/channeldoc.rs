//! Serve each owned channel as a live iroh-docs replica, and keep a read ticket for it
//! published — the author half of the content-resolution ladder's top rung.
//!
//! The durable floor underneath is untouched: a channel write is "done" when its Sia
//! object and pkarr locator are live, and this runs alongside. What it buys is speed —
//! a subscriber holding the ticket is PUSHED a new post instead of waiting for the next
//! poll — so a failure here costs the fast rung and never the durable one.
//!
//! Two jobs per channel, and both need the cadence rather than just a change trigger:
//!
//!   - COPY the manifest into the channel's own doc, so a synced subscriber sees it.
//!   - RE-MINT the ticket. A ticket freezes whatever addresses were known when it was
//!     made — the first one a fresh instance mints carries no relay address at all, so
//!     it is undialable — and pkarr records age off the DHT regardless. Re-minting costs
//!     no Sia object and no manifest rewrite.
//!
//! COPIES BYTES, NEVER CONTENT. The manifest already sits in the main doc as
//! `channel/<id>`, sealed under K — byte-identical to what Sia holds and to what the
//! channel doc wants. So a pass moves that blob across verbatim: no decrypt, no
//! re-encrypt, no manifest parsed. The loop is a courier here in the same sense the pull
//! loop is, and it never needs K for the content (only to derive the ticket's key).
//!
//! That also makes the skip-check exact. The frontend version re-encrypted from the
//! decrypted manifest it found in a UI store, so it had to fingerprint the plaintext;
//! copying means the source ciphertext changes if and only if the manifest was
//! rewritten, so comparing what we last copied is precisely "has this moved".
//!
//! ORDER WITHIN A PASS: land the content, confirm it's there, and only then advertise.
//! A ticket is a claim that this doc holds the manifest, so minting one for a doc we
//! never read back would advertise a capability to unconfirmed content — the same
//! mistake as publishing a pointer to bytes that didn't land. Opening a channel doc
//! CREATES an empty replica when there isn't one, which is the normal state of a fresh
//! page load on web (the replica is in-memory), so the confirmation is load-bearing
//! rather than paranoid.

use std::collections::HashMap;
use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc, DocsApi,
    },
    AuthorId, Capability, NamespaceSecret,
};

use crate::{read_record, read_settings};

/// Where a manifest lives inside a channel's own doc. One record per doc — the doc IS
/// the channel, so it needs no further keyspace.
pub(crate) const MANIFEST_COLLECTION: &str = "manifest";
pub(crate) const MANIFEST_RKEY: &str = "self";

/// The main doc's collection of owned channels' manifests — this loop's source.
const OWN_COLLECTION: &str = "channel";

/// TXT record name prefix for the chunked read ticket.
pub(crate) const TICKET_PREFIX: &str = "_d";

/// Everything a pass needs, gathered by whichever engine is running it.
///
/// `docs` is here because this loop opens replicas of its own: a channel doc is keyed by
/// a namespace the loop derives, and `import_namespace` is idempotent (an already-known
/// capability reports no change rather than failing) and returns a lightweight handle,
/// so the loop needs no share of the engine's replica map.
pub struct ChannelDocContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    pub docs: DocsApi,
    /// The Sia AppKey: the settings key (what do I own) and each channel doc's
    /// namespace both derive from it.
    pub app_key: [u8; 32],
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ChannelDocOutcome {
    /// Channels whose manifest was copied into their doc this pass.
    pub copied: usize,
    /// Channels whose doc already held the current manifest, so only the ticket was
    /// refreshed. The steady state.
    pub unchanged: usize,
    /// Channels advertised — a ticket minted and published. Counted separately from
    /// `copied` because re-advertising is the job that has to repeat.
    pub advertised: usize,
    /// Owned channels with no manifest in the doc yet. Ordinary on a fresh device: a
    /// commit puts one there.
    pub unpublished: usize,
    /// Channels that failed somewhere in the pass. The next pass retries — which is
    /// what makes a failure outstanding work rather than a dropped write.
    pub failed: usize,
}

/// One pass over every owned channel.
///
/// `copied` carries what was last written per channel across passes, so a quiet tick
/// doesn't rewrite an unchanged entry (which would churn a blob and wake every
/// subscriber). It lives with the caller rather than in the context because it's the
/// loop's memory, not the engine's — and it is deliberately NOT persisted: on web the
/// channel replica is in-memory, so every page load starts with an empty doc that must
/// be repopulated, and a remembered fingerprint would skip exactly that write.
///
/// Never gives up the whole pass for one channel: one unreachable relay must not stop
/// the rest of an identity's channels from being served.
pub async fn channel_docs_once(
    ctx: &ChannelDocContext,
    copied: &mut HashMap<String, String>,
) -> Result<ChannelDocOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let mut outcome = ChannelDocOutcome::default();

    for owned in &settings.my_channels {
        let id = owned.channel_id.as_str();
        let Some(k) = pin_crypto::channel_key_from_base64(&owned.channel_key) else {
            // A key we can't decode can't derive the ticket's record. Nothing to serve.
            outcome.failed += 1;
            continue;
        };
        let sealed =
            match read_record(&ctx.doc, &ctx.blobs, ctx.author_id, OWN_COLLECTION, id).await {
                Ok(Some(bytes)) => bytes,
                // No manifest recorded for this channel yet — nothing to serve, and not a
                // failure.
                Ok(None) => {
                    outcome.unpublished += 1;
                    continue;
                }
                Err(_) => {
                    outcome.failed += 1;
                    continue;
                }
            };

        match serve_channel(ctx, id, &k, &sealed, copied).await {
            Ok(Served {
                copied: did_copy,
                advertised,
            }) => {
                if did_copy {
                    outcome.copied += 1;
                } else {
                    outcome.unchanged += 1;
                }
                if advertised {
                    outcome.advertised += 1;
                }
            }
            Err(_) => {
                // Leave this channel's fingerprint as it was so the next pass treats
                // the copy as outstanding rather than done.
                copied.remove(id);
                outcome.failed += 1;
            }
        }
    }

    Ok(outcome)
}

/// What serving one channel did.
struct Served {
    copied: bool,
    advertised: bool,
}

/// Copy one channel's manifest into its doc (when it moved), confirm it landed, then
/// mint and publish a fresh read ticket.
async fn serve_channel(
    ctx: &ChannelDocContext,
    channel_id: &str,
    channel_key: &[u8; 32],
    sealed: &[u8],
    copied: &mut HashMap<String, String>,
) -> Result<Served, String> {
    let doc = open_own_channel_doc(ctx, channel_id).await?;
    let fingerprint = pin_crypto::content_hash(sealed);
    let already = copied.get(channel_id).is_some_and(|f| f == &fingerprint);

    if !already {
        doc.set_bytes(ctx.author_id, manifest_key(), sealed.to_vec())
            .await
            .map_err(|e| format!("channel doc {channel_id}: write manifest: {e}"))?;
    }

    // Confirm before advertising — and confirm on every pass, not just after a write.
    // An unchanged fingerprint says what THIS instance last wrote, which says nothing
    // about a replica that was rebuilt empty since (every page load, on web).
    if !holds_manifest(&doc).await? {
        // Something is there to serve but the doc doesn't have it. Forget the
        // fingerprint so the next pass writes rather than trusting this one.
        copied.remove(channel_id);
        return Ok(Served {
            copied: !already,
            advertised: false,
        });
    }
    copied.insert(channel_id.to_string(), fingerprint);

    let ticket = doc
        .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
        .await
        .map_err(|e| format!("channel doc {channel_id}: share: {e}"))?;
    let seed = pin_derive::channel_doc_ticket_seed(channel_key);
    pin_pkarr::publish(
        &seed,
        &pin_pkarr::chunk_txt(TICKET_PREFIX, &ticket.to_string()),
    )
    .await?;

    Ok(Served {
        copied: !already,
        advertised: true,
    })
}

/// Open (idempotently) the write replica of one of our own channels.
async fn open_own_channel_doc(ctx: &ChannelDocContext, channel_id: &str) -> Result<Doc, String> {
    let seed = pin_derive::channel_doc_seed(&ctx.app_key, channel_id);
    ctx.docs
        .import_namespace(Capability::Write(NamespaceSecret::from_bytes(&seed)))
        .await
        .map_err(|e| format!("channel doc {channel_id}: open: {e}"))
}

/// Whether a channel doc actually holds a manifest entry with content.
///
/// Read author-agnostically, the same way a subscriber reads it: only the author can
/// write to this namespace (the capability everyone else holds is read-only), so any
/// entry at this key is the author's.
async fn holds_manifest(doc: &Doc) -> Result<bool, String> {
    let entry = doc
        .get_one(iroh_docs::store::Query::single_latest_per_key().key_exact(manifest_key()))
        .await
        .map_err(|e| format!("read back manifest: {e}"))?;
    let Some(entry) = entry else { return Ok(false) };
    Ok(entry.content_len() > 0)
}

pub(crate) fn manifest_key() -> Vec<u8> {
    pin_derive::record_key(MANIFEST_COLLECTION, MANIFEST_RKEY)
}

/// Pass, wait, repeat — forever. Returned rather than spawned, for the same reason the
/// other loops are: the caller owns the executor, and that placement is the one genuine
/// difference between running this natively and running it in a tab.
pub async fn run_channel_doc_loop(
    ctx: ChannelDocContext,
    cadence: Duration,
    on_pass: impl Fn(Result<ChannelDocOutcome, String>),
) -> ! {
    let mut copied = HashMap::new();
    loop {
        let outcome = channel_docs_once(&ctx, &mut copied).await;
        on_pass(outcome);
        n0_future::time::sleep(cadence).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The three constants below are a contract with code in another language, and every
    // one of them fails SILENTLY if it drifts: the author would serve a doc nobody
    // reads, or advertise under a record nobody resolves. Nothing errors — a subscriber
    // simply never leaves the polling rung, which looks exactly like an author who
    // publishes no ticket at all.

    #[test]
    fn the_manifest_key_is_the_one_subscribers_read() {
        // `lib/channelDoc.ts`: MANIFEST_COLLECTION = 'manifest', MANIFEST_RKEY = 'self'.
        assert_eq!(manifest_key(), b"manifest/self".to_vec());
    }

    #[test]
    fn the_ticket_prefix_is_the_one_subscribers_resolve() {
        // `lib/channelDoc.ts`: TICKET_PREFIX = '_d'. The subscriber rejoins the chunked
        // TXT records by this name.
        assert_eq!(TICKET_PREFIX, "_d");
        let records = pin_pkarr::chunk_txt(TICKET_PREFIX, "a-ticket");
        assert_eq!(pin_pkarr::rejoin_txt(&records, TICKET_PREFIX), "a-ticket");
    }

    #[test]
    fn the_source_collection_is_where_a_commit_records_a_manifest() {
        // `lib/channelLocator.ts`: OWN_COLLECTION = 'channel', keyed by channelID. Read
        // the wrong collection and every channel looks unpublished forever.
        assert_eq!(
            pin_derive::record_key(OWN_COLLECTION, "chan-1"),
            b"channel/chan-1".to_vec()
        );
    }

    #[test]
    fn the_fingerprint_moves_only_when_the_sealed_bytes_do() {
        // Why copying rather than re-encrypting matters: two seals of the same manifest
        // differ (fresh IV each time), so a re-encrypting author cannot compare
        // ciphertext and has to fingerprint the plaintext. Copying makes the comparison
        // exact — the source blob changes if and only if the manifest was rewritten.
        let sealed = b"sealed-manifest-bytes";
        assert_eq!(
            pin_crypto::content_hash(sealed),
            pin_crypto::content_hash(sealed)
        );
        assert_ne!(
            pin_crypto::content_hash(sealed),
            pin_crypto::content_hash(b"sealed-manifest-bytes-v2")
        );
    }
}
