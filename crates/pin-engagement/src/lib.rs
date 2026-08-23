//! Engagement records — the signed, countable facts a displayed number is made of.
//!
//! The pattern is atproto's stand-off shape with its two centralized pieces swapped
//! out. There: the engager writes a like into their own repo, their PDS emits it on the
//! firehose, an AppView reverse-indexes it, and the author asks the AppView for a
//! number. Here: the engager writes the record into their own directory, tells the
//! author directly (`/hey`) or lets the author's crawl find it, and the author indexes
//! it themselves. Firehose becomes directed delivery; AppView becomes the person whose
//! surface it is.
//!
//! The trade that buys is deliberate and worth stating: atproto's count is COMPLETE but
//! not really checkable (you take the AppView's word), and this one is CHECKABLE but
//! incomplete (only what reached you). A count here is always a claim with receipts
//! attached — never a number to be trusted on its own.
//!
//! Two properties do most of the work:
//!
//! **The actor's identifier IS their public key.** A `did:dht` is z-base32 ed25519, so
//! verifying a record needs nothing but the string it carries — no lookup, no packet, no
//! prior contact. That is what makes engagement from a stranger cheap: their knock
//! arrives with a record we can check on the spot, and we never fetch them at all.
//!
//! **A subject is a hash, so one record shape serves every visibility tier.** Matching
//! is done by recomputing the hash over items you already hold. For a public post the
//! plaintext coordinates ride alongside so the record stays navigable; for an unlisted
//! one they are simply absent, and the count is exact for the people holding K while
//! revealing nothing to anybody else.
//!
//! What this crate does NOT decide: where a record is stored (pin-derive owns the
//! addresses), who goes looking for one (pin-curator), or what a count is displayed as.

use serde::{Deserialize, Serialize};

/// A like: pure signal, no payload beyond its own existence.
pub const KIND_LIKE: &str = "like";

/// A pin: the same signal, and also a byte-level commitment to keep the thing alive.
///
/// Mixed on purpose, and the count means something a like count doesn't — redundancy.
/// The author is pin #1 because publishing already put the bytes in their own Sia scope,
/// so a fresh post reads 1 rather than 0; every pin after that is another party who
/// would keep it alive if the author retracted. So the number answers "how many copies
/// are being paid for", which is Pin's whole thesis stated as a figure.
pub const KIND_PIN: &str = "pin";

/// A repost: circulating the thing in one of your own channels. Actor-keyed like the
/// others, so the figure is reposters rather than reposts.
pub const KIND_REPOST: &str = "repost";

/// A comment: the one kind whose payload is the point rather than its existence.
///
/// Post-shaped — text, plus attachments the commenter goes on carrying — addressed at a
/// subject. The host integrates the words into their own channel and keeps the signed
/// record as the receipt, exactly as they keep a like's. Which is why this is a `kind` on
/// the same envelope rather than a record type of its own: `kind` is inside the signed
/// bytes, so a like's signature can never be replayed as a comment's.
pub const KIND_COMMENT: &str = "comment";

/// The ceiling on a comment's body, in BYTES rather than characters.
///
/// An allocation bound, not a UX limit — a composer is free to insist on far less. The
/// host publishes a comment's words into their own channel, so a body is bytes the SENDER
/// chose and the RECEIVER pays for, which is the one thing a knock must never get to do
/// without limit. Bytes because bytes are what get allocated; counting characters would
/// leave the real figure a factor of four away.
///
/// Raising it later is safe, since every record already under it stays valid. Lowering it
/// invalidates records that were legitimate when they were signed, so it is a one-way door
/// in practice.
pub const MAX_BODY_BYTES: usize = 4096;

/// The domain tag every signed message starts with.
///
/// Not decoration. The same identity key signs pkarr packets, and an unprefixed message
/// is one whose signature could in principle be valid in some other protocol that
/// happens to produce the same bytes. A fixed ASCII prefix makes that impossible for
/// free, and the version in it means a future layout change cannot be mistaken for this
/// one.
const SIGNING_DOMAIN: &[u8] = b"pin.engagement.v1";

/// The domain tag a withdrawal signs under.
///
/// Different from the endorsement's, and that is the whole point rather than tidiness. A
/// retraction covers a subset of an endorsement's fields, so under one domain a signature
/// made over `kind || subject || createdAt` would verify as either — and an attacker
/// holding somebody's endorsement could replay it as the withdrawal of that same
/// endorsement, or the reverse. Separate domains make the two signatures disjoint by
/// construction.
const RETRACTION_DOMAIN: &[u8] = b"pin.retraction.v1";

/// The signed-bytes tag for a comment's body.
const TAG_BODY: &str = "body";

/// The signed-bytes tag for the record a retraction names.
const TAG_TARGET: &str = "target";

/// The wire marker that says a record withdraws rather than asserts.
///
/// Explicit, because the alternative is sniffing structure — "no `version` field, so it
/// must be a retraction" — and this codebase has been bitten twice by inferring meaning
/// from which fields a serializer happened to emit. Absence means endorsement, since
/// endorsements are already published in directories without a marker and adding one
/// would invalidate every signature and every directory already written.
pub const OP_RETRACT: &str = "retract";

/// A record's plaintext coordinates, present only when its subject is public.
///
/// UNSIGNED, and self-checking instead. A reader recomputes the subject hash from these
/// fields and ignores them if it doesn't match, so tampering is detected without putting
/// them inside the signature — which would add a normalization surface (whose exact
/// string form must match byte-for-byte across two implementations) for no gain.
///
/// Absent for unlisted and private subjects: that absence IS the tiering. A record with
/// no reference is a countable token and nothing more, so it can be published in the
/// open without revealing which channel it is about, or that the channel exists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SubjectRef {
    #[serde(rename = "didDht")]
    pub did_dht: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    /// Set when the subject is one ATTACHMENT of that post rather than the post: the
    /// attachment's content hash, which is what names it. Absent means the post itself.
    ///
    /// Part of the self-check, so it cannot be added or removed to make a record point at
    /// something else — the two subject derivations are different functions, and only one
    /// of them reproduces the subject the record carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<String>,
}

/// One signed endorsement, as it travels in a directory blob or a knock.
///
/// Field names are a contract with readers on the other side of a JSON boundary that no
/// compiler checks, so they are renamed explicitly rather than derived and pinned by a
/// test. This codebase has already shipped a field whose share URL arrived under a name
/// nothing read, because `rename_all = "camelCase"` knows word boundaries and not
/// acronyms.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Endorsement {
    /// What was asserted: `like`, `pin`, `repost`, or something a future version added.
    /// Open by design — a reader folds the kinds it understands and ignores the rest, so a
    /// new gesture needs no coordinated upgrade.
    pub kind: String,
    /// Who asserted it, as a `did:dht:` string. Also the verification key.
    pub actor: String,
    /// What it is about: `pin_crypto::engagement_subject(channelID, publishedAt)`.
    pub subject: String,
    /// Which version of the item it was made against — the item's plaintext content
    /// hash. The subject survives an edit deliberately (an endorsement shouldn't
    /// evaporate because the author fixed a typo), so this is what records that the
    /// wording has moved since.
    pub version: String,
    /// When the actor says they made it. SELF-ASSERTED and not to be trusted for
    /// ordering — the same caveat atproto's `createdAt` carries, which is why AppViews
    /// order by their own observation time. It is signed, so it can't be altered by
    /// anyone else, and it is what a retraction is compared against.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Base64 ed25519 over `signing_bytes`.
    pub sig: String,
    /// Plaintext coordinates, for a public subject only. `ref` in the wire form; the
    /// Rust name differs because `ref` is a keyword.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<SubjectRef>,
    /// A comment's text, INLINE and inside the signature. Absent on every other kind.
    ///
    /// Inline rather than behind a pointer, on arithmetic: this record is ~300 bytes and so
    /// is a 280-character comment, so a pointer would buy an upload against Sia's 1-byte
    /// floor, a slab, a share URL, and a second fetch per comment for every reader. Inline
    /// also gets three things a pointer cannot — the words are tamper-evident because they
    /// are signed, they arrive whole in a knock so a stranger's comment is one exchange,
    /// and they cannot dangle, where a pointed-at body is deletable out from under a record
    /// the host is displaying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Where the same words sit as a Sia object of their own — a CUSTODY handle, never the
    /// read path.
    ///
    /// The words render from `body`, so nothing needs this to display a comment. What it
    /// buys is that a comment can be PINNED: taking custody means paying to keep specific
    /// bytes alive, and bytes inside an aggregate blob that is superseded on every write
    /// have no address anyone can hold. Minting one makes a comment content in the same
    /// sense a post is, and makes its author pin #1 on it for the same reason an author is
    /// pin #1 on their own post — publishing put the bytes in their own scope.
    ///
    /// UNSIGNED, and self-checking instead: a reader hashes what it fetched and compares it
    /// to the `body` the signature covers, so a swapped URL is detectable without putting a
    /// URL inside the signed bytes. That matters because repack rewrites URLs while
    /// preserving plaintext — signing one would make the commenter's own repack invalidate
    /// every comment they had ever written.
    ///
    /// Absent until the actor's own Curator has minted it, and absent forever on a comment
    /// whose author never ran one. A reader shows the words either way and offers custody
    /// only when there is something to take custody of.
    #[serde(rename = "bodyURL", default, skip_serializing_if = "Option::is_none")]
    pub body_url: Option<String>,
}

