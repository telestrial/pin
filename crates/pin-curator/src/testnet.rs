//! A network several identities share, and the docs they each keep — so a PASS can run.
//!
//! Pin's substrate decides who can see whom, and that is a property of a SEQUENCE across
//! identities: carol becomes visible to john once alice's record lands, and not before.
//! No pure function holds that. `frontier` says what ORDER a pass would take, which is a
//! different claim. So the only way to test the thing this codebase exists to get right
//! is to run real passes, over real docs, against a network they share.
//!
//! The network is faked and nothing else is. The docs are genuine in-memory iroh-docs
//! replicas, the records are written and read by the crate's own helpers, and every pass
//! under test is the one that ships. What is replaced is the two reads in `net::Network`
//! — which is the whole of what a crawl asks of the outside world.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use iroh_docs::engine::LiveEvent;
use pin_pkarr::TxtRecord;

/// A local write of `key`, as the engine reports one.
///
/// Here rather than beside one loop's tests because SEVERAL loops filter the doc stream by
/// an allowlist, and each one's filter has to be shown to admit what it reads and refuse
/// what its own pass writes. Two spellings of "what a write looks like" would be two
/// slightly different ideas of what the loops are being shown.
pub(crate) fn wrote(key: &str) -> LiveEvent {
    let id = iroh_docs::sync::RecordIdentifier::new(
        iroh_docs::NamespaceId::from(&[1u8; 32]),
        iroh_docs::AuthorId::from(&[2u8; 32]),
        key,
    );
    // A non-empty length: `Record::new` insists a zero-length record carry the hash of the
    // empty range, and the length is nothing to do with what's under test.
    let record = iroh_docs::sync::Record::new(iroh_blobs::Hash::from([3u8; 32]), 1, 0);
    LiveEvent::InsertLocal {
        entry: iroh_docs::sync::Entry::new(id, record),
    }
}

/// A write arriving from another instance of this same identity.
pub(crate) fn synced(key: &str) -> LiveEvent {
    let LiveEvent::InsertLocal { entry } = wrote(key) else {
        unreachable!()
    };
    LiveEvent::InsertRemote {
        entry,
        from: iroh::PublicKey::from_bytes(&[0u8; 32]).unwrap(),
        content_status: iroh_docs::ContentStatus::Complete,
    }
}

/// What every identity in a scenario can see: published packets, and the blobs they name.
///
/// One store, shared — that is the point. Alice publishing is john becoming ABLE to read
/// her, and nothing more; whether he does is what the crawl decides.
///
/// A fake must behave neither better NOR worse than production, and worse is the dangerous
/// direction. So this models the three answers the real thing gives — published, absent,
/// and UNREACHABLE — because the crawl treats them differently and a fake that only ever
/// succeeds would delete every one of those rules from coverage.
#[derive(Default)]
pub struct World {
    packets: Mutex<HashMap<String, Vec<TxtRecord>>>,
    blobs: Mutex<HashMap<String, Vec<u8>>>,
    /// Keys whose resolve FAILS rather than answering — asleep, or the DHT not answering.
    /// Distinct from having published nothing, which is a real answer that ends the asking.
    unreachable: Mutex<Vec<String>>,
    /// Packets published but not yet propagated: what a resolve WOULD return once the
    /// store everyone reads catches up. Until then the old one is served, successfully.
    pending: Mutex<HashMap<String, Vec<TxtRecord>>>,
}

impl World {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Publish a packet under a key, and the blob it points at.
    pub fn publish(self: &Arc<Self>, did: &str, dir_url: &str, directory: serde_json::Value) {
        let mut txt = pin_pkarr::chunk_txt(crate::identity::DIR_PREFIX, dir_url);
        txt.extend(pin_pkarr::chunk_txt(crate::identity::IROH_PREFIX, ""));
        self.packets.lock().unwrap().insert(did.to_string(), txt);
        self.blobs.lock().unwrap().insert(
            dir_url.to_string(),
            serde_json::to_vec(&directory).expect("directory serializes"),
        );
    }

    /// Republish a key while readers keep being served the PREVIOUS packet.
    ///
    /// The answer a fake that models published/absent/unreachable leaves out, and the
    /// dangerous one: a stale resolve SUCCEEDS. A browser reading through the public relays
    /// is served the old pointer for minutes after a republish, and a first-responder read
    /// can stay stale indefinitely — which is the shape behind the cross-device settings
    /// wipe, where a pre-reset value was served long after the reset.
    ///
    /// The new blob lands immediately, because only the POINTER lags: Sia is
    /// content-addressed, so the object exists the moment it is uploaded. That asymmetry is
    /// exactly what the keep-2 grace generation is for — a reader holding the old pointer
    /// must still find the object it names.
    pub fn republish_lagging(
        self: &Arc<Self>,
        did: &str,
        dir_url: &str,
        directory: serde_json::Value,
    ) {
        let mut txt = pin_pkarr::chunk_txt(crate::identity::DIR_PREFIX, dir_url);
        txt.extend(pin_pkarr::chunk_txt(crate::identity::IROH_PREFIX, ""));
        self.pending.lock().unwrap().insert(did.to_string(), txt);
        self.blobs.lock().unwrap().insert(
            dir_url.to_string(),
            serde_json::to_vec(&directory).expect("directory serializes"),
        );
    }

    /// Let the store catch up: what was published is now what is served.
    pub fn propagate(self: &Arc<Self>, did: &str) {
        if let Some(txt) = self.pending.lock().unwrap().remove(did) {
            self.packets.lock().unwrap().insert(did.to_string(), txt);
        }
    }

    /// Take this key off the air without unpublishing it — the network cannot answer.
    pub fn make_unreachable(self: &Arc<Self>, did: &str) {
        self.unreachable.lock().unwrap().push(did.to_string());
    }

    /// Drop the blob a packet still points at. A pointer outliving its object is a real
    /// state (grace deletion), and it reads as a failed read rather than an empty one.
    pub fn drop_blob(self: &Arc<Self>, url: &str) {
        self.blobs.lock().unwrap().remove(url);
    }
}

/// One identity's view of the world. Cloned per identity; they all share the `World`.
#[derive(Clone)]
pub struct FakeNetwork {
    world: Arc<World>,
}

impl FakeNetwork {
    pub fn new(world: &Arc<World>) -> Self {
        Self {
            world: world.clone(),
        }
    }
}

impl crate::net::Network for FakeNetwork {
    async fn resolve(&self, did: &str) -> Result<Vec<TxtRecord>, String> {
        if self
            .world
            .unreachable
            .lock()
            .unwrap()
            .iter()
            .any(|d| d == did)
        {
            return Err(format!("{did}: unreachable"));
        }
        self.world
            .packets
            .lock()
            .unwrap()
            .get(did)
            .cloned()
            .ok_or_else(|| format!("{did}: no packet"))
    }

    async fn download(&self, url: &str) -> Result<Vec<u8>, String> {
        self.world
            .blobs
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| format!("{url}: object not found"))
    }
}

/// One identity in a scenario: a real in-memory doc, a real author, and a view of the
/// shared world.
///
/// The doc is genuine iroh-docs — `Docs::memory()` over a `Minimal` endpoint, which binds
/// nothing off the machine and joins no relay. So records are written and read by the
/// crate's own helpers against the real store, and only the network is substituted.
pub struct Identity {
    pub did: String,
    pub doc: iroh_docs::api::Doc,
    pub blobs: iroh_blobs::api::Store,
    pub author_id: iroh_docs::AuthorId,
    pub app_key: [u8; 32],
    pub net: FakeNetwork,
    /// Channel docs are opened through this to publish a tally, the same as in production.
    pub docs: iroh_docs::api::DocsApi,
    // Held so the router and endpoint outlive the doc.
    _endpoint: iroh::Endpoint,
}

impl Identity {
    /// Stand one up. `seed` decides the app key, so the same seed is the same identity.
    pub async fn new(world: &Arc<World>, seed: u8) -> Self {
        use iroh_blobs::store::mem::MemStore;
        use iroh_docs::{protocol::Docs, Author, NamespaceSecret};
        use iroh_gossip::net::Gossip;

        let app_key = [seed; 32];
        let ns_seed = pin_derive::hkdf32(&app_key, pin_derive::NS_INFO);
        let author_seed = pin_derive::hkdf32(&app_key, pin_derive::AUTHOR_INFO);

        let endpoint = iroh::Endpoint::bind(iroh::endpoint::presets::Minimal)
            .await
            .expect("bind");
        let blobs = MemStore::default();
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .expect("docs");

        let author = Author::from_bytes(&author_seed);
        let author_id = author.id();
        docs.api().author_import(author).await.expect("author");
        let doc = docs
            .api()
            .import_namespace(iroh_docs::Capability::Write(NamespaceSecret::from_bytes(
                &ns_seed,
            )))
            .await
            .expect("namespace");

        let did = format!(
            "did:dht:{}",
            pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(&app_key)).expect("did")
        );

