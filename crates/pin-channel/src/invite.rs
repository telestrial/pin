//! An invitation to a channel only its members may read: everything the invited person
//! needs to climb its member tree, signed by the author and sealed to the invitee.
//!
//! SIGNED because a sealed box is anonymous — anybody can seal one to anybody's published
//! encryption key — so without the author's signature a stranger could put "@alice invited
//! you" in front of somebody alice has never heard of. The signature covers who it is for,
//! so a box opened by its invitee cannot be re-sealed to somebody else as theirs.
//!
//! SEALED because it carries K, and K is what finds the channel at all: a Secret channel is
//! one nobody can locate without having been handed its key. Anyone can see that a box
//! exists; only its invitee can see what is in it or who it is from.
//!
//! The same box travels both roads: knocked to the invitee for speed, and published in the
//! author's directory as the floor, where the invitee finds it whenever they read the
//! author. Pure: sealing and opening, and nothing about where a box goes.

use serde::{Deserialize, Serialize};

/// The domain an invitation's signature is made in. The did:dht key signs other things,
/// and a signature with no domain of its own could be valid as one of them.
const SIGNING_DOMAIN: &[u8] = b"pin.invitation.v1";

/// An invitation, as its invitee opens it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    /// K, base64. The channel is the one K derives, never one the invitation names.
    pub channel_key: String,
    /// The author, as did:dht: who signed this, and who every band of the tree must be
    /// signed by.
    pub author: String,
    /// The author's encryption key, base64, which the invitee's leaf key is agreed with.
    pub author_enc_key: String,
    /// Who it is for, as did:dht.
    pub invitee: String,
    /// The invitee's leaf in the tree.
    pub leaf: u64,
    /// The seating this invitation is for, so a box and the roster entry behind it can be
    /// matched.
    pub seat_id: String,
    /// The author's signature over everything above, base64.
    pub sig: String,
}

impl Invitation {
    /// The channel this invitation is to, derived from its key.
    pub fn channel_id(&self) -> Result<String, String> {
        let k = pin_crypto::channel_key_from_base64(&self.channel_key)
            .ok_or("invitation channel key is malformed")?;
        Ok(pin_crypto::channel_id(&k))
    }
}

/// What the author signs: every field, each length-delimited, after the domain.
fn signing_bytes(
    channel_key: &str,
    author: &str,
    author_enc_key: &str,
    invitee: &str,
    leaf: u64,
    seat_id: &str,
) -> Vec<u8> {
    let mut out = SIGNING_DOMAIN.to_vec();
    for field in [
        channel_key,
        author,
        author_enc_key,
        invitee,
        &leaf.to_string(),
        seat_id,
    ] {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field.as_bytes());
    }
    out
}

/// Seal an invitation to its invitee, signed by the author, answering with the box as
/// base64.
///
/// `author_seed` is the author's did:dht seed and `author_app_key` what their encryption
/// key derives from; `invitee_enc_key` is the encryption key the invitee publishes.
#[allow(clippy::too_many_arguments)]
pub fn seal_invitation(
    author_app_key: &[u8; 32],
    channel_key: &[u8; 32],
    invitee: &str,
    invitee_enc_key: &[u8; 32],
    leaf: u64,
    seat_id: &str,
) -> Result<String, String> {
    let author_seed = pin_derive::did_dht_seed(author_app_key);
    let author = format!("did:dht:{}", pin_pkarr::public_key_from_seed(&author_seed)?);
    let author_enc_key = pin_crypto::b64_encode(&pin_crypto::enc_public(
        &pin_derive::enc_key_seed(author_app_key),
    ));
    let channel_key = pin_crypto::b64_encode(channel_key);
    let sig = pin_pkarr::sign_detached(
        &author_seed,
        &signing_bytes(
            &channel_key,
            &author,
            &author_enc_key,
            invitee,
            leaf,
            seat_id,
        ),
    )?;
    let invitation = Invitation {
        channel_key,
        author,
        author_enc_key,
        invitee: invitee.to_string(),
        leaf,
        seat_id: seat_id.to_string(),
        sig,
    };
    let json = serde_json::to_vec(&invitation).map_err(|e| format!("encode invitation: {e}"))?;
    Ok(pin_crypto::b64_encode(&pin_crypto::seal_to(
        invitee_enc_key,
        &json,
    )?))
}

/// Open a box, answering with the invitation in it when it is one meant for `me`, signed by
/// the author it names.
///
/// An error for anything else — a box sealed to somebody else, which is most of the boxes a
/// directory holds, a forged signature, or a genuine invitation for another person — so a
/// caller trying every box it sees keeps only what is its own.
pub fn open_invitation(
    my_app_key: &[u8; 32],
    me: &str,
    sealed_b64: &str,
) -> Result<Invitation, String> {
    let sealed = pin_crypto::b64_decode(sealed_b64).ok_or("box is not base64")?;
    let json = pin_crypto::open_sealed(&pin_derive::enc_key_seed(my_app_key), &sealed)?;
    let invitation: Invitation =
        serde_json::from_slice(&json).map_err(|e| format!("invitation: {e}"))?;
    if bare(&invitation.invitee) != bare(me) {
        return Err("an invitation for somebody else".into());
    }
    pin_pkarr::verify_detached(
        &invitation.author,
        &signing_bytes(
            &invitation.channel_key,
            &invitation.author,
            &invitation.author_enc_key,
            &invitation.invitee,
            invitation.leaf,
            &invitation.seat_id,
        ),
        &invitation.sig,
    )
    .map_err(|_| "invitation is not signed by its author".to_string())?;
    invitation.channel_id()?;
    Ok(invitation)
}

