//! The member tree: how a channel only its members may read hands each of them the
//! content key C, at any size.
//!
//! A binary tree with a member at each occupied leaf. Every node has a key, and the root's
//! key IS C. Each interior node's key is published wrapped under each of its two children's
//! keys, so a member who holds their leaf key unwraps their parent, then its parent, up to
//! C — log₂N steps. Removing a member replaces only the keys on their path, so the cost of
//! a removal is O(log N) where a flat list of envelopes pays O(N).
//!
//! The single-writer logical key hierarchy (Wong, Gouda and Lam; RFC 2627), not MLS's
//! TreeKEM: one author orders every change, so there is nothing for anyone to agree on.
//!
//! What makes it cheap here, and what each part of the derivation is for:
//!
//! - **A leaf key is never delivered.** It is a static X25519 exchange between the author's
//!   encryption key and the member's, so both compute it and nobody else can.
//! - **An interior key is never stored.** It derives from the author's AppKey, the channel,
//!   the node's place and that node's version, so every device holding the recovery phrase
//!   derives the same tree. The root's version is the epoch, and its key is the channel's
//!   content key for that epoch.
//! - **A node's place does not move when the tree grows.** It is its level above the leaves
//!   and its position along that level, so a new root on top leaves every existing address
//!   alone. Growing is not a rotation: adding members needs no re-keying, because a member
//!   is meant to read what came before them.
//! - **A wrap is bound to where it sits.** Its key covers the channel, the parent's place
//!   and the parent's version, so a wrap copied to another node or replayed from an older
//!   version opens nothing.
//! - **An empty side is filler.** A child with no member under it gets random bytes of the
//!   length a wrap has, so the tree is padded to a power of two by its own shape and an
//!   observer cannot tell occupied leaves from empty ones.
//!
//! Pure: no network, no store. Publishing the records and reading them back is the caller's.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ContentKey;

/// A node's place in the tree: its level above the leaves (0 is a leaf) and its position
/// along that level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId {
    pub level: u8,
    pub pos: u64,
}

impl NodeId {
    pub fn leaf(pos: u64) -> Self {
        NodeId { level: 0, pos }
    }

    pub fn parent(self) -> Self {
        NodeId {
            level: self.level + 1,
            pos: self.pos / 2,
        }
    }

    /// Which of its parent's two wraps opens with this node's key: 0 on the left, 1 on the
    /// right.
    fn side(self) -> usize {
        (self.pos % 2) as usize
    }

    fn child(self, side: usize) -> Self {
        NodeId {
            level: self.level - 1,
            pos: self.pos * 2 + side as u64,
        }
    }
}

/// One interior node as published: its place, its version, and its key wrapped for each
/// child — or filler on a side with nobody under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRecord {
    pub id: NodeId,
    pub version: u32,
    pub wraps: [Vec<u8>; 2],
}

/// One seating of one member: who, at which leaf, and whether they have since been removed.
///
/// The author's roster is a set of these, and the tree is derived from it rather than kept
/// beside it. A record per SEATING rather than per member, so a member removed and later
/// invited back is two records: the removal stays on record whatever comes after it, and
/// the epoch, which counts removals, can only grow. A record per member would have the
/// re-invite overwrite the removal and take the epoch backwards, which is the one direction
/// a member refuses to see it move.
///
/// The only change ever made to a seating is setting `removed_at`, so two of the author's
/// devices writing one seating agree on everything but when it was removed — and a removal
/// counts the same whichever stamp survives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    /// This seating's own id, minted when it is written. The record's key carries it, and
    /// it breaks the tie when two seatings claim one leaf.
    pub id: String,
    /// The member, as did:dht.
    pub did: String,
    /// The member's published encryption key, base64, as their directory carries it.
    pub enc_key: String,
    pub leaf: u64,
    pub added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<String>,
}

/// One past the highest leaf a seating may name: 2²⁴, about sixteen million members.
///
/// The tree holds a slot per leaf up to the highest one seated, so a seating naming a
/// leaf far past any real one would make deriving the tree allocate without bound.
pub const MAX_LEAF: u64 = 1 << 24;