/// Append a length-prefixed field. Length-delimited rather than separated, so no field's
/// content can be mistaken for a boundary.
fn push_field(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
}

/// Append an OPTIONAL field, naming itself.
///
/// Absent appends NOTHING, which is what makes a new field back-compatible: a record
/// signed before the field existed produces byte-identical bytes, so nothing already
/// published stops verifying. Present appends the tag and then the value, and the length
/// prefixes mean neither can be mistaken for a longer version of the field before it.
///
/// THE TAG IS THE LOAD-BEARING PART, and it is why this is not `push_field` behind an `if`.
/// Two untagged optional trailing fields are ambiguous: with `body` and some later `name`
/// both optional, a record carrying only the name and a record carrying only a body of the
/// same text append exactly the same bytes — so a signed name claim would verify as a
/// comment body, and the reverse. Tagging makes them disjoint by construction, which is
/// what lets this layout keep gaining fields without ever needing a v2.
fn push_tagged(out: &mut Vec<u8>, tag: &str, value: Option<&str>) {
    if let Some(v) = value {
        push_field(out, tag);
        push_field(out, v);
    }
}

impl Endorsement {
    /// The exact bytes a signature covers.
    ///
    /// A length-delimited concatenation, NOT serialized JSON. Signing JSON would make a
    /// signature depend on key order, on which absent fields are omitted, and on whether
    /// each side's serializer sorts — and this codebase has been bitten twice by exactly
    /// that class (a renamed field, and `serde_json::Value` sorting keys where
    /// JavaScript preserves insertion order). This layout is byte-stable by
    /// construction, so the wire form stays free to gain fields without invalidating
    /// anything already signed.
    ///
    /// `actor` is deliberately NOT covered. The actor's key is what verifies the
    /// signature, so authenticity is already bound to it; including the string would add
    /// a normalization hazard — prefixed `did:dht:x` against bare `x` — with nothing
    /// gained. `ref` is not covered either, for the reason on `SubjectRef`.
    ///
    /// `body` IS covered, as a tagged optional trailing field — see `push_tagged` for why
    /// the tag rather than a bare append. A record without one signs exactly the bytes it
    /// signed before the field existed.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(SIGNING_DOMAIN.len() + 64);
        out.extend_from_slice(SIGNING_DOMAIN);
        push_field(&mut out, &self.kind);
        push_field(&mut out, &self.subject);
        push_field(&mut out, &self.version);
        push_field(&mut out, &self.created_at);
        push_tagged(&mut out, TAG_BODY, self.body.as_deref());
        out
    }

    /// Build and sign a gesture from the identity seed the actor is derived from.
    pub fn sign(
        did_dht_seed: &[u8],
        kind: &str,
        subject: &str,
        version: &str,
        created_at: &str,
        reference: Option<SubjectRef>,
    ) -> Result<Self, String> {
        Self::signed(
            did_dht_seed,
            kind,
            subject,
            version,
            created_at,
            reference,
            None,
        )
    }

    /// Build and sign a comment.
    ///
    /// Its own constructor rather than a `body: Option<&str>` on `sign`, because a comment
    /// REQUIRES a body: taking `&str` here makes that a fact about the type instead of a
    /// check somebody has to remember, and it keeps every gesture call site free of a
    /// `None` that means nothing to it.
    pub fn sign_comment(
        did_dht_seed: &[u8],
        subject: &str,
        version: &str,
        created_at: &str,
        reference: Option<SubjectRef>,
        body: &str,
    ) -> Result<Self, String> {
        Self::signed(
            did_dht_seed,
            KIND_COMMENT,
            subject,
            version,
            created_at,
            reference,
            Some(body),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn signed(
        did_dht_seed: &[u8],
        kind: &str,
        subject: &str,
        version: &str,
        created_at: &str,
        reference: Option<SubjectRef>,
        body: Option<&str>,
    ) -> Result<Self, String> {
        let mut record = Endorsement {
            kind: kind.to_string(),
            actor: format!("did:dht:{}", pin_pkarr::public_key_from_seed(did_dht_seed)?),
            subject: subject.to_string(),
            version: version.to_string(),
            created_at: created_at.to_string(),
            sig: String::new(),
            reference,
            body: body.map(str::to_string),
            body_url: None,
        };
        record.sig = pin_pkarr::sign_detached(did_dht_seed, &record.signing_bytes())?;
        Ok(record)
    }

    /// This comment's own identity: what addresses it, what engagement on it names, and
    /// what a repost portal into it carries.
    ///
    /// Meaningless on a gesture, which is a singleton at its address and so needs no
    /// discriminator — that singleton is exactly what a comment breaks, since one actor
    /// can leave several on one subject.
    pub fn comment_id(&self) -> String {
        pin_crypto::comment_subject(&self.actor, &self.created_at)
    }

    /// Whether this record holds up: signed by the identity it claims, and consistent
    /// with the coordinates it carries.
    ///
    /// One call rather than two, because the failure mode of forgetting half of it is
    /// counting a forgery. Costs no network — see the crate docs.
    pub fn verify(&self) -> Result<(), String> {
        self.check_shape()?;
        pin_pkarr::verify_detached(&self.actor, &self.signing_bytes(), &self.sig)?;
        if let Some(r) = &self.reference {
            let expected = match &r.attachment {
                Some(hash) => pin_crypto::attachment_subject(&r.channel_id, &r.published_at, hash),
                None => pin_crypto::engagement_subject(&r.channel_id, &r.published_at),
            };
            if expected != self.subject {
                return Err("reference does not hash to the subject it claims".into());
            }
        }
        Ok(())
    }

    /// Whether the payload is what the kind says it is.
    ///
    /// Ahead of the signature check deliberately: an oversized body is refused without
    /// spending an ed25519 verification on it, and the whole point of the limit is to not
    /// do work proportional to what a sender chose.
    ///
    /// The known gestures are held to carrying NO body, because allowing one would take a
    /// like from ~300 bytes to a possible 4 KiB in the log — a thirteenfold amplification
    /// for a record whose entire content is its own existence. Unknown kinds are left alone
    /// on purpose: the fold ignores what it does not understand, so a rule here would make
    /// this crate the thing that has to ship before anyone can add a kind that carries
    /// something.
    fn check_shape(&self) -> Result<(), String> {
        match self.kind.as_str() {
            KIND_COMMENT => match self.body.as_deref() {
                None | Some("") => Err("a comment carries no body".into()),
                Some(body) if body.len() > MAX_BODY_BYTES => Err(format!(
                    "body is {} bytes, over the {MAX_BODY_BYTES} byte limit",
                    body.len()
                )),
                Some(_) => Ok(()),
            },
            KIND_LIKE | KIND_PIN | KIND_REPOST if self.body.is_some() => {
                Err(format!("a {} carries a body", self.kind))
            }
            _ => Ok(()),
        }
    }

    /// Whether this record supersedes one already held for the same actor and subject.
    ///
    /// Strictly newer only, which is what makes a replayed record harmless: an attacker
    /// re-sending an older signed endorsement (or an older retraction) cannot displace
    /// current state. Equal timestamps keep what is held, since re-applying the same
    /// assertion changes nothing. The same recency-guard shape used for a manifest
    /// arriving by two routes at once.
    pub fn supersedes(&self, held_created_at: &str) -> bool {
        self.created_at.as_str() > held_created_at
    }

    /// This record's leaf in the set commitment.
    ///
    /// The SIGNATURE is what makes two records distinct, and it has to be in here for
    /// that reason. The signed bytes alone cover kind, subject, version and timestamp —
    /// all of which two identities endorsing the same subject in the same millisecond
    /// share — so a set of two would commit as a set of one and a count could be quietly
    /// halved. Signatures are per-key and deterministic, so including it separates them.
    ///
    /// The actor is deliberately NOT in here, and it would be redundant if it were:
    /// `verify` binds the actor string to the key that signed, so among verified records
    /// the signature already determines who. Leaving it out also keeps the leaf free of
    /// the `did:dht:x`-versus-bare-`x` normalization question that the signature itself
    /// avoids.
    ///
    /// Errors only on a signature that isn't base64 — records reaching here are verified,
    /// so this is a guard rather than a path.
    pub fn leaf(&self) -> Result<[u8; 32], String> {
        let sig = pin_crypto::b64_decode(&self.sig).ok_or("signature is not base64")?;
        let mut buf = vec![LEAF_TAG];
        buf.extend_from_slice(&self.signing_bytes());
        buf.extend_from_slice(&sig);
        Ok(sha256(&buf))
    }
}

/// Taking an endorsement back, as something an author can be TOLD.
///
/// Withdrawing removes the record from the actor's own directory, and an author who found
/// it by crawling that directory notices the absence on their next pass. An author who
/// learned of it by knock has no crawl of us at all — that is what a knock is for — so
/// they would go on counting it forever. This is the other half of the push route: the
/// same asymmetry as delivery, in the opposite direction.
///
/// Deliberately not an `Endorsement` with a flag. The two have different signing domains
/// (see `RETRACTION_DOMAIN`), so neither signature can be replayed as the other, and a
/// retraction covers strictly less: no `version`, because taking a gesture back is not
/// specific to the wording it was made against, and no `ref`, because a withdrawal must
/// not reveal a channel the endorsement it withdraws didn't already name.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Retraction {
    /// The literal `retract`, so a receiver can tell the two apart without guessing from
    /// which fields are present.
    pub op: String,
    /// Which gesture is being withdrawn.
    pub kind: String,
    /// Who is withdrawing it. Also the verification key.
    pub actor: String,
    /// What it was about — the same subject the endorsement named.
    pub subject: String,
    /// When it was withdrawn. Compared against the `createdAt` of the endorsement it
    /// withdraws, which is what stops a replayed retraction from undoing a gesture the
    /// actor made again afterwards.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Base64 ed25519 over `signing_bytes`.
    pub sig: String,
    /// WHICH record is being withdrawn, when the address alone does not say.
    ///
    /// A gesture is a singleton per `(subject, kind)`, so "retract my like on S" is
    /// unambiguous and this stays absent. A comment is not: one actor can leave several on
    /// one subject, so a withdrawal has to name the one it means, by that comment's own id.
    ///
    /// It also makes replay harmless rather than defended-against. `withdraws` exists
    /// because a singleton reuses its address, so a stale retraction could undo a gesture
    /// the actor made again afterwards. A named record cannot come back — commenting again
    /// produces a different id — so re-sending a retraction can only re-withdraw something
    /// already gone, which is idempotent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl Retraction {
    /// The exact bytes a signature covers. Same construction as an endorsement's — a
    /// domain tag then length-delimited fields — under a different domain, and without
    /// `version`. `target` rides as a tagged optional field for the same reason `body`
    /// does on an endorsement, and is absent on every withdrawal written before it existed.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(RETRACTION_DOMAIN.len() + 64);
        out.extend_from_slice(RETRACTION_DOMAIN);
        push_field(&mut out, &self.kind);
        push_field(&mut out, &self.subject);
        push_field(&mut out, &self.created_at);
        push_tagged(&mut out, TAG_TARGET, self.target.as_deref());
        out
    }

    /// Build and sign a withdrawal of a gesture, which its address alone identifies.
    pub fn sign(
        did_dht_seed: &[u8],
        kind: &str,
        subject: &str,
        created_at: &str,
    ) -> Result<Self, String> {
        Self::signed(did_dht_seed, kind, subject, created_at, None)
    }

    /// Build and sign the withdrawal of ONE comment, named by its id.
    pub fn sign_comment_withdrawal(
        did_dht_seed: &[u8],
        subject: &str,
        created_at: &str,
        comment_id: &str,
    ) -> Result<Self, String> {
        Self::signed(
            did_dht_seed,
            KIND_COMMENT,
            subject,
            created_at,
            Some(comment_id),
        )
    }

    fn signed(
        did_dht_seed: &[u8],
        kind: &str,
        subject: &str,
        created_at: &str,
        target: Option<&str>,
    ) -> Result<Self, String> {
        let mut record = Retraction {
            op: OP_RETRACT.to_string(),
            kind: kind.to_string(),
            actor: format!("did:dht:{}", pin_pkarr::public_key_from_seed(did_dht_seed)?),
            subject: subject.to_string(),
            created_at: created_at.to_string(),
            sig: String::new(),
            target: target.map(str::to_string),
        };
        record.sig = pin_pkarr::sign_detached(did_dht_seed, &record.signing_bytes())?;
        Ok(record)
    }

    /// Whether this holds up: signed by the identity it names, and saying it is a
    /// withdrawal.
    ///
    /// The `op` check is part of verification rather than of parsing, because a record
    /// that verifies under this domain but claims to be something else is a record whose
    /// author and reader disagree about what was signed.
    pub fn verify(&self) -> Result<(), String> {
        if self.op != OP_RETRACT {
            return Err(format!("not a retraction: op is {:?}", self.op));
        }
        pin_pkarr::verify_detached(&self.actor, &self.signing_bytes(), &self.sig)
    }

    /// Whether this withdraws an endorsement made at the given time.
    ///
    /// Strictly newer, the same rule an endorsement uses. A withdrawal older than the
    /// gesture it names is one the actor made and then changed their mind about — they
    /// endorsed again afterwards — so honouring it would undo a current gesture with a
    /// stale message. Equal keeps what is held for the same reason.
    pub fn withdraws(&self, held_created_at: &str) -> bool {
        self.created_at.as_str() > held_created_at
    }
}

