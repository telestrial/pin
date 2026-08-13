//! Keep this identity's pkarr locators alive — every owned channel's, and the
//! settings snapshot's.
//!
//! A locator is a signed pointer on the Mainline DHT saying "the current version of
//! this thing is that Sia object". DHT records are not permanent — they age off unless
//! somebody republishes them — so a channel published in an earlier session quietly
//! stops resolving for its subscribers, which is the same as disappearing.
//!
//! The settings locator ages off the same way, and its failure is worse: it's the
//! pointer a device with nothing but the recovery phrase follows to find your account.
//! It was published only when settings CHANGED, so an identity that stopped changing
//! its settings stopped being recoverable — the single most recovery-critical pointer
//! was the one nothing republished.
//!
//! It ran as a React effect until now, and fire-once: it republished on mount and then
//! never again, so an instance left running for a day republished at hour zero and let
//! the record expire under it. The comment on that effect described exactly the failure
//! it wasn't preventing. Hence a loop with a cadence, in the Curator, where "still
//! running with nobody watching" is the whole point.
//!
//! What it does NOT do is learn its own pointer from the network. Resolving first could
//! read back a stale value from a lagging relay, and re-signing THAT with a fresh
//! timestamp would bury the real current pointer — a keep-alive that can corrupt what
//! it's keeping. The author's own pointer is in their publish state, which is why that
//! record had to stop being device-local before this loop could exist.
//!
//! No Sia session: republishing re-signs a pointer that already names its object. The
//! bytes aren't touched, so nothing here needs to reach Sia at all.

use std::time::Duration;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_derive::{published_channel_rkey, PUBLISHED_SETTINGS_RKEY, SETTINGS_POINTER_PREFIX};

use crate::read_settings;

/// Everything a pass needs, gathered by whichever engine is running it.
pub struct KeepAliveContext {
    pub doc: Doc,
    pub blobs: Store,
    pub author_id: AuthorId,
    /// The Sia AppKey: the settings key (who do I own) and the publish-state key
    /// (what did I publish) both derive from it.
    pub app_key: [u8; 32],
}

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct KeepAliveOutcome {
    /// Channels whose locator was re-signed and republished.
    pub refreshed: usize,
    /// Owned channels with nothing published yet (or no publish state on this
    /// identity's doc). Ordinary: a commit establishes the pointer.
    pub unknown: usize,
    /// Channels whose republish failed. The next pass retries — which is the point of
    /// there being a next pass.
    pub failed: usize,
    /// What happened to the settings locator, reported separately from the channel
    /// counts: "3 refreshed" would otherwise say nothing about whether the one pointer
    /// that recovers a whole account is still alive.
    pub settings: SettingsLocator,
}

/// The settings locator's fate on one pass.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum SettingsLocator {
    /// No snapshot pointer in publish state — nothing has been mirrored yet, or this
    /// instance's doc hasn't synced one. Ordinary on a fresh identity, and NOT a
    /// failure: there is genuinely nothing to keep alive.
    #[default]
    Unknown,
    Refreshed,
    Failed,
}

/// One pass: republish the current pointer for every owned channel we know one for.
///
/// Never gives up the whole pass for one channel — a channel that fails is counted and
/// left for the next pass, because one unreachable relay must not stop the rest of an
/// identity's channels from staying findable.
pub async fn keep_alive_once(ctx: &KeepAliveContext) -> Result<KeepAliveOutcome, String> {
    let settings = read_settings(&ctx.doc, &ctx.blobs, ctx.author_id, &ctx.app_key).await?;
    let published_key = pin_derive::published_key(&ctx.app_key);
    let mut outcome = KeepAliveOutcome::default();

    for owned in &settings.my_channels {
        let Some(k) = pin_crypto::channel_key_from_base64(&owned.channel_key) else {
            // A key we can't decode can't derive the locator it would republish to.
            continue;
        };
        let rkey = published_channel_rkey(&owned.channel_id);
        let Some(url) = read_published_url(ctx, &published_key, &rkey).await else {
            outcome.unknown += 1;
            continue;
        };
        match pin_channel::republish_pointer(&k, &url).await {
            Ok(()) => outcome.refreshed += 1,
            Err(_) => outcome.failed += 1,
        }
    }

    // The settings locator, republished from the same publish state and by the same
    // rule: re-sign the pointer we know, never one read back off the network.
    if let Some(url) = read_published_url(ctx, &published_key, PUBLISHED_SETTINGS_RKEY).await {
        let seed = pin_derive::settings_locator_seed(&ctx.app_key);
        let records = pin_pkarr::chunk_txt(SETTINGS_POINTER_PREFIX, &url);
        outcome.settings = match pin_pkarr::publish(&seed, &records).await {
            Ok(()) => SettingsLocator::Refreshed,
            Err(_) => SettingsLocator::Failed,
        };
    }

    Ok(outcome)
}

/// The Sia URL a pointer currently names, or `None` when we don't know — no record, or
/// one we can't open. Not knowing is survivable (skip this pointer); guessing would not
/// be.
async fn read_published_url(
    ctx: &KeepAliveContext,
    published_key: &[u8; 32],
    rkey: &str,
) -> Option<String> {
    crate::read_published(&ctx.doc, &ctx.blobs, ctx.author_id, published_key, rkey)
        .await
        .and_then(|p| p.url)
}

/// Pass, wait, repeat — forever. Returned rather than spawned, for the same reason the
/// pull loop is: the caller owns the executor, and that placement is the one genuine
/// difference between running this natively and running it in a tab.
pub async fn run_keep_alive_loop(
    ctx: KeepAliveContext,
    cadence: Duration,
    on_pass: impl Fn(Result<KeepAliveOutcome, String>),
) -> ! {
    loop {
        let outcome = keep_alive_once(&ctx).await;
        on_pass(outcome);
        n0_future::time::sleep(cadence).await;
    }
}

// The publish-state record's contract with the frontend is tested beside the type it
// decodes into, in lib.rs.