/// The length of one wrap: a 32-byte key sealed by `seal_raw`.
pub const WRAP_LEN: usize = pin_crypto::sealed_len(32);

/// The author's whole view of a channel's members: who sits at each leaf, and how often
/// each interior node's key has been replaced.
///
/// Rebuilt from the author's own roster rather than published, since only the author ever
/// needs it; what is published is `records`, which reveals the shape and nothing of who.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    /// Levels above the leaves; the root sits at `(height, 0)`. Never below 1, so the root
    /// is always an interior node that wraps.
    height: u8,
    /// Each leaf's member, by their encryption key. `None` is a hole — never occupied, or
    /// left by a removal and waiting to be filled.
    leaves: Vec<Option<[u8; 32]>>,
    /// How many members have ever been removed from each leaf; absent means none.
    ///
    /// The only history the tree keeps, and every version is computed from it: a node's
    /// version is the removals beneath it, and the root's is all of them, which is the
    /// epoch. Counted rather than stored per node so a version never depends on how tall
    /// the tree was when a removal happened — the old root of a tree that has since grown
    /// carries the removals beneath it like any other node, and a tree rebuilt from its
    /// roster comes out the same as the one that lived through the changes.
    removals: BTreeMap<u64, u32>,
}

impl Default for Tree {
    fn default() -> Self {
        Self::new()
    }
}

impl Tree {
    /// An empty tree at epoch 0.
    pub fn new() -> Self {
        Tree {
            height: 1,
            leaves: vec![None; 2],
            removals: BTreeMap::new(),
        }
    }

    /// The tree a roster describes.
    ///
    /// Every removed seating is a removal at its leaf, so the versions and the epoch are
    /// the same however the seatings are ordered and whichever device wrote them. Every
    /// seating still standing seats its member, and when two claim one leaf — two devices
    /// inviting at once, each filling the same hole — the earliest `added_at` takes it,
    /// then the lower did, then the lower id, so every device seats the same one. The
    /// other is in no leaf and climbs to nothing.
    ///
    /// Everything that cannot be read fails closed. A seating naming a leaf at or past
    /// `MAX_LEAF`, or carrying an encryption key that is not one, seats nobody; a removal
    /// still counts wherever it names, because the cost of counting one too many is a
    /// rotation and the cost of dropping one is a member never removed.
    pub fn from_roster(seats: &[Seat]) -> Self {
        let mut tree = Tree::new();
        let mut held: BTreeMap<u64, &Seat> = BTreeMap::new();
        for seat in seats {
            if seat.removed_at.is_some() {
                if seat.leaf < MAX_LEAF {
                    tree.reach(seat.leaf);
                }
                *tree.removals.entry(seat.leaf).or_insert(0) += 1;
                continue;
            }
            if seat.leaf >= MAX_LEAF {
                continue;
            }
            let rank = |s: &Seat| (s.added_at.clone(), s.did.clone(), s.id.clone());
            match held.get(&seat.leaf) {
                Some(other) if rank(other) <= rank(seat) => {}
                _ => {
                    held.insert(seat.leaf, seat);
                }
            }
        }
        for (leaf, seat) in held {
            let key = pin_crypto::b64_decode(&seat.enc_key)
                .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
            if let Some(key) = key {
                tree.seat(leaf, key);
            }
        }
        tree
    }

    /// The root's version: every removal ever made.
    pub fn epoch(&self) -> u32 {
        self.removals.values().sum()
    }

    pub fn height(&self) -> u8 {
        self.height
    }

    pub fn root(&self) -> NodeId {
        NodeId {
            level: self.height,
            pos: 0,
        }
    }

    /// Who sits at a leaf, if anyone.
    pub fn member_at(&self, leaf: u64) -> Option<[u8; 32]> {
        self.leaves.get(leaf as usize).copied().flatten()
    }

    /// The leaf the next member would be seated at: the first hole, or the first leaf past
    /// a full tree.
    pub fn next_leaf(&self) -> u64 {
        self.leaves
            .iter()
            .position(Option::is_none)
            .unwrap_or(self.leaves.len()) as u64
    }