// --- committing to the set a count is made of -----------------------------------
//
// A count is only a claim; what makes it checkable is that the set behind it is
// COMMITTED. Without that, an author asked to justify "12" hands over whichever twelve
// records they like, and sampling proves nothing because they chose the sample. With a
// published root they can't: the root is in the aggregate every subscriber syncs, an
// auditor asks for arbitrary members, and each answer comes with a proof that verifies in
// O(log n) — so a spot check of a hundred records says something about a set of millions.
//
// Certificate Transparency's construction. Leaf and interior hashes are tagged
// differently so an interior node can never be presented as a leaf, and an odd node is
// PROMOTED rather than duplicated — duplicating it (Bitcoin's approach) lets two different
// sets share a root.

const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// The root of an empty set. A named constant rather than zeroes, so "no endorsements"
/// is a value nobody can arrive at by accident or forge by truncation.
pub fn empty_root() -> [u8; 32] {
    sha256(b"pin.engagement.empty.v1")
}

fn parent(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(65);
    buf.push(NODE_TAG);
    buf.extend_from_slice(left);
    buf.extend_from_slice(right);
    sha256(&buf)
}

/// The commitment over a set of leaves, in the order given.
///
/// Order is the caller's and must be deterministic — the fold sorts by actor, which is
/// unique per subject and kind — because a root that depended on iteration order would
/// change on every pass and mean nothing.
pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return empty_root();
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity((level.len() + 1) / 2);
        let mut i = 0;
        while i + 1 < level.len() {
            next.push(parent(&level[i], &level[i + 1]));
            i += 2;
        }
        if i < level.len() {
            // Promoted unchanged. Duplicating it instead would make a set of three and a
            // set of four with a repeated last element commit identically.
            next.push(level[i]);
        }
        level = next;
    }
    level[0]
}

