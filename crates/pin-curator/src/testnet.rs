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

use pin_pkarr::TxtRecord;

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
    /// Both, because the engagement pass returns early when nothing is published: nothing
    /// can be endorsed, so there is nothing to crawl FOR. Hop one is a byproduct of that
    /// crawl, so an identity that has published nothing reads nobody — correct, and the
    /// reason a scenario about hop one cannot be built out of follows alone.
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

    /// Whatever graph these settings describe, plus a channel with one post in it.
    async fn publishing(&self, mut settings: serde_json::Value) {
        let k = self.channel_key();
        let channel_id = pin_crypto::channel_id(&k);
        settings["myChannels"] = serde_json::json!([{
            "channelID": channel_id,
            "channelKey": pin_crypto::channel_key_to_base64(&k),
            "name": "A channel",
            "visibility": "public",
        }]);
        self.set_settings(settings).await;

        // Where the commit that publishes a channel puts its manifest, sealed under K, so
        // `own_subjects` opens it exactly as it opens the app's own.
        let manifest = serde_json::json!({
            "version": 1,
            "name": "A channel",
            "description": "",
            "authorPubkey": "ed25519:testnet",
            "publishedAt": "2026-09-12T00:00:00.000Z",
            "items": [{
                "id": "item-1",
                "itemURL": "sia://item-1",
                "type": "text",
                "title": "",
                "publishedAt": "2026-09-12T00:00:00.000Z",
                "mimeType": "text/markdown",
                "byteSize": 32,
            }],
        });
        let sealed = pin_crypto::encrypt(&k, &serde_json::to_vec(&manifest).expect("serialize"))
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

    /// A channel with no posts in it, which is not the same as no channel.
    ///
    /// Separated from `follows_and_publishes` because the threshold that matters is a
    /// POST: `own_subjects` walks a manifest's items, so an author who made a channel and
    /// has not written in it yet has no subjects and is indistinguishable from one who
    /// made nothing.
    pub async fn follows_with_an_empty_channel(&self, dids: &[&str]) {
        let k = self.channel_key();
        let channel_id = pin_crypto::channel_id(&k);
        self.set_settings(serde_json::json!({
            "handleFollows": dids,
            "myChannels": [{
                "channelID": channel_id,
                "channelKey": pin_crypto::channel_key_to_base64(&k),
                "name": "A channel",
                "visibility": "public",
            }],
        }))
        .await;
        let manifest = serde_json::json!({
            "version": 1,
            "name": "A channel",
            "description": "",
            "authorPubkey": "ed25519:testnet",
            "publishedAt": "2026-09-12T00:00:00.000Z",
            "items": [],
        });
        let sealed = pin_crypto::encrypt(&k, &serde_json::to_vec(&manifest).expect("serialize"))
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

    /// PUBLISHING NOTHING MEANS DISCOVERING NOBODY — a fact about the shipped loops,
    /// recorded rather than endorsed.
    ///
    /// `engagement_once` returns before its crawl when this identity has no subjects:
    /// nothing published means nothing that can be endorsed, so there is nothing to fold
    /// and no reason to read anybody. That is right for ENGAGEMENT and it is not obviously
    /// right for DISCOVERY, which inherits it — hop one is a byproduct of that crawl, and
    /// the discovery frontier is derived from held records, so a reader who follows people
    /// and has never posted holds nobody and reaches nobody, permanently. Not "slowly":
    /// there is no other path to a first held record.
    ///
    /// Two things follow. Any live verification of the chain has to have each account
    /// publish something first, or it is testing this instead. And whether a lurker ought
    /// to discover is a question about the loop boundary — today `covered_elsewhere` gives
    /// the whole of your own graph to engagement, so when engagement declines to read it,
    /// nothing else will.
    #[tokio::test]
    async fn publishing_nothing_means_discovering_nobody() {
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
        // Exactly the scenario that works above, minus the publishing.
        john.follows(&[&alice.did]).await;

        let folded = engagement(&john).await;
        assert_eq!(
            folded.reached, 0,
            "the pass returns before its crawl, so not even himself",
        );
        assert!(
            john.held(&alice.did).await.is_none(),
            "so hop one never lands for the person he follows",
        );

        // And discovery cannot make up the difference: its frontier is derived from held
        // records, and there are none.
        let out = pass(&john).await;
        assert_eq!(out.resolved, 0);
        assert!(john.held(&carol.did).await.is_none(), "carol stays unseen");

        // The threshold is a POST, not a channel — which is the part that would be got
        // wrong setting this up by hand, because having made a channel feels like having
        // published. `own_subjects` walks a manifest's items, so an empty one contributes
        // nothing and this identity is still exactly the lurker above.
        john.follows_with_an_empty_channel(&[&alice.did]).await;
        assert_eq!(
            engagement(&john).await.reached,
            0,
            "an empty channel is not a post"
        );
        assert!(john.held(&alice.did).await.is_none());
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