fn bare(did: &str) -> &str {
    did.strip_prefix("did:dht:").unwrap_or(did)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTHOR: [u8; 32] = [1u8; 32];
    const BOB: [u8; 32] = [2u8; 32];
    const CAROL: [u8; 32] = [3u8; 32];
    const K: [u8; 32] = [7u8; 32];

    fn did(app_key: &[u8; 32]) -> String {
        format!(
            "did:dht:{}",
            pin_pkarr::public_key_from_seed(&pin_derive::did_dht_seed(app_key)).unwrap()
        )
    }

    fn enc(app_key: &[u8; 32]) -> [u8; 32] {
        pin_crypto::enc_public(&pin_derive::enc_key_seed(app_key))
    }

    #[test]
    fn the_invitee_opens_an_invitation_signed_by_its_author() {
        let sealed = seal_invitation(&AUTHOR, &K, &did(&BOB), &enc(&BOB), 5, "seat1").unwrap();
        let invitation = open_invitation(&BOB, &did(&BOB), &sealed).unwrap();
        assert_eq!(invitation.author, did(&AUTHOR));
        assert_eq!(invitation.leaf, 5);
        assert_eq!(invitation.seat_id, "seat1");
        assert_eq!(invitation.channel_id().unwrap(), pin_crypto::channel_id(&K));
        assert_eq!(
            pin_crypto::b64_decode(&invitation.author_enc_key).unwrap(),
            enc(&AUTHOR)
        );
        // A bare did names the same person.
        let bare = did(&BOB).trim_start_matches("did:dht:").to_string();
        assert!(open_invitation(&BOB, &bare, &sealed).is_ok());
    }

    #[test]
    fn nobody_else_opens_it() {
        let sealed = seal_invitation(&AUTHOR, &K, &did(&BOB), &enc(&BOB), 5, "seat1").unwrap();
        assert!(open_invitation(&CAROL, &did(&CAROL), &sealed).is_err());
    }

    #[test]
    fn an_invitation_for_somebody_else_is_refused_even_sealed_to_me() {
        // Bob opens his own box and re-seals its contents to carol: still bob's invitation.
        let sealed = seal_invitation(&AUTHOR, &K, &did(&BOB), &enc(&BOB), 5, "seat1").unwrap();
        let invitation = open_invitation(&BOB, &did(&BOB), &sealed).unwrap();
        let resealed = pin_crypto::b64_encode(
            &pin_crypto::seal_to(&enc(&CAROL), &serde_json::to_vec(&invitation).unwrap()).unwrap(),
        );
        let err = open_invitation(&CAROL, &did(&CAROL), &resealed).unwrap_err();
        assert!(err.contains("somebody else"), "{err}");
    }

    #[test]
    fn a_forged_or_altered_invitation_is_refused() {
        // Signed by mallory while naming the author.
        let sealed = seal_invitation(&[9u8; 32], &K, &did(&BOB), &enc(&BOB), 5, "seat1").unwrap();
        let mut forged = open_invitation(&BOB, &did(&BOB), &sealed).unwrap();
        forged.author = did(&AUTHOR);
        let reseal = |inv: &Invitation| {
            pin_crypto::b64_encode(
                &pin_crypto::seal_to(&enc(&BOB), &serde_json::to_vec(inv).unwrap()).unwrap(),
            )
        };
        assert!(open_invitation(&BOB, &did(&BOB), &reseal(&forged)).is_err());

        // The author's genuine invitation with any field moved.
        let genuine = open_invitation(
            &BOB,
            &did(&BOB),
            &seal_invitation(&AUTHOR, &K, &did(&BOB), &enc(&BOB), 5, "seat1").unwrap(),
        )
        .unwrap();
        let changes: Vec<Box<dyn Fn(&mut Invitation)>> = vec![
            Box::new(|i| i.leaf = 6),
            Box::new(|i| i.seat_id = "seat2".into()),
            Box::new(|i| i.channel_key = pin_crypto::b64_encode(&[8u8; 32])),
            Box::new(|i| i.author_enc_key = pin_crypto::b64_encode(&[4u8; 32])),
        ];
        for change in changes {
            let mut altered = genuine.clone();
            change(&mut altered);
            assert!(open_invitation(&BOB, &did(&BOB), &reseal(&altered)).is_err());
        }
    }

    #[test]
    fn an_invitation_crosses_as_these_keys() {
        let sealed = seal_invitation(&AUTHOR, &K, &did(&BOB), &enc(&BOB), 5, "seat1").unwrap();
        let invitation = open_invitation(&BOB, &did(&BOB), &sealed).unwrap();
        let json = serde_json::to_value(&invitation).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "author",
                "authorEncKey",
                "channelKey",
                "invitee",
                "leaf",
                "seatId",
                "sig"
            ]
        );
    }
}
