//! A request to read a private channel: who is asking, to whom, and the key an approval would
//! be sealed to, signed by the person asking.
//!
//! SIGNED because it travels by knock and is believed by its author: a request nobody signed
//! could name anybody as the one asking, and approving it would seat a stranger's choice of
//! person. The signature also covers the channel and its author, so a request cannot be
//! replayed at another channel or another author.
//!
//! A WITHDRAWAL IS A NEWER REQUEST, not a deletion. The author keeps the newest record per
//! person per channel, so a withdrawal has to outrank the request it takes back — and an old
//! request replayed after it must lose, which a deletion could not ensure. `withdrawn` is
//! signed as a tagged field, so a request and its withdrawal never sign the same bytes.
//!
//! Not sealed: it is knocked straight to the author over an encrypted transport and published
//! nowhere, and the author is the one person who may read it. Pure: signing and checking, and
//! nothing about where a request goes.

use serde::{Deserialize, Serialize};

/// The domain a request's signature is made in. The did:dht key signs other things, and a
/// signature with no domain of its own could be valid as one of them.
const SIGNING_DOMAIN: &[u8] = b"pin.request.v1";

/// A request to read a private channel, or its withdrawal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// The channel asked about, as its channelID.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel's author, as did:dht: the one this is for.
    pub author: String,
    /// Who is asking, as did:dht: who signed this.
    pub actor: String,
    /// The asker's encryption key, base64: what an approval's invitation is sealed to, so
    /// approving needs no lookup of the asker.
    pub enc_key: String,
    /// When it was made, ISO 8601. The newest record per person per channel is the one that
    /// stands.
    pub created_at: String,
    /// Whether this takes a request back.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
    /// The asker's signature over everything above, base64.
    pub sig: String,
}

/// What the asker signs: every field, each length-delimited, after the domain; `withdrawn`
/// tagged, so present and absent never sign the same bytes.
fn signing_bytes(
    channel_id: &str,
    author: &str,
    actor: &str,
    enc_key: &str,
    created_at: &str,
    withdrawn: bool,
) -> Vec<u8> {
    let mut out = SIGNING_DOMAIN.to_vec();
    for field in [channel_id, author, actor, enc_key, created_at] {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field.as_bytes());
    }
    out.push(withdrawn as u8);
    out
}

/// Sign a request to read `channel_key`'s channel, or its withdrawal, as the identity
/// `app_key` derives.
pub fn sign_request(
    app_key: &[u8; 32],
    channel_key: &[u8; 32],
    author: &str,
    withdrawn: bool,
    created_at: &str,
) -> Result<Request, String> {
    let seed = pin_derive::did_dht_seed(app_key);
    let actor = format!("did:dht:{}", pin_pkarr::public_key_from_seed(&seed)?);
    let enc_key =
        pin_crypto::b64_encode(&pin_crypto::enc_public(&pin_derive::enc_key_seed(app_key)));
    let channel_id = pin_crypto::channel_id(channel_key);
    let sig = pin_pkarr::sign_detached(
        &seed,
        &signing_bytes(&channel_id, author, &actor, &enc_key, created_at, withdrawn),
    )?;
    Ok(Request {
        channel_id,
        author: author.to_string(),
        actor,
        enc_key,
        created_at: created_at.to_string(),
        withdrawn,
        sig,
    })
}

impl Request {
    /// Whether this was signed by the person it names as asking.
    pub fn verify(&self) -> Result<(), String> {
        let message = signing_bytes(
            &self.channel_id,
            &self.author,
            &self.actor,
            &self.enc_key,
            &self.created_at,
            self.withdrawn,
        );
        pin_pkarr::verify_detached(&self.actor, &message, &self.sig)
            .map_err(|_| "request is not signed by the person it names".to_string())
    }

    /// The asker's encryption key, decoded.
    pub fn enc_key_bytes(&self) -> Result<[u8; 32], String> {
        pin_crypto::b64_decode(&self.enc_key)
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| "request encryption key is malformed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASKER: [u8; 32] = [3u8; 32];
    const K: [u8; 32] = [7u8; 32];
    const AUTHOR: &str = "did:dht:author";

    #[test]
    fn a_signed_request_verifies_and_names_who_asked() {
        let request = sign_request(&ASKER, &K, AUTHOR, false, "2026-10-03T00:00:00Z").unwrap();
        assert!(request.verify().is_ok());
        assert_eq!(request.channel_id, pin_crypto::channel_id(&K));
        assert_eq!(
            request.enc_key_bytes().unwrap(),
            pin_crypto::enc_public(&pin_derive::enc_key_seed(&ASKER))
        );
        assert!(!serde_json::to_string(&request)
            .unwrap()
            .contains("withdrawn"));
    }

    #[test]
    fn every_field_is_covered_by_the_signature() {
        let request = sign_request(&ASKER, &K, AUTHOR, false, "2026-10-03T00:00:00Z").unwrap();
        let tamper = |f: fn(&mut Request)| {
            let mut r = request.clone();
            f(&mut r);
            r.verify().is_err()
        };
        assert!(tamper(|r| r.channel_id = "elsewhere".into()));
        assert!(tamper(|r| r.author = "did:dht:someone".into()));
        assert!(tamper(|r| r.enc_key = pin_crypto::b64_encode(&[1u8; 32])));
        assert!(tamper(|r| r.created_at = "2027-01-01T00:00:00Z".into()));
        // A request cannot be passed off as its withdrawal, or the other way round.
        assert!(tamper(|r| r.withdrawn = true));
        // And nobody else's name can be put on it.
        let mut forged = request.clone();
        forged.actor = sign_request(&[4u8; 32], &K, AUTHOR, false, "x")
            .unwrap()
            .actor;
        assert!(forged.verify().is_err());
    }
}