    /// Seat a member at the first hole, growing the tree a level when there is none, and
    /// answer with their leaf position.
    ///
    /// No key changes: a member joining is meant to read what came before them, so only the
    /// wraps on their path have to exist, and those are produced by `records` from state
    /// that has not moved.
    pub fn add(&mut self, enc_key: [u8; 32]) -> u64 {
        let at = self.next_leaf();
        self.seat(at, enc_key);
        at
    }

    /// Put a member at a given leaf, growing the tree until it reaches that far.
    ///
    /// Growing puts a new root on top. Every existing node keeps its place, and the old
    /// root becomes an ordinary interior node whose key is now derived like any other's.
    fn seat(&mut self, leaf: u64, enc_key: [u8; 32]) {
        self.reach(leaf);
        self.leaves[leaf as usize] = Some(enc_key);
    }

    /// Grow the tree until `leaf` is one of its leaves.
    fn reach(&mut self, leaf: u64) {
        while leaf >= self.leaves.len() as u64 {
            self.height += 1;
            let len = self.leaves.len() * 2;
            self.leaves.resize(len, None);
        }
    }

    /// Take a member out, and replace every key they held.
    ///
    /// The keys on their path are the only ones they ever derived, so those are the ones
    /// that move: every interior node above them has one more removal beneath it and so a
    /// new version, and the root's new version is the next epoch. Their leaf is left a hole
    /// for the next member to fill; nobody else moves, so nobody else's position ever
    /// changes.
    pub fn remove(&mut self, leaf: u64) -> Result<(), String> {
        match self.leaves.get_mut(leaf as usize) {
            Some(slot @ Some(_)) => *slot = None,
            _ => return Err(format!("no member at leaf {leaf}")),
        }
        *self.removals.entry(leaf).or_insert(0) += 1;
        Ok(())
    }

    /// A node's version: the removals made from the leaves beneath it. The root's is the
    /// epoch, which counts every removal on record, including one at a leaf the tree never
    /// reached (see `from_roster`).
    fn version(&self, id: NodeId) -> u32 {
        if id == self.root() {
            return self.epoch();
        }
        let first = id.pos << id.level;
        let end = (id.pos + 1) << id.level;
        self.removals.range(first..end).map(|(_, n)| n).sum()
    }

    /// Every node with somebody under it: each member's leaf and everything above it.
    ///
    /// Walked up from the members rather than asked of each node by scanning its leaves,
    /// which would make publishing the whole tree quadratic in its size.
    pub(crate) fn occupied(&self) -> std::collections::HashSet<NodeId> {
        let mut out = std::collections::HashSet::new();
        for (leaf, member) in self.leaves.iter().enumerate() {
            if member.is_none() {
                continue;
            }
            let mut node = NodeId::leaf(leaf as u64);
            loop {
                if !out.insert(node) || node.level == self.height {
                    break;
                }
                node = node.parent();
            }
        }
        out
    }

    /// An interior node's key, as the author derives it.
    fn node_key(&self, app_key: &[u8; 32], channel_id: &str, id: NodeId) -> [u8; 32] {
        if id == self.root() {
            pin_derive::channel_content_key(app_key, channel_id, self.epoch())
        } else {
            interior_key(app_key, channel_id, id, self.version(id))
        }
    }

    /// Any node's key as the author derives it, a leaf's included.
    fn key_of(
        &self,
        app_key: &[u8; 32],
        channel_id: &str,
        id: NodeId,
    ) -> Result<Option<[u8; 32]>, String> {
        if id.level > 0 {
            return Ok(Some(self.node_key(app_key, channel_id, id)));
        }
        match self.member_at(id.pos) {
            Some(member) => {
                let shared = pin_crypto::enc_shared(&pin_derive::enc_key_seed(app_key), &member)?;
                Ok(Some(leaf_key(&shared, channel_id)))
            }
            None => Ok(None),
        }
    }

    /// One interior node, published: its key wrapped for each child that has anyone under
    /// it, and filler for each that does not.
    pub fn record(
        &self,
        app_key: &[u8; 32],
        channel_id: &str,
        id: NodeId,
    ) -> Result<NodeRecord, String> {
        self.record_with(app_key, channel_id, id, &self.occupied())
    }

