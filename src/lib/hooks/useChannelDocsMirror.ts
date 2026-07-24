import { useEffect } from 'react'
import { channelKeyFromBase64, encryptForChannel } from '../../core/crypto'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { deleteRecord, openDocs, putRecord } from '../docs'
import { snapshotToSia } from '../docsMirror'

// Phase C, increment 2 — DUAL-WRITE the user's own channel manifests into
// iroh-docs + Sia mirror, alongside the atproto channel records (which stay the
// source of truth). Same posture as useSettingsDocsMirror: a separate subscriber
// that touches none of the atproto write path (core/channels.ts), so risk is zero
// and reads are unchanged; a later increment flips reads onto the doc.
//
// It watches feedStore.manifests ∩ myChannels (own authored channels only),
// re-encrypts each changed manifest under its channel key K, and writes it to the
// doc as `channel/<channelID>`. Re-encrypting the decrypted manifest yields a
// fresh-IV ciphertext that decrypts identically — fine for storage. A channel that
// leaves myChannels (retract) is deleted from the doc. Debounced, serialized,
// best-effort; pin-core loads lazily (only fires when you actually own channels).

const DEBOUNCE_MS = 2000

export function useChannelDocsMirror() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !storedKeyHex) return

    const appKeyBytes = Uint8Array.fromHex(storedKeyHex)
    let cancelled = false
    let opened = false
    let saving = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // channelID -> last mirrored manifest fingerprint (skip redundant writes).
    const mirrored = new Map<string, string>()

    const ensureOpen = async () => {
      if (!opened) {
        await openDocs(storedKeyHex)
        opened = true
      }
    }

    const reconcile = async () => {
      saving = true
      try {
        await ensureOpen()
        if (cancelled) return
        const owned = new Map(
          useAuthStore
            .getState()
            .myChannels.map((c) => [c.channelID, c.channelKey]),
        )
        const { manifests } = useFeedStore.getState()
        let dirty = false

        // Upsert own channels whose manifest changed since last mirror.
        for (const [channelID, keyB64] of owned) {
          const manifest = manifests[channelID]
          if (!manifest) continue
          const fingerprint = JSON.stringify(manifest)
          if (mirrored.get(channelID) === fingerprint) continue
          const enc = await encryptForChannel(
            channelKeyFromBase64(keyB64),
            fingerprint,
          )
          await putRecord('channel', channelID, new TextEncoder().encode(enc))
          mirrored.set(channelID, fingerprint)
          dirty = true
        }

        // Delete channels we mirrored before that are no longer owned (retract).
        for (const channelID of [...mirrored.keys()]) {
          if (!owned.has(channelID)) {
            await deleteRecord('channel', channelID)
            mirrored.delete(channelID)
            dirty = true
          }
        }

        if (dirty) await snapshotToSia(client, appKeyBytes)
      } catch (e) {
        console.warn('channel docs-mirror failed:', e)
      } finally {
        saving = false
        if (pending && !cancelled) {
          pending = false
          schedule()
        }
      }
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (saving) pending = true
        else void reconcile()
      }, DEBOUNCE_MS)
    }

    const unsubFeed = useFeedStore.subscribe((s, p) => {
      if (s.manifests !== p.manifests) schedule()
    })
    const unsubAuth = useAuthStore.subscribe((s, p) => {
      if (s.myChannels !== p.myChannels) schedule()
    })
    // Catch channels already loaded before this hook mounted (don't load pin-core
    // for a user who owns nothing).
    if (useAuthStore.getState().myChannels.length > 0) schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubFeed()
      unsubAuth()
    }
  }, [client, storedKeyHex])
}
