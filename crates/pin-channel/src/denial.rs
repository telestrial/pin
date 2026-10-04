//! An author's answer of no to a request to read their private channel: which request it
//! answers, signed by the author and sealed to the person who asked.
//!
//! SIGNED because a sealed box is anonymous, so without the author's signature anybody could
//! tell somebody their request was turned down. It names the request it answers by that
//! request's timestamp, so a denial of an old request says nothing about a newer one.
//!
//! SEALED because who asked to read what is between the two of them. The box is knocked to
//! the asker and also published in the author's directory, the floor for an asker who cannot
//! be knocked — a browser tab — so anyone can count the boxes and only the asker can open
//! theirs, the way an invitation travels. Pure: sealing and opening.

use serde::{Deserialize, Serialize};

/// The domain a denial's signature is made in.
const SIGNING_DOMAIN: &[u8] = b"pin.denial.v1";

/// A denial, as its asker opens it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Denial {
    /// The channel asked about, as its channelID.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The author, as did:dht: who signed this.
    pub author: String,
    /// Who asked, as did:dht: who it is for.
    pub requester: String,
    /// The `createdAt` of the request it answers.
    pub request_created_at: String,
    /// The author's signature over everything above, base64.
    pub sig: String,
}

fn signing_bytes(
    channel_id: &str,
    author: &str,
    requester: &str,
    request_created_at: &str,
) -> Vec<u8> {
    let mut out = SIGNING_DOMAIN.to_vec();
    for field in [channel_id, author, requester, request_created_at] {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field.as_bytes());
    }
    out
}

/// Seal a denial of `requester`'s request made at `request_created_at`, signed as the author
/// `author_app_key` derives, answering with the box as base64.
pub fn seal_denial(
    author_app_key: &[u8; 32],
    channel_id: &str,
    requester: &str,
    requester_enc_key: &[u8; 32],
    request_created_at: &str,
) -> Result<String, String> {
    let seed = pin_derive::did_dht_seed(author_app_key);
    let author = format!("did:dht:{}", pin_pkarr::public_key_from_seed(&seed)?);
    let sig = pin_pkarr::sign_detached(
        &seed,
        &signing_bytes(channel_id, &author, requester, request_created_at),
    )?;
    let denial = Denial {
        channel_id: channel_id.to_string(),
        author,
        requester: requester.to_string(),
        request_created_at: request_created_at.to_string(),
        sig,
    };
    let json = serde_json::to_vec(&denial).map_err(|e| format!("encode denial: {e}"))?;
    Ok(pin_crypto::b64_encode(&pin_crypto::seal_to(
        requester_enc_key,
        &json,
    )?))
}

/// Open a box, answering with the denial in it when it is one meant for `me`, signed by the
/// author it names. An error for anything else — most boxes a directory holds are somebody
/// else's.
pub fn open_denial(my_app_key: &[u8; 32], me: &str, sealed_b64: &str) -> Result<Denial, String> {
    let sealed = pin_crypto::b64_decode(sealed_b64).ok_or("box is not base64")?;
    let json = pin_crypto::open_sealed(&pin_derive::enc_key_seed(my_app_key), &sealed)?;
    let denial: Denial = serde_json::from_slice(&json).map_err(|e| format!("denial: {e}"))?;
    if bare(&denial.requester) != bare(me) {
        return Err("a denial for somebody else".into());
    }
    pin_pkarr::verify_detached(
        &denial.author,
        &signing_bytes(
            &denial.channel_id,
            &denial.author,
            &denial.requester,
            &denial.request_created_at,
        ),
        &denial.sig,
    )
    .map_err(|_| "denial is not signed by its author".to_string())?;
    Ok(denial)
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
    fn the_asker_opens_a_denial_signed_by_the_author() {
        let sealed = seal_denial(&AUTHOR, "chan", &did(&BOB), &enc(&BOB), "t1").unwrap();
        let denial = open_denial(&BOB, &did(&BOB), &sealed).unwrap();
        assert_eq!(denial.author, did(&AUTHOR));
        assert_eq!(denial.channel_id, "chan");
        assert_eq!(denial.request_created_at, "t1");
    }

    #[test]
    fn nobody_else_opens_it_and_a_forged_one_is_refused() {
        let sealed = seal_denial(&AUTHOR, "chan", &did(&BOB), &enc(&BOB), "t1").unwrap();
        assert!(open_denial(&CAROL, &did(&CAROL), &sealed).is_err());
        // Sealed to bob but addressed to carol.
        let misaddressed = seal_denial(&AUTHOR, "chan", &did(&CAROL), &enc(&BOB), "t1").unwrap();
        assert!(open_denial(&BOB, &did(&BOB), &misaddressed).is_err());
        // A box whose author field names somebody who did not sign it.
        let json = pin_crypto::open_sealed(
            &pin_derive::enc_key_seed(&BOB),
            &pin_crypto::b64_decode(&sealed).unwrap(),
        )
        .unwrap();
        let mut denial: Denial = serde_json::from_slice(&json).unwrap();
        denial.author = did(&CAROL);
        let forged = pin_crypto::b64_encode(
            &pin_crypto::seal_to(&enc(&BOB), &serde_json::to_vec(&denial).unwrap()).unwrap(),
        );
        assert!(open_denial(&BOB, &did(&BOB), &forged).is_err());
    }
}
