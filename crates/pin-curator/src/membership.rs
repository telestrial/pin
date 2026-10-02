//! This identity's side of the channels it is a MEMBER of: climbing each one's member tree
//! to its content key, and keeping every key it reaches.
//!
//! A channel only its members may read publishes no read key; what it publishes is a tree,
//! behind its `_m` pointer, from which each member — and nobody else — unwraps the current
//! content key C. The author's side is `members`. This is the reader's: a pass that resolves
//! each membership's pointer, refuses a tree older than one already climbed, and climbs only
//! when the epoch has moved.
//!
//! Every key reached is kept, one record per epoch, in this identity's own doc, so every one
//! of its devices holds them and none has to climb again. Kept rather than replaced because
//! an object sealed before a rotation still opens with the key of its own epoch.
//!
//! Through `Network` for both the pointer and the bands, so the pass runs over a fake one in
//! tests exactly as the crawl does.

use std::collections::BTreeMap;

use iroh_blobs::api::Store;
use iroh_docs::{api::Doc, AuthorId};
use pin_channel::band::{climb_bands, path, Band};
use pin_derive::{
    content_key_rkey, content_key_rkey_prefix, parse_content_key_epoch, CONTENT_KEY_COLLECTION,
    MEMBERSHIP_COLLECTION,
};
use serde::{Deserialize, Serialize};

use crate::net::Network;
use crate::{list_rkeys, read_record, write_record};

/// One channel this identity is a member of: what a climb to its content key needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    /// K, base64: what finds the tree and opens its bands.
    pub channel_key: String,
    /// The author, as did:dht: whose signature every band must carry.
    pub author: String,
    /// The author's encryption key, base64, which the leaf key is agreed with.
    pub author_enc_key: String,
    /// This identity's leaf in the tree.
    pub leaf: u64,
    /// The seating the invitation was for. A member removed and invited back holds a new
    /// seating at a new leaf, and this is how the newer invitation is told from the old.
    #[serde(default)]
    pub seat_id: String,
}

/// A content key as kept: the key, base64. Its channel and epoch are in its rkey.
#[derive(Serialize, Deserialize)]
struct HeldKey {
    key: String,
}

/// Record that this identity is a member of a channel.
pub async fn join(
    doc: &Doc,
    author_id: AuthorId,
    channel_id: &str,
    membership: &Membership,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(membership).map_err(|e| format!("encode membership: {e}"))?;
    write_record(doc, author_id, MEMBERSHIP_COLLECTION, channel_id, bytes).await
}

/// The record an invitation knock carries: the sealed box, as the directory carries it.
pub fn invitation_knock(sealed: &str) -> serde_json::Value {
    serde_json::json!({ "invite": sealed })
}

/// Whether a knocked record is an invitation rather than an endorsement or a comment.
pub(crate) fn is_invitation_knock(record: &serde_json::Value) -> bool {
    record.get("invite").and_then(|v| v.as_str()).is_some()
}