        Self {
            did,
            doc,
            blobs: (*blobs).clone(),
            author_id,
            app_key,
            net: FakeNetwork::new(world),
            docs: docs.api().clone(),
            _endpoint: endpoint,
        }
    }

    /// This channel's K, derived from the seed so the same identity is the same channel.
    fn channel_key(&self) -> [u8; 32] {
        pin_derive::hkdf32(&self.app_key, b"pin:testnet-channel:v1")
    }

    /// Seed this identity's settings — the record the frontend writes and every loop
    /// reads. Sealed with the real settings key, so `read_settings` opens it exactly as
    /// it opens the app's own.
    ///
    /// A scenario's whole graph is built from these: `handle_follows` is what `edges_of`
    /// walks, so who-follows-whom needs no channels, no posts and no publishing gesture.
    /// That is the "intent in, state out" boundary — write the intent, let the loops do
    /// the rest.
    pub async fn set_settings(&self, settings: serde_json::Value) {
        let key = crate::settings_key(&self.app_key);
        let blob = pin_crypto::encrypt_settings(
            &key,
            &serde_json::to_vec(&settings).expect("settings serialize"),
        )
        .expect("seal settings");
        crate::write_record(
            &self.doc,
            self.author_id,
            crate::SETTINGS_COLLECTION,
            crate::SETTINGS_RKEY,
            blob.into_bytes(),
        )
        .await
        .expect("write settings");
    }

    /// Follow these identities wholesale, which is the edge `edges_of` walks.
    pub async fn follows(&self, dids: &[&str]) {
        self.set_settings(serde_json::json!({ "handleFollows": dids }))
            .await;
    }

    /// Follow these identities wholesale AND publish one post.
    ///
    /// The post is a subject beyond the identity itself, which is what a scenario about
    /// endorsements on posts needs something to count against.
    pub async fn follows_and_publishes(&self, dids: &[&str]) {
        self.publishing(serde_json::json!({ "handleFollows": dids }))
            .await;
    }

    /// Follow one CHANNEL of somebody, AND publish one post.
    ///
    /// A different edge from the one above: a `FollowEdge` names a channel and carries its
    /// author's did, where a handle-follow names the person. Both are public, both are what
    /// `graph_actors` reads — which is the claim worth having a scenario for, since
    /// following a channel is the ordinary way to end up with somebody in your graph and it
    /// is not obvious that the PERSON is what gets crawled.
    pub async fn follows_channel_and_publishes(&self, did: &str, channel_id: &str) {
        self.publishing(serde_json::json!({
            "follows": [{
                "didDht": did,
                "channelID": channel_id,
                "name": "Their channel",
            }],
        }))
        .await;
    }

    /// Endorse every one of this identity's own posts, as the app does when publishing
    /// auto-pins what it just wrote.
    ///
    /// This is what gives a subject a record in the log — written on the first pass, which
    /// marks it touched — so without it a pass folds nothing however much has been
    /// published, and a test about what folding costs would pass by doing none of it.
    pub async fn endorses_own_posts(&self, posts: usize) {
        let channel_id = pin_crypto::channel_id(&self.channel_key());
        for i in 0..posts {
            let subject = pin_crypto::engagement_subject(
                &channel_id,
                &format!("2026-09-12T00:00:{i:02}.000Z"),
            );
            // Really signed, with this identity's own key. A hand-built record with a
            // plausible-looking signature is discarded as a forgery before it reaches the
            // log, so a fake one would leave the fold with nothing and a test about folding
            // measuring none of it.
            let record = pin_engagement::Endorsement::sign(
                &pin_derive::did_dht_seed(&self.app_key),
                "pin",
                &subject,
                "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "2026-09-12T00:00:00.000Z",
                None,
            )
            .expect("sign");
            crate::write_record(
                &self.doc,
                self.author_id,
                pin_derive::ENDORSE_COLLECTION,
                &pin_derive::endorse_rkey("pin", &subject),
                serde_json::to_vec(&record).expect("encode"),
            )
            .await
            .expect("endorse");
        }
    }

    /// Follow nobody, and publish a channel holding `posts` items.
    ///
    /// The item count decides how many SUBJECTS this identity owns, and a pass re-folds one
    /// per subject — so this is the lever for a test about what a pass costs as an author's
    /// back catalogue grows rather than as any one post gets popular.
    pub async fn publishes_posts(&self, posts: usize) {
        self.publishing_n(
            serde_json::json!({ "follows": [], "handleFollows": [] }),
            posts,
        )
        .await;
    }

    /// Whatever graph these settings describe, plus a channel with one post in it.
    async fn publishing(&self, settings: serde_json::Value) {
        self.publishing_n(settings, 1).await;
    }

    /// The same, with the post count as a lever.
    async fn publishing_n(&self, mut settings: serde_json::Value, posts: usize) {
        let k = self.channel_key();
        let channel_id = pin_crypto::channel_id(&k);
        settings["myChannels"] = serde_json::json!([{
            "channelID": channel_id,
            "channelKey": pin_crypto::channel_key_to_base64(&k),
            "name": "A channel",
            "visibility": "public",
        }]);
        self.set_settings(settings).await;

        // Where the commit that publishes a channel puts its manifest, sealed as its author
        // seals it, so `own_subjects` opens it exactly as it opens the app's own.
        let manifest = serde_json::json!({
            "version": 1,
            "name": "A channel",
            "description": "",
            "authorPubkey": "ed25519:testnet",
            "publishedAt": "2026-09-12T00:00:00.000Z",
            "items": (0..posts)
                .map(|i| {
                    serde_json::json!({
                        "id": format!("item-{i}"),
                        "itemURL": format!("sia://item-{i}"),
                        "type": "text",
                        "title": "",
                        // Distinct, because the engagement subject is f(channelID,
                        // publishedAt) and two items sharing a stamp would be one subject.
                        "publishedAt": format!("2026-09-12T00:00:{i:02}.000Z"),
                        "mimeType": "text/markdown",
                        "byteSize": 32,
                    })
                })
                .collect::<Vec<_>>(),
        });
        let sealed = pin_channel::seal(
            &pin_channel::author_sealing(&self.app_key, &k),
            &serde_json::to_vec(&manifest).expect("serialize"),
        )
        .expect("seal manifest");
        crate::write_record(
            &self.doc,
            self.author_id,
            "channel",
            &channel_id,
            sealed.into_bytes(),
        )
        .await
        .expect("write manifest");
    }

    /// This identity's engagement context, as the loop builds one.
    ///
    /// `sia` is a DISCONNECTED session, which is what makes an engagement pass runnable
    /// here at all. Every op on one returns "Sia is not connected" rather than panicking,
    /// and the pass's two READS already go through `net` — so the crawl half runs for real
    /// and only the publishing half declines, which is the half a fake network has nothing
    /// to say about anyway.
    pub fn engagement_ctx(&self) -> crate::EngagementContext<FakeNetwork> {
        crate::EngagementContext {
            comment_policy: Default::default(),
            doc: self.doc.clone(),
            blobs: self.blobs.clone(),
            author_id: self.author_id,
            docs: self.docs.clone(),
            sia: std::sync::Arc::new(pin_sia::Session::new()),
            net: self.net.clone(),
            app_key: self.app_key,
            inbox: pin_rpc::new_inbox(),
        }
    }

    /// This identity's context for the publishing loop, as the shells build one.
    ///
    /// `sia` is DISCONNECTED, same as `engagement_ctx`, and here that is more than a
    /// convenience: it means a pass can never reach the network, so what a scenario using
    /// this observes is purely the loop's own scheduling. Every reachable pass fails or
    /// reports nothing to advertise, which is exactly the cheap, repeatable pass a test of
    /// the WAIT wants either side of it.
    ///
    /// The namespace id is re-derived rather than plumbed, so it matches what the engine
    /// would have handed over for this app key.
    pub fn identity_ctx(&self) -> crate::IdentityContext {
        let ns_seed = pin_derive::hkdf32(&self.app_key, pin_derive::NS_INFO);
        let ns = iroh_docs::NamespaceSecret::from_bytes(&ns_seed);
        crate::IdentityContext {
            doc: self.doc.clone(),
            blobs: self.blobs.clone(),
            author_id: self.author_id,
            sia: std::sync::Arc::new(pin_sia::Session::new()),
            app_key: self.app_key,
            namespace_id: ns.id().to_string(),
        }
    }

    /// What this identity's crawl currently holds about `did`, if anything.
    pub async fn held(&self, did: &str) -> Option<crate::DirectoryRecord> {
        let raw = crate::read_record(
            &self.doc,
            &self.blobs,
            self.author_id,
            pin_derive::DIRECTORY_COLLECTION,
            did,
        )
        .await
        .expect("read directory record")?;
        serde_json::from_slice(&raw).ok()
    }

    /// Record somebody the way HOP ONE does — the free half, where the engagement crawl
    /// is already resolving a graph actor's packet and downloading their directory, so
    /// recording it is a parse rather than a fetch.
    ///
    /// Calls the crate's own `parse_directory` and `record_directory`, so this is the
    /// shipped path with the loop's other work left out, never a second implementation
    /// of what a record is.
    pub async fn hop_one(&self, did: &str) {
        let resolved = crate::discover::resolve_directory(&self.net, did)
            .await
            .expect("resolves");
        let raw = crate::net::Network::download(&self.net, &resolved.url)
            .await
            .expect("directory downloads");
        let blob: serde_json::Value = serde_json::from_slice(&raw).expect("directory parses");
        let record = crate::discover::parse_directory(
            &blob,
            &resolved.txt,
            &resolved.url,
            "2026-09-12T00:00:00.000Z",
        );
        crate::discover::record_directory(&self.doc, &self.blobs, self.author_id, did, record)
            .await;
    }

    /// Record somebody as if they had been read at `seen_iso`.
    ///
    /// The only way to test what happens to a record OVER TIME. Decay fires seven days
    /// after a record was last seen, so on a real network every tier rule is a week of
    /// waiting away — and it also needs the record ranked past `MAX_FULL`, which on a real
    /// network means five hundred real identities. Both are a loop counter here.
    pub async fn hold_at(&self, did: &str, directory: serde_json::Value, seen_iso: &str) {
        let txt = pin_pkarr::chunk_txt(crate::identity::DIR_PREFIX, "sia://seeded");
        let record = crate::discover::parse_directory(&directory, &txt, "sia://seeded", seen_iso);
        crate::discover::record_directory(&self.doc, &self.blobs, self.author_id, did, record)
            .await;
    }

    /// This identity's discovery context, as the loop builds one.
    pub fn discover_ctx(&self) -> crate::DiscoverContext<FakeNetwork> {
        crate::DiscoverContext {
            doc: self.doc.clone(),
            blobs: self.blobs.clone(),
            author_id: self.author_id,
            net: self.net.clone(),
            app_key: self.app_key,
        }
    }
}

#[cfg(test)]
mod probe {
    use super::*;

    /// The load-bearing unknown: a real doc, in a test, in this crate. Everything a
    /// scenario does is built on it.
    #[tokio::test]
    async fn an_identity_keeps_a_doc_it_can_read_back() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;

        crate::write_record(&me.doc, me.author_id, "probe", "x", b"hello".to_vec())
            .await
            .expect("write");
        let got = crate::read_record(&me.doc, &me.blobs, me.author_id, "probe", "x")
            .await
            .expect("read");

        assert_eq!(got.as_deref(), Some(&b"hello"[..]));
        assert!(me.did.starts_with("did:dht:"));
    }

    /// Two identities are genuinely separate: one's records are not the other's.
    #[tokio::test]
    async fn two_identities_do_not_share_a_doc() {
        let world = World::new();
        let a = Identity::new(&world, 1).await;
        let b = Identity::new(&world, 2).await;

        crate::write_record(&a.doc, a.author_id, "probe", "x", b"mine".to_vec())
            .await
            .expect("write");

        assert_ne!(a.did, b.did);
        assert_eq!(
            crate::read_record(&b.doc, &b.blobs, b.author_id, "probe", "x")
                .await
                .expect("read"),
            None,
        );
    }
}

/// What a loop does BETWEEN passes.
///
/// Every other test in this crate calls a `*_once` and asserts on what came back, which
/// leaves the `run_*_loop` wrappers — the race between a doc wake and the cadence, the
/// settle, the dropped stream — with no coverage at all. That is the whole of what a wake
/// IS, and the identity loop's is the one that can spin: its pass writes publish state on
/// every turn, changed or not, so a wake condition that is too broad republishes to the
/// DHT as fast as the doc can report it.
///
/// A loop returns `!`, so it is driven rather than awaited: `select!` puts it and a driver
/// on one task, the driver watches the reported passes and writes to the doc, and whichever
/// finishes first ends the test. No spawn, so nothing here needs `Send` — a browser's
/// futures are not `Send` either, and this is the same code.
///
/// The cadences are set far longer than any test window, so a SECOND pass can only ever
/// have come from a wake. `settled()` is false for every pass reachable offline (nothing
/// is published, so nothing is dialable), which means these exercise the retry branch of
/// the wait; the race, the settle and the filter are the same on both branches, and only
/// the duration differs.
#[cfg(test)]
mod loops {
    use super::*;
    use std::time::Duration;

