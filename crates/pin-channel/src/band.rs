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

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::tree::{climb, NodeId, NodeRecord, Tree};
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

/// How many bands a tier of a tree this tall holds: one per node at its apex level, or
/// the one band on top when the apex is above the root.
fn tier_width(tier: u8, height: u8) -> u64 {
    let apex = apex_level(tier);
    if apex >= height {
        1
    } else {
        1u64 << (height - apex)
    }
}

/// The interior nodes a band holds in a tree this tall, lowest level first.
fn nodes_of(id: BandId, height: u8) -> Vec<NodeId> {
    let low = BAND_LEVELS * id.tier + 1;
    let high = (low + BAND_LEVELS - 1).min(height);
    let apex = apex_level(id.tier);
    let mut out = Vec::new();
    for level in low..=high {
        let span = 1u64 << (apex - level);
        let width = 1u64 << (height - level);
        let first = id.pos * span;
        out.extend((first..(first + span).min(width)).map(|pos| NodeId { level, pos }));
    }
    out
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

/// A tree on its way to being published: what each band would say, and the band itself
/// for the ones that have to be uploaded.
///
/// Split so a publisher can decide WHICH bands to upload before paying for any of them. A
/// band's records are sealed under fresh nonces and so cannot be compared with last time's;
/// its fingerprint is taken over what decides them instead, and only a band whose
/// fingerprint moved is built. Bottom tier first, because a band names the URLs of the ones
/// beneath it — so a change anywhere moves every band above it, up to the top, and nothing
/// else.
pub struct Publication<'t> {
    tree: &'t Tree,
    app_key: [u8; 32],
    channel_id: String,
    occupied: HashSet<NodeId>,
}

/// The leading tag of a band's fingerprint, so a change to what goes into one is a change
/// to every fingerprint rather than a silent collision with the old ones.
const FINGERPRINT_FORMAT: &str = "pin.members-band.v1";

impl<'t> Publication<'t> {
    pub fn new(tree: &'t Tree, app_key: &[u8; 32], channel_id: &str) -> Self {
        Publication {
            tree,
            app_key: *app_key,
            channel_id: channel_id.to_string(),
            occupied: tree.occupied(),
        }
    }

    pub fn top(&self) -> BandId {
        BandId::top(self.tree.height())
    }

    /// The epoch the bands are published at: the tree's.
    pub fn epoch(&self) -> u32 {
        self.tree.epoch()
    }

    /// Every band of one tier.
    pub fn bands_in(&self, tier: u8) -> Vec<BandId> {
        (0..tier_width(tier, self.tree.height()))
            .map(|pos| BandId { tier, pos })
            .collect()
    }

    /// The URLs a band names, from where the bands beneath it ended up. An error when one
    /// of them has none, since a band published without a child would cut every member
    /// beneath it off.
    pub fn children_urls(
        &self,
        id: BandId,
        urls: &HashMap<BandId, String>,
    ) -> Result<Vec<String>, String> {
        id.children(self.tree.height())
            .into_iter()
            .map(|child| {
                urls.get(&child)
                    .cloned()
                    .ok_or_else(|| format!("band {child:?} has no URL yet"))
            })
            .collect()
    }

    /// What a band would say: equal to last time's exactly when it would hold the same
    /// records — up to the nonces their seals draw — and name the same bands beneath it.
    pub fn fingerprint(&self, id: BandId, children: &[String]) -> String {
        let height = self.tree.height();
        let mut out = format!(
            "{FINGERPRINT_FORMAT}|{}|{}|{}",
            id.tier,
            id.pos,
            u8::from(id == BandId::top(height))
        );
        for node in nodes_of(id, height) {
            out.push('|');
            out.push_str(&self.tree.node_substance(node, &self.occupied));
        }
        for url in children {
            out.push('|');
            out.push_str(url);
        }
        pin_crypto::content_hash(out.as_bytes())
    }