/// The sealed boxes a directory blob publishes.
pub(crate) fn boxes_in(blob: &serde_json::Value) -> Vec<String> {
    blob.get("invites")
        .and_then(|v| v.as_array())
        .map(|boxes| {
            boxes
                .iter()
                .filter_map(|b| b.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Record a membership for every invitation to this identity among `boxes`, answering how
/// many were new.
///
/// Every box is tried, because a box does not say whose it is: the ones for somebody else
/// fail to open and are passed over, and that is most of them. An invitation already held
/// for the same seating writes nothing; one for a NEWER seating of the same channel — a
/// member removed and invited back — replaces the old, whose leaf no longer climbs.
///
/// Recording a membership is not joining a feed. It is what lets this identity's Curator
/// climb to the channel's key, so the channel is readable the moment its person accepts;
/// what reaches their feed is still what they choose to watch.
pub(crate) async fn take_invitations(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
    boxes: &[String],
) -> usize {
    let me = crate::own_did(app_key);
    let mut taken = 0;
    for sealed in boxes {
        let Ok(invitation) = pin_channel::invite::open_invitation(app_key, &me, sealed) else {
            continue;
        };
        let Ok(channel_id) = invitation.channel_id() else {
            continue;
        };
        let held = read_record(doc, blobs, author_id, MEMBERSHIP_COLLECTION, &channel_id)
            .await
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice::<Membership>(&b).ok());
        if held.is_some_and(|h| h.seat_id == invitation.seat_id) {
            continue;
        }
        let membership = Membership {
            channel_key: invitation.channel_key,
            author: invitation.author,
            author_enc_key: invitation.author_enc_key,
            leaf: invitation.leaf,
            seat_id: invitation.seat_id,
        };
        if join(doc, author_id, &channel_id, &membership).await.is_ok() {
            taken += 1;
        }
    }
    taken
}

/// Every channel this identity is a member of. A record that will not read is left out:
/// the cost is one channel not climbed this pass, and nothing is acted on its absence.
pub(crate) async fn memberships(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
) -> Result<Vec<(String, Membership)>, String> {
    let mut out = Vec::new();
    for channel_id in list_rkeys(doc, author_id, MEMBERSHIP_COLLECTION).await? {
        let Ok(Some(bytes)) =
            read_record(doc, blobs, author_id, MEMBERSHIP_COLLECTION, &channel_id).await
        else {
            continue;
        };
        if let Ok(membership) = serde_json::from_slice(&bytes) {
            out.push((channel_id, membership));
        }
    }
    Ok(out)
}

/// Every content key this identity holds for one channel, by epoch.
///
/// An error when any of them will not read, rather than the ones that would: the highest
/// epoch held is what an older tree is refused against, so leaving one out could let a tree
/// this identity has already seen past be taken for current.
pub async fn content_keys(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
) -> Result<BTreeMap<u32, [u8; 32]>, String> {
    let prefix = content_key_rkey_prefix(channel_id);
    let mut out = BTreeMap::new();
    for rkey in list_rkeys(doc, author_id, CONTENT_KEY_COLLECTION).await? {
        if !rkey.starts_with(&prefix) {
            continue;
        }
        let epoch = parse_content_key_epoch(&rkey).ok_or_else(|| format!("content key {rkey}"))?;
        let bytes = read_record(doc, blobs, author_id, CONTENT_KEY_COLLECTION, &rkey)
            .await?
            .ok_or_else(|| format!("content key {rkey} listed and then not there"))?;
        let held: HeldKey =
            serde_json::from_slice(&bytes).map_err(|e| format!("content key {rkey}: {e}"))?;
        let key = pin_crypto::channel_key_from_base64(&held.key)
            .ok_or_else(|| format!("content key {rkey} is malformed"))?;
        out.insert(epoch, key);
    }
    Ok(out)
}

/// The content key this identity holds for one channel at one epoch, or `None` when it
/// holds none — not a member, or not climbed that far yet. A direct read, not a scan.
pub(crate) async fn held_key(
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    channel_id: &str,
    epoch: u32,
) -> Option<pin_channel::ContentKey> {
    let bytes = read_record(
        doc,
        blobs,
        author_id,
        CONTENT_KEY_COLLECTION,
        &content_key_rkey(channel_id, epoch),
    )
    .await
    .ok()
    .flatten()?;
    let held: HeldKey = serde_json::from_slice(&bytes).ok()?;
    Some(pin_channel::ContentKey {
        epoch,
        key: pin_crypto::channel_key_from_base64(&held.key)?,
    })
}

/// What one pass over this identity's memberships did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ClimbOutcome {
    /// Channels climbed to a new content key.
    pub climbed: usize,
    /// Channels whose tree is at an epoch already held. Nothing to do.
    pub unchanged: usize,
    /// Channels whose pointer named a tree OLDER than one already climbed — a K-holder
    /// repointing it, or a relay serving a stale record. Refused.
    pub refused: usize,
    /// Channels with no tree published.
    pub unpublished: usize,
    /// Channels whose pointer or bands could not be reached. Retried next pass.
    pub unreachable: usize,
    /// Channels whose tree would not climb: not signed by its author, not this
    /// identity's path, or a leaf this identity no longer holds — which is what being
    /// removed looks like from the inside.
    pub failed: usize,
}

/// One pass: climb every membership whose tree has moved.
pub async fn climb_once<N: Network>(
    net: &N,
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
) -> Result<ClimbOutcome, String> {
    let mut outcome = ClimbOutcome::default();
    for (channel_id, membership) in memberships(doc, blobs, author_id).await? {
        match climb(
            net,
            doc,
            blobs,
            author_id,
            app_key,
            &channel_id,
            &membership,
        )
        .await
        {
            Ok(Climbed::New) => outcome.climbed += 1,
            Ok(Climbed::Unchanged) => outcome.unchanged += 1,
            Ok(Climbed::Older) => outcome.refused += 1,
            Ok(Climbed::Unpublished) => outcome.unpublished += 1,
            Err(Failure::Unreachable) => outcome.unreachable += 1,
            Err(Failure::Refused) => outcome.failed += 1,
        }
    }
    Ok(outcome)
}

enum Climbed {
    New,
    Unchanged,
    Older,
    Unpublished,
}

/// Why a climb did not finish. Kept apart because one is retried as a matter of course and
/// the other says something is wrong with what was published.
enum Failure {
    Unreachable,
    Refused,
}

async fn climb<N: Network>(
    net: &N,
    doc: &Doc,
    blobs: &Store,
    author_id: AuthorId,
    app_key: &[u8; 32],
    channel_id: &str,
    membership: &Membership,
) -> Result<Climbed, Failure> {
    let channel_key =
        pin_crypto::channel_key_from_base64(&membership.channel_key).ok_or(Failure::Refused)?;
    let locator = pin_channel::members_locator_key(&channel_key).map_err(|_| Failure::Refused)?;
    let records = net
        .resolve(&locator)
        .await
        .map_err(|_| Failure::Unreachable)?;
    let Some(top_url) = pin_channel::members_url_in(&records) else {
        return Ok(Climbed::Unpublished);
    };
    let signer = pin_channel::Signer::Author(&membership.author);
    let fetch = |url: String| async move {
        let bytes = net.download(&url).await.map_err(|_| Failure::Unreachable)?;
        let blob = String::from_utf8(bytes).map_err(|_| Failure::Refused)?;
        Band::open(&channel_key, &blob, signer).map_err(|_| Failure::Refused)
    };

    let (epoch, top) = fetch(top_url).await?;
    let held = content_keys(doc, blobs, author_id, channel_id)
        .await
        .map_err(|_| Failure::Unreachable)?;
    match held.keys().next_back() {
        Some(&highest) if epoch < highest => return Ok(Climbed::Older),
        Some(&highest) if epoch == highest => return Ok(Climbed::Unchanged),
        _ => {}
    }

    // Down the path, each band from the URL the band above it names. Only the top's epoch is
    // checked: a band below it is reached through a URL the author signed, and one a removal
    // elsewhere left alone keeps the epoch it was published at.
    let height = top.height().ok_or(Failure::Refused)?;
    let mut bands = vec![top];
    for next in &path(membership.leaf, height)[1..] {
        let url = bands
            .last()
            .and_then(|b| b.child_url(*next))
            .ok_or(Failure::Refused)?
            .to_string();
        bands.push(fetch(url).await?.1);
    }

    let author_enc = pin_crypto::b64_decode(&membership.author_enc_key)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or(Failure::Refused)?;
    let shared = pin_crypto::enc_shared(&pin_derive::enc_key_seed(app_key), &author_enc)
        .map_err(|_| Failure::Refused)?;
    let leaf_key = pin_channel::tree::leaf_key(&shared, channel_id);
    let content =
        climb_bands(&bands, membership.leaf, leaf_key, channel_id).map_err(|_| Failure::Refused)?;
    // The root's version is the epoch, and the head says which epoch the tree was published
    // at; a disagreement is a tree that is not what its head claims.
    if content.epoch != epoch {
        return Err(Failure::Refused);
    }

    let bytes = serde_json::to_vec(&HeldKey {
        key: pin_crypto::b64_encode(&content.key),
    })
    .map_err(|_| Failure::Refused)?;
    write_record(
        doc,
        author_id,
        CONTENT_KEY_COLLECTION,
        &content_key_rkey(channel_id, epoch),
        bytes,
    )
    .await
    .map_err(|_| Failure::Unreachable)?;
    Ok(Climbed::New)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::members::{invite, publish_members, remove, MembersOutcome, MembersSink};
    use crate::testnet::{Identity, World};
    use std::sync::Arc;

    /// The author's sink, publishing into the world the members read from.
    struct WorldSink {
        world: Arc<World>,
        uploads: std::cell::Cell<usize>,
    }

    impl MembersSink for WorldSink {
        async fn upload(&self, objects: Vec<Vec<u8>>) -> Result<Vec<(String, String)>, String> {
            Ok(objects
                .into_iter()
                .map(|bytes| {
                    self.uploads.set(self.uploads.get() + 1);
                    let url = format!("sia://band/{}", self.uploads.get());
                    self.world.put_blob(&url, bytes);
                    (format!("obj{}", self.uploads.get()), url)
                })
                .collect())
        }

        async fn delete(&self, _object_id: &str) -> Result<(), String> {
            Ok(())
        }

        async fn point(&self, channel_key: &[u8; 32], top_url: &str) -> Result<(), String> {
            self.world.put_packet(
                &pin_channel::members_locator_key(channel_key)?,
                pin_channel::members_records(top_url),
            );
            Ok(())
        }
    }

    /// An author, a channel, and a sink into the shared world.
    struct Channel {
        author: Identity,
        key: [u8; 32],
        id: String,
        sink: WorldSink,
    }

    impl Channel {
        async fn new(world: &Arc<World>) -> Self {
            let author = Identity::new(world, 1).await;
            let key = author.channel_key();
            Channel {
                id: pin_crypto::channel_id(&key),
                key,
                author,
                sink: WorldSink {
                    world: world.clone(),
                    uploads: Default::default(),
                },
            }
        }

        /// Seat a member, and have their side take the invitation from what the author
        /// publishes — the directory's boxes, as a crawl of the author would find them.
        async fn seat(&self, member: &Identity) {
            let a = &self.author;
            invite(
                &a.doc,
                &a.blobs,
                a.author_id,
                &a.app_key,
                &self.key,
                &member.did,
                &pin_crypto::enc_public(&pin_derive::enc_key_seed(&member.app_key)),
                "2026-10-01T00:00:00Z",
            )
            .await
            .unwrap();
            let boxes = crate::members::invitation_boxes(&a.doc, &a.blobs, a.author_id)
                .await
                .unwrap();
            take_invitations(
                &member.doc,
                &member.blobs,
                member.author_id,
                &member.app_key,
                &boxes,
            )
            .await;
        }

        async fn unseat(&self, member: &Identity) {
            let a = &self.author;
            remove(
                &a.doc,
                &a.blobs,
                a.author_id,
                &self.id,
                &member.did,
                "2026-10-02T00:00:00Z",
            )
            .await
            .unwrap();
        }

        async fn publish(&self) -> MembersOutcome {
            let a = &self.author;
            publish_members(
                &self.sink,
                &a.doc,
                &a.blobs,
                a.author_id,
                &a.app_key,
                &self.id,
                &self.key,
            )
            .await
            .unwrap()
        }

        fn c(&self, epoch: u32) -> [u8; 32] {
            pin_derive::channel_content_key(&self.author.app_key, &self.id, epoch)
        }
    }

    async fn pass(member: &Identity) -> ClimbOutcome {
        climb_once(
            &member.net,
            &member.doc,
            &member.blobs,
            member.author_id,
            &member.app_key,
        )
        .await
        .unwrap()
    }

    async fn keys(member: &Identity, channel: &Channel) -> BTreeMap<u32, [u8; 32]> {
        content_keys(&member.doc, &member.blobs, member.author_id, &channel.id)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_member_climbs_to_the_content_key_once() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        channel.seat(&bob).await;
        channel.publish().await;

        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                climbed: 1,
                ..Default::default()
            }
        );
        assert_eq!(
            keys(&bob, &channel).await,
            BTreeMap::from([(0, channel.c(0))])
        );
        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                unchanged: 1,
                ..Default::default()
            }
        );
    }

    #[tokio::test]
    async fn a_rotation_is_climbed_to_and_the_older_key_is_kept() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        channel.seat(&bob).await;
        channel.seat(&carol).await;
        channel.publish().await;
        pass(&bob).await;
        pass(&carol).await;

        channel.unseat(&carol).await;
        channel.publish().await;
        assert_eq!(pass(&bob).await.climbed, 1);
        assert_eq!(
            keys(&bob, &channel).await,
            BTreeMap::from([(0, channel.c(0)), (1, channel.c(1))])
        );
        // The removed member reaches nothing new and writes nothing.
        assert_eq!(
            pass(&carol).await,
            ClimbOutcome {
                failed: 1,
                ..Default::default()
            }
        );
        assert_eq!(
            keys(&carol, &channel).await,
            BTreeMap::from([(0, channel.c(0))])
        );
    }

    #[tokio::test]
    async fn a_tree_older_than_one_climbed_is_refused() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        channel.seat(&bob).await;
        channel.seat(&carol).await;
        channel.publish().await;
        let locator = pin_channel::members_locator_key(&channel.key).unwrap();
        let old = bob.net.resolve(&locator).await.unwrap();

        channel.unseat(&carol).await;
        channel.publish().await;
        pass(&bob).await;

        // A K-holder puts the old pointer back: a genuine, author-signed tree, one epoch old.
        world.put_packet(&locator, old);
        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                refused: 1,
                ..Default::default()
            }
        );
        assert_eq!(
            keys(&bob, &channel).await,
            BTreeMap::from([(1, channel.c(1))])
        );
    }

    #[tokio::test]
    async fn a_tree_signed_by_anyone_else_is_refused() {
        // Anyone holding K can repoint `_m` and seal a band under K; only the author can
        // sign one.
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        channel.seat(&bob).await;
        channel.publish().await;

        let mallory = Identity::new(&world, 9).await;
        let mut tree = pin_channel::tree::Tree::new();
        tree.add(pin_crypto::enc_public(&pin_derive::enc_key_seed(
            &bob.app_key,
        )));
        let plan = pin_channel::band::Publication::new(&tree, &mallory.app_key, &channel.id);
        let forged = plan
            .band(plan.top(), Vec::new())
            .unwrap()
            .seal(&channel.key, 7, pin_derive::did_dht_seed(&mallory.app_key))
            .unwrap();
        world.put_blob("sia://forged", forged.into_bytes());
        world.put_packet(
            &pin_channel::members_locator_key(&channel.key).unwrap(),
            pin_channel::members_records("sia://forged"),
        );
        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                failed: 1,
                ..Default::default()
            }
        );
        assert!(keys(&bob, &channel).await.is_empty());
    }

    #[tokio::test]
    async fn a_tree_whose_head_and_root_disagree_on_the_epoch_is_refused() {
        // The author's own band, signed at an epoch its root does not unwrap to. Taken as
        // published, the key it yields would be filed under the head's epoch, and opening
        // anything sealed at that epoch would then fail with the wrong key in hand.
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        channel.seat(&bob).await;
        channel.publish().await;

        let locator = pin_channel::members_locator_key(&channel.key).unwrap();
        let url = pin_channel::members_url_in(&bob.net.resolve(&locator).await.unwrap()).unwrap();
        let blob = String::from_utf8(bob.net.download(&url).await.unwrap()).unwrap();
        let (_, band) = Band::open(
            &channel.key,
            &blob,
            pin_channel::Signer::Author(&channel.author.did),
        )
        .unwrap();
        let resealed = band
            .seal(
                &channel.key,
                5,
                pin_derive::did_dht_seed(&channel.author.app_key),
            )
            .unwrap();
        world.put_blob("sia://resealed", resealed.into_bytes());
        world.put_packet(&locator, pin_channel::members_records("sia://resealed"));

        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                failed: 1,
                ..Default::default()
            }
        );
        assert!(keys(&bob, &channel).await.is_empty());
    }

    #[tokio::test]
    async fn a_members_only_manifest_opens_with_the_key_climbed_to() {
        // Its head carries no read key, so the only route to C is the climb, and the head's
        // epoch says which of the member's keys to use.
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        channel.seat(&bob).await;
        channel.seat(&carol).await;
        channel.publish().await;

        let manifest_at = |epoch: u32| {
            let a = &channel.author;
            pin_channel::seal(
                &pin_channel::Sealing {
                    channel_key: &channel.key,
                    content: pin_channel::ContentKey {
                        epoch,
                        key: channel.c(epoch),
                    },
                    publish_read_key: false,
                    signer: pin_derive::did_dht_seed(&a.app_key),
                },
                pin_channel::Kind::Manifest,
                b"{}",
            )
            .unwrap()
        };
        let cache = |blob: String| async {
            crate::write_record(
                &bob.doc,
                bob.author_id,
                crate::SUB_COLLECTION,
                &channel.id,
                blob.into_bytes(),
            )
            .await
            .unwrap()
        };
        let settings: crate::SettingsView = serde_json::from_str("{}").unwrap();
        let held = || {
            crate::held_content_key(
                &bob.doc,
                &bob.blobs,
                bob.author_id,
                &bob.app_key,
                &settings,
                &channel.id,
                &channel.key,
                &channel.author.did,
            )
        };

        cache(manifest_at(0)).await;
        assert_eq!(held().await, None, "not climbed yet");
        pass(&bob).await;
        assert_eq!(
            held().await.map(|c| (c.epoch, c.key)),
            Some((0, channel.c(0)))
        );

        // A rotation: the manifest moves to the new epoch, and so does the key it takes.
        channel.unseat(&carol).await;
        channel.publish().await;
        cache(manifest_at(1)).await;
        assert_eq!(held().await, None, "the new epoch is not climbed yet");
        pass(&bob).await;
        assert_eq!(
            held().await.map(|c| (c.epoch, c.key)),
            Some((1, channel.c(1)))
        );
    }

    #[tokio::test]
    async fn a_members_only_object_opens_once_its_key_is_climbed_to() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        channel.seat(&bob).await;
        channel.publish().await;

        let a = &channel.author;
        let sealing = pin_channel::author_sealing(&a.app_key, &channel.key);
        let members_only = pin_channel::seal(
            &pin_channel::Sealing {
                publish_read_key: false,
                ..sealing
            },
            pin_channel::Kind::Manifest,
            b"{\"items\":[]}",
        )
        .unwrap();
        let open = |blob: String| {
            let bob = &bob;
            let channel = &channel;
            async move {
                crate::open_held(
                    &bob.doc,
                    &bob.blobs,
                    bob.author_id,
                    &channel.id,
                    &channel.key,
                    &blob,
                    pin_channel::Kind::Manifest,
                    &channel.author.did,
                )
                .await
            }
        };

        let err = open(members_only.clone()).await.unwrap_err();
        assert!(err.contains("no content key held"), "{err}");
        pass(&bob).await;
        let (json, content) = open(members_only).await.unwrap();
        assert_eq!(json, "{\"items\":[]}");
        assert_eq!(content.key, channel.c(0));

        // A channel anyone holding K may read opens with no membership at all.
        let public = pin_channel::seal(&sealing, pin_channel::Kind::Manifest, b"{}").unwrap();
        let carol = Identity::new(&world, 3).await;
        let opened = crate::open_held(
            &carol.doc,
            &carol.blobs,
            carol.author_id,
            &channel.id,
            &channel.key,
            &public,
            pin_channel::Kind::Manifest,
            &channel.author.did,
        )
        .await
        .unwrap();
        assert_eq!(opened.0, "{}");
    }

    async fn boxes(channel: &Channel) -> Vec<String> {
        let a = &channel.author;
        crate::members::invitation_boxes(&a.doc, &a.blobs, a.author_id)
            .await
            .unwrap()
    }

    async fn membership_of(member: &Identity, channel: &Channel) -> Option<Membership> {
        read_record(
            &member.doc,
            &member.blobs,
            member.author_id,
            MEMBERSHIP_COLLECTION,
            &channel.id,
        )
        .await
        .unwrap()
        .and_then(|b| serde_json::from_slice(&b).ok())
    }

    async fn take(who: &Identity, boxes: Vec<String>) -> usize {
        take_invitations(&who.doc, &who.blobs, who.author_id, &who.app_key, &boxes).await
    }

    #[tokio::test]
    async fn only_ones_own_invitation_is_taken_and_only_once() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        channel.seat(&carol).await;
        // Carol's box is in what bob reads; it is not his.

        assert_eq!(take(&bob, boxes(&channel).await).await, 0);
        assert!(membership_of(&bob, &channel).await.is_none());
        assert_eq!(
            take(&carol, boxes(&channel).await).await,
            0,
            "already taken"
        );
    }

    #[tokio::test]
    async fn an_invitation_back_replaces_the_membership_it_supersedes() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        let carol = Identity::new(&world, 3).await;
        channel.seat(&carol).await;
        channel.seat(&bob).await;
        let first = membership_of(&bob, &channel).await.unwrap();
        assert_eq!(first.leaf, 1);

        // Out, carol's leaf freed, back in: a new seating at a new leaf.
        channel.unseat(&bob).await;
        channel.unseat(&carol).await;
        channel.seat(&bob).await;
        let second = membership_of(&bob, &channel).await.unwrap();
        assert_ne!(second.seat_id, first.seat_id);
        assert_eq!(second.leaf, 0);
        channel.publish().await;
        assert_eq!(pass(&bob).await.climbed, 1, "the new leaf climbs");
    }

    #[tokio::test]
    async fn a_knocked_invitation_records_a_membership() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        bob.follows(&[]).await;
        let a = &channel.author;
        invite(
            &a.doc,
            &a.blobs,
            a.author_id,
            &a.app_key,
            &channel.key,
            &bob.did,
            &pin_crypto::enc_public(&pin_derive::enc_key_seed(&bob.app_key)),
            "2026-10-01T00:00:00Z",
        )
        .await
        .unwrap();
        let sealed = boxes(&channel).await.remove(0);

        let ctx = bob.engagement_ctx();
        let handler = pin_rpc::HeyHandler::new(ctx.inbox.clone());
        assert!(handler.accept_knock(&pin_rpc::hey_request(&invitation_knock(&sealed))));
        let outcome = crate::engagement_once(
            &ctx,
            &bob.did,
            "2026-10-01T00:00:00.000Z".into(),
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(outcome.invitations, 1);
        assert_eq!(
            outcome.rejected + outcome.knocks_rejected,
            0,
            "not read as an endorsement"
        );
        assert_eq!(membership_of(&bob, &channel).await.unwrap().author, a.did);
    }

    #[tokio::test]
    async fn an_invitation_in_a_directory_the_crawl_reads_records_a_membership() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        bob.follows_and_publishes(&[&channel.author.did]).await;
        let a = &channel.author;
        invite(
            &a.doc,
            &a.blobs,
            a.author_id,
            &a.app_key,
            &channel.key,
            &bob.did,
            &pin_crypto::enc_public(&pin_derive::enc_key_seed(&bob.app_key)),
            "2026-10-01T00:00:00Z",
        )
        .await
        .unwrap();
        world.publish(
            &a.did,
            "sia://alice-directory",
            serde_json::json!({
                "version": 1,
                "profile": { "username": "alice" },
                "channels": [],
                "follows": [],
                "handleFollows": [],
                "endorsements": [],
                "invites": boxes(&channel).await,
                "updatedAt": "2026-10-01T00:00:00.000Z",
            }),
        );

        let outcome = crate::engagement_once(
            &bob.engagement_ctx(),
            &bob.did,
            "2026-10-01T00:00:00.000Z".into(),
            true,
            false,
        )
        .await
        .unwrap();
        assert_eq!(outcome.invitations, 1);
        assert_eq!(membership_of(&bob, &channel).await.unwrap().author, a.did);
    }

    #[tokio::test]
    async fn nothing_published_and_nothing_reachable_write_nothing() {
        let world = World::new();
        let channel = Channel::new(&world).await;
        let bob = Identity::new(&world, 2).await;
        channel.seat(&bob).await;
        // A packet with no tree in it: published nothing. (The fake answers a key it holds
        // no packet for as an error, which is the unreachable case below.)
        let locator = pin_channel::members_locator_key(&channel.key).unwrap();
        world.put_packet(&locator, Vec::new());
        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                unpublished: 1,
                ..Default::default()
            }
        );

        channel.publish().await;
        world.make_unreachable(&locator);
        assert_eq!(
            pass(&bob).await,
            ClimbOutcome {
                unreachable: 1,
                ..Default::default()
            }
        );
        assert!(keys(&bob, &channel).await.is_empty());
    }
}
