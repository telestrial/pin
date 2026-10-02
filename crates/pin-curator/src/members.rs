//! The roster of each channel this identity owns: who has been seated, at which leaf, and
//! who has since been removed.
//!
//! The roster is the record and the member tree is derived from it
//! (`pin_channel::tree::Tree::from_roster`), so every one of the author's devices that
//! holds the same seatings derives the same tree and the same epoch. One record per
//! SEATING, never deleted: an invitation writes a new one, and a removal sets `removedAt`
//! on what is already there, so the set of removals only grows and the epoch with it.
//!
//! The roster is private, in the doc only the author's devices hold. What members read is
//! the tree, published by `publish_members` as bands behind the channel's `_m` pointer.

use std::collections::HashMap;
use std::future::Future;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_channel::band::{BandId, Publication};
use pin_channel::tree::{Seat, Tree};
use pin_derive::{
    member_rkey, member_rkey_prefix, published_members_band_rkey, published_members_rkey,
    MEMBERS_COLLECTION,
};

use crate::{
    list_rkeys, read_published, read_record, write_published, write_record, PublishedState,
};

/// Every seating of one channel's roster, in no particular order.
///
/// An error when any seating cannot be read, rather than the ones that could: a seating
/// left out might be a removal, and a tree derived without it hands the removed member
/// the current key. A partial reading decides nothing.
pub async fn roster(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
) -> Result<Vec<Seat>, String> {
    let prefix = member_rkey_prefix(channel_id);
    let mut seats = Vec::new();
    for rkey in list_rkeys(doc, author_id, MEMBERS_COLLECTION).await? {
        if !rkey.starts_with(&prefix) {
            continue;
        }
        let bytes = read_record(doc, blobs, author_id, MEMBERS_COLLECTION, &rkey)
            .await?
            .ok_or_else(|| format!("seating {rkey} listed and then not there"))?;
        let seat: Seat =
            serde_json::from_slice(&bytes).map_err(|e| format!("seating {rkey}: {e}"))?;
        seats.push(seat);
    }
    Ok(seats)
}

/// Seat a member in one of this identity's channels, answering with their seating.
///
/// A member already standing in the roster is answered with the seating they have rather
/// than given a second. Otherwise they go at the first hole of the tree the roster
/// derives. Two devices inviting at once may both pick that hole; the roster settles
/// which of them holds it, the same way on every device.
pub async fn invite(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
    did: &str,
    enc_key: &[u8; 32],
    now_iso: &str,
) -> Result<Seat, String> {
    let seats = roster(doc, blobs, author_id, channel_id).await?;
    if let Some(seat) = seats
        .iter()
        .find(|s| s.did == did && s.removed_at.is_none())
    {
        return Ok(seat.clone());
    }
    let mut id = [0u8; 16];
    pin_crypto::fill_random(&mut id)?;
    let seat = Seat {
        id: id.iter().map(|b| format!("{b:02x}")).collect(),
        did: did.to_string(),
        enc_key: pin_crypto::b64_encode(enc_key),
        leaf: Tree::from_roster(&seats).next_leaf(),
        added_at: now_iso.to_string(),
        removed_at: None,
    };
    write_seat(doc, author_id, channel_id, &seat).await?;
    Ok(seat)
}

/// Take a member out of one of this identity's channels, answering with how many of their
/// seatings were standing.
///
/// Every standing seating of theirs is marked, so a member two devices seated twice is out
/// of both. Zero when they were not in, which writes nothing.
pub async fn remove(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
    did: &str,
    now_iso: &str,
) -> Result<usize, String> {
    let mut removed = 0;
    for mut seat in roster(doc, blobs, author_id, channel_id).await? {
        if seat.did != did || seat.removed_at.is_some() {
            continue;
        }
        seat.removed_at = Some(now_iso.to_string());
        write_seat(doc, author_id, channel_id, &seat).await?;
        removed += 1;
    }
    Ok(removed)
}

