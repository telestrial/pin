//! Asking to read a private channel, from both ends.
//!
//! The asker signs a request and keeps the newest in `join-request/<channelID>`; the deliver
//! loop knocks it to the channel's author until it lands, the way it knocks an invitation.
//! The author's knock drain takes it into `join-inbox/<channelID>:<did>`, the newest per
//! person, if the channel is one of the author's own private ones. Nothing is published:
//! who asked to read what is between the two of them.
//!
//! The intake answers nothing either way, like every knock: a request refused for the cap or
//! for naming the wrong channel looks to its sender exactly like one taken, so the inbox is
//! not something a stranger can probe.

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_channel::request::Request;

use crate::{read_record, write_record, SettingsView};

/// How many people's requests one channel's inbox holds. A request costs nothing to send,
/// so without a ceiling a stranger could fill the author's doc; past it, a newcomer's
/// request is dropped, while somebody already in the inbox can still withdraw or re-ask.
pub const MAX_REQUESTS_PER_CHANNEL: usize = 500;

/// Sign a request to read a private channel, or its withdrawal, and keep it as this
/// identity's own — the record the deliver loop knocks and a screen reads.
#[allow(clippy::too_many_arguments)]
pub async fn request_access(
    doc: &Doc,
    author_id: AuthorId,
    app_key: &[u8; 32],
    channel_key: &[u8; 32],
    author: &str,
    withdrawn: bool,
    now_iso: &str,
) -> Result<Request, String> {
    let request =
        pin_channel::request::sign_request(app_key, channel_key, author, withdrawn, now_iso)?;
    let bytes = serde_json::to_vec(&request).map_err(|e| format!("encode request: {e}"))?;
    write_record(
        doc,
        author_id,
        pin_derive::JOIN_REQUEST_COLLECTION,
        &request.channel_id,
        bytes,
    )
    .await?;
    Ok(request)
}

/// The knock a request travels as.
pub fn request_knock(request: &Request) -> serde_json::Value {
    serde_json::json!({ "request": request })
}

/// Whether a knocked record is a request to read a channel.
pub(crate) fn is_request_knock(record: &serde_json::Value) -> bool {
    record.get("request").is_some_and(|v| v.is_object())
}

/// Take knocked requests into the inbox, answering with how many changed it.
///
/// Kept only when signed by the person it names, addressed to this identity, about one of
/// its own private channels, and newer than what the inbox holds for that person. Anything
/// else is dropped without a word — see the module doc.
pub(crate) async fn take_requests(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    settings: &SettingsView,
    own_did: &str,
    knocks: &[serde_json::Value],
) -> usize {
    take_requests_capped(
        doc,
        blobs,
        author_id,
        settings,
        own_did,
        knocks,
        MAX_REQUESTS_PER_CHANNEL,
    )
    .await
}

/// `take_requests` with the ceiling as a parameter, so it can be tested without
/// [`MAX_REQUESTS_PER_CHANNEL`] people.
async fn take_requests_capped(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    settings: &SettingsView,
    own_did: &str,
    knocks: &[serde_json::Value],
    cap: usize,
) -> usize {
    let mut taken = 0;
    for knock in knocks {
        let Ok(request) = serde_json::from_value::<Request>(knock["request"].clone()) else {
            continue;
        };
        if request.verify().is_err() || bare(&request.author) != bare(own_did) {
            continue;
        }
        let private = settings.my_channels.iter().any(|c| {
            c.channel_id == request.channel_id && c.visibility.as_deref() == Some("private")
        });
        if !private {
            continue;
        }
        let rkey = pin_derive::join_inbox_rkey(&request.channel_id, &request.actor);
        let held = held_request(doc, blobs, author_id, &rkey).await;
        match &held {
            // Not newer: a duplicate knock, or an older record replayed.
            Some(h) if h.created_at.as_str() >= request.created_at.as_str() => continue,
            // A withdrawal of nothing held takes nothing back.
            None if request.withdrawn => continue,
            None if standing(doc, blobs, author_id, &request.channel_id).await >= cap => continue,
            _ => {}
        }
        let Ok(bytes) = serde_json::to_vec(&request) else {
            continue;
        };
        if write_record(
            doc,
            author_id,
            pin_derive::JOIN_INBOX_COLLECTION,
            &rkey,
            bytes,
        )
        .await
        .is_ok()
        {
            taken += 1;
        }
    }
    taken
}