    pub(crate) fn record_with(
        &self,
        app_key: &[u8; 32],
        channel_id: &str,
        id: NodeId,
        occupied: &std::collections::HashSet<NodeId>,
    ) -> Result<NodeRecord, String> {
        let version = self.version(id);
        let key = self.node_key(app_key, channel_id, id);
        let mut wraps: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
        for (side, slot) in wraps.iter_mut().enumerate() {
            let child = id.child(side);
            let child_key = if occupied.contains(&child) {
                self.key_of(app_key, channel_id, child)?
            } else {
                None
            };
            *slot = match child_key {
                Some(ck) => pin_crypto::seal_raw(&wrap_key(&ck, channel_id, id, version), &key)?,
                None => {
                    let mut filler = vec![0u8; WRAP_LEN];
                    pin_crypto::fill_random(&mut filler)?;
                    filler
                }
            };
        }
        Ok(NodeRecord { id, version, wraps })
    }

    /// Everything that decides an interior node's record, short of the randomness a seal
    /// draws: its place, its version, whether it is the root (whose key is C rather than an
    /// interior key), and for each child whether anyone is under it and what that child's
    /// key is derived from — its version, or at a leaf the member's encryption key.
    ///
    /// For a publisher that skips a node whose record would say the same thing as last time:
    /// the record itself is re-sealed under a fresh nonce on every call, so its bytes cannot
    /// be compared.
    pub(crate) fn node_substance(
        &self,
        id: NodeId,
        occupied: &std::collections::HashSet<NodeId>,
    ) -> String {
        let mut out = format!(
            "{}:{}:{}:{}",
            id.level,
            id.pos,
            self.version(id),
            u8::from(id == self.root())
        );
        for side in 0..2 {
            let child = id.child(side);
            out.push(':');
            if !occupied.contains(&child) {
                out.push('-');
            } else if child.level == 0 {
                match self.member_at(child.pos) {
                    Some(member) => {
                        out.push('k');
                        out.push_str(&pin_crypto::b64_encode(&member));
                    }
                    None => out.push('-'),
                }
            } else {
                out.push('v');
                out.push_str(&self.version(child).to_string());
            }
        }
        out
    }

    /// Every interior node, published.
    pub fn records(&self, app_key: &[u8; 32], channel_id: &str) -> Result<Vec<NodeRecord>, String> {
        let occupied = self.occupied();
        let mut out = Vec::new();
        for level in 1..=self.height {
            for pos in 0..(1u64 << (self.height - level)) {
                out.push(self.record_with(
                    app_key,
                    channel_id,
                    NodeId { level, pos },
                    &occupied,
                )?);
            }
        }
        Ok(out)
    }
}

/// An interior node's key below the root.
fn interior_key(app_key: &[u8; 32], channel_id: &str, id: NodeId, version: u32) -> [u8; 32] {
    pin_derive::hkdf32(
        app_key,
        format!(
            "pin:member-node:v1:{channel_id}:{}:{}:{version}",
            id.level, id.pos
        )
        .as_bytes(),
    )
}

/// A member's leaf key, from the secret their encryption key shares with the author's.
pub fn leaf_key(shared: &[u8; 32], channel_id: &str) -> [u8; 32] {
    pin_derive::hkdf32(
        shared,
        format!("pin:member-leaf:v1:{channel_id}").as_bytes(),
    )
}

/// The key a parent is wrapped under for one child: the child's key, bound to where the
/// wrap sits.
fn wrap_key(child_key: &[u8; 32], channel_id: &str, parent: NodeId, version: u32) -> [u8; 32] {
    pin_derive::hkdf32(
        child_key,
        format!(
            "pin:member-wrap:v1:{channel_id}:{}:{}:{version}",
            parent.level, parent.pos
        )
        .as_bytes(),
    )
}