    /// Long enough that no timer in these tests can fire.
    const NEVER: Duration = Duration::from_secs(600);
    /// Short enough not to pad the suite; it only has to be non-zero to be exercised.
    const SETTLE: Duration = Duration::from_millis(10);

    /// Run the identity loop until `drive` says it is done, and give back what it reported.
    ///
    /// `drive` gets the count of passes so far, so it can wait for one without the test
    /// reaching into how reporting works.
    async fn driving<F, Fut>(me: &Identity, drive: F) -> Vec<Result<crate::IdentityOutcome, String>>
    where
        F: FnOnce(Arc<Mutex<Vec<Result<crate::IdentityOutcome, String>>>>) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let passes = Arc::new(Mutex::new(Vec::new()));
        let recorder = passes.clone();
        let spinning = crate::run_identity_loop(
            me.identity_ctx(),
            NEVER,
            NEVER,
            SETTLE,
            || "2026-09-17T00:00:00.000Z".to_string(),
            || 1_789_000_000,
            move |outcome| recorder.lock().unwrap().push(outcome),
        );
        tokio::select! {
            _ = spinning => unreachable!("the loop never returns"),
            () = drive(passes.clone()) => {}
        }
        let held = passes.lock().unwrap();
        held.clone()
    }

    /// Wait for at least `n` passes, or give up after `within`.
    async fn passes_reach(
        passes: &Arc<Mutex<Vec<Result<crate::IdentityOutcome, String>>>>,
        n: usize,
        within: Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        while tokio::time::Instant::now() < deadline {
            if passes.lock().unwrap().len() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        passes.lock().unwrap().len() >= n
    }

    #[tokio::test]
    async fn a_write_to_the_directory_sources_wakes_a_second_pass() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let doc = me.doc.clone();
        let author = me.author_id;

        let reported = driving(&me, |passes| async move {
            assert!(
                passes_reach(&passes, 1, Duration::from_secs(5)).await,
                "the loop publishes once before it ever waits",
            );

            // Following somebody is a settings write. The cadence is ten minutes away, so
            // a second pass can only have come from the doc.
            crate::write_record(
                &doc,
                author,
                crate::SETTINGS_COLLECTION,
                "self",
                b"x".to_vec(),
            )
            .await
            .expect("write settings");

            assert!(
                passes_reach(&passes, 2, Duration::from_secs(5)).await,
                "a settings write wakes the publisher rather than waiting out the cadence",
            );
        })
        .await;

        assert!(reported.len() >= 2, "two passes were reported");
    }

    /// The spin guard, and the half that makes it mean anything is the END.
    ///
    /// "No second pass" is satisfied just as well by a loop that died, so this writes
    /// publish state, insists nothing happened, and THEN writes settings to prove the loop
    /// was listening the whole time. Without that, the test passes for the one reason it
    /// is meant to rule out.
    #[tokio::test]
    async fn publish_state_does_not_wake_it_and_the_loop_is_still_listening() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let doc = me.doc.clone();
        let author = me.author_id;

        driving(&me, |passes| async move {
            assert!(
                passes_reach(&passes, 1, Duration::from_secs(5)).await,
                "the loop publishes once before it ever waits",
            );

            // What the pass itself writes, every turn, because the publish is the
            // keep-alive. A loop woken by this is a loop woken by its own output.
            crate::write_record(
                &doc,
                author,
                pin_derive::PUBLISHED_COLLECTION,
                "directory",
                b"x".to_vec(),
            )
            .await
            .expect("write publish state");

            assert!(
                !passes_reach(&passes, 2, Duration::from_millis(300)).await,
                "publishing is not its own trigger",
            );

            // And the loop is alive and still watching, so the silence above was a filter
            // rather than a corpse.
            crate::write_record(
                &doc,
                author,
                crate::SETTINGS_COLLECTION,
                "self",
                b"x".to_vec(),
            )
            .await
            .expect("write settings");

            assert!(
                passes_reach(&passes, 2, Duration::from_secs(5)).await,
                "the stream was still being read",
            );
        })
        .await;
    }

    /// What a BURST costs, measured rather than assumed — and it is not what `settle`'s
    /// name suggests.
    ///
    /// The wait consumes ONE event and then settles, so the writes that landed behind it
    /// are still queued and the next wait returns on them immediately. Four writes are
    /// four wakes, and the settle only decides how long after the first one the pass runs.
    /// It buys the pass a fuller view of the burst; it does not coalesce anything.
    ///
    /// So what bounds the cost of a burst is NOT this: it is the fingerprint inside
    /// `publish_identity_once`, which re-uploads the directory blob only when its content
    /// moved. A redundant pass still republishes the pkarr packet, because that publish IS
    /// the keep-alive and is unconditional — so N writes are N signed DHT packets. Bounded
    /// by what a person actually did, so it is not a spin, and that is the whole of why it
    /// is acceptable rather than fixed.
    ///
    /// Pinned because it was ASSERTED the other way in this loop's own doc comment before
    /// anything ran it. If a drain ever lands ahead of the settle this test is what says
    /// the behaviour changed on purpose.
    #[tokio::test]
    async fn a_burst_costs_a_pass_per_write_and_the_settle_does_not_coalesce() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let doc = me.doc.clone();
        let author = me.author_id;

        let reported = driving(&me, |passes| async move {
            assert!(
                passes_reach(&passes, 1, Duration::from_secs(5)).await,
                "the loop publishes once before it ever waits",
            );

            for i in 0..4u8 {
                crate::write_record(&doc, author, crate::SETTINGS_COLLECTION, "self", vec![i])
                    .await
                    .expect("write settings");
            }

            // Five: the first pass plus one per write. Waiting well past the settle, so
            // this is where the count lands rather than where it happens to be caught.
            assert!(
                passes_reach(&passes, 5, Duration::from_secs(5)).await,
                "each queued write is its own wake",
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        })
        .await;

        assert_eq!(
            reported.len(),
            5,
            "four writes cost four passes beyond the first, and no more",
        );
    }
    /// Run the engagement loop until `drive` says it is done.
    ///
    /// Its cadence is the one a doc wake is meant to replace: before the wake existed, the
    /// only reason to run every 30 seconds was to notice a gesture of this identity's own,
    /// which the frontend writes straight into the doc. So `NEVER` here is not merely a
    /// long timer — it is the whole point, since a second pass under it can have come from
    /// nothing but the stream.
    async fn driving_engagement<F, Fut>(
        me: &Identity,
        drive: F,
    ) -> Vec<Result<crate::EngagementOutcome, String>>
    where
        F: FnOnce(Arc<Mutex<Vec<Result<crate::EngagementOutcome, String>>>>) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let passes = Arc::new(Mutex::new(Vec::new()));
        let recorder = passes.clone();
        let spinning = crate::run_engagement_loop(
            me.engagement_ctx(),
            me.did.clone(),
            NEVER,
            20,
            || "2026-09-26T00:00:00.000Z".to_string(),
            move |outcome| recorder.lock().unwrap().push(outcome),
        );
        tokio::select! {
            _ = spinning => unreachable!("the loop never returns"),
            () = drive(passes.clone()) => {}
        }
        let held = passes.lock().unwrap();
        held.clone()
    }

    /// Wait for at least `n` engagement passes, or give up after `within`.
    async fn folds_reach(
        passes: &Arc<Mutex<Vec<Result<crate::EngagementOutcome, String>>>>,
        n: usize,
        within: Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        while tokio::time::Instant::now() < deadline {
            if passes.lock().unwrap().len() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        passes.lock().unwrap().len() >= n
    }

    #[tokio::test]
    async fn a_gesture_wakes_the_fold_rather_than_waiting_out_the_cadence() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let doc = me.doc.clone();
        let author = me.author_id;

        let reported = driving_engagement(&me, |passes| async move {
            assert!(
                folds_reach(&passes, 1, Duration::from_secs(5)).await,
                "the loop folds once before it ever waits",
            );

            // Liking something is a frontend write into this doc. The cadence is ten
            // minutes away and no knock is coming, so a second pass can only have come
            // from the stream.
            crate::write_record(
                &doc,
                author,
                pin_derive::ENDORSE_COLLECTION,
                "like:abc",
                b"x".to_vec(),
            )
            .await
            .expect("write endorsement");

            assert!(
                folds_reach(&passes, 2, Duration::from_secs(5)).await,
                "an endorsement wakes the fold",
            );
        })
        .await;

        assert!(reported.len() >= 2, "two passes were reported");
    }

    /// A WAKE FOLDS AND DOES NOT CRAWL, which is the property the knock already has and
    /// the one a local write could quietly take away.
    ///
    /// The tick a wake does not advance is what spaces the crawl out, so a pass that both
    /// woke early and crawled would let whatever does the waking set the schedule on which
    /// this identity resolves and downloads every directory in its graph. Somebody else's
    /// knocks are the sharp version; fifty likes of your own in a row is the same shape.
    ///
    /// Observable because the identity has a graph actor AND a post: a crawling pass reaches
    /// two where a folding one reaches one, and the difference is exactly the actor whose
    /// directory was resolved.
    #[tokio::test]
    async fn a_woken_pass_folds_without_crawling() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let them = Identity::new(&world, 2).await;
        world.publish(
            &them.did,
            "sia://them-dir",
            serde_json::json!({
                "profile": { "$type": "dev.sia.pin.profile", "username": "them" },
                "channels": [],
                "handleFollows": [],
            }),
        );
        me.follows_and_publishes(&[&them.did]).await;
        let doc = me.doc.clone();
        let author = me.author_id;

        let reported = driving_engagement(&me, |passes| async move {
            assert!(
                folds_reach(&passes, 1, Duration::from_secs(5)).await,
                "the first pass crawls, so a fresh start learns what it missed",
            );

            crate::write_record(
                &doc,
                author,
                pin_derive::ENDORSE_COLLECTION,
                "like:abc",
                b"x".to_vec(),
            )
            .await
            .expect("write endorsement");

            assert!(
                folds_reach(&passes, 2, Duration::from_secs(5)).await,
                "the endorsement woke a second pass",
            );
        })
        .await;

        let reached = |i: usize| reported[i].as_ref().expect("a pass ran").reached;
        // Two on a crawling pass: this identity, whose own endorsements are read locally
        // and cost no network, plus the actor whose directory was resolved and downloaded.
        // One on a folding pass — a fold always reads its own, which is why the difference
        // between the two numbers is the crawl and not the fold.
        assert_eq!(reached(0), 2, "the first pass read the graph");
        assert_eq!(reached(1), 1, "the woken pass read only its own");
    }

    /// The spin guard, with the liveness half that makes it mean anything.
    ///
    /// "No second pass" is satisfied just as well by a loop that died, so this writes the
    /// log the pass itself writes, insists nothing happened, and THEN writes an
    /// endorsement to prove the stream was being read the whole time.
    #[tokio::test]
    async fn its_own_log_does_not_wake_it_and_the_loop_is_still_listening() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let doc = me.doc.clone();
        let author = me.author_id;

        driving_engagement(&me, |passes| async move {
            assert!(
                folds_reach(&passes, 1, Duration::from_secs(5)).await,
                "the loop folds once before it ever waits",
            );

            // What a pass writes when it accepts a record. Gated on substance, so waking
            // on it would settle rather than spin — which is why nothing would go wrong
            // loudly and why this is worth pinning.
            crate::write_record(
                &doc,
                author,
                pin_derive::ENGAGEMENT_LOG_COLLECTION,
                "like:abc:did:dht:x",
                b"x".to_vec(),
            )
            .await
            .expect("write log");

            assert!(
                !folds_reach(&passes, 2, Duration::from_millis(300)).await,
                "the fold is not woken by its own output",
            );

            crate::write_record(
                &doc,
                author,
                pin_derive::ENDORSE_COLLECTION,
                "like:abc",
                b"x".to_vec(),
            )
            .await
            .expect("write endorsement");

            assert!(
                folds_reach(&passes, 2, Duration::from_secs(5)).await,
                "the stream was still being read",
            );
        })
        .await;
    }
}