/// What the inbox holds for one person on one channel.
async fn held_request(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    rkey: &str,
) -> Option<Request> {
    let bytes = read_record(
        doc,
        blobs,
        author_id,
        pin_derive::JOIN_INBOX_COLLECTION,
        rkey,
    )
    .await
    .ok()
    .flatten()?;
    serde_json::from_slice(&bytes).ok()
}

/// How many people currently ask to read one channel: the inbox entries for it that are not
/// withdrawals.
async fn standing(doc: &Doc, blobs: &Store, author_id: AuthorId, channel_id: &str) -> usize {
    let prefix = format!("{channel_id}:");
    let rkeys = crate::list_rkeys(doc, author_id, pin_derive::JOIN_INBOX_COLLECTION)
        .await
        .unwrap_or_default();
    let mut count = 0;
    for rkey in rkeys.iter().filter(|k| k.starts_with(&prefix)) {
        if held_request(doc, blobs, author_id, rkey)
            .await
            .is_some_and(|r| !r.withdrawn)
        {
            count += 1;
        }
    }
    count
}

/// This identity's own requests, each with the content hash its delivery mark compares.
pub(crate) async fn own_requests(doc: &Doc, blobs: &Store, author_id: AuthorId) -> Vec<Request> {
    let rkeys = crate::list_rkeys(doc, author_id, pin_derive::JOIN_REQUEST_COLLECTION)
        .await
        .unwrap_or_default();
    let mut out = Vec::new();
    for rkey in rkeys {
        let Ok(Some(bytes)) = read_record(
            doc,
            blobs,
            author_id,
            pin_derive::JOIN_REQUEST_COLLECTION,
            &rkey,
        )
        .await
        else {
            continue;
        };
        if let Ok(request) = serde_json::from_slice::<Request>(&bytes) {
            out.push(request);
        }
    }
    out
}

/// What a request's delivery mark holds: its content hash, so a new request or a withdrawal
/// is sent and an unchanged one is not.
pub(crate) fn request_hash(request: &Request) -> String {
    pin_crypto::content_hash(
        serde_json::to_string(request)
            .unwrap_or_default()
            .as_bytes(),
    )
}