/// The sibling hashes proving one leaf's membership, bottom-up. `None` when the index is
/// out of range.
pub fn inclusion_proof(leaves: &[[u8; 32]], index: usize) -> Option<Vec<[u8; 32]>> {
    if index >= leaves.len() {
        return None;
    }
    let mut proof = Vec::new();
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    let mut idx = index;
    while level.len() > 1 {
        let sibling = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        // A promoted odd node has no sibling at this level and contributes nothing.
        if sibling < level.len() {
            proof.push(level[sibling]);
        }
        let mut next = Vec::with_capacity((level.len() + 1) / 2);
        let mut i = 0;
        while i + 1 < level.len() {
            next.push(parent(&level[i], &level[i + 1]));
            i += 2;
        }
        if i < level.len() {
            next.push(level[i]);
        }
        level = next;
        idx /= 2;
    }
    Some(proof)
}

/// Whether a leaf is in the set a root commits to.
///
/// `total` is the set's size, which the aggregate publishes as its count — needed because
/// the shape of the tree (and so where a promoted node sits) depends on it. That is also
/// what stops a count being inflated past the set: claiming a larger total changes the
/// tree, and the proofs stop verifying.
pub fn verify_inclusion(
    root: &[u8; 32],
    leaf: &[u8; 32],
    index: usize,
    total: usize,
    proof: &[[u8; 32]],
) -> bool {
    if total == 0 || index >= total {
        return false;
    }
    let mut hash = *leaf;
    let mut idx = index;
    let mut level_size = total;
    let mut fed = 0;
    while level_size > 1 {
        let sibling = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        if sibling < level_size {
            let Some(s) = proof.get(fed) else {
                return false;
            };
            fed += 1;
            hash = if idx % 2 == 0 {
                parent(&hash, s)
            } else {
                parent(s, &hash)
            };
        }
        idx /= 2;
        level_size = (level_size + 1) / 2;
    }
    // A proof carrying more hashes than the tree needs is rejected rather than ignored:
    // trailing junk that verified would be a second valid proof for one leaf.
    fed == proof.len() && hash == *root
}

// --- the aggregate a channel publishes ------------------------------------------

/// How many actors an aggregate names inline, so a reader can show a few faces without
/// opening the log. Taken in the set's own sort order rather than by recency, so the
/// record doesn't churn — and every write announces a change to each subscriber syncing
/// the channel doc.
pub const SAMPLE_ACTORS: usize = 5;

/// One kind's tally for one subject.
///
/// `count` is always the size of the set, never a running total. A stored number is fine —
/// this IS stored — but it is a CACHE of a fold, re-derivable from the log at any time,
/// which is what makes an unlike need no decrement message and a duplicate knock harmless.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct KindTally {
    pub count: usize,
    /// Hex commitment over the backing set. Published so an auditor can ask for arbitrary
    /// members: without it, the holder chooses the sample and a spot check proves nothing.
    #[serde(rename = "setRoot")]
    pub set_root: String,
    #[serde(rename = "sampleActors")]
    pub sample_actors: Vec<String>,
    /// When this identity last re-read the actors' own records to confirm the endorsements
    /// still stand. Published rather than hidden: retention is the one thing a holder
    /// can't prove by holding a signature, so how stale the check is belongs in the open.
    /// Absent means never — a set built from records that arrived by delivery and have not
    /// been re-checked at source.
    #[serde(rename = "retentionCheckedAt", skip_serializing_if = "Option::is_none")]
    pub retention_checked_at: Option<String>,
}

/// Everything published about one subject: a tally per kind, so rendering a row is one
/// read rather than a scan. Kinds are open, and a reader ignores what it doesn't know.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Aggregate {
    pub kinds: std::collections::BTreeMap<String, KindTally>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// How many of one subject's comments get published.
///
/// A replication bound rather than an opinion about conversation. The published conversation
/// is one entry in the channel's doc, which syncs in full to every subscriber — so what this
/// caps is what a reader downloads to open a post, and a body ceiling alone would still let
/// one busy post push megabytes at everybody.
///
/// The cap is applied where a subject's comments are GATHERED, so the count and the
/// conversation are made of the same set: a tally claiming more than the conversation shows
/// would be a number whose backing set the holder had, in part, chosen not to produce.
pub const MAX_CONVERSATION: usize = 100;

/// One subject's published conversation: the signed comments themselves.
///
/// Verbatim, so a reader verifies each one against the actor's own key rather than trusting
/// whoever published the page it appears on. That is the same reason a directory carries
/// endorsements untouched, and it is what makes an integrated comment attributable to the
/// person who wrote it instead of to the host who displays it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Conversation {
    pub comments: Vec<Endorsement>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// The comments of one subject that get published, newest first, and how many were left out.
///
/// Newest first because that is the half of a long thread anybody reads, and deterministic
/// because two instances of the same identity holding the same log must publish the same set
/// — otherwise they would take turns rewriting one entry with different roots. Ties break on
/// the signature, which is what separates two records that agree on every other field.
///
/// The count of what was dropped is returned rather than discarded: a cap nobody is told
/// about reads as complete.
pub fn newest_comments(mut records: Vec<Endorsement>) -> (Vec<Endorsement>, usize) {
    records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.sig.cmp(&a.sig))
    });
    let dropped = records.len().saturating_sub(MAX_CONVERSATION);
    records.truncate(MAX_CONVERSATION);
    (records, dropped)
}

/// Fold a set of VERIFIED records for one subject into its published tally.
///
/// Verification is the caller's — it happens once, when a record arrives — and this must
/// only ever be handed records that passed, since a count is an assertion that its
/// backing set is real.
///
/// Sorted by actor before committing: one record per actor per kind (the address enforces
/// it), so this is a total order, and a deterministic one is what lets a root mean
/// anything across two instances of the same identity.
pub fn fold(
    records: &[Endorsement],
    retention_checked_at: Option<String>,
    now: String,
) -> Result<Aggregate, String> {
    let mut by_kind: std::collections::BTreeMap<String, Vec<&Endorsement>> = Default::default();
    for r in records {
        by_kind.entry(r.kind.clone()).or_default().push(r);
    }

    let mut kinds = std::collections::BTreeMap::new();
    for (kind, mut group) in by_kind {
        // By actor, then by timestamp. The tiebreak is what keeps this a TOTAL order once
        // comments exist: a gesture is one record per actor so it never reaches the second
        // key, but an actor can leave several comments on one subject, and two instances of
        // the same identity ordering them differently would publish two different roots for
        // one set.
        group.sort_by(|a, b| {
            a.actor
                .cmp(&b.actor)
                .then_with(|| a.created_at.cmp(&b.created_at))
        });
        let leaves: Vec<[u8; 32]> = group.iter().map(|r| r.leaf()).collect::<Result<_, _>>()?;
        kinds.insert(
            kind,
            KindTally {
                count: group.len(),
                set_root: hex(&merkle_root(&leaves)),
                sample_actors: group.iter().map(|r| r.actor.clone()).fold(
                    Vec::new(),
                    |mut acc, actor| {
                        // Deduplicated, because the field names ACTORS and a comment kind
                        // can hold several records from one. Sorted input, so equality with
                        // the last is the whole test.
                        if acc.len() < SAMPLE_ACTORS && acc.last() != Some(&actor) {
                            acc.push(actor);
                        }
                        acc
                    },
                ),
                retention_checked_at: retention_checked_at.clone(),
            },
        );
    }
    Ok(Aggregate {
        kinds,
        updated_at: now,
    })
}