/// Scenarios: who becomes visible to whom, and when.
///
/// Each of these runs the SHIPPED pass over real docs. The only substitution is the two
/// reads in `net::Network`, so what is under test is the crawl itself rather than a second
/// model of it.
#[cfg(test)]
mod visibility {
    use super::*;

    /// A directory as an identity publishes one.
    fn directory(name: &str, follows: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "profile": { "$type": "dev.sia.pin.profile", "username": name },
            "channels": [],
            "handleFollows": follows,
        })
    }

    /// The subject of the one post `follows_and_publishes` writes.
    ///
    /// Spelled the way `own_subjects` spells it, from the same channel key and the same
    /// `publishedAt` the harness puts in the manifest — a second spelling here would be a
    /// test agreeing with itself.
    fn own_post_subject(who: &Identity) -> String {
        pin_crypto::engagement_subject(
            &pin_crypto::channel_id(&who.channel_key()),
            "2026-09-12T00:00:00.000Z",
        )
    }

    /// Run one discovery pass and return what it did.
    async fn pass(who: &Identity) -> crate::DiscoverOutcome {
        crate::discover_once(
            &who.discover_ctx(),
            &who.did,
            "2026-09-12T00:00:00.000Z".to_string(),
            1_789_000_000,
            "",
        )
        .await
        .expect("pass")
        .0
    }

    /// THE scenario: john follows alice, alice follows carol, and carol is a stranger.
    ///
    /// Nobody has to hand john anything. Alice's published record names carol, the frontier
    /// is derived from that edge, and one pass later john holds somebody he was never told
    /// about — which is the whole claim the crawl makes.
    #[tokio::test]
    async fn a_stranger_two_hops_out_becomes_visible() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did]),
        );
        world.publish(&carol.did, "sia://carol-dir", directory("carol", &[]));
        john.follows(&[&alice.did]).await;

        // Alice is john's own graph, so the engagement crawl owns her — discovery must
        // leave her alone, and with nothing else known the frontier is empty.
        let first = pass(&john).await;
        assert_eq!(first.resolved, 0, "discovery must not read its own graph");
        assert!(john.held(&alice.did).await.is_none());

        // Hop one, as the engagement crawl records it out of a read it was making anyway.
        john.hop_one(&alice.did).await;

        // Now alice's edge is held, so carol is on the frontier and one pass reaches her.
        let second = pass(&john).await;
        assert_eq!(second.resolved, 1, "carol is read");
        let held = john.held(&carol.did).await.expect("carol is held");
        assert_eq!(
            held.profile
                .as_ref()
                .and_then(|p| p.get("username"))
                .and_then(|u| u.as_str()),
            Some("carol"),
            "and john knows who she is",
        );
    }

    /// Run one ENGAGEMENT pass, crawling, and return what it did.
    ///
    /// The pass that reads the graph — and, as a byproduct, records who it read.
    async fn engagement(who: &Identity) -> crate::EngagementOutcome {
        crate::engagement_once(
            &who.engagement_ctx(),
            &who.did,
            "2026-09-12T00:00:00.000Z".to_string(),
            true,
            false,
        )
        .await
        .expect("engagement pass")
    }

    /// HOP ONE IS FREE, which until now was asserted and never run.
    ///
    /// The engagement crawl already resolves each graph actor's packet and downloads their
    /// directory to read their endorsements. Recording who they are out of those same bytes
    /// is a parse, not a fetch — that is the claim the whole discovery arc is costed on, and
    /// the scenarios below it had to call `hop_one` by hand to get started.
    ///
    /// Sia is not connected here, so the pass CANNOT publish. That is the point: hop one has
    /// to land on the reading half, where a fake network can speak for the real one.
    #[tokio::test]
    async fn the_engagement_crawl_records_who_it_read() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;

        world.publish(&alice.did, "sia://alice-dir", directory("alice", &[]));
        john.follows_and_publishes(&[&alice.did]).await;

        let out = engagement(&john).await;

        // Two: john himself, whose endorsements are read locally and cost no network, and
        // alice, who cost one resolve and one download.
        assert_eq!(out.reached, 2, "alice's directory was read");
        let held = john.held(&alice.did).await.expect("and recorded");
        assert_eq!(
            held.profile
                .as_ref()
                .and_then(|p| p.get("username"))
                .and_then(|u| u.as_str()),
            Some("alice"),
            "out of the bytes the fold downloaded anyway",
        );
        // And not himself. Reading john would spend a resolve and a download to be told,
        // staler, what local state already holds — the same exclusion discovery makes, and
        // the reason this pass skips its own did before the crawl rather than after.
        assert!(
            john.held(&john.did).await.is_none(),
            "the crawl never reads you",
        );
    }

    /// THE WHOLE CHAIN, with nothing handed over: john follows alice, alice follows carol,
    /// and john ends up holding carol.
    ///
    /// Every scenario above starts from a manual `hop_one`, so each proves its own link and
    /// none proves they join. This one calls only the two shipped passes in the order the
    /// Curator runs them, which is the claim a live run is actually trying to check: nobody
    /// tells john about carol, and one round later he knows her.
    #[tokio::test]
    async fn john_reaches_carol_through_alice_with_nobody_telling_him() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did]),
        );
        world.publish(&carol.did, "sia://carol-dir", directory("carol", &[]));
        john.follows_and_publishes(&[&alice.did]).await;

        // Before anything runs, john knows nobody — not even the person he follows.
        assert!(john.held(&alice.did).await.is_none());

        // The engagement pass reads alice, because she is in his graph, and records her.
        engagement(&john).await;
        assert!(
            john.held(&alice.did).await.is_some(),
            "hop one, from the fold's own read",
        );

        // Her record carries the edge to carol, so carol is on the frontier — and the
        // discovery pass, whose whole job is everybody BEYOND the graph, goes and reads her.
        let out = pass(&john).await;

        assert_eq!(out.resolved, 1, "carol is read");
        let held = john.held(&carol.did).await.expect("carol is held");
        assert_eq!(
            held.profile
                .as_ref()
                .and_then(|p| p.get("username"))
                .and_then(|u| u.as_str()),
            Some("carol"),
            "and john knows who she is, having been told by nobody",
        );
    }

    /// FOLLOWING A CHANNEL CRAWLS ITS AUTHOR, which is the whole of what makes a channel
    /// a way into the network rather than a dead end.
    ///
    /// A `FollowEdge` names a channel and carries the author's did, and `graph_actors`
    /// reads that did — so following one of somebody's voices puts the PERSON in your
    /// graph, their whole directory gets read, and every edge in it lands on your frontier.
    /// Not obvious from the gesture: you followed a channel and what you get is its author.
    ///
    /// No priority is involved, and none is needed: a crawling pass reads every actor in
    /// the graph, uncapped and unordered, so a channel's author is read as promptly as
    /// anybody. What competes for a budget is DISCOVERY, and your own graph is excluded
    /// from it by construction.
    #[tokio::test]
    async fn following_a_channel_crawls_its_author() {
        let world = World::new();
        let a = Identity::new(&world, 1).await;
        let b = Identity::new(&world, 2).await;
        let c = Identity::new(&world, 3).await;

        world.publish(&b.did, "sia://b-dir", directory("b", &[&c.did]));
        world.publish(&c.did, "sia://c-dir", directory("c", &[]));

        // One channel of b's — never b themselves.
        a.follows_channel_and_publishes(&b.did, "bchannel00000001")
            .await;

        let folded = engagement(&a).await;
        assert_eq!(folded.reached, 2, "itself and the channel's author");
        assert!(
            a.held(&b.did).await.is_some(),
            "the person behind the channel is what gets a directory record",
        );

        // And because it is the whole directory that was read, the edges in it are on the
        // frontier — so following a channel reaches past its author the same way following
        // a person does.
        let out = pass(&a).await;
        assert_eq!(out.resolved, 1);
        assert!(a.held(&c.did).await.is_some());
    }

    /// A FOLLOWED PERSON NOBODY HAS READ YET DROPS NOTHING FROM THE CACHE.
    ///
    /// Following a person reads their profile feed out of the crawl's record of them, so
    /// until that record exists their channels are missing from the set the pull loop keeps
    /// — for want of a reading, not because they are gone. The loop's cleanup deletes every
    /// cached channel outside that set, and running it then would be deleting by absence.
    /// Once a full record is held the set is complete again, and the same pass drops what
    /// nothing reads.
    ///
    /// Every channel in play here is either unread or in nobody's set, so a pass makes no
    /// network call at all: what is observed is the cleanup's decision alone.
    #[tokio::test]
    async fn an_unread_follow_holds_the_pull_cleanup_until_it_is_read() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        me.follows(&[&alice.did]).await;

        crate::write_record(
            &me.doc,
            me.author_id,
            crate::SUB_COLLECTION,
            "a1",
            b"cached".to_vec(),
        )
        .await
        .expect("seed a cached channel");
        let ctx = crate::PullContext {
            doc: me.doc.clone(),
            blobs: me.blobs.clone(),
            author_id: me.author_id,
            sia: std::sync::Arc::new(pin_sia::Session::new()),
            app_key: me.app_key,
        };
        let cached = || async {
            crate::read_record(
                &me.doc,
                &me.blobs,
                me.author_id,
                crate::SUB_COLLECTION,
                "a1",
            )
            .await
            .expect("read")
            .is_some()
        };

        let out = crate::pull_once(&ctx).await.expect("pass");
        assert_eq!(out.dropped, 0);
        assert!(cached().await, "kept while alice is unread");

        me.hold_at(
            &alice.did,
            directory("alice", &[]),
            "2026-09-12T00:00:00.000Z",
        )
        .await;
        let out = crate::pull_once(&ctx).await.expect("pass");
        assert_eq!(out.dropped, 1);
        assert!(
            !cached().await,
            "dropped once the set is complete and nothing reads it"
        );
    }

    /// BEING FOLLOWED TELLS YOU NOTHING. The graph is directed, and reading it is
    /// something you do from your own end of the arrow.
    ///
    /// `graph_actors` is built entirely out of YOUR settings — who you follow, who you
    /// watch. Nothing anywhere tells you who follows you, and that is not an omission: a
    /// follow lives in the FOLLOWER's directory and nothing writes into the followed
    /// identity's scope, so being followed is knowable only by having read the follower.
    /// It is why a follower count can only ever be a reverse scan of what the crawl
    /// already holds.
    ///
    /// So an identity every arrow points AT holds nothing and reaches nobody, however long
    /// it waits — it has no first record, and the discovery frontier is derived from held
    /// records. This is the shape a chain gets set up in by hand when the middle of it does
    /// the following: b follows a, b follows c, and a is left looking at an empty network.
    #[tokio::test]
    async fn being_followed_is_not_following() {
        let world = World::new();
        let a = Identity::new(&world, 1).await;
        let b = Identity::new(&world, 2).await;
        let c = Identity::new(&world, 3).await;

        // Everybody publishes. Nothing here is unreachable or unpublished — the only
        // thing wrong is which way the arrows run.
        world.publish(&a.did, "sia://a-dir", directory("a", &[]));
        world.publish(&b.did, "sia://b-dir", directory("b", &[&a.did, &c.did]));
        world.publish(&c.did, "sia://c-dir", directory("c", &[]));

        // a published a post, so its engagement pass does run its crawl half — and
        // follows nobody, so there is nobody in it.
        a.follows_and_publishes(&[]).await;
        b.follows_and_publishes(&[&a.did, &c.did]).await;

        let folded = engagement(&a).await;
        assert_eq!(
            folded.reached, 1,
            "itself and nobody else: being followed by b puts b in nobody's graph",
        );
        assert!(a.held(&b.did).await.is_none(), "not even the follower");

        let out = pass(&a).await;
        assert_eq!(out.resolved, 0, "and so the frontier is empty");
        assert!(a.held(&c.did).await.is_none(), "c is unreachable from a");

        // The same network from b's end, which is the end the arrows leave from: one pass
        // and b holds both. Nothing about the network changed — only who is asking.
        engagement(&b).await;
        assert!(b.held(&a.did).await.is_some());
        assert!(b.held(&c.did).await.is_some());
    }

    /// WHAT A PASS SCANS DOES NOT GROW WITH AN AUTHOR'S BACK CATALOGUE.
    ///
    /// `list_rkeys` is `Query::all()` over the whole doc with the prefix stripped in Rust,
    /// so it costs the size of the doc however small the collection. Both per-subject
    /// gathers used to open with one — so a pass paid two WHOLE-DOC SCANS PER TOUCHED
    /// SUBJECT, and `touched` is seeded from every subject in `found`, which includes this
    /// identity's own endorsements. An author's own auto-pin keeps every post they have ever
    /// published in `touched` forever, so the multiplier was the size of the back catalogue
    /// rather than the number of things that moved.
    ///
    /// Asserted as an EQUALITY between two catalogue sizes rather than against a fixed
    /// number, so it locks the property — scans are a function of the pass, not of the
    /// subjects — and survives the pass gaining or losing a scan for unrelated reasons.
    ///
    /// The non-zero check is not decoration. This counter is thread-local and only sees work
    /// that stayed on the test's own thread, and the scenario only folds anything because
    /// `endorses_own_posts` put the subjects in `found` — either could silently make this
    /// a comparison of two zeroes, which is the shape of a cost test that measures nothing.
    #[tokio::test]
    async fn scanning_does_not_scale_with_the_subjects_a_pass_folds() {
        async fn scans_for(posts: usize, seed: u8) -> usize {
            let world = World::new();
            let who = Identity::new(&world, seed).await;
            who.publishes_posts(posts).await;
            who.endorses_own_posts(posts).await;

            let ctx = who.engagement_ctx();
            crate::scans::reset();
            let folded = crate::engagement_once(
                &ctx,
                &who.did,
                "2026-09-12T00:00:00.000Z".to_string(),
                false,
                false,
            )
            .await
            .expect("engagement pass");
            let scanned = crate::scans::taken();

            // `tallies` counts tallies PUBLISHED, and this context's Sia session is
            // deliberately disconnected — so the gate is that every subject was folded and
            // tried, which is the work the scans are being counted for.
            // `tallies` is the per-SUBJECT counter — a tally written into the channel doc,
            // which needs no Sia. (`published`/`publish_failed` are per CHANNEL and would
            // read 1 however many posts there are, which is the wrong gate and was the
            // first one tried.)
            assert_eq!(
                folded.tallies, posts,
                "one tally per post, so every subject was folded and the scans counted                  below are the scans of doing that work",
            );
            assert_eq!(folded.cleared, 0, "and none of them folded to nothing");
            scanned
        }

        let one = scans_for(1, 1).await;
        let five = scans_for(5, 2).await;

        assert!(one > 0, "the counter saw this pass at all");
        assert_eq!(
            one, five,
            "five posts cost the same scans as one — the gathers take the list rather than \
             each taking their own",
        );
    }

    /// A FOLD-ONLY PASS FOLDS WHAT MOVED, AND A CRAWLING PASS FOLDS EVERYTHING HELD.
    ///
    /// `touched` used to be seeded from every subject in `found`, and `found` always holds
    /// this identity's own endorsements — so an author's own auto-pin kept every post they
    /// had ever published in `touched`, and a pass every 30 seconds read every record behind
    /// every one of them to conclude nothing had changed. Now a subject is marked where it
    /// moves, which is what the comment lane already did.
    ///
    /// The crawling half is the self-healing the old seeding gave for free, and the last
    /// step is what it is for: a tally lost from the channel doc is invisible to a pass
    /// that only folds what moved, because nothing moved. A crawling pass puts it back.
    #[tokio::test]
    async fn a_fold_only_pass_folds_what_moved_and_a_crawl_folds_everything() {
        async fn fold(who: &Identity, crawl: bool) -> crate::EngagementOutcome {
            crate::engagement_once(
                &who.engagement_ctx(),
                &who.did,
                "2026-09-12T00:00:00.000Z".to_string(),
                crawl,
                false,
            )
            .await
            .expect("engagement pass")
        }

        let world = World::new();
        let john = Identity::new(&world, 1).await;
        john.publishes_posts(5).await;
        john.endorses_own_posts(5).await;

        let first = fold(&john, false).await;
        assert_eq!(
            first.folded, 5,
            "every post's record is written, so every post moved"
        );
        assert_eq!(first.tallies, 5);

        assert_eq!(
            fold(&john, false).await.folded,
            0,
            "and on the next fold-only pass nothing moved, so nothing is folded — the back              catalogue is no longer re-read every 30 seconds",
        );

        // One new gesture on one post is one subject's worth of work.
        let subject = own_post_subject(&john);
        let like = pin_engagement::Endorsement::sign(
            &pin_derive::did_dht_seed(&john.app_key),
            pin_engagement::KIND_LIKE,
            &subject,
            "version-1",
            "2026-09-12T00:00:02.000Z",
            None,
        )
        .expect("sign");
        crate::write_record(
            &john.doc,
            john.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &pin_derive::endorse_rkey(pin_engagement::KIND_LIKE, &subject),
            serde_json::to_vec(&like).expect("encode"),
        )
        .await
        .expect("write endorsement");
        let liked = fold(&john, false).await;
        assert_eq!(
            liked.folded, 1,
            "the one post that moved, and only that one"
        );
        assert_eq!(liked.tallies, 1, "and its count reaches the channel");

        // Lose one post's published tally, which is what a pass failing between writing a
        // record and folding its subject leaves behind.
        let ctx = john.engagement_ctx();
        let channel_id = pin_crypto::channel_id(&john.channel_key());
        let channel_doc = crate::engagement::open_channel_doc(&ctx, &channel_id)
            .await
            .expect("channel doc");
        channel_doc
            .del(john.author_id, crate::engagement::tally_key(&subject))
            .await
            .expect("drop the tally");

        let blind = fold(&john, false).await;
        assert_eq!(
            (blind.folded, blind.tallies),
            (0, 0),
            "a fold-only pass cannot see it: nothing moved",
        );

        let crawled = fold(&john, true).await;
        assert_eq!(
            crawled.folded, 5,
            "a crawling pass folds every post the log holds"
        );
        assert_eq!(
            crawled.tallies, 1,
            "and republishes only the one that was lost — the gate still holds for the rest",
        );
    }

    /// A GRAPH ACTOR'S WITHDRAWAL KNOCK IS APPLIED ON A FOLD-ONLY PASS.
    ///
    /// Alice is in john's graph and john holds her like from an earlier crawl. She takes it
    /// back, and her Curator knocks the signed withdrawal. The verdict treats a record in
    /// `found` as "read from the actor's own directory this pass" and ignores a withdrawal
    /// that the same pass read contradicted — right on a crawl, where `found` is what was
    /// read. A fold-only pass reads nobody, so nothing it holds contradicts her, and her
    /// withdrawal should land now rather than waiting for the next crawl.
    #[tokio::test]
    async fn a_graph_actors_withdrawal_lands_on_a_fold_only_pass() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        john.follows_and_publishes(&[&alice.did]).await;

        let subject = own_post_subject(&john);
        let like = pin_engagement::Endorsement::sign(
            &pin_derive::did_dht_seed(&alice.app_key),
            pin_engagement::KIND_LIKE,
            &subject,
            "version-1",
            "2026-09-12T00:00:01.000Z",
            None,
        )
        .expect("sign like");
        // Held, as an earlier crawl of her directory would have left it.
        crate::write_record(
            &john.doc,
            john.author_id,
            pin_derive::ENGAGEMENT_LOG_COLLECTION,
            &pin_derive::engagement_log_rkey(&subject, pin_engagement::KIND_LIKE, &alice.did),
            serde_json::to_vec(&like).expect("encode"),
        )
        .await
        .expect("hold like");

        let withdrawal = pin_engagement::Retraction::sign(
            &pin_derive::did_dht_seed(&alice.app_key),
            pin_engagement::KIND_LIKE,
            &subject,
            "2026-09-12T00:00:02.000Z",
        )
        .expect("sign withdrawal");
        let ctx = john.engagement_ctx();
        let handler = pin_rpc::HeyHandler::new(ctx.inbox.clone());
        assert!(handler.accept_knock(&pin_rpc::hey_request(
            &serde_json::to_value(&withdrawal).expect("encode")
        )));

        let folded = crate::engagement_once(
            &ctx,
            &john.did,
            "2026-09-12T00:00:03.000Z".to_string(),
            false,
            false,
        )
        .await
        .expect("engagement pass");

        assert_eq!(
            (folded.retractions_applied, folded.retractions_ignored),
            (1, 0),
            "her withdrawal is applied, not ignored until the next crawl",
        );
    }

    /// WHAT A FOLD-ONLY PASS READS DOES NOT GROW WITH WHAT THE GRAPH HAS ENDORSED.
    ///
    /// A fold reads its counts straight from the log, so the records held for graph actors
    /// have no job on a pass that reads nobody. Asserted as an equality between one held
    /// record and five, with the same non-zero gate as the scan test.
    #[tokio::test]
    async fn a_fold_only_pass_does_not_read_what_the_graph_endorsed() {
        async fn reads_for(actors: usize, seed: u8) -> usize {
            let world = World::new();
            let john = Identity::new(&world, seed).await;
            let dids: Vec<String> = (0..actors).map(|i| format!("did:dht:{i:0>52}")).collect();
            let refs: Vec<&str> = dids.iter().map(String::as_str).collect();
            john.follows_and_publishes(&refs).await;
            let subject = own_post_subject(&john);
            for did in &dids {
                // Only read, never verified here, so a plain record is enough to count.
                let record = serde_json::json!({
                    "kind": "like",
                    "actor": did,
                    "subject": subject,
                    "version": "version-1",
                    "createdAt": "2026-09-12T00:00:01.000Z",
                    "sig": pin_crypto::b64_encode(&[7u8; 64]),
                });
                crate::write_record(
                    &john.doc,
                    john.author_id,
                    pin_derive::ENGAGEMENT_LOG_COLLECTION,
                    &pin_derive::engagement_log_rkey(&subject, "like", did),
                    serde_json::to_vec(&record).expect("encode"),
                )
                .await
                .expect("hold");
            }

            let ctx = john.engagement_ctx();
            crate::reads::reset();
            crate::engagement_once(
                &ctx,
                &john.did,
                "2026-09-12T00:00:02.000Z".to_string(),
                false,
                false,
            )
            .await
            .expect("engagement pass");
            crate::reads::taken()
        }

        let one = reads_for(1, 1).await;
        let five = reads_for(5, 2).await;
        assert!(one > 0, "the counter saw this pass at all");
        assert_eq!(
            one, five,
            "five actors' held records cost a fold-only pass the same reads as one",
        );
    }

    /// A FULL INBOX IS REPORTED, where it used to be silent on both sides.
    ///
    /// A refusal loses nothing: the sender writes no delivery mark and re-knocks on its own
    /// cadence forever, with no attempt cap anywhere. What it costs is one retry period of
    /// delay per refusal — and, until this counted, an instance whose drain could not keep
    /// up with arrivals read exactly like one nobody was knocking. The sender sees a failed
    /// stream, which is also what an offline node looks like; this side recorded nothing.
    ///
    /// Asserted from an identity that has published nothing, which is still one that can be
    /// followed — so it drains, and reports that it turned people away rather than a bare
    /// `not_ours` that says the knocks were somebody else's problem.
    #[tokio::test]
    async fn a_refused_knock_is_counted_rather_than_silent() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        // A settings record and nothing else. Without one the pass errors above the drain and
        // never reaches the count.
        john.follows(&[]).await;
        let ctx = john.engagement_ctx();

        // Through the real handler, so what fills the inbox is what a knock does.
        let handler = pin_rpc::HeyHandler::new(ctx.inbox.clone());
        let frame = pin_rpc::hey_request(&serde_json::json!({ "kind": "like" }));
        for _ in 0..pin_rpc::MAX_INBOX {
            assert!(handler.accept_knock(&frame), "the inbox takes these");
        }
        assert!(
            !handler.accept_knock(&frame),
            "and turns this one away, which is the thing being counted",
        );

        let folded = crate::engagement_once(
            &ctx,
            &john.did,
            "2026-09-12T00:00:00.000Z".to_string(),
            true,
            false,
        )
        .await
        .expect("engagement pass");

        assert_eq!(folded.knocks_refused, 1, "the refusal reaches the outcome");
    }

    /// A FOLLOW OF A CHANNEL IS COUNTED ON THE CHANNEL, one to one.
    ///
    /// A follow names the channel rather than any post in it, and a public channel is a
    /// subject of its own, so the follow folds into that channel's tally exactly as a like
    /// folds into a post's. The author's own follow of their channel counts, which is what
    /// puts them among its followers from the moment it exists; a stranger's arrives by
    /// knock, since nothing about being followed puts the follower in the author's graph.
    #[tokio::test]
    async fn a_knocked_channel_follow_is_counted_beside_the_authors_own() {
        let world = World::new();
        let alice = Identity::new(&world, 1).await;
        let bob = Identity::new(&world, 2).await;
        let channel_id = pin_crypto::channel_id(&alice.channel_key());
        alice.publishing_n(serde_json::json!({}), 1).await;

        let own = pin_engagement::Endorsement::sign_channel_follow(
            &pin_derive::did_dht_seed(&alice.app_key),
            &alice.did,
            &channel_id,
            "2026-09-12T00:00:00.000Z",
        )
        .expect("sign");
        crate::write_record(
            &alice.doc,
            alice.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &pin_derive::endorse_rkey(pin_engagement::KIND_FOLLOW, &channel_id),
            serde_json::to_vec(&own).expect("encode"),
        )
        .await
        .expect("write the author's own follow");

        let ctx = alice.engagement_ctx();
        let bobs = pin_engagement::Endorsement::sign_channel_follow(
            &pin_derive::did_dht_seed(&bob.app_key),
            &alice.did,
            &channel_id,
            "2026-09-12T00:00:01.000Z",
        )
        .expect("sign");
        let handler = pin_rpc::HeyHandler::new(ctx.inbox.clone());
        assert!(handler.accept_knock(&pin_rpc::hey_request(
            &serde_json::to_value(&bobs).expect("encode")
        )));

        let folded = crate::engagement_once(
            &ctx,
            &alice.did,
            "2026-09-12T00:00:02.000Z".to_string(),
            false,
            false,
        )
        .await
        .expect("engagement pass");
        assert_eq!(folded.knocked, 1, "bob's follow is hers to count");

        let channel_doc = crate::engagement::open_channel_doc(&ctx, &channel_id)
            .await
            .expect("channel doc");
        let tally = crate::engagement::read_tally(&ctx, &channel_doc, &channel_id)
            .await
            .expect("the channel has a tally of its own");
        assert_eq!(tally.kinds[pin_engagement::KIND_FOLLOW].count, 2);
    }

    /// A FOLLOW OF A PERSON IS COUNTED ON THE PERSON, and a withdrawal takes it back out.
    ///
    /// The person is a subject of their own — even one who has published nothing — and the
    /// fold files their follows in the person tally, since a person has no channel doc.
    #[tokio::test]
    async fn a_knocked_person_follow_is_counted_and_withdrawn() {
        let world = World::new();
        let alice = Identity::new(&world, 1).await;
        let bob = Identity::new(&world, 2).await;
        alice.follows(&[]).await;
        let bob_seed = pin_derive::did_dht_seed(&bob.app_key);

        let ctx = alice.engagement_ctx();
        let handler = pin_rpc::HeyHandler::new(ctx.inbox.clone());
        let pass = |at: &'static str| {
            let ctx = &ctx;
            let did = alice.did.clone();
            async move {
                crate::engagement_once(ctx, &did, at.to_string(), false, false)
                    .await
                    .expect("engagement pass")
            }
        };

        let follow = pin_engagement::Endorsement::sign_person_follow(
            &bob_seed,
            &alice.did,
            "2026-09-12T00:00:01.000Z",
        )
        .expect("sign");
        assert!(handler.accept_knock(&pin_rpc::hey_request(
            &serde_json::to_value(&follow).expect("encode")
        )));
        assert_eq!(pass("2026-09-12T00:00:02.000Z").await.knocked, 1);
        let tally = crate::engagement::read_person_tally(&alice.doc, &alice.blobs, alice.author_id)
            .await
            .expect("a person tally");
        assert_eq!(tally.kinds[pin_engagement::KIND_FOLLOW].count, 1);
        assert_eq!(
            tally.kinds[pin_engagement::KIND_FOLLOW].sample_actors,
            vec![bob.did.clone()]
        );

        let unfollow = pin_engagement::Retraction::sign(
            &bob_seed,
            pin_engagement::KIND_FOLLOW,
            &alice.did,
            "2026-09-12T00:00:03.000Z",
        )
        .expect("sign");
        assert!(handler.accept_knock(&pin_rpc::hey_request(
            &serde_json::to_value(&unfollow).expect("encode")
        )));
        assert_eq!(
            pass("2026-09-12T00:00:04.000Z").await.retractions_applied,
            1
        );
        assert!(
            crate::engagement::read_person_tally(&alice.doc, &alice.blobs, alice.author_id)
                .await
                .is_none(),
            "nobody follows her now, so there is no tally rather than a zero"
        );
    }

    /// AN IDENTITY THAT HAS PUBLISHED NOTHING STILL CRAWLS ITS GRAPH.
    ///
    /// It used to return before its crawl, having nothing to fold — so a reader who followed
    /// people and never posted held nobody, permanently, since hop one is this crawl's
    /// byproduct and the discovery frontier is derived from held records. Two things ended
    /// that: following a person reads their profile feed out of their record, and every
    /// identity is a subject of its own, because anyone can follow it. So there is always
    /// something to count, and the pass is the ordinary one.
    #[tokio::test]
    async fn an_identity_that_has_published_nothing_still_crawls_its_graph() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did]),
        );
        world.publish(&carol.did, "sia://carol-dir", directory("carol", &[]));
        john.follows(&[&alice.did]).await;

        let folded = engagement(&john).await;
        assert_eq!(folded.reached, 2, "himself and alice");
        assert!(john.held(&alice.did).await.is_some());

        let out = pass(&john).await;
        assert_eq!(out.resolved, 1);
        assert!(
            john.held(&carol.did).await.is_some(),
            "reached through alice"
        );
    }

    /// A NEW FOLLOW IS READ ON THE NEXT WOKEN PASS, NOT THE NEXT CRAWL.
    ///
    /// Their profile feed is what following them shows, and it is empty until their record
    /// is held — so a fold-only pass woken by this identity's own write reads anybody
    /// followed wholesale who has no record, once. A scheduled fold reads nobody, so an
    /// unreachable newcomer waits for the crawl rather than costing a resolve every pass.
    #[tokio::test]
    async fn a_new_follow_is_read_on_the_next_woken_pass() {
        // Whether or not the identity has posted: both read a newcomer through the crawl's
        // own loop body.
        for lurker in [true, false] {
            let world = World::new();
            let john = Identity::new(&world, 1).await;
            let alice = Identity::new(&world, 2).await;
            world.publish(&alice.did, "sia://alice-dir", directory("alice", &[]));
            if lurker {
                john.follows(&[&alice.did]).await;
            } else {
                john.follows_and_publishes(&[&alice.did]).await;
            }
            let fold = |newcomers| {
                let ctx = john.engagement_ctx();
                let did = john.did.clone();
                async move {
                    crate::engagement_once(
                        &ctx,
                        &did,
                        "2026-09-12T00:00:00.000Z".to_string(),
                        false,
                        newcomers,
                    )
                    .await
                    .expect("engagement pass")
                }
            };

            fold(false).await;
            assert!(
                john.held(&alice.did).await.is_none(),
                "a scheduled fold reads nobody (lurker={lurker})"
            );

            fold(true).await;
            assert!(john.held(&alice.did).await.is_some(), "lurker={lurker}");

            // Held now, so a second wake does not go and look.
            world.make_unreachable(&alice.did);
            assert_eq!(fold(true).await.unreachable, 0, "lurker={lurker}");
        }
    }

    /// A SECOND PASS OVER UNCHANGED STATE PUBLISHES NOTHING.
    ///
    /// The fold stamps `updated_at` with the time it ran, so the bytes it produces differ
    /// on every pass whether a count moved or not. Written ungated, that is an entry per
    /// subject per pass replicated to every subscriber of the channel, on an account
    /// nobody has touched — the shape the cached tally and the cached thread were each
    /// given a gate for, on the entry those two are caches OF.
    ///
    /// The cadence is what makes it worth a test rather than a note: a fold-only pass runs
    /// every 30 seconds, and its whole job is to notice a knock or this identity's own
    /// writes. When there are neither, it should cost nothing.
    #[tokio::test]
    async fn a_second_pass_over_unchanged_state_publishes_no_tally() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        john.follows_and_publishes(&[]).await;

        // John pins his own post, which is what publishing does in the app: the author is
        // pin #1 on their own bytes. One real signed record, so the fold has something to
        // fold and the crawl's `verify` has something to accept.
        let subject = own_post_subject(&john);
        let pin = pin_engagement::Endorsement::sign(
            &pin_derive::did_dht_seed(&john.app_key),
            pin_engagement::KIND_PIN,
            &subject,
            "version-1",
            "2026-09-12T00:00:00.000Z",
            None,
        )
        .expect("sign");
        // Into his OWN doc, which is where the pass reads an identity's own records from.
        // Never over the network, because the published copy lags local edits — so the
        // endorsing-directory helper above is for somebody ELSE's records, not his.
        crate::write_record(
            &john.doc,
            john.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &pin_derive::endorse_rkey(pin_engagement::KIND_PIN, &subject),
            serde_json::to_vec(&pin).expect("encode"),
        )
        .await
        .expect("write endorsement");

        let first = engagement(&john).await;
        assert_eq!(first.tallies, 1, "the count has to land once");

        let second = engagement(&john).await;
        assert_eq!(
            second.tallies, 0,
            "and not again, nothing having endorsed or unendorsed it in between",
        );

        // And a count that MOVES is still published. Without this a gate that skipped
        // whenever anything was already held would pass both assertions above and then
        // silently stop publishing for good.
        let like = pin_engagement::Endorsement::sign(
            &pin_derive::did_dht_seed(&john.app_key),
            pin_engagement::KIND_LIKE,
            &subject,
            "version-1",
            "2026-09-12T00:00:02.000Z",
            None,
        )
        .expect("sign");
        crate::write_record(
            &john.doc,
            john.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &pin_derive::endorse_rkey(pin_engagement::KIND_LIKE, &subject),
            serde_json::to_vec(&like).expect("encode"),
        )
        .await
        .expect("write endorsement");

        assert_eq!(
            engagement(&john).await.tallies,
            1,
            "a new gesture is a new count, and it has to reach the channel",
        );
    }

    /// The conversation beside it, which is the same gate on the entry next door.
    ///
    /// Worth its own scenario rather than trusting the tally's: the two are gated on
    /// different predicates, because a tally has folded its set down to a number and needs
    /// a `setRoot` to compare, where a conversation still carries the signed records and
    /// comparing them IS the set comparison.
    #[tokio::test]
    async fn a_second_pass_over_unchanged_state_republishes_no_conversation() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        john.follows_and_publishes(&[]).await;

        // Alice comments on john's post and john holds it — the state after a knock was
        // taken, which is what the fold turns into a published conversation.
        //
        // John's own pin goes in beside it, and not as scenery: it is the post an idle
        // account carries, and these passes crawl — so each one folds every subject the
        // log holds a record for, the comment's included, and the gate is all that stops
        // a rewrite.
        let subject = own_post_subject(&john);
        let pin = pin_engagement::Endorsement::sign(
            &pin_derive::did_dht_seed(&john.app_key),
            pin_engagement::KIND_PIN,
            &subject,
            "version-1",
            "2026-09-12T00:00:00.000Z",
            None,
        )
        .expect("sign");
        crate::write_record(
            &john.doc,
            john.author_id,
            pin_derive::ENDORSE_COLLECTION,
            &pin_derive::endorse_rkey(pin_engagement::KIND_PIN, &subject),
            serde_json::to_vec(&pin).expect("encode"),
        )
        .await
        .expect("write endorsement");
        let comment = pin_engagement::Endorsement::sign_comment(
            &pin_derive::did_dht_seed(&alice.app_key),
            &subject,
            "version-1",
            "2026-09-12T00:00:01.000Z",
            None,
            "a remark",
            Vec::new(),
            Vec::new(),
        )
        .expect("sign comment");
        crate::write_record(
            &john.doc,
            john.author_id,
            pin_derive::COMMENT_LOG_COLLECTION,
            &pin_derive::comment_log_rkey(&subject, &comment.comment_id(), &alice.did),
            serde_json::to_vec(&comment).expect("encode"),
        )
        .await
        .expect("hold comment");

        let first = engagement(&john).await;
        assert_eq!(first.comments.published, 1, "the conversation has to land");

        let second = engagement(&john).await;
        assert_eq!(
            second.comments.published, 0,
            "and not again, nobody having commented or withdrawn in between",
        );
    }

    /// The same scenario with alice's edge removed: carol stays invisible.
    ///
    /// The negative half, and the one that makes the positive mean something — without it
    /// a pass that read everybody would pass the test above.
    #[tokio::test]
    async fn a_stranger_nobody_points_at_stays_invisible() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;

        world.publish(&alice.did, "sia://alice-dir", directory("alice", &[]));
        world.publish(&carol.did, "sia://carol-dir", directory("carol", &[]));
        john.follows(&[&alice.did]).await;

        john.hop_one(&alice.did).await;

        let out = pass(&john).await;
        assert_eq!(out.resolved, 0, "nothing points at carol");
        assert!(
            john.held(&carol.did).await.is_none(),
            "carol is published and still not visible: reachability is the edge, not the network",
        );
    }

    /// Somebody the network cannot answer for is NOT somebody who published nothing.
    ///
    /// The shape that has bitten this repo three times — the orphan sweep, the settings
    /// wipe, the identity publisher — is an inability to read becoming a written claim.
    /// Here it would mean recording carol as an identity with no name and no edges, which
    /// then fades on schedule and takes her branch of the graph with it.
    #[tokio::test]
    async fn an_unreachable_stranger_is_not_recorded_as_empty() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did]),
        );
        world.publish(&carol.did, "sia://carol-dir", directory("carol", &[]));
        world.make_unreachable(&carol.did);
        john.follows(&[&alice.did]).await;
        john.hop_one(&alice.did).await;

        let out = pass(&john).await;

        assert_eq!(out.unreachable, 1, "the pass reports it could not read her");
        assert_eq!(out.resolved, 0);
        assert!(
            john.held(&carol.did).await.is_none(),
            "no record: silence is not an answer about what she publishes",
        );
    }

    /// A pointer that outlives its object reads the same way — a failed read, not an
    /// empty identity. Ordinary during the grace window after a republish.
    #[tokio::test]
    async fn a_pointer_with_no_object_behind_it_records_nothing() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did]),
        );
        world.publish(&carol.did, "sia://carol-dir", directory("carol", &[]));
        // Her packet still resolves and names a blob that is gone.
        world.drop_blob("sia://carol-dir");
        john.follows(&[&alice.did]).await;
        john.hop_one(&alice.did).await;

        let out = pass(&john).await;

        assert_eq!(out.unreachable, 1);
        assert!(john.held(&carol.did).await.is_none());
    }

    /// The crawl never reads YOU.
    ///
    /// Anyone in your graph who follows one of your channels names your own did as an
    /// edge, so without the exclusion a pass spends a resolve and a download to be told,
    /// staler, what local state already holds. Found once by simulation against an oracle;
    /// this is the same claim asserted directly against a pass.
    #[tokio::test]
    async fn the_crawl_never_reads_its_own_identity() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;

        // Alice follows john back, so john's own did is an edge on a record he holds.
        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&john.did]),
        );
        world.publish(&john.did, "sia://john-dir", directory("john", &[]));
        john.follows(&[&alice.did]).await;
        john.hop_one(&alice.did).await;

        let out = pass(&john).await;

        assert_eq!(
            out.resolved, 0,
            "john is on a held record's edge and is skipped"
        );
        assert!(john.held(&john.did).await.is_none());
    }

    /// A record too far out to keep current, and old enough to have gone stale, FADES —
    /// and keeps the way back to whoever it names.
    ///
    /// Neither half of the condition is reachable on a real network in a test: decay needs
    /// a record seven days old, and the tier boundary needs five hundred identities ranked
    /// ahead of it. Here both are a parameter and a loop. This is the family of rules that
    /// shipped on 2026-09-05 with nothing exercising them.
    #[tokio::test]
    async fn a_far_and_stale_record_fades_without_losing_the_way_back() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;

        john.follows(&[]).await;

        let seeded = "2026-09-01T00:00:00.000Z";
        let seen = crate::iso_secs(seeded).expect("seed stamp parses");

        // Past MAX_FULL, so the tail of the ranking cannot stay in the refresh set.
        for i in 0..(crate::discover::MAX_FULL + 20) {
            john.hold_at(
                &format!("did:dht:{i:04}"),
                directory(&format!("person{i}"), &[]),
                seeded,
            )
            .await;
        }

        // Eight days later.
        let out = crate::discover_once(
            &john.discover_ctx(),
            &john.did,
            "2026-09-09T00:00:00.000Z".to_string(),
            seen + 8 * 24 * 60 * 60,
            "",
        )
        .await
        .expect("pass")
        .0;

        assert!(out.faded > 0, "the tail of the ranking fades");

        // The last by did sorts last, so it is the one past the cap.
        let far = john
            .held("did:dht:0519")
            .await
            .expect("still held after fading");
        assert_ne!(far.tier, crate::DirectoryTier::Full, "it faded");
        assert!(
            far.profile.is_none(),
            "a faded record drops what it looked like",
        );
        assert!(
            !far.url.is_empty(),
            "and keeps the way back: losing the record entirely loses the person",
        );
    }

    /// A resolve that succeeds with an OLD packet must not become a permanent answer.
    ///
    /// The nastiest thing a real network does, and the one the other four scenarios cannot
    /// reach: not silence, but a confident wrong answer. Carol has followed dave and
    /// republished; the store john reads still serves her previous packet. Dave is
    /// genuinely reachable through her and john cannot see him yet — which is correct, and
    /// the point is that it is TEMPORARY. Once the store catches up, the crawl's own
    /// refresh has to notice and pick him up, with nobody re-asking.
    #[tokio::test]
    async fn a_stale_read_is_corrected_rather_than_kept() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        let dave = Identity::new(&world, 4).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did]),
        );
        world.publish(&carol.did, "sia://carol-v1", directory("carol", &[]));
        world.publish(&dave.did, "sia://dave-dir", directory("dave", &[]));
        john.follows(&[&alice.did]).await;
        john.hop_one(&alice.did).await;

        // John reads carol as she currently reads: following nobody.
        let first = pass(&john).await;
        assert_eq!(first.resolved, 1);
        assert!(john
            .held(&carol.did)
            .await
            .expect("carol")
            .handle_follows
            .is_empty());

        // Carol follows dave and republishes. The store john reads has not caught up, and
        // still answers — with her old packet, naming her old blob.
        world.republish_lagging(
            &carol.did,
            "sia://carol-v2",
            directory("carol", &[&dave.did]),
        );

        let stale = pass(&john).await;
        assert_eq!(stale.resolved, 0, "dave is not on the frontier yet");
        assert!(
            john.held(&dave.did).await.is_none(),
            "john cannot see through an edge the store has not served him",
        );

        // The store catches up. Nobody asks for anything; the rotation comes round.
        world.propagate(&carol.did);
        let caught_up = pass(&john).await;
        assert!(
            caught_up.refreshed >= 1,
            "the pointer moved, so the refresh downloads rather than confirming",
        );
        assert_eq!(
            john.held(&carol.did).await.expect("carol").handle_follows,
            vec![dave.did.clone()],
            "her new edge is held",
        );

        // And the ring beyond opens up in the SAME pass. The frontier this pass started
        // from could not contain dave — carol's edge to him did not exist in anything john
        // held when it was computed — so the re-read that revealed him recomputes it. Every
        // widening of the graph arrives by this route, and before the recompute each one
        // waited out another full cadence.
        assert_eq!(caught_up.revealed, 1, "dave is who the re-read turned up");
        assert_eq!(caught_up.resolved, 1);
        assert!(john.held(&dave.did).await.is_some(), "dave becomes visible");

        // And the pass after it has nothing left to do, rather than the read arriving there.
        let onward = pass(&john).await;
        assert_eq!(onward.resolved, 0);
        assert_eq!(onward.revealed, 0);
    }

    /// An edge that points somewhere already held reveals nobody.
    ///
    /// The other half of the recompute, and the one that says it is a widening check rather
    /// than a change check: carol follows dave, who john already holds. Her record moves,
    /// so the re-read downloads — and there is nobody new behind it. The graph got denser
    /// without getting bigger.
    ///
    /// What this does NOT prove is that the re-rank was SKIPPED. That guard is a cost guard
    /// and costs nothing observable from out here; the assertion is that the pass reads
    /// nobody it had no reason to.
    #[tokio::test]
    async fn an_edge_onto_somebody_held_reveals_nobody() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        let dave = Identity::new(&world, 4).await;

        world.publish(
            &alice.did,
            "sia://alice-dir",
            directory("alice", &[&carol.did, &dave.did]),
        );
        world.publish(&carol.did, "sia://carol-v1", directory("carol", &[]));
        world.publish(&dave.did, "sia://dave-dir", directory("dave", &[]));
        john.follows(&[&alice.did]).await;
        john.hop_one(&alice.did).await;

        // Both of alice's follows are read, so the whole graph is held.
        let first = pass(&john).await;
        assert_eq!(first.resolved, 2);
        assert!(john.held(&dave.did).await.is_some(), "dave is held already");

        // Carol now follows dave too. Her pointer moves, so the rotation downloads her.
        world.publish(
            &carol.did,
            "sia://carol-v2",
            directory("carol", &[&dave.did]),
        );
        let denser = pass(&john).await;
        assert!(denser.refreshed >= 1, "her record moved, so it was re-read");
        assert_eq!(
            john.held(&carol.did).await.expect("carol").handle_follows,
            vec![dave.did.clone()],
            "the new edge is held",
        );
        assert_eq!(denser.revealed, 0, "dave was never news");
        assert_eq!(denser.resolved, 0, "so nothing was read for him again");
    }

    /// The recompute does not offer back somebody this pass has already read.
    ///
    /// The frontier is computed from the edge set as it stood at the top of the pass, so a
    /// recompute working from that same set would hand back everybody phase one just read —
    /// and being the nearest candidates, they would sort to the top and take the remaining
    /// budget re-reading themselves. What the pass actually found would go unread, which is
    /// the widening this whole recompute exists to pick up.
    ///
    /// Needs a frontier LARGER than one pass can read (six behind a budget of five) so that
    /// some of it is still outstanding when the recompute runs, plus a re-read that widens
    /// in the same pass. That combination is the only place the bug can surface, and it is
    /// why the other two scenarios cannot reach it.
    #[tokio::test]
    async fn the_recompute_does_not_re_offer_what_this_pass_read() {
        let world = World::new();
        let john = Identity::new(&world, 1).await;
        let alice = Identity::new(&world, 2).await;

        // Six people alice already points at — one more than a pass reads — and three more
        // she has not published yet, so the recompute is left with more than it can read.
        let ring: Vec<String> = (1..=6).map(|i| format!("did:dht:p{i}")).collect();
        let later: Vec<String> = (7..=9).map(|i| format!("did:dht:p{i}")).collect();
        for did in ring.iter().chain(later.iter()) {
            world.publish(did, &format!("sia://{did}"), directory(did, &[]));
        }

        let refs: Vec<&str> = ring.iter().map(String::as_str).collect();
        world.publish(&alice.did, "sia://alice-v1", directory("alice", &refs));
        john.follows(&[&alice.did]).await;
        john.hop_one(&alice.did).await;

        // Alice follows the three and republishes, so the re-read below downloads her.
        let mut widened: Vec<&str> = refs.clone();
        widened.extend(later.iter().map(String::as_str));
        world.publish(&alice.did, "sia://alice-v2", directory("alice", &widened));

        let out = pass(&john).await;

        // Five of the ring read up front, alice re-read, and the budget that is left spent
        // on what is genuinely outstanding.
        assert!(
            out.refreshed >= 1,
            "alice's pointer moved, so she was re-read"
        );
        assert_eq!(out.revealed, 3, "the three are what the re-read turned up");
        let unread_up_front = &ring[5];
        assert!(
            john.held(unread_up_front).await.is_some(),
            "the one the first phase had no budget for is read — the recomputed frontier is              read from the top, so a nearer candidate already waiting is not jumped by              somebody just revealed",
        );
        assert!(
            john.held(&later[0]).await.is_some(),
            "and the first of the revealed, in this pass rather than the next",
        );
        assert!(
            john.held(&later[2]).await.is_none(),
            "while the budget still cuts the pass off — the rest come round next time",
        );
        // And the second phase draws from the SAME allowance as the first two, counted by
        // what was actually spent rather than by the reservation. Every resolve this pass
        // made is one of these four: a new read, a re-read that downloaded, a re-read the
        // pointer settled, or an attempt that got no answer.
        assert_eq!(
            out.resolved + out.refreshed + out.unchanged + out.unreachable,
            crate::MAX_RESOLVES_PER_PASS,
            "the pass spends its budget and does not exceed it",
        );
    }
}