fn bare(did: &str) -> &str {
    did.strip_prefix("did:dht:").unwrap_or(did)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testnet::{Identity, World};

    /// The author, owning one channel at `visibility`, and the settings that say so.
    async fn owning(author: &Identity, visibility: &str) -> ([u8; 32], SettingsView) {
        let k = author.channel_key();
        let settings: SettingsView = serde_json::from_value(serde_json::json!({
            "myChannels": [{
                "channelID": pin_crypto::channel_id(&k),
                "channelKey": pin_crypto::channel_key_to_base64(&k),
                "visibility": visibility,
            }],
        }))
        .unwrap();
        (k, settings)
    }

    async fn asks(
        asker: &Identity,
        k: &[u8; 32],
        author: &str,
        withdrawn: bool,
        at: &str,
    ) -> serde_json::Value {
        let request = request_access(
            &asker.doc,
            asker.author_id,
            &asker.app_key,
            k,
            author,
            withdrawn,
            at,
        )
        .await
        .unwrap();
        request_knock(&request)
    }

    async fn inbox(author: &Identity, k: &[u8; 32], asker: &Identity) -> Option<Request> {
        held_request(
            &author.doc,
            &author.blobs,
            author.author_id,
            &pin_derive::join_inbox_rkey(&pin_crypto::channel_id(k), &asker.did),
        )
        .await
    }

    async fn take(
        author: &Identity,
        settings: &SettingsView,
        knocks: &[serde_json::Value],
    ) -> usize {
        take_requests(
            &author.doc,
            &author.blobs,
            author.author_id,
            settings,
            &author.did,
            knocks,
        )
        .await
    }

    #[tokio::test]
    async fn a_request_lands_and_a_withdrawal_outranks_it_but_not_the_reverse() {
        let world = World::new();
        let author = Identity::new(&world, 1).await;
        let bob = Identity::new(&world, 2).await;
        let (k, settings) = owning(&author, "private").await;

        let first = asks(&bob, &k, &author.did, false, "2026-10-03T00:00:01Z").await;
        assert_eq!(take(&author, &settings, &[first.clone()]).await, 1);
        assert!(!inbox(&author, &k, &bob).await.unwrap().withdrawn);
        // The same knock again changes nothing.
        assert_eq!(take(&author, &settings, &[first.clone()]).await, 0);

        let back = asks(&bob, &k, &author.did, true, "2026-10-03T00:00:02Z").await;
        assert_eq!(take(&author, &settings, &[back]).await, 1);
        assert!(inbox(&author, &k, &bob).await.unwrap().withdrawn);
        // The old request replayed after its withdrawal does not bring it back.
        assert_eq!(take(&author, &settings, &[first]).await, 0);
        assert!(inbox(&author, &k, &bob).await.unwrap().withdrawn);

        // And bob's own copy is the newest, which is what his screen says.
        let own = own_requests(&bob.doc, &bob.blobs, bob.author_id).await;
        assert_eq!(own.len(), 1);
        assert!(own[0].withdrawn);
    }

    #[tokio::test]
    async fn a_full_inbox_drops_a_newcomer_but_lets_somebody_already_in_it_withdraw() {
        let world = World::new();
        let author = Identity::new(&world, 1).await;
        let bob = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        let (k, settings) = owning(&author, "private").await;
        let take_one = |knock: serde_json::Value| {
            let author = &author;
            let settings = &settings;
            async move {
                take_requests_capped(
                    &author.doc,
                    &author.blobs,
                    author.author_id,
                    settings,
                    &author.did,
                    &[knock],
                    1,
                )
                .await
            }
        };

        assert_eq!(
            take_one(asks(&bob, &k, &author.did, false, "2026-10-03T00:00:01Z").await).await,
            1
        );
        // Full: carol is dropped.
        assert_eq!(
            take_one(asks(&carol, &k, &author.did, false, "2026-10-03T00:00:02Z").await).await,
            0
        );
        assert!(inbox(&author, &k, &carol).await.is_none());
        // Bob, already in it, can still take his back — which makes room.
        assert_eq!(
            take_one(asks(&bob, &k, &author.did, true, "2026-10-03T00:00:03Z").await).await,
            1
        );
        assert_eq!(
            take_one(asks(&carol, &k, &author.did, false, "2026-10-03T00:00:04Z").await).await,
            1
        );
    }

    #[tokio::test]
    async fn a_knocked_request_reaches_the_inbox_through_an_engagement_pass() {
        let world = World::new();
        let author = Identity::new(&world, 1).await;
        let bob = Identity::new(&world, 2).await;
        let k = author.channel_key();
        author
            .set_settings(serde_json::json!({
                "myChannels": [{
                    "channelID": pin_crypto::channel_id(&k),
                    "channelKey": pin_crypto::channel_key_to_base64(&k),
                    "visibility": "private",
                }],
            }))
            .await;
        let knock = asks(&bob, &k, &author.did, false, "2026-10-03T00:00:01Z").await;
        let ctx = author.engagement_ctx();
        assert!(
            pin_rpc::HeyHandler::new(ctx.inbox.clone()).accept_knock(&pin_rpc::hey_request(&knock))
        );

        let pass = crate::engagement_once(
            &ctx,
            &author.did,
            "2026-10-03T00:00:02Z".to_string(),
            false,
            false,
        )
        .await
        .expect("engagement pass");

        assert_eq!(pass.requests, 1);
        assert!(inbox(&author, &k, &bob).await.is_some());
    }

    #[tokio::test]
    async fn only_a_genuine_request_for_ones_own_private_channel_is_kept() {
        let world = World::new();
        let author = Identity::new(&world, 1).await;
        let bob = Identity::new(&world, 2).await;

        // A public channel takes no requests: following it needs nobody's leave.
        let (k, public) = owning(&author, "public").await;
        let knock = asks(&bob, &k, &author.did, false, "2026-10-03T00:00:01Z").await;
        assert_eq!(take(&author, &public, &[knock.clone()]).await, 0);

        let (_, private) = owning(&author, "private").await;
        // Addressed to somebody else.
        let elsewhere = asks(&bob, &k, "did:dht:someone", false, "2026-10-03T00:00:02Z").await;
        assert_eq!(take(&author, &private, &[elsewhere]).await, 0);
        // Tampered after signing.
        let mut forged = knock.clone();
        forged["request"]["encKey"] = serde_json::json!(pin_crypto::b64_encode(&[1u8; 32]));
        assert_eq!(take(&author, &private, &[forged]).await, 0);
        // A withdrawal of a request never held.
        let nothing = asks(&bob, &k, &author.did, true, "2026-10-03T00:00:03Z").await;
        assert_eq!(take(&author, &private, &[nothing]).await, 0);
        assert!(inbox(&author, &k, &bob).await.is_none());
        // The genuine article.
        assert_eq!(take(&author, &private, &[knock]).await, 1);
    }
}
