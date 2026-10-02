//! The roster of each channel this identity owns: who has been seated, at which leaf, and
//! who has since been removed.
//!
//! The roster is the record and the member tree is derived from it
//! (`pin_channel::tree::Tree::from_roster`), so every one of the author's devices that
//! holds the same seatings derives the same tree and the same epoch. One record per
//! SEATING, never deleted: an invitation writes a new one, and a removal sets `removedAt`
//! on what is already there, so the set of removals only grows and the epoch with it.
//!
//! Nothing here publishes. What members read is the tree, and publishing it is its own
//! step; this is the author's private side of it, in the doc only the author's devices
//! hold.

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_channel::tree::{Seat, Tree};
use pin_derive::{member_rkey, member_rkey_prefix, MEMBERS_COLLECTION};

use crate::{list_rkeys, read_record, write_record};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testnet::{Identity, World};

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