/// What a member does: start from their leaf key and unwrap up to C.
///
/// `lookup` answers the published record for a node, or `None` when it is not held. The
/// answer is the content key at the root's version, which is the epoch.
pub fn climb<'r>(
    lookup: impl Fn(NodeId) -> Option<&'r NodeRecord>,
    leaf: u64,
    height: u8,
    leaf_key: [u8; 32],
    channel_id: &str,
) -> Result<ContentKey, String> {
    let mut node = NodeId::leaf(leaf);
    let mut key = leaf_key;
    while node.level < height {
        let parent = node.parent();
        let record = lookup(parent).ok_or_else(|| {
            format!(
                "no record for node {}:{} on the path",
                parent.level, parent.pos
            )
        })?;
        let opened = pin_crypto::open_raw(
            &wrap_key(&key, channel_id, parent, record.version),
            &record.wraps[node.side()],
        )?;
        key = opened
            .try_into()
            .map_err(|_| "unwrapped key is not 32 bytes".to_string())?;
        if parent.level == height {
            return Ok(ContentKey {
                epoch: record.version,
                key,
            });
        }
        node = parent;
    }
    Err("the tree has no root above this leaf".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    const APP_KEY: [u8; 32] = [42u8; 32];
    const CHANNEL: &str = "chan";

    /// A member's encryption seed, distinct per index and never a low-order key.
    fn seed(i: u64) -> [u8; 32] {
        pin_derive::hkdf32(&i.to_be_bytes(), b"pin:tree-test-member")
    }

    fn public(i: u64) -> [u8; 32] {
        pin_crypto::enc_public(&seed(i))
    }

    fn author_public() -> [u8; 32] {
        pin_crypto::enc_public(&pin_derive::enc_key_seed(&APP_KEY))
    }

    /// The member's own leaf key, computed from THEIR side of the exchange — so a test
    /// that passes cannot be the author agreeing with themselves.
    fn member_leaf_key(i: u64) -> [u8; 32] {
        let shared = pin_crypto::enc_shared(&seed(i), &author_public()).unwrap();
        leaf_key(&shared, CHANNEL)
    }

    fn published(tree: &Tree) -> HashMap<NodeId, NodeRecord> {
        tree.records(&APP_KEY, CHANNEL)
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r))
            .collect()
    }

    fn current_c(tree: &Tree) -> ContentKey {
        ContentKey {
            epoch: tree.epoch(),
            key: pin_derive::channel_content_key(&APP_KEY, CHANNEL, tree.epoch()),
        }
    }

    fn climbs(
        tree: &Tree,
        records: &HashMap<NodeId, NodeRecord>,
        member: u64,
        leaf: u64,
    ) -> Result<ContentKey, String> {
        climb(
            |id| records.get(&id),
            leaf,
            tree.height(),
            member_leaf_key(member),
            CHANNEL,
        )
    }

    #[test]
    fn a_member_climbs_to_c() {
        let mut tree = Tree::new();
        let leaf = tree.add(public(1));
        let records = published(&tree);
        assert_eq!(climbs(&tree, &records, 1, leaf).unwrap(), current_c(&tree));
    }

    #[test]
    fn a_full_tree_grows_without_rotating() {
        // Growing puts a new root on top. The epoch stays: nobody left, so nothing anybody
        // holds has to stop working, and the content key a member already has is still C.
        let mut tree = Tree::new();
        let mut seated = Vec::new();
        for i in 0..9 {
            seated.push((i, tree.add(public(i))));
        }
        assert_eq!(tree.height(), 4, "nine members need sixteen leaves");
        assert_eq!(tree.epoch(), 0);
        let records = published(&tree);
        for (member, leaf) in seated {
            assert_eq!(
                climbs(&tree, &records, member, leaf).unwrap(),
                current_c(&tree)
            );
        }
    }

    #[test]
    fn a_removal_moves_the_epoch_and_only_the_path() {
        let mut tree = Tree::new();
        for i in 0..8 {
            tree.add(public(i));
        }
        let before = tree.clone();
        tree.remove(5).unwrap();
        assert_eq!(tree.epoch(), 1);
        for level in 1..tree.height() {
            for pos in 0..(1u64 << (tree.height() - level)) {
                let id = NodeId { level, pos };
                let on_path = (5u64 >> level) == pos;
                assert_eq!(
                    tree.version(id) != before.version(id),
                    on_path,
                    "node {level}:{pos}"
                );
            }
        }
        assert!(tree.remove(5).is_err(), "a hole is not a member");
    }

    #[test]
    fn the_old_root_keeps_the_removals_beneath_it_when_the_tree_grows() {
        // A version counts the removals under a node whatever the tree's height was when
        // they happened, so the root a tree grows past carries its history with it rather
        // than restarting at 0 as an ordinary node.
        let mut tree = Tree::new();
        tree.add(public(0));
        tree.add(public(1));
        tree.remove(1).unwrap();
        let old_root = tree.root();
        assert_eq!(tree.version(old_root), 1);
        for i in 2..4 {
            tree.add(public(i));
        }
        assert_eq!(tree.height(), 2);
        assert_ne!(tree.root(), old_root);
        assert_eq!(tree.version(old_root), 1);
        assert_eq!(tree.epoch(), 1);
        let records = published(&tree);
        for (member, leaf) in [(0, 0), (2, 1), (3, 2)] {
            assert_eq!(
                climbs(&tree, &records, member, leaf).unwrap(),
                current_c(&tree)
            );
        }
    }

    #[test]
    fn a_node_s_substance_says_whether_it_is_the_root() {
        // The root's key is C and every other node's is derived from its place, so the same
        // node at the same version says something different once the tree grows past it.
        let mut tree = Tree::new();
        for i in 0..16 {
            tree.add(public(i));
        }
        let node = tree.root();
        let as_root = tree.node_substance(node, &tree.occupied());
        let mut grown = tree.clone();
        grown.reach(16);
        assert_eq!(grown.version(node), tree.version(node));
        assert_ne!(grown.node_substance(node, &grown.occupied()), as_root);
    }

    #[test]
    fn a_hole_is_filled_before_the_tree_grows() {
        let mut tree = Tree::new();
        for i in 0..4 {
            tree.add(public(i));
        }
        tree.remove(1).unwrap();
        assert_eq!(tree.add(public(9)), 1);
        assert_eq!(tree.height(), 2);
    }

    #[test]
    fn filler_is_the_length_of_a_wrap() {
        // Otherwise an observer could tell occupied leaves from empty ones by size alone.
        let mut tree = Tree::new();
        tree.add(public(1));
        for record in tree.records(&APP_KEY, CHANNEL).unwrap() {
            assert_eq!(record.wraps[0].len(), WRAP_LEN);
            assert_eq!(record.wraps[1].len(), WRAP_LEN);
        }
    }

    #[test]
    fn a_wrap_key_is_bound_to_the_parent_s_place_and_version() {
        // So a wrap copied to another node, or replayed from an older version of its own,
        // is sealed under a key the climb there does not derive.
        let child = [5u8; 32];
        let at = NodeId { level: 2, pos: 1 };
        let base = wrap_key(&child, CHANNEL, at, 0);
        assert_ne!(
            base,
            wrap_key(&child, CHANNEL, NodeId { level: 2, pos: 0 }, 0)
        );
        assert_ne!(
            base,
            wrap_key(&child, CHANNEL, NodeId { level: 1, pos: 1 }, 0)
        );
        assert_ne!(base, wrap_key(&child, CHANNEL, at, 1));
        assert_ne!(base, wrap_key(&child, "other", at, 0));
    }

    #[test]
    fn a_record_replayed_from_an_older_version_opens_nothing() {
        let mut tree = Tree::new();
        for i in 0..4 {
            tree.add(public(i));
        }
        let old = published(&tree);
        tree.remove(3).unwrap();
        let mut records = published(&tree);
        // The root as it was, with its old version claimed as current.
        let root = tree.root();
        let mut replayed = old[&root].clone();
        replayed.version = records[&root].version;
        records.insert(root, replayed);
        assert!(climbs(&tree, &records, 0, 0).is_err());
    }

    /// A small deterministic generator, so a failure reproduces.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 33
        }
    }

    /// Every key a member could have learned while they were in: their leaf key, and every
    /// node key on their path at every epoch they saw.
    fn learn(
        tree: &Tree,
        records: &HashMap<NodeId, NodeRecord>,
        member: u64,
        leaf: u64,
        known: &mut HashSet<[u8; 32]>,
    ) {
        let mut key = member_leaf_key(member);
        known.insert(key);
        let mut node = NodeId::leaf(leaf);
        while node.level < tree.height() {
            let parent = node.parent();
            let record = &records[&parent];
            let opened = pin_crypto::open_raw(
                &wrap_key(&key, CHANNEL, parent, record.version),
                &record.wraps[node.side()],
            )
            .expect("a member opens their own path");
            key = opened.try_into().unwrap();
            known.insert(key);
            node = parent;
        }
    }

    #[test]
    fn random_churn_keeps_every_member_in_and_every_leaver_out() {
        // The property the tree exists for, checked over thousands of random operations:
        // after any sequence of joins and removals, everyone seated climbs to the current
        // C, and nobody removed can reach it from anything they ever held.
        for run in 0..4u64 {
            let mut rng = Lcg(run.wrapping_mul(0x9e3779b97f4a7c15) + 1);
            let mut tree = Tree::new();
            let mut seated: HashMap<u64, u64> = HashMap::new(); // member -> leaf
            let mut gone: Vec<HashSet<[u8; 32]>> = Vec::new();
            let mut next_member = 0u64;

            for step in 0..40 {
                let remove = !seated.is_empty() && rng.next() % 3 == 0;
                if remove {
                    let mut members: Vec<u64> = seated.keys().copied().collect();
                    members.sort();
                    let member = members[(rng.next() as usize) % members.len()];
                    let leaf = seated.remove(&member).unwrap();
                    // Everything they could have learned up to the moment they left.
                    let mut known = HashSet::new();
                    learn(&tree, &published(&tree), member, leaf, &mut known);
                    tree.remove(leaf).unwrap();
                    gone.push(known);
                } else {
                    let member = next_member;
                    next_member += 1;
                    let leaf = tree.add(public(member));
                    seated.insert(member, leaf);
                }

                let records = published(&tree);
                let c = current_c(&tree);
                for (&member, &leaf) in &seated {
                    assert_eq!(
                        climbs(&tree, &records, member, leaf).unwrap(),
                        c,
                        "run {run}"
                    );
                }
                // A leaver holding every key they ever saw opens no wrap anywhere in the
                // current tree, so in particular never C. Every tenth step and the last:
                // the check tries every key against every wrap, which a debug build pays
                // for dearly.
                if step % 10 != 9 {
                    continue;
                }
                for known in &gone {
                    assert!(!known.contains(&c.key), "run {run}: a leaver holds C");
                    for record in records.values() {
                        for key in known {
                            for wrap in &record.wraps {
                                assert!(
                                    pin_crypto::open_raw(
                                        &wrap_key(key, CHANNEL, record.id, record.version),
                                        wrap
                                    )
                                    .is_err(),
                                    "run {run}: a leaver opened {}:{}",
                                    record.id.level,
                                    record.id.pos
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    fn seating(id: u64, member: u64, leaf: u64) -> Seat {
        Seat {
            id: format!("s{id}"),
            did: format!("did:dht:m{member}"),
            enc_key: pin_crypto::b64_encode(&public(member)),
            leaf,
            added_at: format!("2026-10-01T00:00:{:02}.000Z", id % 60),
            removed_at: None,
        }
    }

    #[test]
    fn a_roster_derives_the_tree_that_lived_through_it() {
        // The roster is the record and the tree is derived from it, so a tree rebuilt from
        // the seatings must be the one that saw every change happen — through growth,
        // removals and holes refilled — and must not depend on the order they are read in.
        for run in 0..4u64 {
            let mut rng = Lcg(run.wrapping_mul(0x9e3779b97f4a7c15) + 7);
            let mut tree = Tree::new();
            let mut roster: Vec<Seat> = Vec::new();
            let mut next = 0u64;
            for _ in 0..60 {
                let standing: Vec<usize> = (0..roster.len())
                    .filter(|&i| roster[i].removed_at.is_none())
                    .collect();
                if !standing.is_empty() && rng.next() % 3 == 0 {
                    let i = standing[(rng.next() as usize) % standing.len()];
                    tree.remove(roster[i].leaf).unwrap();
                    roster[i].removed_at = Some("2026-10-02T00:00:00.000Z".into());
                } else {
                    let leaf = tree.add(public(next));
                    roster.push(seating(next, next, leaf));
                    next += 1;
                }
                assert_eq!(Tree::from_roster(&roster), tree, "run {run}");
            }
            let mut shuffled = roster.clone();
            for i in (1..shuffled.len()).rev() {
                shuffled.swap(i, (rng.next() as usize) % (i + 1));
            }
            assert_eq!(Tree::from_roster(&shuffled), tree, "run {run}");
        }
    }

    #[test]
    fn a_member_invited_back_does_not_take_the_epoch_back() {
        let mut first = seating(0, 1, 0);
        first.removed_at = Some("2026-10-02T00:00:00.000Z".into());
        let again = seating(1, 1, 0);
        let tree = Tree::from_roster(&[first, again]);
        assert_eq!(tree.epoch(), 1);
        assert_eq!(tree.member_at(0), Some(public(1)));
    }

    #[test]
    fn two_seatings_on_one_leaf_seat_the_earlier_on_every_device() {
        let early = seating(3, 1, 0);
        let late = seating(9, 2, 0);
        for roster in [
            vec![early.clone(), late.clone()],
            vec![late.clone(), early.clone()],
        ] {
            let tree = Tree::from_roster(&roster);
            assert_eq!(tree.member_at(0), Some(public(1)));
            assert_eq!(
                tree.epoch(),
                0,
                "a seating that lost its leaf was never removed"
            );
        }
        // Stamped in the same instant, the lower did takes it.
        let mut tied = late.clone();
        tied.added_at = early.added_at.clone();
        assert_eq!(
            Tree::from_roster(&[tied.clone(), early.clone()]).member_at(0),
            Some(public(1))
        );
    }

    #[test]
    fn an_unreadable_seating_seats_nobody_and_a_removal_still_counts() {
        let mut bad_key = seating(0, 1, 0);
        bad_key.enc_key = "not a key".into();
        let mut short_key = seating(1, 2, 1);
        short_key.enc_key = pin_crypto::b64_encode(&[7u8; 31]);
        let far = seating(2, 3, MAX_LEAF);
        let mut far_removed = seating(3, 4, MAX_LEAF + 5);
        far_removed.removed_at = Some("2026-10-02T00:00:00.000Z".into());
        let tree = Tree::from_roster(&[bad_key, short_key, far, far_removed]);
        assert_eq!(tree.member_at(0), None);
        assert_eq!(tree.member_at(1), None);
        assert_eq!(tree.height(), 1, "a leaf past the bound grows nothing");
        assert_eq!(tree.epoch(), 1);
        // The epoch the root is published at is the one the author derives C for.
        let root = tree.records(&APP_KEY, CHANNEL).unwrap().pop().unwrap();
        assert_eq!(root.id, tree.root());
        assert_eq!(root.version, 1);
    }

    #[test]
    fn a_seating_crosses_as_these_keys() {
        let mut seat = seating(0, 1, 4);
        let standing = serde_json::to_value(&seat).unwrap();
        let mut keys: Vec<&str> = standing
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(keys, ["addedAt", "did", "encKey", "id", "leaf"]);
        seat.removed_at = Some("2026-10-02T00:00:00.000Z".into());
        let removed = serde_json::to_value(&seat).unwrap();
        assert!(removed.get("removedAt").is_some());
        assert_eq!(serde_json::from_value::<Seat>(removed).unwrap(), seat);
    }

    #[test]
    fn the_root_key_is_the_channel_content_key() {
        // So the author's own derivation of C and what the tree hands a member are one key.
        let mut tree = Tree::new();
        for i in 0..3 {
            let leaf = tree.add(public(100 + i));
            tree.remove(leaf).unwrap();
        }
        let leaf = tree.add(public(1));
        let records = published(&tree);
        let got = climbs(&tree, &records, 1, leaf).unwrap();
        assert_eq!(got.epoch, 3);
        assert_eq!(
            got.key,
            pin_derive::channel_content_key(&APP_KEY, CHANNEL, 3)
        );
    }
}
