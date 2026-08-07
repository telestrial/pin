//! Keep every owned channel's pkarr locator alive.
//!
//! A locator is a signed pointer on the Mainline DHT saying "this channel's current
//! manifest is that Sia object". DHT records are not permanent — they age off unless
//! somebody republishes them — so a channel published in an earlier session quietly
//! stops resolving for its subscribers, which is the same as disappearing.
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
use pin_derive::{published_channel_rkey, PUBLISHED_COLLECTION};

use crate::{read_record, read_settings};

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
}

/// One channel's publish state, as the frontend writes it.
///
/// Field names are asserted rather than derived: `rename_all = "camelCase"` gets
/// acronyms wrong, and this repo has already shipped a descriptor whose URL arrived
/// under a name nothing read. A mismatch here wouldn't error — the record would simply
/// never be found, and the locator would age off in silence.
#[derive(serde::Deserialize)]
struct PublishedView {
    #[serde(default)]
    url: Option<String>,
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
    Ok(outcome)
}

/// The Sia URL this channel's locator currently names, or `None` when we don't know —
/// no record, or one we can't open. Not knowing is survivable (skip this channel);
/// guessing would not be.
async fn read_published_url(
    ctx: &KeepAliveContext,
    published_key: &[u8; 32],
    rkey: &str,
) -> Option<String> {
    let raw = read_record(
        &ctx.doc,
        &ctx.blobs,
        ctx.author_id,
        PUBLISHED_COLLECTION,
        rkey,
    )
    .await
    .ok()
    .flatten()?;
    let blob = String::from_utf8(raw).ok()?;
    let json = pin_crypto::decrypt(published_key, &blob).ok()?;
    let view: PublishedView = serde_json::from_slice(&json).ok()?;
    view.url
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_state_decodes_what_the_frontend_writes() {
        // Verbatim from `lib/publishState.ts`'s `PublishedObject`. If this stops
        // matching, the loop finds no pointer and republishes nothing — silently.
        let written = r#"{"id":"obj-2","url":"sia://obj-2#encryption_key=k","olderId":"obj-1"}"#;
        let view: PublishedView = serde_json::from_str(written).unwrap();
        assert_eq!(view.url.as_deref(), Some("sia://obj-2#encryption_key=k"));
    }

    #[test]
    fn a_record_without_a_url_is_not_a_pointer() {
        // `url` is optional on the frontend's type, and a record without one names
        // nothing to republish — the channel counts as unknown, not as a failure.
        let view: PublishedView = serde_json::from_str(r#"{"id":"obj-1"}"#).unwrap();
        assert!(view.url.is_none());
    }
}