/// WHAT A PASS PAYS TO READ ITS OWN LOG — measured, because the shape is not obvious from
/// the call site and the recorded guess about it was wrong.
///
/// `log_records_for` is called ONCE PER TOUCHED SUBJECT, and each call opens with
/// `list_rkeys`, which is `Query::all()` over the whole doc with the prefix stripped in
/// Rust. So the scan is not paid once a pass — it is paid once per subject, and again by
/// `held_for` on the comments lane beside it. Two whole-doc scans per touched subject.
///
/// That is a different cost from the fold's arithmetic, which `pin-engagement`'s own cost
/// module measures at well under two seconds for a million records. This is the half that
/// grows with what the doc HOLDS rather than with what the pass folds, and it is the one
/// worth knowing a number for before anything is redesigned around it.
#[cfg(test)]
mod cost {
    use super::*;
    use std::time::Instant;

    const SIZES: &[usize] = &[200, 1_000];
    const BIG_SIZES: &[usize] = &[10_000, 50_000];

    /// A subject every seeded record folds into, so a gather has to read all of them — the
    /// viral shape, and the expensive one.
    const HOT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";

    /// Fill the engagement log with `n` records on one subject, written the way the pass
    /// writes them so the keys a scan strips are the real ones.
    async fn seed_log(who: &Identity, n: usize) {
        for i in 0..n {
            let actor = format!("did:dht:{i:0>52}");
            let rkey = pin_derive::engagement_log_rkey(HOT, "like", &actor);
            let record = serde_json::json!({
                "kind": "like",
                "actor": actor,
                "subject": HOT,
                "version": "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "createdAt": "2026-08-11T12:00:00.000Z",
                "sig": pin_crypto::b64_encode(&[7u8; 64]),
            });
            crate::write_record(
                &who.doc,
                who.author_id,
                pin_derive::ENGAGEMENT_LOG_COLLECTION,
                &rkey,
                serde_json::to_vec(&record).expect("encode"),
            )
            .await
            .expect("seed");
        }
    }

