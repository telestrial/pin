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

/// The domain tag every signed message starts with.
///
/// Not decoration. The same identity key signs pkarr packets, and an unprefixed message
/// is one whose signature could in principle be valid in some other protocol that
/// happens to produce the same bytes. A fixed ASCII prefix makes that impossible for
/// free, and the version in it means a future layout change cannot be mistaken for this
/// one.
const SIGNING_DOMAIN: &[u8] = b"pin.engagement.v1";

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
    /// What was asserted: `like`, `pin`, or something a future version added. Open by
    /// design — a reader folds the kinds it understands and ignores the rest, so a new
    /// gesture needs no coordinated upgrade.
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
}

/// Append a length-prefixed field. Length-delimited rather than separated, so no field's
/// content can be mistaken for a boundary.
fn push_field(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
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
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(SIGNING_DOMAIN.len() + 64);
        out.extend_from_slice(SIGNING_DOMAIN);
        push_field(&mut out, &self.kind);
        push_field(&mut out, &self.subject);
        push_field(&mut out, &self.version);
        push_field(&mut out, &self.created_at);
        out
    }

    /// Build and sign a record from the identity seed the actor is derived from.
    pub fn sign(
        did_dht_seed: &[u8],
        kind: &str,
        subject: &str,
        version: &str,
        created_at: &str,
        reference: Option<SubjectRef>,
    ) -> Result<Self, String> {
        let mut record = Endorsement {
            kind: kind.to_string(),
            actor: format!("did:dht:{}", pin_pkarr::public_key_from_seed(did_dht_seed)?),
            subject: subject.to_string(),
            version: version.to_string(),
            created_at: created_at.to_string(),
            sig: String::new(),
            reference,
        };
        record.sig = pin_pkarr::sign_detached(did_dht_seed, &record.signing_bytes())?;
        Ok(record)
    }

    /// Whether this record holds up: signed by the identity it claims, and consistent
    /// with the coordinates it carries.
    ///
    /// One call rather than two, because the failure mode of forgetting half of it is
    /// counting a forgery. Costs no network — see the crate docs.
    pub fn verify(&self) -> Result<(), String> {
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

    #[test]
    fn an_absent_reference_is_omitted_rather_than_null_and_round_trips() {
        let e = signed(KIND_LIKE);
        let wire = serde_json::to_string(&e).unwrap();
        assert!(!wire.contains("\"ref\""), "{wire}");
        assert_eq!(serde_json::from_str::<Endorsement>(&wire).unwrap(), e);
    }
}
