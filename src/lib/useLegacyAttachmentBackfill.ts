import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect } from 'react'
import { putChannelRecord } from '../core/atproto'
import { channelKeyFromBase64, encryptForChannel } from '../core/crypto'
import { type ChannelManifest, isValidAttachment } from '../core/types'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useUploadQueueStore } from '../stores/uploadQueue'

// One-shot migration: walks own-channel manifests for attachments
// missing objectID (the field added 2026-05-08) and rewrites the
// manifest with each one resolved via sharedObject. Logs a console
// summary so you can see what it did and remove this hook once it's
// reported "nothing to do".
//
// Removal steps once you see "all done" or "nothing to do" in console:
//   1. Drop the import + call in App.tsx
//   2. Delete this file
//
// Same gating as useOrphanSweep — wait for settle, manifests loaded,
// uploads idle.

const SETTLE_DELAY_MS = 5000
const TAG = '[legacy attachment backfill]'

async function backfillChannel(
  sdk: Sdk,
  agent: Agent,
  channel: OwnedChannel,
  manifest: ChannelManifest,
): Promise<{ scanned: number; resolved: number; written: boolean }> {
  type Pending = { itemIdx: number; attIdx: number; url: string }
  const pending: Pending[] = []
  manifest.items.forEach((item, itemIdx) => {
    if (!item.attachments) return
    item.attachments.forEach((att, attIdx) => {
      // Skip pre-schema malformed entries — they can't be resolved
      // because there's no URL to resolve from.
      if (!isValidAttachment(att)) return
      if (!att.objectID) pending.push({ itemIdx, attIdx, url: att.url })
    })
  })

  if (pending.length === 0) {
    return { scanned: 0, resolved: 0, written: false }
  }

  const settled = await Promise.allSettled(
    pending.map(async (p) => {
      const obj = await sdk.sharedObject(p.url)
      return { ...p, objectID: obj.id() }
    }),
  )

  // Build patched manifest. Use shallow-copied attachments arrays so
  // the original manifest object stays untouched.
  const newItems = manifest.items.map((it) =>
    it.attachments ? { ...it, attachments: [...it.attachments] } : it,
  )
  let resolved = 0
  for (const s of settled) {
    if (s.status !== 'fulfilled') {
      console.warn(`${TAG}   resolution failed:`, s.reason)
      continue
    }
    const { itemIdx, attIdx, objectID } = s.value
    const item = newItems[itemIdx]
    if (!item.attachments) continue
    item.attachments[attIdx] = { ...item.attachments[attIdx], objectID }
    resolved++
  }

  if (resolved === 0) {
    return { scanned: pending.length, resolved: 0, written: false }
  }

  const updated: ChannelManifest = {
    ...manifest,
    // Bumping publishedAt is intentional — the manifest record is
    // genuinely new ciphertext. Item publishedAt stays so chronology
    // doesn't shift. Same convention as repack manifest swaps.
    publishedAt: new Date().toISOString(),
    items: newItems,
  }
  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  await putChannelRecord(agent, channel.channelID, ciphertext)

  return { scanned: pending.length, resolved, written: true }
}

export function useLegacyAttachmentBackfill() {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)

  useEffect(() => {
    if (!sdk || !agent) return
    let cancelled = false

    async function run() {
      await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS))
      if (cancelled) return

      const auth = useAuthStore.getState()
      const feed = useFeedStore.getState()
      const queue = useUploadQueueStore.getState()

      const uploadsIdle = queue.tasks.every(
        (t) => t.state === 'success' || t.state === 'failed',
      )
      if (!uploadsIdle) return

      const allManifestsLoaded = auth.myChannels.every(
        (c) => feed.manifests[c.channelID] !== undefined,
      )
      if (auth.myChannels.length > 0 && !allManifestsLoaded) return

      let totalScanned = 0
      let totalResolved = 0
      const written: { name: string; resolved: number; scanned: number }[] = []

      for (const channel of auth.myChannels) {
        const manifest = feed.manifests[channel.channelID]
        if (!manifest) continue
        try {
          if (!sdk || !agent) return
          const result = await backfillChannel(sdk, agent, channel, manifest)
          if (cancelled) return
          totalScanned += result.scanned
          totalResolved += result.resolved
          if (result.written) {
            written.push({
              name: channel.name,
              resolved: result.resolved,
              scanned: result.scanned,
            })
          }
        } catch (e) {
          console.warn(`${TAG} channel "${channel.name}" failed:`, e)
        }
      }

      if (totalScanned === 0) {
        console.log(
          `${TAG} nothing to do — every attachment already has an objectID.`,
        )
        console.log(
          `${TAG} you can remove the import + call in App.tsx and delete src/lib/useLegacyAttachmentBackfill.ts.`,
        )
        return
      }

      console.log(
        `${TAG} scanned ${totalScanned} legacy attachments, backfilled ${totalResolved}`,
      )
      for (const w of written) {
        console.log(
          `${TAG}   "${w.name}": ${w.resolved}/${w.scanned} resolved`,
        )
      }
      if (totalResolved === totalScanned) {
        console.log(
          `${TAG} done. Refresh — you should see "nothing to do" — then remove the import + call from App.tsx.`,
        )
      } else {
        console.warn(
          `${TAG} ${totalScanned - totalResolved} attachments could not be resolved this pass; will retry next session.`,
        )
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [sdk, agent])
}