async fn write_seat(
    doc: &Doc,
    author_id: AuthorId,
    channel_id: &str,
    seat: &Seat,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(seat).map_err(|e| format!("encode seating: {e}"))?;
    write_record(
        doc,
        author_id,
        MEMBERS_COLLECTION,
        &member_rkey(channel_id, &seat.id),
        bytes,
    )
    .await
}

/// Where a published member tree goes: Sia for the bands, the DHT for the pointer.
///
/// Behind a seam so the pass can be run without either. Generic rather than `dyn`, as
/// `Network` is, so the futures keep whatever Send-ness their target gives them.
pub trait MembersSink {
    /// Upload sealed band objects together, answering each one's object id and share URL in
    /// the order they were given.
    fn upload(
        &self,
        objects: Vec<Vec<u8>>,
    ) -> impl Future<Output = Result<Vec<(String, String)>, String>>;

    /// Give back one object.
    fn delete(&self, object_id: &str) -> impl Future<Output = Result<(), String>>;

    /// Point the channel's `_m` key at its top band.
    fn point(
        &self,
        channel_key: &[u8; 32],
        top_url: &str,
    ) -> impl Future<Output = Result<(), String>>;
}

/// The real one: a Sia session and the channel's K-derived pointer.
pub struct LiveMembersSink {
    sia: std::sync::Arc<pin_sia::Session>,
}

impl LiveMembersSink {
    pub fn new(sia: std::sync::Arc<pin_sia::Session>) -> Self {
        Self { sia }
    }
}

impl MembersSink for LiveMembersSink {
    async fn upload(&self, objects: Vec<Vec<u8>>) -> Result<Vec<(String, String)>, String> {
        // Packed, so the bands of one tier share slabs rather than paying one apiece.
        let uploaded = self.sia.upload_items_packed(objects, None).await?;
        Ok(uploaded.into_iter().map(|u| (u.id, u.item_url)).collect())
    }

    async fn delete(&self, object_id: &str) -> Result<(), String> {
        self.sia.delete_object(object_id).await
    }

    async fn point(&self, channel_key: &[u8; 32], top_url: &str) -> Result<(), String> {
        pin_channel::point_members(channel_key, top_url).await
    }
}

/// What one publish of a member tree did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MembersOutcome {
    /// Bands uploaded: the ones whose fingerprint moved.
    pub uploaded: usize,
    /// Whether the pointer was moved to a new top.
    pub repointed: bool,
}

