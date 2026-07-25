// Native pkarr publish/resolve over the DIRECT Mainline DHT — the desktop
// implementation of the pkarr network seam (src/lib/pkarrTransport.ts).
//
// WHY: on the web these go through public pkarr RELAYS, which lag on read-after-
// write (a just-published channel/identity pointer isn't resolvable for minutes —
// the reader-tier boundary that dominated the last few sessions). This talks
// straight to the Mainline DHT (`no_relays()`), the way the Curator's identity.rs
// already does — so a fresh publish is resolvable in seconds, not minutes. It's the
// desktop fix for that lag; the web path stays relay-limited (a browser can't do
// UDP to the DHT — physics, honest reader tier).
//
// These are GENERIC TXT publish/resolve (any records under any key), distinct from
// identity.rs's `publish_doc`/`resolve_did` (which self-verify and decode the
// Curator's own `_iroh`/`_ns` doc). The frontend derives the key material on the
// wasm (identityFromSeed / deriveDidDht) and hands us the 32-byte SEED to publish
// under — a wasm Keypair can't cross IPC, but the seed can, and we rebuild the
// keypair here the same way the Curator does (Keypair::from_secret_key).
//
// EXECUTION MODEL: like sia.rs, a dedicated multi-thread `enable_all` runtime so
// the net/time drivers the Mainline DHT (UDP + timers) needs are guaranteed,
// independent of Tauri's own runtime. Each call builds a fresh DHT client (matching
// identity.rs) — fine for these infrequent, background ops.

use std::time::Duration;

use pkarr::dns::rdata::RData;
use pkarr::{Client, Keypair, PublicKey, SignedPacket};

// DNS TTL on every published record — mirrors the web's RECORD_TTL_SECS (lib/pkarr.ts).
// Governs how long resolvers/caches hold a resolved packet, NOT the DHT record's own
// ~2h life. Short = mutable pointers propagate fast (the whole point here).
const RECORD_TTL_SECS: u32 = 60;
// DHT publishes fail transiently (best-effort UDP, cold-client warmup) — retry a few
// times, same posture as identity.rs and the web side.
const PUBLISH_RETRIES: usize = 3;
// DHT lookups from a cold client are timing-sensitive (a single attempt can miss a
// record that's present) — retry up to ~12s, matching the web resolve window.
const RESOLVE_ATTEMPTS: usize = 6;
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// A TXT name/value pair — the wire shape of the frontend's `PkarrTxt`
/// (`{ name, value }`). Deserialize for publish input, Serialize for resolve output.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct TxtRecord {
    name: String,
    value: String,
}

/// Tauri-managed state: a dedicated runtime with the full driver set (the Mainline
/// DHT needs UDP + timers), independent of Tauri's own runtime.
pub struct PkarrState {
    rt: tokio::runtime::Runtime,
}

impl Default for PkarrState {
    fn default() -> Self {
        PkarrState {
            rt: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("pkarr tokio runtime"),
        }
    }
}

/// Publish TXT records signed by the ed25519 key derived from `seed`, directly to
/// the Mainline DHT (no relay). Overwrites the prior document for that key.
#[tauri::command]
pub async fn pkarr_publish(
    state: tauri::State<'_, PkarrState>,
    seed: Vec<u8>,
    records: Vec<TxtRecord>,
) -> Result<(), String> {
    let seed32: [u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| "seed must be exactly 32 bytes".to_string())?;
    state
        .rt
        .spawn(async move {
            let keypair = Keypair::from_secret_key(&seed32);
            let mut builder = SignedPacket::builder();
            for r in &records {
                let n = r
                    .name
                    .as_str()
                    .try_into()
                    .map_err(|_| format!("bad record name: {}", r.name))?;
                let v = r
                    .value
                    .as_str()
                    .try_into()
                    .map_err(|_| format!("bad record value: {}", r.value))?;
                builder = builder.txt(n, v, RECORD_TTL_SECS);
            }
            let packet = builder.sign(&keypair).map_err(|e| format!("sign: {e}"))?;

            let mut cb = Client::builder();
            cb.no_relays();
            let client = cb.build().map_err(|e| format!("dht client: {e}"))?;

            let mut last_err = String::new();
            for attempt in 0..PUBLISH_RETRIES {
                if attempt > 0 {
                    tokio::time::sleep(RETRY_DELAY).await;
                }
                match client.publish(&packet, None).await {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = format!("publish: {e}"),
                }
            }
            Err(last_err)
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}

/// Resolve a `did:dht:<key>` (or bare pkarr pubkey string) from the Mainline DHT to
/// its current TXT records. Returns an empty vec when nothing is published /
/// resolvable — matching the web `resolveDidDht`'s undefined-resolve → [] (a miss is
/// not an error; callers treat "no records" as "no pointer").
#[tauri::command]
pub async fn pkarr_resolve(
    state: tauri::State<'_, PkarrState>,
    key: String,
) -> Result<Vec<TxtRecord>, String> {
    let z = key
        .strip_prefix("did:dht:")
        .unwrap_or(&key)
        .to_string();
    state
        .rt
        .spawn(async move {
            let pubkey: PublicKey = z
                .as_str()
                .try_into()
                .map_err(|_| format!("bad pkarr key: {z}"))?;

            let mut rb = Client::builder();
            rb.no_relays();
            let resolver = rb.build().map_err(|e| format!("dht client: {e}"))?;

            // resolve_most_recent (not resolve): gather the highest-timestamp packet
            // across nodes, avoiding pkarr's documented "lost update" stale read from
            // the first node hit (bites when a key is republished across sessions).
            let mut packet = None;
            for _ in 0..RESOLVE_ATTEMPTS {
                if let Some(found) = resolver.resolve_most_recent(&pubkey).await {
                    packet = Some(found);
                    break;
                }
                tokio::time::sleep(RETRY_DELAY).await;
            }
            let Some(sp) = packet else {
                return Ok(Vec::new());
            };

            let mut out = Vec::new();
            for rr in sp.all_resource_records() {
                let RData::TXT(txt) = &rr.rdata else { continue };
                let Ok(value) = String::try_from(txt.clone()) else {
                    continue;
                };
                // name resolves fully-qualified ("_c0.<zbase32>", "_dir0.<zbase32>",
                // …); the frontend's reassembleTxt matches on the prefix + index.
                out.push(TxtRecord {
                    name: rr.name.to_string(),
                    value,
                });
            }
            Ok(out)
        })
        .await
        .map_err(|e| format!("task: {e}"))?
}
