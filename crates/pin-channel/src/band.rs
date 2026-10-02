//! The member tree as it is published: cut into BANDS of four levels, each band one object.
//!
//! A member needs the nodes on the path from their leaf to the root and nothing else, and
//! a removal changes only the nodes on one path. So the tree is published in pieces small
//! enough that reading a path, or rewriting one, touches few bytes: a band holds four
//! levels of nodes — at most fifteen, under sixteen bands or sixteen leaves beneath it —
//! and the URLs of the bands beneath it. One pointer names the top band, and a member walks
//! down by URL. A band of four levels rather than eight because every member re-fetches the
//! bands on their path after every removal, so a small band is most of what a removal costs
//! the people still in.
//!
//! Bands are counted from the LEAVES up: tier 0 holds levels 1 to 4, tier 1 levels 5 to 8,
//! and so on, and a band's place is its tier and the position of the node at its apex. So a
//! band, like a node, keeps its address when the tree grows, and the only band the growth
//! itself adds is a new one on top.
//!
//! Merkle-shaped: a band names its children by URL, and a Sia URL addresses the bytes behind
//! it, so a band fixes everything beneath it and the top band fixes the whole tree. Only the
//! top is reached through a pointer anyone holding K could rewrite; every band below it is
//! reached through a band the author signed.
//!
//! The tree's height is not stored: it is the highest level in the top band, which is the
//! root's. Stored in every band it would go stale in the bands a growth leaves alone. What
//! IS stored is whether a band was published as the top, because the pointer to the top is
//! the one thing a K-holder can rewrite, and a lower band put in its place would otherwise
//! read as a shorter tree whose root is an interior node — handing its members an interior
//! key as though it were C. A band that really was the top keeps its flag after the tree
//! grows past it, and that is harmless: its root key was C at its epoch, and an epoch older
//! than one a member has seen is refused before any band is read.
//!
//! Pure, like the tree: what is uploaded where, and the pointer to the top, are the
//! publisher's.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::tree::{climb, NodeId, NodeRecord};
use crate::ContentKey;

/// Levels of the tree in one band.
pub const BAND_LEVELS: u8 = 4;
/// Bands beneath a band, or leaves beneath a tier-0 band.
pub const BAND_FANOUT: u64 = 1 << BAND_LEVELS;

/// A band's place: its tier counted from the leaves, and the position along its apex level
/// of the node at its apex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BandId {
    pub tier: u8,
    pub pos: u64,
}

impl BandId {
    /// The band an interior node is published in.
    pub fn of(node: NodeId) -> Self {
        debug_assert!(node.level > 0, "a leaf is in no band");
        let tier = (node.level - 1) / BAND_LEVELS;
        BandId {
            tier,
            pos: node.pos >> (apex_level(tier) - node.level),
        }
    }

    /// The band on top of a tree of this height, which the pointer names.
    pub fn top(height: u8) -> Self {
        BandId {
            tier: (height.max(1) - 1) / BAND_LEVELS,
            pos: 0,
        }
    }

    /// The bands beneath this one in a tree of this height, in the order the band lists
    /// their URLs. None for a tier-0 band, whose children are leaves.
    pub fn children(self, height: u8) -> Vec<BandId> {
        if self.tier == 0 {
            return Vec::new();
        }
        let tier = self.tier - 1;
        // The apexes of the bands beneath are the nodes at their apex level, of which a
        // tree this tall has 2^(height - level).
        let width = 1u64 << (height - apex_level(tier));
        let first = self.pos * BAND_FANOUT;
        (first..(first + BAND_FANOUT).min(width))
            .map(|pos| BandId { tier, pos })
            .collect()
    }
}

/// The level of a tier's apex.
fn apex_level(tier: u8) -> u8 {
    BAND_LEVELS * (tier + 1)
}

/// The bands a member at `leaf` reads to climb a tree of this height, from the top down.
pub fn path(leaf: u64, height: u8) -> Vec<BandId> {
    (0..=BandId::top(height).tier)
        .rev()
        .map(|tier| BandId {
            tier,
            pos: leaf >> apex_level(tier),
        })
        .collect()
}

