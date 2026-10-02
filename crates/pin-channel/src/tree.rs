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

    /// Seat a member at the first hole, growing the tree a level when there is none, and
    /// answer with their leaf position.
    ///
    /// No key changes: a member joining is meant to read what came before them, so only the
    /// wraps on their path have to exist, and those are produced by `records` from state
    /// that has not moved.
    pub fn add(&mut self, enc_key: [u8; 32]) -> u64 {
        if let Some(i) = self.leaves.iter().position(Option::is_none) {
            self.leaves[i] = Some(enc_key);
            return i as u64;
        }
        // Full: a new root on top. Every existing node keeps its place, and the old root
        // becomes an ordinary interior node whose key is now derived like any other's.
        let at = self.leaves.len();
        self.height += 1;
        self.leaves.resize(at * 2, None);
        self.leaves[at] = Some(enc_key);
        at as u64
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

    /// A node's version: the removals made from the leaves beneath it.
    fn version(&self, id: NodeId) -> u32 {
        let first = id.pos << id.level;
        let end = (id.pos + 1) << id.level;
        self.removals.range(first..end).map(|(_, n)| n).sum()
    }

    /// Every node with somebody under it: each member's leaf and everything above it.
    ///
    /// Walked up from the members rather than asked of each node by scanning its leaves,
    /// which would make publishing the whole tree quadratic in its size.
    fn occupied(&self) -> std::collections::HashSet<NodeId> {
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

    fn record_with(
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