    async fn measure(n: usize) {
        let world = World::new();
        let who = Identity::new(&world, 1).await;
        seed_log(&who, n).await;
        let ctx = who.engagement_ctx();

        let t0 = Instant::now();
        let rkeys = crate::list_rkeys(
            &who.doc,
            who.author_id,
            pin_derive::ENGAGEMENT_LOG_COLLECTION,
        )
        .await
        .expect("scan");
        let scan = t0.elapsed();

        // The scan is handed in, as the pass hands it in — so what is timed here is the
        // gather alone, which is what the hoist left behind.
        let t1 = Instant::now();
        let records = crate::engagement::log_records_for(&ctx, &rkeys, HOT).await;
        let gather = t1.elapsed();

        // The gate that says this measured something rather than scanning an empty doc or
        // gathering nothing. Without it a broken seed reports an encouragingly small
        // number for the wrong reason.
        assert_eq!(rkeys.len(), n, "the scan sees every seeded record");
        assert_eq!(records.len(), n, "and the gather reads every one of them");

        println!(
            "  n={n:>7}  scan={:>9.1?}  gather={:>9.1?}  (a pass pays 2 gathers per touched subject)",
            scan, gather,
        );
    }

    fn header() {
        println!(
            "\nengagement-log read cost, n records on one subject — {}",
            if cfg!(debug_assertions) {
                "DEBUG BUILD: read the shape, not the absolute numbers"
            } else {
                "RELEASE BUILD"
            },
        );
    }

    #[tokio::test]
    async fn the_log_read_is_measured() {
        header();
        for &n in SIZES {
            measure(n).await;
        }
    }

    /// `cargo test -p pin-curator --release -- --ignored --nocapture cost::`
    #[tokio::test]
    #[ignore = "slow to seed; run deliberately with --release --nocapture"]
    async fn the_log_read_at_scale() {
        header();
        for &n in BIG_SIZES {
            measure(n).await;
        }
    }
}