/// The tree's node records, grouped by the band each is published in, bottom tier first —
/// the order they have to be uploaded in, since a band names the URLs of the ones beneath.
pub fn layout(records: Vec<NodeRecord>) -> BTreeMap<BandId, Vec<NodeRecord>> {
    let mut out: BTreeMap<BandId, Vec<NodeRecord>> = BTreeMap::new();
    for record in records {
        out.entry(BandId::of(record.id)).or_default().push(record);
    }
    out
}

/// One band, as its object carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Band {
    pub tier: u8,
    pub pos: u64,
    /// Whether this band was published as the top of the tree.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub top: bool,
    pub nodes: Vec<BandNode>,
    /// The URLs of the bands beneath, in `BandId::children` order. Empty in tier 0.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
}

/// One node in a band: its place, its version, and its two wraps, base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BandNode {
    pub level: u8,
    pub pos: u64,
    pub version: u32,
    pub wraps: [String; 2],
}

impl Band {
    /// A band of a tree of this height, from its records and the URLs of the bands beneath
    /// it.
    pub fn new(id: BandId, height: u8, records: &[NodeRecord], children: Vec<String>) -> Self {
        Band {
            tier: id.tier,
            pos: id.pos,
            top: id == BandId::top(height),
            nodes: records
                .iter()
                .map(|r| BandNode {
                    level: r.id.level,
                    pos: r.id.pos,
                    version: r.version,
                    wraps: [
                        pin_crypto::b64_encode(&r.wraps[0]),
                        pin_crypto::b64_encode(&r.wraps[1]),
                    ],
                })
                .collect(),
            children,
        }
    }

    pub fn id(&self) -> BandId {
        BandId {
            tier: self.tier,
            pos: self.pos,
        }
    }

    /// The tree's height, read off the top band: its highest level is the root's.
    pub fn height(&self) -> Option<u8> {
        self.nodes.iter().map(|n| n.level).max()
    }

    /// The URL of one band beneath this one, when this band names it.
    pub fn child_url(&self, child: BandId) -> Option<&str> {
        if child.tier + 1 != self.tier || child.pos / BAND_FANOUT != self.pos {
            return None;
        }
        self.children
            .get((child.pos % BAND_FANOUT) as usize)
            .map(String::as_str)
    }

    fn records(&self) -> Result<Vec<NodeRecord>, String> {
        self.nodes
            .iter()
            .map(|n| {
                let wrap = |i: usize| {
                    pin_crypto::b64_decode(&n.wraps[i])
                        .ok_or_else(|| format!("node {}:{} wrap is not base64", n.level, n.pos))
                };
                Ok(NodeRecord {
                    id: NodeId {
                        level: n.level,
                        pos: n.pos,
                    },
                    version: n.version,
                    wraps: [wrap(0)?, wrap(1)?],
                })
            })
            .collect()
    }
}