/// Lowercase hex. Roots travel as text in a JSON record both implementations read.
pub fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [7u8; 32];
    const SUBJECT: &str = "f4xlljzqxtqpv7ul6ngkyeafusdwqrirpmhochqyjz2hgz3djo6a";
    const VERSION: &str = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
    const WHEN: &str = "2026-08-11T12:00:00.000Z";

    fn signed(kind: &str) -> Endorsement {
        Endorsement::sign(&SEED, kind, SUBJECT, VERSION, WHEN, None).unwrap()
    }

    // The signed layout, as an exact hex literal. Nothing existed before this to capture
    // from, so what a vector can pin instead is that the layout never moves silently: a
    // refactor that reordered the fields, changed the length width, or dropped the domain
    // prefix would still round-trip its own signatures perfectly while invalidating every
    // record already published by anyone else.
    #[test]
    fn the_signed_bytes_have_a_fixed_layout() {
        let e = Endorsement {
            kind: "like".into(),
            actor: "did:dht:ignored".into(),
            subject: "sub".into(),
            version: "ver".into(),
            created_at: "when".into(),
            sig: String::new(),
            reference: None,
            body: None,
            body_url: None,
        };
        let hex: String = e
            .signing_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            hex,
            concat!(
                "70696e2e656e676167656d656e742e7631", // "pin.engagement.v1"
                "000000046c696b65",                   // len 4, "like"
                "0000000373756200000003766572",       // len 3 "sub", len 3 "ver"
                "000000047768656e",                   // len 4, "when"
            )
        );
    }

    #[test]
    fn a_comment_signs_its_body_as_a_tagged_trailing_field() {
        // Pinned like the gesture layout above, and for one more reason: the TAG is what
        // keeps a second optional field from being confusable with this one, so a refactor
        // that dropped it would leave every signature verifying while quietly reopening
        // that hole.
        let c = Endorsement {
            kind: KIND_COMMENT.into(),
            actor: "did:dht:ignored".into(),
            subject: "sub".into(),
            version: "ver".into(),
            created_at: "when".into(),
            sig: String::new(),
            reference: None,
            body: Some("hi".into()),
            body_url: None,
        };
        let hex: String = c
            .signing_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, "70696e2e656e676167656d656e742e763100000007636f6d6d656e740000000373756200000003766572000000047768656e00000004626f6479000000026869");
    }

    #[test]
    fn an_absent_optional_field_appends_nothing() {
        // The whole back-compat claim, stated directly rather than only implied by the
        // pinned vector: adding an optional field cannot change what an older record signs.
        let mut with = Vec::new();
        push_tagged(&mut with, TAG_BODY, None);
        assert!(with.is_empty());
    }

    #[test]
    fn two_optional_fields_holding_the_same_text_are_not_interchangeable() {
        // THE reason for the tag. Untagged, a record carrying only field A and a record
        // carrying only field B would append identical bytes — so a signature over one
        // would verify as the other, and a future signed name claim would be replayable as
        // a comment body.
        let mut a = Vec::new();
        let mut b = Vec::new();
        push_tagged(&mut a, TAG_BODY, Some("x"));
        push_tagged(&mut b, TAG_TARGET, Some("x"));
        assert_ne!(a, b);
    }

    fn commented(body: &str) -> Endorsement {
        Endorsement::sign_comment(&SEED, SUBJECT, VERSION, WHEN, None, body).unwrap()
    }

    #[test]
    fn a_signed_comment_verifies_and_carries_its_words() {
        let c = commented("worth saying");
        assert!(c.verify().is_ok());
        assert_eq!(c.kind, KIND_COMMENT);
        assert_eq!(c.body.as_deref(), Some("worth saying"));
    }

    #[test]
    fn a_comment_stripped_of_its_body_stops_verifying() {
        // The body is INSIDE the signature, which is what makes an integrated comment
        // tamper-evident: a host publishes the words, so anyone who could alter them in
        // flight could put words in the commenter's mouth.
        let mut c = commented("as written");
        c.body = Some("as edited".into());
        assert!(c.verify().is_err());
    }

    #[test]
    fn a_comment_with_no_body_is_not_a_comment() {
        // SIGNED as a comment with no body, rather than a signed comment with the body
        // taken off afterwards. The mutating version passes whatever the shape rule says,
        // because removing a signed field breaks the signature — so it would be a test of
        // `verify_detached` wearing this test's name.
        let bodiless =
            Endorsement::sign(&SEED, KIND_COMMENT, SUBJECT, VERSION, WHEN, None).unwrap();
        assert!(bodiless.check_shape().is_err());
        assert!(bodiless.verify().is_err());

        let empty = Endorsement::sign_comment(&SEED, SUBJECT, VERSION, WHEN, None, "").unwrap();
        assert!(empty.check_shape().is_err());
        assert!(empty.verify().is_err());
    }

    #[test]
    fn a_body_over_the_limit_is_refused() {
        // An allocation bound: the host publishes these words into their own channel, so
        // the size of one is the sender choosing what the receiver pays for.
        let ok = commented(&"x".repeat(MAX_BODY_BYTES));
        assert!(ok.verify().is_ok());
        let too_big = commented(&"x".repeat(MAX_BODY_BYTES + 1));
        assert!(too_big.verify().is_err());
    }

    #[test]
    fn a_gesture_carrying_a_body_is_refused_and_an_unknown_kind_is_not() {
        // Bodies on the known gestures would take a like from ~300 bytes to a possible
        // 4 KiB for a record whose only content is that it exists. Signed WITH the body, so
        // the signature is valid and the shape rule is the only thing that can reject it.
        let fat_like = Endorsement::signed(
            &SEED,
            KIND_LIKE,
            SUBJECT,
            VERSION,
            WHEN,
            None,
            Some("smuggled"),
        )
        .unwrap();
        assert!(fat_like.check_shape().is_err());
        assert!(fat_like.verify().is_err());

        // An unknown kind is left alone deliberately, so a future one can carry a payload
        // without this crate shipping first.
        let future = Endorsement::signed(
            &SEED,
            "applaud",
            SUBJECT,
            VERSION,
            WHEN,
            None,
            Some("allowed"),
        )
        .unwrap();
        assert!(future.check_shape().is_ok());
        assert!(future.verify().is_ok());
    }

    #[test]
    fn a_body_url_sits_outside_the_signature() {
        // Which is what lets the actor's own Curator attach one after the fact, with no
        // re-signing — and what stops the commenter's own repack, which rewrites URLs while
        // preserving plaintext, from invalidating every comment they ever wrote.
        let c = commented("said so");
        let mut with_url = c.clone();
        with_url.body_url = Some("sia://body#encryption_key=k".into());
        assert_eq!(c.signing_bytes(), with_url.signing_bytes());
        assert!(with_url.verify().is_ok());
        // Same leaf too, so attaching one moves no published root.
        assert_eq!(c.leaf().unwrap(), with_url.leaf().unwrap());
    }

    #[test]
    fn a_swapped_body_url_is_caught_by_the_words_it_claims() {
        // Unsigned, so it is self-checking instead: a reader hashes what it fetched and
        // compares against the body the signature covers.
        let c = commented("as written");
        assert_eq!(c.body.as_deref(), Some("as written"));
        // The check a reader makes, stated as the property it rests on: the body is signed,
        // so bytes that don't match it are not this comment's whatever URL named them.
        let mut tampered = c.clone();
        tampered.body = Some("as swapped".into());
        assert!(tampered.verify().is_err());
    }

    #[test]
    fn a_comment_id_distinguishes_two_comments_by_one_actor() {
        // The singleton a gesture relies on is exactly what a comment breaks: three
        // comments on one post from one person have to be three records, not one.
        let first = commented("first");
        let second = Endorsement::sign_comment(
            &SEED,
            SUBJECT,
            VERSION,
            "2026-08-22T13:00:00.000Z",
            None,
            "second",
        )
        .unwrap();
        assert_ne!(first.comment_id(), second.comment_id());
        assert_eq!(
            first.comment_id(),
            commented("different words").comment_id()
        );
    }

    #[test]
    fn a_comment_withdrawal_names_the_record_it_takes_back() {
        let c = commented("regretted");
        let r = Retraction::sign_comment_withdrawal(
            &SEED,
            SUBJECT,
            "2026-08-22T14:00:00.000Z",
            &c.comment_id(),
        )
        .unwrap();
        assert!(r.verify().is_ok());
        assert_eq!(r.target.as_deref(), Some(c.comment_id().as_str()));

        // A withdrawal that named nothing would be ambiguous across several comments on one
        // subject, so the two must not sign the same bytes.
        let untargeted =
            Retraction::sign(&SEED, KIND_COMMENT, SUBJECT, "2026-08-22T14:00:00.000Z").unwrap();
        assert_ne!(r.signing_bytes(), untargeted.signing_bytes());
    }

    fn withdrawn(kind: &str, when: &str) -> Retraction {
        Retraction::sign(&SEED, kind, SUBJECT, when).unwrap()
    }

    #[test]
    fn a_retraction_signs_the_bytes_it_says_it_does() {
        // Pinned exactly, like the endorsement's, because these bytes are a contract with
        // every future reader: a layout that drifted would verify nothing already sent and
        // would say so only as a signature failure.
        let r = Retraction {
            op: OP_RETRACT.into(),
            kind: "like".into(),
            actor: "did:dht:ignored".into(),
            subject: "sub".into(),
            created_at: "when".into(),
            sig: String::new(),
            target: None,
        };
        let hex: String = r
            .signing_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            hex,
            concat!(
                "70696e2e72657472616374696f6e2e7631", // "pin.retraction.v1"
                "000000046c696b65",                   // len 4, "like"
                "0000000373756200000004",             // len 3 "sub", len 4
                "7768656e",                           // "when"
            )
        );
    }

    #[test]
    fn an_endorsement_cannot_be_replayed_as_the_withdrawal_of_itself() {
        // The reason the domains differ. Both cover kind, subject and a timestamp, so
        // under one domain a retraction's signed bytes would be a PREFIX-equal message to
        // an endorsement's over the same fields — and anyone holding a signed endorsement
        // could present it as that endorsement being taken back.
        let e = signed(KIND_LIKE);
        let r = withdrawn(KIND_LIKE, WHEN);
        assert_ne!(e.signing_bytes(), r.signing_bytes());
        assert!(r.signing_bytes().starts_with(b"pin.retraction.v1"));

        // And the signatures don't cross: neither record verifies as the other kind.
        let crossed = Retraction {
            sig: e.sig.clone(),
            ..withdrawn(KIND_LIKE, WHEN)
        };
        assert!(crossed.verify().is_err());
    }

    #[test]
    fn a_retraction_that_does_not_say_it_is_one_is_refused() {
        // The marker is checked as part of verification rather than left to the parse: a
        // record that verifies under this domain while claiming to be something else is
        // one whose author and reader disagree about what was signed.
        let mut r = withdrawn(KIND_LIKE, WHEN);
        assert!(r.verify().is_ok());
        r.op = "endorse".into();
        assert!(r.verify().is_err());
    }

    #[test]
    fn only_a_strictly_newer_withdrawal_takes_a_gesture_back() {
        // A withdrawal older than the gesture it names is one the actor changed their
        // mind about — they endorsed again after sending it — so honouring it would undo
        // something current with a stale message.
        let r = withdrawn(KIND_LIKE, WHEN);
        assert!(r.withdraws("2026-08-11T11:59:59.999Z"));
        assert!(!r.withdraws("2026-08-11T12:00:00.001Z"));
        assert!(!r.withdraws(WHEN));
    }

    #[test]
    fn the_domain_prefix_and_length_delimiting_are_both_load_bearing() {
        // Domain separation: the same key signs pkarr packets, so the prefix is what
        // stops a signature being valid in two protocols at once.
        assert!(signed(KIND_LIKE)
            .signing_bytes()
            .starts_with(b"pin.engagement.v1"));

        // Length-delimited, not separated: no pair of field values can be rearranged
        // into the same message. Concatenation alone would make ("ab","c") and ("a","bc")
        // identical, and that would let one signature endorse a different subject.
        let a = Endorsement {
            kind: "ab".into(),
            actor: String::new(),
            subject: "c".into(),
            version: String::new(),
            created_at: String::new(),
            sig: String::new(),
            reference: None,
            body: None,
            body_url: None,
        };
        let mut b = a.clone();
        b.kind = "a".into();
        b.subject = "bc".into();
        assert_ne!(a.signing_bytes(), b.signing_bytes());
    }

    #[test]
    fn a_signed_record_verifies_and_names_its_actor() {
        let e = signed(KIND_LIKE);
        assert!(e.verify().is_ok());
        // The actor string carries the key the signature is checked against — no lookup
        // is involved, which is the property the whole stranger case rests on.
        assert_eq!(
            e.actor,
            format!(
                "did:dht:{}",
                pin_pkarr::public_key_from_seed(&SEED).unwrap()
            )
        );
    }

    #[test]
    fn a_pin_and_a_like_on_one_subject_are_distinct_records() {
        // Both gestures are available on the same post, which is why the kind is signed
        // and why an address has to include it — otherwise one would overwrite the other.
        let like = signed(KIND_LIKE);
        let pin = signed(KIND_PIN);
        assert_ne!(like.signing_bytes(), pin.signing_bytes());
        assert_ne!(like.sig, pin.sig);
        assert!(pin.verify().is_ok());
    }

    #[test]
    fn tampering_with_any_signed_field_fails_verification() {
        for mutate in [
            |e: &mut Endorsement| e.kind = KIND_PIN.into(),
            |e: &mut Endorsement| e.subject = "another".into(),
            |e: &mut Endorsement| e.version = "another".into(),
            |e: &mut Endorsement| e.created_at = "2027-01-01T00:00:00.000Z".into(),
        ] {
            let mut e = signed(KIND_LIKE);
            mutate(&mut e);
            assert!(e.verify().is_err(), "{} should not verify", e.kind);
        }
    }

    #[test]
    fn a_record_reattributed_to_another_identity_fails_verification() {
        // The one that matters for a count: an endorsement cannot be relabelled as
        // somebody else's, so nobody can inflate a number with records they didn't get.
        let mut e = signed(KIND_LIKE);
        e.actor = format!(
            "did:dht:{}",
            pin_pkarr::public_key_from_seed(&[9u8; 32]).unwrap()
        );
        assert!(e.verify().is_err());
    }

    #[test]
    fn a_malformed_signature_or_actor_is_rejected_rather_than_panicking() {
        let mut e = signed(KIND_LIKE);
        e.sig = "not base64!!".into();
        assert!(e.verify().is_err());

        let mut e = signed(KIND_LIKE);
        e.sig = pin_crypto::b64_encode(&[0u8; 32]); // right encoding, wrong length
        assert!(e.verify().is_err());

        let mut e = signed(KIND_LIKE);
        e.actor = "did:dht:nonsense".into();
        assert!(e.verify().is_err());
    }

    #[test]
    fn a_public_reference_must_hash_to_the_subject_it_claims() {
        let subject = pin_crypto::engagement_subject("chan-one", WHEN);
        let reference = SubjectRef {
            did_dht: "did:dht:someone".into(),
            channel_id: "chan-one".into(),
            published_at: WHEN.into(),
            attachment: None,
        };
        let e =
            Endorsement::sign(&SEED, KIND_LIKE, &subject, VERSION, WHEN, Some(reference)).unwrap();
        assert!(e.verify().is_ok());

        // The reference is outside the signature, so it can be altered — and this is what
        // makes that harmless rather than a way to mislabel an endorsement. Detected
        // without signing it, which keeps the exact-string-form hazard out of the
        // signature entirely.
        let mut swapped = e.clone();
        swapped.reference.as_mut().unwrap().channel_id = "chan-two".into();
        assert!(swapped.verify().is_err());
    }

    #[test]
    fn an_attachment_reference_is_checked_against_the_attachment_subject() {
        let hash = "bafkreiattachment";
        let subject = pin_crypto::attachment_subject("chan-one", WHEN, hash);
        let reference = SubjectRef {
            did_dht: "did:dht:someone".into(),
            channel_id: "chan-one".into(),
            published_at: WHEN.into(),
            attachment: Some(hash.into()),
        };
        let e = Endorsement::sign(&SEED, KIND_PIN, &subject, hash, WHEN, Some(reference)).unwrap();
        assert!(e.verify().is_ok());

        // Dropping the attachment field would reinterpret a file's endorsement as the
        // whole post's — the count that must never be overstated. The two derivations are
        // different functions, so only one of them reproduces the subject on the record.
        let mut as_post = e.clone();
        as_post.reference.as_mut().unwrap().attachment = None;
        assert!(as_post.verify().is_err());

        // And naming a different attachment fails the same way.
        let mut other = e.clone();
        other.reference.as_mut().unwrap().attachment = Some("bafkreiother".into());
        assert!(other.verify().is_err());
    }

    #[test]
    fn an_unlisted_subject_carries_no_reference_and_still_verifies() {
        // The absence IS the tiering: a countable token that reveals neither which
        // channel it concerns nor that the channel exists. Only a holder of K can compute
        // the subject and match it.
        let e = signed(KIND_PIN);
        assert!(e.reference.is_none());
        assert!(e.verify().is_ok());
    }

    #[test]
    fn only_a_strictly_newer_record_supersedes_what_is_held() {
        let e = signed(KIND_LIKE);
        assert!(e.supersedes("2026-08-11T11:59:59.999Z"));
        // Replaying an older record must not displace current state, and re-applying the
        // same one must not either.
        assert!(!e.supersedes("2026-08-11T12:00:00.001Z"));
        assert!(!e.supersedes(WHEN));
    }

    // The wire field names, asserted exactly. Nothing type-checks across the JSON
    // boundary in either direction, and `channelID` is precisely the acronym-shaped case
    // `rename_all` gets wrong.
    #[test]
    fn the_wire_form_uses_the_field_names_readers_expect() {
        let subject = pin_crypto::engagement_subject("chan-one", WHEN);
        let e = Endorsement::sign(
            &SEED,
            KIND_PIN,
            &subject,
            VERSION,
            WHEN,
            Some(SubjectRef {
                did_dht: "did:dht:someone".into(),
                channel_id: "chan-one".into(),
                published_at: WHEN.into(),
                attachment: None,
            }),
        )
        .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "actor",
                "createdAt",
                "kind",
                "ref",
                "sig",
                "subject",
                "version"
            ]
        );

        let mut ref_keys: Vec<&str> = json["ref"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        ref_keys.sort_unstable();
        assert_eq!(ref_keys, vec!["channelID", "didDht", "publishedAt"]);
    }

    // --- the set commitment ----------------------------------------------------

    /// N distinct actors endorsing one subject. Seeds differ, so the actors do.
    fn set(n: usize, kind: &str) -> Vec<Endorsement> {
        (0..n)
            .map(|i| {
                Endorsement::sign(&[i as u8 + 1; 32], kind, SUBJECT, VERSION, WHEN, None).unwrap()
            })
            .collect()
    }

    fn leaves_of(records: &[Endorsement]) -> Vec<[u8; 32]> {
        let mut sorted: Vec<&Endorsement> = records.iter().collect();
        sorted.sort_by(|a, b| a.actor.cmp(&b.actor));
        sorted.iter().map(|r| r.leaf().unwrap()).collect()
    }

    #[test]
    fn two_actors_endorsing_at_the_same_instant_are_two_leaves() {
        // The reason the signature is in the leaf. These two records agree on every signed
        // field — kind, subject, version, timestamp — so without it a set of two would
        // commit as a set of one and a count could be quietly halved.
        let s = set(2, KIND_LIKE);
        assert_eq!(s[0].created_at, s[1].created_at);
        assert_eq!(s[0].signing_bytes(), s[1].signing_bytes());
        assert_ne!(s[0].actor, s[1].actor);
        assert_ne!(s[0].leaf().unwrap(), s[1].leaf().unwrap());
    }

    #[test]
    fn every_member_of_a_set_can_prove_it_belongs() {
        // Every size up to a few, because the promoted-odd-node case only appears at some
        // of them and an off-by-one there would pass at the sizes a single example covers.
        for n in 1..=9 {
            let leaves = leaves_of(&set(n, KIND_LIKE));
            let root = merkle_root(&leaves);
            for (i, leaf) in leaves.iter().enumerate() {
                let proof = inclusion_proof(&leaves, i).expect("in range");
                assert!(
                    verify_inclusion(&root, leaf, i, n, &proof),
                    "n={n} i={i} should verify"
                );
            }
            assert!(inclusion_proof(&leaves, n).is_none());
        }
    }

    #[test]
    fn a_leaf_that_is_not_in_the_set_cannot_prove_it_is() {
        // The forgery that matters: padding a count with records you don't hold. Every
        // slot is tried, since a proof for the wrong position is the plausible attempt.
        let leaves = leaves_of(&set(5, KIND_LIKE));
        let root = merkle_root(&leaves);
        let outsider = set(1, KIND_PIN)[0].leaf().unwrap();
        for i in 0..5 {
            let proof = inclusion_proof(&leaves, i).unwrap();
            assert!(!verify_inclusion(&root, &outsider, i, 5, &proof));
        }
    }

    #[test]
    fn a_count_cannot_be_inflated_past_the_set_it_commits_to() {
        // Claiming a bigger total changes the tree's shape, so the proofs stop verifying —
        // which is what makes the published count auditable rather than decorative.
        let leaves = leaves_of(&set(4, KIND_LIKE));
        let root = merkle_root(&leaves);
        let proof = inclusion_proof(&leaves, 0).unwrap();
        assert!(verify_inclusion(&root, &leaves[0], 0, 4, &proof));
        assert!(!verify_inclusion(&root, &leaves[0], 0, 5, &proof));
        assert!(!verify_inclusion(&root, &leaves[0], 0, 8, &proof));
    }

    #[test]
    fn a_promoted_odd_node_is_not_a_duplicated_one() {
        // Duplicating the odd leaf instead of promoting it (Bitcoin's construction) makes
        // a set of three and a set of four whose last element repeats commit identically,
        // so one root would stand for two different sets.
        let three = leaves_of(&set(3, KIND_LIKE));
        let mut four = three.clone();
        four.push(three[2]);
        assert_ne!(merkle_root(&three), merkle_root(&four));
    }

    #[test]
    fn a_proof_with_extra_hashes_is_rejected() {
        // Trailing junk that verified would be a second valid proof for one leaf.
        let leaves = leaves_of(&set(4, KIND_LIKE));
        let root = merkle_root(&leaves);
        let mut proof = inclusion_proof(&leaves, 1).unwrap();
        proof.push([9u8; 32]);
        assert!(!verify_inclusion(&root, &leaves[1], 1, 4, &proof));
    }

    #[test]
    fn an_empty_set_has_a_named_root_that_nothing_belongs_to() {
        assert_eq!(merkle_root(&[]), empty_root());
        assert!(!verify_inclusion(&empty_root(), &[0u8; 32], 0, 0, &[]));
    }

    #[test]
    fn a_root_does_not_depend_on_the_order_records_arrived_in() {
        // Two instances of one identity fold the same set in whatever order their crawls
        // happened to run. A root that moved would churn the record and mean nothing.
        let records = set(6, KIND_LIKE);
        let mut shuffled = records.clone();
        shuffled.reverse();
        let a = fold(&records, None, WHEN.into()).unwrap();
        let b = fold(&shuffled, None, WHEN.into()).unwrap();
        assert_eq!(a, b);
    }

    // --- the aggregate ---------------------------------------------------------

    #[test]
    fn a_fold_tallies_each_kind_separately() {
        let mut records = set(3, KIND_LIKE);
        records.extend(set(2, KIND_PIN));
        let agg = fold(&records, Some(WHEN.into()), WHEN.into()).unwrap();

        assert_eq!(agg.kinds[KIND_LIKE].count, 3);
        assert_eq!(agg.kinds[KIND_PIN].count, 2);
        // Different sets, so different commitments — a shared root would mean one tally
        // could be audited with the other's records.
        assert_ne!(agg.kinds[KIND_LIKE].set_root, agg.kinds[KIND_PIN].set_root);
        assert_eq!(
            agg.kinds[KIND_LIKE].retention_checked_at,
            Some(WHEN.to_string())
        );
    }

    #[test]
    fn a_conversation_publishes_the_newest_and_says_how_many_it_left() {
        // A cap nobody is told about reads as complete, so the number that did not fit comes
        // back with the ones that did.
        let many: Vec<Endorsement> = (0..MAX_CONVERSATION + 5)
            .map(|i| {
                let when = format!("2026-08-22T12:00:{:02}.000Z", i % 60);
                Endorsement::sign_comment(
                    &[(i % 200) as u8 + 1; 32],
                    SUBJECT,
                    VERSION,
                    &when,
                    None,
                    "words",
                )
                .unwrap()
            })
            .collect();
        let (published, dropped) = newest_comments(many);
        assert_eq!(published.len(), MAX_CONVERSATION);
        assert_eq!(dropped, 5);
    }

    #[test]
    fn a_short_conversation_is_published_whole() {
        let three: Vec<Endorsement> = ["a", "b", "c"]
            .iter()
            .enumerate()
            .map(|(i, body)| {
                let when = format!("2026-08-22T12:0{i}:00.000Z");
                Endorsement::sign_comment(&SEED, SUBJECT, VERSION, &when, None, body).unwrap()
            })
            .collect();
        let (published, dropped) = newest_comments(three);
        assert_eq!(dropped, 0);
        // Newest first: the half of a long thread anybody reads.
        assert_eq!(published[0].body.as_deref(), Some("c"));
        assert_eq!(published[2].body.as_deref(), Some("a"));
    }

    #[test]
    fn one_log_publishes_one_set_whatever_order_it_is_read_in() {
        // Two instances of the same identity write this entry, so a set that depended on read
        // order would have them taking turns publishing different roots for one subject.
        let mut records: Vec<Endorsement> = (0..6)
            .map(|i| {
                let when = format!("2026-08-22T12:0{i}:00.000Z");
                Endorsement::sign_comment(&[(i + 1) as u8; 32], SUBJECT, VERSION, &when, None, "w")
                    .unwrap()
            })
            .collect();
        let forwards = newest_comments(records.clone()).0;
        records.reverse();
        assert_eq!(forwards, newest_comments(records).0);
    }

    #[test]
    fn two_comments_agreeing_on_everything_signed_still_order() {
        // Same subject, same instant, different actors — so `createdAt` cannot separate them
        // and the signature has to.
        let a = Endorsement::sign_comment(&[11u8; 32], SUBJECT, VERSION, WHEN, None, "w").unwrap();
        let b = Endorsement::sign_comment(&[12u8; 32], SUBJECT, VERSION, WHEN, None, "w").unwrap();
        assert_eq!(a.created_at, b.created_at);
        let one = newest_comments(vec![a.clone(), b.clone()]).0;
        let other = newest_comments(vec![b, a]).0;
        assert_eq!(one, other);
    }

    #[test]
    fn comments_and_gestures_tally_side_by_side() {
        // One fold, one aggregate: `kind` drives it, so a comment count appears beside the
        // gestures with its own set and its own root, and a row reads one record for every
        // number it shows.
        let mut records = set(3, KIND_LIKE);
        records.push(
            Endorsement::sign_comment(&[7u8; 32], SUBJECT, VERSION, WHEN, None, "said so").unwrap(),
        );
        let agg = fold(&records, None, WHEN.into()).unwrap();

        assert_eq!(agg.kinds[KIND_LIKE].count, 3);
        assert_eq!(agg.kinds[KIND_COMMENT].count, 1);
        // Separate sets, so an auditor cannot be handed one lane's records for the other's
        // claim.
        assert_ne!(
            agg.kinds[KIND_LIKE].set_root,
            agg.kinds[KIND_COMMENT].set_root
        );
    }

    #[test]
    fn several_comments_from_one_actor_all_count() {
        // A gesture is a singleton per actor, so the fold has never had to hold two records
        // from one — a comment is where that stops being true, and counting commenters
        // instead of comments would show 1 where a thread has three.
        let seed = [9u8; 32];
        let comments: Vec<Endorsement> = ["first", "second", "third"]
            .iter()
            .enumerate()
            .map(|(i, body)| {
                let when = format!("2026-08-22T1{i}:00:00.000Z");
                Endorsement::sign_comment(&seed, SUBJECT, VERSION, &when, None, body).unwrap()
            })
            .collect();

        let agg = fold(&comments, None, WHEN.into()).unwrap();
        assert_eq!(agg.kinds[KIND_COMMENT].count, 3);
        // One actor wrote all three, and the field names actors.
        assert_eq!(agg.kinds[KIND_COMMENT].sample_actors.len(), 1);
    }

    #[test]
    fn one_actors_comments_commit_in_a_stable_order() {
        // The timestamp tiebreak. Sorting by actor alone leaves three records from one
        // identity in whatever order the input arrived, so two instances of the same
        // identity would publish two different roots for one set — and an auditor's proofs
        // would fail against an honest holder.
        let seed = [8u8; 32];
        let mut comments: Vec<Endorsement> = (0..3)
            .map(|i| {
                let when = format!("2026-08-22T1{i}:00:00.000Z");
                Endorsement::sign_comment(&seed, SUBJECT, VERSION, &when, None, "words").unwrap()
            })
            .collect();
        let forwards = fold(&comments, None, WHEN.into()).unwrap();
        comments.reverse();
        let backwards = fold(&comments, None, WHEN.into()).unwrap();
        assert_eq!(forwards, backwards);
    }

    #[test]
    fn a_tallys_root_is_the_commitment_over_its_own_records() {
        // The count and the root have to describe the SAME set, or an auditor's proofs
        // would fail against an honest holder.
        let records = set(4, KIND_PIN);
        let agg = fold(&records, None, WHEN.into()).unwrap();
        let tally = &agg.kinds[KIND_PIN];
        assert_eq!(tally.count, 4);
        assert_eq!(tally.set_root, hex(&merkle_root(&leaves_of(&records))));

        let leaves = leaves_of(&records);
        let proof = inclusion_proof(&leaves, 2).unwrap();
        let root: [u8; 32] = {
            let mut r = [0u8; 32];
            for (i, b) in r.iter_mut().enumerate() {
                *b = u8::from_str_radix(&tally.set_root[i * 2..i * 2 + 2], 16).unwrap();
            }
            r
        };
        assert!(verify_inclusion(&root, &leaves[2], 2, tally.count, &proof));
    }

    #[test]
    fn a_sample_is_bounded_and_stable() {
        let agg = fold(&set(20, KIND_LIKE), None, WHEN.into()).unwrap();
        let sample = &agg.kinds[KIND_LIKE].sample_actors;
        assert_eq!(sample.len(), SAMPLE_ACTORS);
        // In the set's own order, not by arrival — so a pass that changed nothing rewrites
        // nothing, and every write here wakes each subscriber syncing the channel doc.
        let mut expected: Vec<String> =
            set(20, KIND_LIKE).iter().map(|r| r.actor.clone()).collect();
        expected.sort();
        assert_eq!(sample, &expected[..SAMPLE_ACTORS]);
    }

    #[test]
    fn an_aggregate_uses_the_field_names_a_reader_expects() {
        // Nothing type-checks across the JSON boundary, and every one of these is an
        // acronym-or-camelCase case that a derived rename gets wrong.
        let agg = fold(&set(1, KIND_LIKE), Some(WHEN.into()), WHEN.into()).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&agg).unwrap()).unwrap();

        let mut top: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        top.sort_unstable();
        assert_eq!(top, vec!["kinds", "updatedAt"]);

        let mut tally: Vec<&str> = json["kinds"][KIND_LIKE]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        tally.sort_unstable();
        assert_eq!(
            tally,
            vec!["count", "retentionCheckedAt", "sampleActors", "setRoot"]
        );
    }

    #[test]
    fn a_never_checked_tally_omits_the_retention_field_rather_than_claiming_a_time() {
        let agg = fold(&set(1, KIND_LIKE), None, WHEN.into()).unwrap();
        let wire = serde_json::to_string(&agg).unwrap();
        assert!(!wire.contains("retentionCheckedAt"), "{wire}");
    }

    #[test]
    fn an_absent_reference_is_omitted_rather_than_null_and_round_trips() {
        let e = signed(KIND_LIKE);
        let wire = serde_json::to_string(&e).unwrap();
        assert!(!wire.contains("\"ref\""), "{wire}");
        assert_eq!(serde_json::from_str::<Endorsement>(&wire).unwrap(), e);
    }
}