    /// A band, built: its records sealed for the members beneath it.
    pub fn band(&self, id: BandId, children: Vec<String>) -> Result<Band, String> {
        let height = self.tree.height();
        let records = nodes_of(id, height)
            .into_iter()
            .map(|node| {
                self.tree
                    .record_with(&self.app_key, &self.channel_id, node, &self.occupied)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Band::new(id, height, &records, children))
    }
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

    /// An author publishing through `Publication`, as the Curator will: bottom tier first,
    /// a band uploaded only when its fingerprint moved, with a fresh URL standing in for
    /// each upload. Every band ever uploaded stays readable by its URL, as a generation a
    /// reader may still hold does.
    #[derive(Default)]
    struct Author {
        published: HashMap<BandId, (String, String)>,
        by_url: HashMap<String, Band>,
        uploads: usize,
    }

    impl Author {
        /// Publish, answering with the bands uploaded this time and the top band's URL.
        fn publish(&mut self, tree: &Tree) -> (Vec<BandId>, String) {
            let plan = Publication::new(tree, &APP_KEY, CHANNEL);
            let mut urls: HashMap<BandId, String> = HashMap::new();
            let mut uploaded = Vec::new();
            for tier in 0..=plan.top().tier {
                for id in plan.bands_in(tier) {
                    let children = plan.children_urls(id, &urls).unwrap();
                    let fp = plan.fingerprint(id, &children);
                    match self.published.get(&id) {
                        Some((held, url)) if *held == fp => {
                            urls.insert(id, url.clone());
                        }
                        _ => {
                            let band = plan.band(id, children).unwrap();
                            let band: Band =
                                serde_json::from_slice(&serde_json::to_vec(&band).unwrap())
                                    .unwrap();
                            self.uploads += 1;
                            let url = format!("sia://upload/{}", self.uploads);
                            self.by_url.insert(url.clone(), band);
                            self.published.insert(id, (fp, url.clone()));
                            urls.insert(id, url);
                            uploaded.push(id);
                        }
                    }
                }
            }
            (uploaded, urls[&plan.top()].clone())
        }

        fn climbs(&self, top: &str, member: u64, leaf: u64) -> Result<ContentKey, String> {
            climb_bands(
                &walk(&self.by_url, top, leaf),
                leaf,
                member_leaf_key(member),
                CHANNEL,
            )
        }
    }

    fn content_key(tree: &Tree) -> ContentKey {
        ContentKey {
            epoch: tree.epoch(),
            key: pin_derive::channel_content_key(&APP_KEY, CHANNEL, tree.epoch()),
        }
    }

    #[test]
    fn a_publication_builds_the_bands_the_layout_groups() {
        // Two routes to one answer: the planner enumerates each band's nodes from its
        // address, the layout groups every record the tree publishes.
        for count in [1u64, 5, 17, 300] {
            let mut tree = Tree::new();
            for i in 0..count {
                tree.add(pin_crypto::enc_public(&seed(i)));
            }
            let grouped = layout(tree.records(&APP_KEY, CHANNEL).unwrap());
            let plan = Publication::new(&tree, &APP_KEY, CHANNEL);
            let mut planned = Vec::new();
            for tier in 0..=plan.top().tier {
                planned.extend(plan.bands_in(tier));
            }
            assert_eq!(
                planned,
                grouped.keys().copied().collect::<Vec<_>>(),
                "{count}"
            );
            for (id, records) in grouped {
                let ids: Vec<NodeId> = records.iter().map(|r| r.id).collect();
                assert_eq!(nodes_of(id, tree.height()), ids, "{count} {id:?}");
            }
        }
    }

    #[test]
    fn nothing_moved_uploads_nothing() {
        let mut tree = Tree::new();
        for i in 0..40 {
            tree.add(pin_crypto::enc_public(&seed(i)));
        }
        let mut author = Author::default();
        let (first, top) = author.publish(&tree);
        assert_eq!(first.len(), 1 + 4, "a top band over four tier-0 bands");
        let (again, same_top) = author.publish(&tree);
        assert!(again.is_empty(), "{again:?}");
        assert_eq!(same_top, top);
    }

    #[test]
    fn a_removal_uploads_one_band_per_tier_and_only_its_member_is_out() {
        let mut tree = Tree::new();
        let seated: Vec<(u64, u64)> = (0..300)
            .map(|i| (i, tree.add(pin_crypto::enc_public(&seed(i)))))
            .collect();
        let mut author = Author::default();
        author.publish(&tree);

        let (gone, gone_leaf) = seated[123];
        tree.remove(gone_leaf).unwrap();
        let (uploaded, top) = author.publish(&tree);
        let mut expected = path(gone_leaf, tree.height());
        expected.reverse();
        assert_eq!(uploaded, expected);

        let c = content_key(&tree);
        for &(member, leaf) in &seated {
            if member == gone {
                assert!(author.climbs(&top, member, leaf).is_err());
            } else {
                assert_eq!(
                    author.climbs(&top, member, leaf).unwrap(),
                    c,
                    "member {member}"
                );
            }
        }
    }

    #[test]
    fn a_join_uploads_only_its_own_path() {
        // No key moves when somebody joins, so only the wraps on their path change: filler
        // becomes a wrap for them.
        let mut tree = Tree::new();
        for i in 0..40 {
            tree.add(pin_crypto::enc_public(&seed(i)));
        }
        let mut author = Author::default();
        author.publish(&tree);
        let leaf = tree.add(pin_crypto::enc_public(&seed(40)));
        let (uploaded, top) = author.publish(&tree);
        let mut expected = path(leaf, tree.height());
        expected.reverse();
        assert_eq!(uploaded, expected);
        assert_eq!(author.climbs(&top, 40, leaf).unwrap(), content_key(&tree));
        assert_eq!(author.climbs(&top, 0, 0).unwrap(), content_key(&tree));
    }

    #[test]
    fn growing_past_a_band_republishes_the_old_top_and_adds_a_new_one() {
        // Sixteen members fill a height-4 tree whose top is tier 0; the seventeenth grows it
        // to height 5. The old top's apex stops being the root, so its key, and the band,
        // changes; the new member's tier-0 band and the new top are new.
        let mut tree = Tree::new();
        for i in 0..16 {
            tree.add(pin_crypto::enc_public(&seed(i)));
        }
        let mut author = Author::default();
        author.publish(&tree);
        let leaf = tree.add(pin_crypto::enc_public(&seed(16)));
        assert_eq!(tree.height(), 5);
        let (mut uploaded, top) = author.publish(&tree);
        uploaded.sort();
        assert_eq!(
            uploaded,
            [
                BandId { tier: 0, pos: 0 },
                BandId { tier: 0, pos: 1 },
                BandId { tier: 1, pos: 0 },
            ]
        );
        let c = content_key(&tree);
        assert_eq!(author.climbs(&top, 16, leaf).unwrap(), c);
        assert_eq!(author.climbs(&top, 3, 3).unwrap(), c);
    }

    #[test]
    fn a_fingerprint_moves_with_every_input() {
        let mut tree = Tree::new();
        for i in 0..20 {
            tree.add(pin_crypto::enc_public(&seed(i)));
        }
        let id = BandId { tier: 0, pos: 1 };
        let fp = |t: &Tree| Publication::new(t, &APP_KEY, CHANNEL).fingerprint(id, &[]);
        let base = fp(&tree);
        // Same inputs, same fingerprint, though every seal would draw new nonces.
        assert_eq!(base, fp(&tree));
        // A child's URL.
        let top = BandId { tier: 1, pos: 0 };
        let plan = Publication::new(&tree, &APP_KEY, CHANNEL);
        assert_ne!(
            plan.fingerprint(top, &["a".into(), "b".into()]),
            plan.fingerprint(top, &["a".into(), "c".into()])
        );
        // A removal beneath it, and then a different member in the hole it left.
        let mut removed = tree.clone();
        removed.remove(17).unwrap();
        let mut swapped = removed.clone();
        swapped.add(pin_crypto::enc_public(&seed(99)));
        assert_ne!(fp(&removed), base);
        assert_ne!(fp(&swapped), fp(&removed));
        // Another member at the same leaf with no removal between: two devices seating at
        // once, and the roster settling the leaf on the other one.
        let mut other = Tree::new();
        for i in 0..20 {
            other.add(pin_crypto::enc_public(&seed(if i == 17 { 99 } else { i })));
        }
        assert_ne!(fp(&other), base);
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