/// Publish one of this identity's channels' member trees, uploading only the bands that
/// moved, and point `_m` at the top.
///
/// Bottom tier first, each tier's changed bands in one packed upload, because a band names
/// the URLs of the bands beneath it. Each band's publish state is recorded as its tier
/// lands, so a pass that fails partway resumes from there: the bands already uploaded
/// fingerprint the same next time and are not uploaded again.
///
/// Keep-2 per band, as every pointer-published object here: the generation a band just
/// superseded stays alive for a reader still walking the tree it belonged to, and the one
/// before that is given back. Given back only AFTER the pointer has moved, because a
/// pointer that failed to move still names the old top, and the old top names old bands.
/// A pointer that fails leaves those generations unreclaimed — a leak of a few small
/// objects, which is the safe direction.
///
/// A channel nobody has ever been seated in publishes nothing.
#[allow(clippy::too_many_arguments)]
pub async fn publish_members<S: MembersSink>(
    sink: &S,
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
    channel_id: &str,
    channel_key: &[u8; 32],
) -> Result<MembersOutcome, String> {
    let mut outcome = MembersOutcome::default();
    let seats = roster(doc, blobs, author_id, channel_id).await?;
    if seats.is_empty() {
        return Ok(outcome);
    }
    let tree = Tree::from_roster(&seats);
    let plan = Publication::new(&tree, app_key, channel_id);
    let signer = pin_derive::did_dht_seed(app_key);
    let published_key = pin_derive::published_key(app_key);

    let mut urls: HashMap<BandId, String> = HashMap::new();
    let mut stale: Vec<String> = Vec::new();
    for tier in 0..=plan.top().tier {
        let mut pending = Vec::new();
        for id in plan.bands_in(tier) {
            let children = plan.children_urls(id, &urls)?;
            let fingerprint = plan.fingerprint(id, &children);
            let rkey = published_members_band_rkey(channel_id, id.tier, id.pos);
            let previous = read_published(doc, blobs, author_id, &published_key, &rkey).await;
            let unchanged = previous
                .as_ref()
                .filter(|p| p.fp.as_deref() == Some(fingerprint.as_str()))
                .and_then(|p| p.url.clone());
            if let Some(url) = unchanged {
                urls.insert(id, url);
                continue;
            }
            let blob = plan
                .band(id, children)?
                .seal(channel_key, plan.epoch(), signer)?;
            pending.push((id, rkey, fingerprint, previous, blob));
        }
        if pending.is_empty() {
            continue;
        }
        let objects = pending
            .iter()
            .map(|(.., blob)| blob.clone().into_bytes())
            .collect();
        let uploaded = sink.upload(objects).await?;
        if uploaded.len() != pending.len() {
            return Err(format!(
                "uploaded {} band objects for {} bands",
                uploaded.len(),
                pending.len()
            ));
        }
        for ((id, rkey, fingerprint, previous, _), (object_id, url)) in
            pending.into_iter().zip(uploaded)
        {
            stale.extend(crate::engagement::reclaimable(
                previous.as_ref(),
                &object_id,
            ));
            write_published(
                doc,
                author_id,
                &published_key,
                &rkey,
                &PublishedState {
                    id: object_id,
                    url: Some(url.clone()),
                    older_id: previous.map(|p| p.id),
                    fp: Some(fingerprint),
                },
            )
            .await;
            urls.insert(id, url);
            outcome.uploaded += 1;
        }
    }

    let top_url = urls
        .get(&plan.top())
        .cloned()
        .ok_or("the top band has no URL")?;
    let pointer_rkey = published_members_rkey(channel_id);
    let pointed = read_published(doc, blobs, author_id, &published_key, &pointer_rkey).await;
    if pointed.as_ref().and_then(|p| p.url.as_deref()) != Some(top_url.as_str()) {
        sink.point(channel_key, &top_url).await?;
        write_published(
            doc,
            author_id,
            &published_key,
            &pointer_rkey,
            &PublishedState {
                id: String::new(),
                url: Some(top_url),
                older_id: None,
                fp: None,
            },
        )
        .await;
        outcome.repointed = true;
    }
    for object_id in stale {
        let _ = sink.delete(&object_id).await;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testnet::{Identity, World};
    use pin_channel::ContentKey;

    const CHANNEL: &str = "chan";

    fn member(i: u8) -> (String, [u8; 32]) {
        (format!("did:dht:m{i}"), pin_crypto::enc_public(&[i; 32]))
    }

    async fn seat(me: &Identity, i: u8, at: &str) -> Seat {
        let (did, key) = member(i);
        invite(&me.doc, &me.blobs, me.author_id, CHANNEL, &did, &key, at)
            .await
            .unwrap()
    }

    async fn tree(me: &Identity, channel: &str) -> Tree {
        Tree::from_roster(
            &roster(&me.doc, &me.blobs, me.author_id, channel)
                .await
                .unwrap(),
        )
    }

    /// Sia and the DHT in memory: every upload stays readable by its URL, as a generation a
    /// reader may still hold does, and each step can be made to fail.
    #[derive(Default)]
    struct FakeSink {
        by_url: std::cell::RefCell<HashMap<String, String>>,
        uploads: std::cell::Cell<usize>,
        deleted: std::cell::RefCell<Vec<String>>,
        pointed: std::cell::RefCell<Option<String>>,
        /// Fail the upload call with this number, counting from 1.
        fail_upload: std::cell::Cell<Option<usize>>,
        fail_point: std::cell::Cell<bool>,
        upload_calls: std::cell::Cell<usize>,
    }

    impl MembersSink for FakeSink {
        async fn upload(&self, objects: Vec<Vec<u8>>) -> Result<Vec<(String, String)>, String> {
            self.upload_calls.set(self.upload_calls.get() + 1);
            if self.fail_upload.get() == Some(self.upload_calls.get()) {
                return Err("upload failed".into());
            }
            Ok(objects
                .into_iter()
                .map(|bytes| {
                    self.uploads.set(self.uploads.get() + 1);
                    let n = self.uploads.get();
                    let url = format!("sia://object/{n}");
                    self.by_url
                        .borrow_mut()
                        .insert(url.clone(), String::from_utf8(bytes).unwrap());
                    (format!("obj{n}"), url)
                })
                .collect())
        }

        async fn delete(&self, object_id: &str) -> Result<(), String> {
            self.deleted.borrow_mut().push(object_id.to_string());
            Ok(())
        }

        async fn point(&self, _channel_key: &[u8; 32], top_url: &str) -> Result<(), String> {
            if self.fail_point.get() {
                return Err("point failed".into());
            }
            *self.pointed.borrow_mut() = Some(top_url.to_string());
            Ok(())
        }
    }

    const K: [u8; 32] = [5u8; 32];

    fn channel() -> String {
        pin_crypto::channel_id(&K)
    }

    async fn publish(me: &Identity, sink: &FakeSink) -> Result<MembersOutcome, String> {
        publish_members(
            sink,
            &me.doc,
            &me.blobs,
            me.author_id,
            &me.app_key,
            &channel(),
            &K,
        )
        .await
    }

    async fn seat_in(me: &Identity, i: u8) -> Seat {
        let (did, key) = member(i);
        invite(
            &me.doc,
            &me.blobs,
            me.author_id,
            &channel(),
            &did,
            &key,
            "2026-10-01T00:00:00Z",
        )
        .await
        .unwrap()
    }

    async fn unseat(me: &Identity, i: u8) {
        let (did, _) = member(i);
        remove(
            &me.doc,
            &me.blobs,
            me.author_id,
            &channel(),
            &did,
            "2026-10-02T00:00:00Z",
        )
        .await
        .unwrap();
    }

    /// What a member does: resolve the pointer, walk down their path by URL, climb to C.
    fn climb_as(me: &Identity, sink: &FakeSink, i: u8, leaf: u64) -> Result<ContentKey, String> {
        use pin_channel::band::{climb_bands, path, Band};
        let open = |url: &str| {
            let blob = sink.by_url.borrow()[url].clone();
            Band::open(&K, &blob, pin_channel::Signer::Author(&me.did))
                .unwrap()
                .1
        };
        let top_url = sink.pointed.borrow().clone().ok_or("nothing pointed")?;
        let mut bands = vec![open(&top_url)];
        let height = bands[0].height().unwrap();
        for next in &path(leaf, height)[1..] {
            let url = bands.last().unwrap().child_url(*next).unwrap().to_string();
            bands.push(open(&url));
        }
        let author = pin_crypto::enc_public(&pin_derive::enc_key_seed(&me.app_key));
        let shared = pin_crypto::enc_shared(&[i; 32], &author)?;
        climb_bands(
            &bands,
            leaf,
            pin_channel::tree::leaf_key(&shared, &channel()),
            &channel(),
        )
    }

    fn c_at(me: &Identity, epoch: u32) -> ContentKey {
        ContentKey {
            epoch,
            key: pin_derive::channel_content_key(&me.app_key, &channel(), epoch),
        }
    }

    #[tokio::test]
    async fn a_channel_nobody_was_seated_in_publishes_nothing() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let sink = FakeSink::default();
        assert_eq!(
            publish(&me, &sink).await.unwrap(),
            MembersOutcome::default()
        );
        assert_eq!(sink.upload_calls.get(), 0);
        assert!(sink.pointed.borrow().is_none());
    }

    #[tokio::test]
    async fn members_climb_the_published_tree_and_an_idle_pass_uploads_nothing() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let sink = FakeSink::default();
        let mut seats = Vec::new();
        for i in 1..=3 {
            seats.push(seat_in(&me, i).await);
        }
        let first = publish(&me, &sink).await.unwrap();
        assert_eq!(
            first,
            MembersOutcome {
                uploaded: 1,
                repointed: true
            }
        );
        for (i, seat) in (1..=3).zip(&seats) {
            assert_eq!(climb_as(&me, &sink, i, seat.leaf).unwrap(), c_at(&me, 0));
        }
        let again = publish(&me, &sink).await.unwrap();
        assert_eq!(again, MembersOutcome::default());
    }

    #[tokio::test]
    async fn a_removal_republishes_its_path_and_the_member_is_out() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let sink = FakeSink::default();
        let mut seats = Vec::new();
        for i in 1..=20 {
            seats.push(seat_in(&me, i).await);
        }
        let first = publish(&me, &sink).await.unwrap();
        assert_eq!(first.uploaded, 3, "a top band over two tier-0 bands");

        unseat(&me, 7).await;
        let second = publish(&me, &sink).await.unwrap();
        assert_eq!(
            second,
            MembersOutcome {
                uploaded: 2,
                repointed: true
            }
        );
        for (i, seat) in (1..=20).zip(&seats) {
            if i == 7 {
                assert!(climb_as(&me, &sink, i, seat.leaf).is_err());
            } else {
                assert_eq!(
                    climb_as(&me, &sink, i, seat.leaf).unwrap(),
                    c_at(&me, 1),
                    "{i}"
                );
            }
        }
    }

    #[tokio::test]
    async fn each_band_keeps_the_generation_before_it_and_gives_back_the_one_before_that() {
        // One band, three generations: the first is given back when the third lands, and
        // the second — what a reader holding the last pointer is still walking — is kept.
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let sink = FakeSink::default();
        for i in 1..=3 {
            seat_in(&me, i).await;
            publish(&me, &sink).await.unwrap();
        }
        assert_eq!(*sink.deleted.borrow(), ["obj1"]);
    }

    #[tokio::test]
    async fn a_pass_that_fails_partway_resumes_from_the_tier_it_reached() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        for i in 1..=20 {
            seat_in(&me, i).await;
        }
        let sink = FakeSink::default();
        // Tier 0 lands, the top's upload fails: nothing is pointed at.
        sink.fail_upload.set(Some(2));
        assert!(publish(&me, &sink).await.is_err());
        assert!(sink.pointed.borrow().is_none());
        assert_eq!(sink.uploads.get(), 2);
        // The next pass uploads only the top.
        let resumed = publish(&me, &sink).await.unwrap();
        assert_eq!(
            resumed,
            MembersOutcome {
                uploaded: 1,
                repointed: true
            }
        );
        assert_eq!(climb_as(&me, &sink, 3, 2).unwrap(), c_at(&me, 0));
    }

    #[tokio::test]
    async fn nothing_is_given_back_until_the_pointer_has_moved() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let sink = FakeSink::default();
        seat_in(&me, 1).await;
        publish(&me, &sink).await.unwrap();
        seat_in(&me, 2).await;
        publish(&me, &sink).await.unwrap();
        // The third generation is uploaded but the pointer will not move: the first is
        // still what the pointer's previous generation names, so it stays.
        seat_in(&me, 3).await;
        sink.fail_point.set(true);
        assert!(publish(&me, &sink).await.is_err());
        assert!(sink.deleted.borrow().is_empty());
        assert_eq!(sink.pointed.borrow().as_deref(), Some("sia://object/2"));
        // Pointing again needs no upload.
        sink.fail_point.set(false);
        let retried = publish(&me, &sink).await.unwrap();
        assert_eq!(
            retried,
            MembersOutcome {
                uploaded: 0,
                repointed: true
            }
        );
        assert_eq!(sink.pointed.borrow().as_deref(), Some("sia://object/3"));
    }

    #[tokio::test]
    async fn invitations_fill_leaves_in_order_and_a_removal_moves_the_epoch() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let leaves: Vec<u64> = [
            seat(&me, 1, "2026-10-01T00:00:01Z").await.leaf,
            seat(&me, 2, "2026-10-01T00:00:02Z").await.leaf,
            seat(&me, 3, "2026-10-01T00:00:03Z").await.leaf,
        ]
        .to_vec();
        assert_eq!(leaves, [0, 1, 2]);
        assert_eq!(tree(&me, CHANNEL).await.epoch(), 0);

        let (did, _) = member(2);
        let n = remove(
            &me.doc,
            &me.blobs,
            me.author_id,
            CHANNEL,
            &did,
            "2026-10-02T00:00:00Z",
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let derived = tree(&me, CHANNEL).await;
        assert_eq!(derived.epoch(), 1);
        assert_eq!(derived.member_at(1), None);

        // The hole is filled before the tree grows.
        assert_eq!(seat(&me, 4, "2026-10-02T00:00:01Z").await.leaf, 1);
    }

    #[tokio::test]
    async fn a_member_already_in_keeps_their_seating() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let first = seat(&me, 1, "2026-10-01T00:00:01Z").await;
        let again = seat(&me, 1, "2026-10-01T00:00:09Z").await;
        assert_eq!(again, first);
        assert_eq!(
            roster(&me.doc, &me.blobs, me.author_id, CHANNEL)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn a_member_invited_back_is_a_new_seating_and_the_epoch_holds() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        let first = seat(&me, 1, "2026-10-01T00:00:01Z").await;
        let (did, _) = member(1);
        remove(
            &me.doc,
            &me.blobs,
            me.author_id,
            CHANNEL,
            &did,
            "2026-10-02T00:00:00Z",
        )
        .await
        .unwrap();
        let back = seat(&me, 1, "2026-10-03T00:00:00Z").await;
        assert_ne!(back.id, first.id);
        let seats = roster(&me.doc, &me.blobs, me.author_id, CHANNEL)
            .await
            .unwrap();
        assert_eq!(seats.len(), 2);
        let derived = Tree::from_roster(&seats);
        assert_eq!(derived.epoch(), 1, "the removal is still on record");
        assert_eq!(derived.member_at(back.leaf), Some(member(1).1));
    }

    #[tokio::test]
    async fn removing_somebody_not_in_writes_nothing() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        seat(&me, 1, "2026-10-01T00:00:01Z").await;
        let n = remove(
            &me.doc,
            &me.blobs,
            me.author_id,
            CHANNEL,
            "did:dht:nobody",
            "2026-10-02T00:00:00Z",
        )
        .await
        .unwrap();
        assert_eq!(n, 0);
        assert_eq!(tree(&me, CHANNEL).await.epoch(), 0);
    }

    #[tokio::test]
    async fn each_channel_reads_only_its_own_roster() {
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        seat(&me, 1, "2026-10-01T00:00:01Z").await;
        let (did, key) = member(2);
        invite(
            &me.doc,
            &me.blobs,
            me.author_id,
            "other",
            &did,
            &key,
            "2026-10-01T00:00:02Z",
        )
        .await
        .unwrap();
        let mine = roster(&me.doc, &me.blobs, me.author_id, CHANNEL)
            .await
            .unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].did, member(1).0);
    }

    #[tokio::test]
    async fn a_seating_that_will_not_parse_fails_the_whole_roster() {
        // It might be a removal, and a tree derived without it would hand the removed
        // member the current key.
        let world = World::new();
        let me = Identity::new(&world, 1).await;
        seat(&me, 1, "2026-10-01T00:00:01Z").await;
        write_record(
            &me.doc,
            me.author_id,
            MEMBERS_COLLECTION,
            &member_rkey(CHANNEL, "broken"),
            b"not json".to_vec(),
        )
        .await
        .unwrap();
        assert!(roster(&me.doc, &me.blobs, me.author_id, CHANNEL)
            .await
            .is_err());
    }
}