/// What a member does with the bands on their path: climb from their leaf key to C.
///
/// `bands` is the path from the top down, as `path` lists it for the height the top band
/// says the tree has; anything else is refused before a wrap is tried, so a band that is
/// not where the member's path goes cannot stand in for one that is.
pub fn climb_bands(
    bands: &[Band],
    leaf: u64,
    leaf_key: [u8; 32],
    channel_id: &str,
) -> Result<ContentKey, String> {
    let top = bands.first().ok_or("no bands to climb")?;
    if !top.top || bands[1..].iter().any(|b| b.top) {
        return Err("the first band, and only the first, must be the top".into());
    }
    let height = top.height().ok_or("the top band holds no nodes")?;
    if leaf >> height != 0 {
        return Err(format!("leaf {leaf} is outside a tree of height {height}"));
    }
    let expected = path(leaf, height);
    let got: Vec<BandId> = bands.iter().map(Band::id).collect();
    if got != expected {
        return Err(format!("bands {got:?} are not the path {expected:?}"));
    }
    let mut nodes: HashMap<NodeId, NodeRecord> = HashMap::new();
    for band in bands {
        for record in band.records()? {
            nodes.insert(record.id, record);
        }
    }
    climb(|id| nodes.get(&id), leaf, height, leaf_key, channel_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::{leaf_key, Tree};

    const APP_KEY: [u8; 32] = [42u8; 32];
    const CHANNEL: &str = "chan";

    fn seed(i: u64) -> [u8; 32] {
        pin_derive::hkdf32(&i.to_be_bytes(), b"pin:band-test-member")
    }

    fn member_leaf_key(i: u64) -> [u8; 32] {
        let author = pin_crypto::enc_public(&pin_derive::enc_key_seed(&APP_KEY));
        let shared = pin_crypto::enc_shared(&seed(i), &author).unwrap();
        leaf_key(&shared, CHANNEL)
    }

    /// Publish a tree the way an author would — bottom tier first, each band naming the
    /// URLs of the ones beneath — with a band's URL standing in for its upload. Answers
    /// with the bands by URL and the top band's URL.
    fn publish(tree: &Tree) -> (HashMap<String, Band>, String) {
        let height = tree.height();
        let mut by_url = HashMap::new();
        let mut url_of: HashMap<BandId, String> = HashMap::new();
        for (id, records) in layout(tree.records(&APP_KEY, CHANNEL).unwrap()) {
            let children = id
                .children(height)
                .into_iter()
                .map(|c| url_of[&c].clone())
                .collect();
            let band = Band::new(id, height, &records, children);
            // Through JSON, as a member receives it.
            let band: Band = serde_json::from_slice(&serde_json::to_vec(&band).unwrap()).unwrap();
            let url = format!("sia://band/{}/{}", id.tier, id.pos);
            url_of.insert(id, url.clone());
            by_url.insert(url, band);
        }
        let top = url_of[&BandId::top(height)].clone();
        (by_url, top)
    }

    /// What a member does: read the top, then follow URLs down their path.
    fn walk(bands: &HashMap<String, Band>, top: &str, leaf: u64) -> Vec<Band> {
        let mut out = vec![bands[top].clone()];
        let height = out[0].height().unwrap();
        for next in &path(leaf, height)[1..] {
            let url = out.last().unwrap().child_url(*next).unwrap().to_string();
            out.push(bands[&url].clone());
        }
        out
    }

    #[test]
    fn every_member_climbs_through_the_bands_at_every_height() {
        // Across the heights where a band boundary falls (4, 8) and either side of them, so
        // a tree with a partial top band and one with a full one are both covered.
        for count in [1u64, 2, 9, 16, 17, 100, 256, 257] {
            let mut tree = Tree::new();
            let seated: Vec<(u64, u64)> = (0..count)
                .map(|i| (i, tree.add(pin_crypto::enc_public(&seed(i)))))
                .collect();
            // A removal, so the versions on one path are not all 0.
            tree.remove(seated[0].1).unwrap();
            let (bands, top) = publish(&tree);
            let c = ContentKey {
                epoch: tree.epoch(),
                key: pin_derive::channel_content_key(&APP_KEY, CHANNEL, tree.epoch()),
            };
            for &(member, leaf) in &seated[1..] {
                let path = walk(&bands, &top, leaf);
                assert_eq!(
                    climb_bands(&path, leaf, member_leaf_key(member), CHANNEL).unwrap(),
                    c,
                    "{count} members, member {member}"
                );
            }
            let (member, leaf) = seated[0];
            let path = walk(&bands, &top, leaf);
            assert!(climb_bands(&path, leaf, member_leaf_key(member), CHANNEL).is_err());
        }
    }

    #[test]
    fn a_band_holds_four_levels_and_names_sixteen_beneath() {
        let mut tree = Tree::new();
        for i in 0..300 {
            tree.add(pin_crypto::enc_public(&seed(i)));
        }
        assert_eq!(tree.height(), 9);
        let (bands, top) = publish(&tree);
        for band in bands.values() {
            assert!(band.nodes.len() <= 15, "{:?}", band.id());
            assert!(band.children.len() <= 16, "{:?}", band.id());
            let levels: Vec<u8> = band.nodes.iter().map(|n| n.level).collect();
            let low = 4 * band.tier + 1;
            assert!(levels.iter().all(|l| (low..low + 4).contains(l)));
            for node in &band.nodes {
                let at = NodeId {
                    level: node.level,
                    pos: node.pos,
                };
                assert_eq!(BandId::of(at), band.id());
            }
        }
        // Height 9: tier 2 holds the root alone, over two tier-1 bands of sixteen tier-0
        // bands each.
        assert_eq!(bands[&top].id(), BandId { tier: 2, pos: 0 });
        assert_eq!(bands[&top].nodes.len(), 1);
        assert_eq!(bands[&top].children.len(), 2);
        assert_eq!(bands.len(), 1 + 2 + 32);
    }

    #[test]
    fn a_band_keeps_its_address_when_the_tree_grows() {
        let node = NodeId { level: 3, pos: 5 };
        assert_eq!(BandId::of(node), BandId { tier: 0, pos: 2 });
        // The same node in a taller tree is in the same band; only the top moves.
        assert_eq!(BandId::top(4), BandId { tier: 0, pos: 0 });
        assert_eq!(BandId::top(5), BandId { tier: 1, pos: 0 });
        assert_eq!(path(37, 4), vec![BandId { tier: 0, pos: 2 }]);
        assert_eq!(
            path(37, 5),
            vec![BandId { tier: 1, pos: 0 }, BandId { tier: 0, pos: 2 }]
        );
    }

    #[test]
    fn bands_off_the_member_s_path_are_refused_before_any_wrap_is_tried() {
        let mut tree = Tree::new();
        let seated: Vec<(u64, u64)> = (0..40)
            .map(|i| (i, tree.add(pin_crypto::enc_public(&seed(i)))))
            .collect();
        let (bands, top) = publish(&tree);
        let (member, leaf) = seated[3];
        let mut path = walk(&bands, &top, leaf);
        // Another member's tier-0 band in place of this one's.
        let elsewhere = walk(&bands, &top, seated[35].1);
        path[1] = elsewhere[1].clone();
        let err = climb_bands(&path, leaf, member_leaf_key(member), CHANNEL).unwrap_err();
        assert!(err.contains("not the path"), "{err}");
        // The path without its top: the tier-0 band would read as a tree of height 4.
        let path = walk(&bands, &top, leaf);
        let err = climb_bands(&path[1..], leaf, member_leaf_key(member), CHANNEL).unwrap_err();
        assert!(err.contains("must be the top"), "{err}");
        // A band names only the bands directly beneath it.
        let top_band = &bands[&top];
        assert!(top_band.child_url(BandId { tier: 0, pos: 2 }).is_some());
        assert!(top_band.child_url(BandId { tier: 0, pos: 99 }).is_none());
        assert!(top_band.child_url(BandId { tier: 1, pos: 0 }).is_none());
    }

    #[test]
    fn a_band_crosses_as_these_keys() {
        let band = Band::new(
            BandId { tier: 1, pos: 0 },
            5,
            &[NodeRecord {
                id: NodeId { level: 5, pos: 0 },
                version: 2,
                wraps: [vec![1], vec![2]],
            }],
            vec!["sia://x".into()],
        );
        let json = serde_json::to_value(&band).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(keys, ["children", "nodes", "pos", "tier", "top"]);
        let mut node: Vec<&str> = json["nodes"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        node.sort();
        assert_eq!(node, ["level", "pos", "version", "wraps"]);
        // A band below the top carries no flag, and a tier-0 band no children field.
        let leafward = Band::new(BandId { tier: 0, pos: 0 }, 5, &[], Vec::new());
        let leafward = serde_json::to_value(&leafward).unwrap();
        assert!(leafward.get("children").is_none());
        assert!(leafward.get("top").is_none());
    }
}
