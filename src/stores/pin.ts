import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { type AccountSnapshot, pinItem } from '../core/pin'
import type { SiaClient } from '../core/siaClient'
import type { ItemRef } from '../core/types'
import { APP_KEY } from '../lib/constants'
import { useActionStore } from './actionQueue'

/** The AppKey this identity's pin records are sealed under.
 *
 *  Resolved lazily because the auth store imports this one — a static import back would
 *  be a cycle. Null before sign-in, which is also the only time a pin can't happen. */
async function appKeyHex(): Promise<string | null> {
  const { useAuthStore } = await import('./auth')
  return useAuthStore.getState().storedKeyHex ?? null
}

/** Record a pin in the doc, so it survives this device and reaches the others.
 *
 *  Best-effort at the moment of the action: the pin itself already succeeded (its bytes
 *  are mirrored and it's in the local list), so a doc write that fails costs travel
 *  rather than the pin. `usePinDocsMirror` catches up whatever didn't land. */
async function recordPin(ref: PinnedItemRef): Promise<void> {
  try {
    const hex = await appKeyHex()
    if (!hex) return
    const { writePinRecord } = await import('../lib/pinRecords')
    await writePinRecord(hex, ref)
  } catch (e) {
    console.warn('pin record write failed (will be caught up):', e)
  }
}

/** What a pin is about, for the endorsement side.
 *
 *  Three cases. A pin of a post is the post's subject. A library pin that came from a
 *  post's attachment gets that FILE's own subject — its own count, not a share of the
 *  post's, because keeping one attachment alive is not keeping the post alive and
 *  counting a partial custodian as a full one would overstate the redundancy the number
 *  reports. A file uploaded straight to the library is null: nothing was ever published,
 *  so there is nothing another party could identify.
 *
 *  The attachment's identity is the library item's own `contentHash`, which for a file
 *  IS the file. Without one — a legacy attachment written before the field existed —
 *  there is no subject, and no count is better than a wrong one. */
export function endorsedItemFor(ref: PinnedItemRef): {
  channelID: string
  publishedAt: string
  contentHash?: string
  attachment?: string
} | null {
  if (ref.channel.channelID !== 'library') {
    return {
      channelID: ref.channel.channelID,
      publishedAt: ref.item.publishedAt,
      contentHash: ref.item.contentHash,
    }
  }
  if (!ref.origin || !ref.item.contentHash) return null
  return {
    channelID: ref.origin.channelID,
    publishedAt: ref.origin.publishedAt,
    // For an attachment the version and the identity are the same hash: change the bytes
    // and it is a different file, so there is no drift to record separately.
    contentHash: ref.item.contentHash,
    attachment: ref.item.contentHash,
  }
}

/** Publish the pin as an endorsement too, so it can be counted.
 *
 *  A pin is a mixed gesture: it mirrors bytes into this identity's Sia scope (private, in
 *  the pin record above) AND it says the thing was worth keeping (public, here). Those
 *  are two records because they are two facts with two audiences — nobody but you needs
 *  the share URL, and a count needs a signed public claim.
 *
 *  Best-effort at the moment of the action, like the pin record: the bytes are already
 *  mirrored, so a failed write costs a count rather than the pin, and the catch-up in
 *  `usePinDocsMirror` picks up whatever didn't land. */
async function endorsePin(ref: PinnedItemRef): Promise<void> {
  const item = endorsedItemFor(ref)
  if (!item) return
  try {
    const hex = await appKeyHex()
    if (!hex) return
    const { writeEndorsement, referenceAuthorFor } = await import(
      '../lib/engagement'
    )
    await writeEndorsement(
      hex,
      'pin',
      item,
      await referenceAuthorFor(item.channelID),
    )
  } catch (e) {
    console.warn('endorsement write failed (will be caught up):', e)
  }
}

/** Withdraw the endorsement. Kept exact by being done where the unpinning is: a leftover
 *  record is an over-count nothing else would correct, and a reconciler can never tell a
 *  withdrawal from an endorsement another device just made. */
async function unendorsePin(ref: PinnedItemRef): Promise<void> {
  const item = endorsedItemFor(ref)
  if (!item) return
  try {
    const hex = await appKeyHex()
    if (!hex) return
    const { deleteEndorsement } = await import('../lib/engagement')
    await deleteEndorsement(hex, 'pin', item)
  } catch (e) {
    console.warn('endorsement release failed (will be retried):', e)
  }
}

/** Release a pin's record. Best-effort for the same reason, with one asymmetry worth
 *  naming: a release that doesn't land leaves a record for a pin that no longer exists,
 *  and the read side would adopt it back. That is why the retry lives with the local
 *  list rather than being inferred from the doc — see `usePinDocsMirror`. */
async function forgetPin(ref: PinnedItemRef): Promise<void> {
  try {
    const hex = await appKeyHex()
    if (!hex) return
    const { deletePinRecord } = await import('../lib/pinRecords')
    await deletePinRecord(hex, ref)
  } catch (e) {
    console.warn('pin record release failed (will be caught up):', e)
  }
}

// At-most-one-in-flight account refresh. Coalesces bursts (e.g.
// loop-until-clean repack with N batches, each calling refreshAccount)
// into at most one follow-up round-trip after the current one settles —
// so N batches produce 1 or 2 accountSnapshot() calls instead of N.
let accountRefreshInFlight: Promise<void> | null = null
let accountRefreshPending: SiaClient | null = null

export type PinnedItemRef = {
  item: ItemRef
  channel: {
    authorHandle: string
    channelID: string
    name: string
  }
  objectID: string
  // Object IDs of the item's pinned attachment bytes, so unpin can release
  // the whole post. Legacy persisted entries predate this field — readers
  // default to []. Optional so PinInput callers don't construct it.
  attachmentObjectIDs?: string[]
  // Where a LIBRARY pin came from, when it came from somewhere: the post whose
  // attachment this file is. Set only by the per-file pin, because that is the only
  // library pin with a post behind it — a file uploaded straight to the library has
  // none.
  //
  // Needed because a library pin is stored under the 'library' sentinel with
  // `publishedAt` stamped at the moment of pinning, so nothing else in the record can
  // say what it is a copy of. The attachment's own identity is `item.contentHash`,
  // which for a library item IS the file's hash.
  origin?: { channelID: string; publishedAt: string }
  pinnedAt: string
}

export type PinInput = Omit<
  PinnedItemRef,
  'objectID' | 'attachmentObjectIDs' | 'pinnedAt'
>

type ChannelFanoutResult = { total: number; failed: number }

// An in-flight channel batch pin/unpin with per-item progress. Drives the
// channel header's in-place progress pin (fills bottom-up while pinning,
// drains while unpinning) and the right-sidebar in-flight row. Not persisted.
export type ChannelPinJob = {
  channelID: string
  channelName: string
  done: number
  total: number
  mode: 'pin' | 'unpin'
}

type PinState = {
  pinned: PinnedItemRef[]
  account: AccountSnapshot | null
  pinning: Set<string>
  // Channel batch jobs in flight, keyed by channelID, with progress. The
  // job outlives the button that started it (it's a store action), so a
  // navigate-away keeps pinning and the sidebar keeps showing it. Not
  // persisted.
  channelPins: Record<string, ChannelPinJob>
  pin: (client: SiaClient, input: PinInput) => Promise<void>
  unpin: (client: SiaClient, itemURL: string) => Promise<void>
  // Snapshot a whole channel: fan out pin() over every current item
  // (body + attachments). Reuses pin()'s dedup + drift-swap, so this
  // doubles as catch-up — already-held items are skipped, drifted ones
  // swap to current, new ones get pinned. Partial-failure-tolerant: one
  // item failing doesn't abort the batch; the count comes back so the
  // caller can surface "pinned 44 of 47."
  pinChannel: (
    client: SiaClient,
    items: readonly ItemRef[],
    channel: PinInput['channel'],
  ) => Promise<ChannelFanoutResult>
  // Release a whole channel: unpin every item currently held for it.
  unpinChannel: (
    client: SiaClient,
    channelID: string,
  ) => Promise<ChannelFanoutResult>
  refreshAccount: (client: SiaClient) => Promise<void>
  isPinned: (itemURL: string) => boolean
  isPinning: (itemURL: string) => boolean
  // Used by the repack runner: swap the underlying object identity for one
  // or more pinned entries when their bytes get re-uploaded into a packed
  // slab. The user-visible "I pinned this" relationship is preserved; only
  // the internal ID + URL change.
  replaceMany: (
    replacements: Array<{
      oldObjectID: string
      newObjectID: string
      newURL: string
      newContentHash: string
    }>,
  ) => void
  // Replace the whole library with the doc's version. Guarded by its only caller
  // (the pin mirror), which applies it solely when local state is already recorded.
  adoptPinned: (pinned: PinnedItemRef[]) => void
  reset: () => void
}

// Every Sia object ID currently held by these pins — each pin's body plus its
// attachment objects. Used by unpin to refcount shared bytes: with granular
// pinning a file can be held by both a whole-post pin and a standalone library
// pin, so a delete must skip any object still referenced by another pin.
export function objectIDsReferencedBy(
  pins: readonly PinnedItemRef[],
): Set<string> {
  const set = new Set<string>()
  for (const p of pins) {
    set.add(p.objectID)
    for (const aid of p.attachmentObjectIDs ?? []) set.add(aid)
  }
  return set
}

// Simplified shape of zustand's setter — enough for the channel-job
// helpers below to be defined outside the store initializer.
type PinSet = (
  partial: Partial<PinState> | ((state: PinState) => Partial<PinState>),
) => void

function startChannelJob(set: PinSet, job: ChannelPinJob): void {
  set((s) => ({ channelPins: { ...s.channelPins, [job.channelID]: job } }))
}

function bumpChannelJob(set: PinSet, channelID: string): void {
  set((s) => {
    const job = s.channelPins[channelID]
    if (!job) return {}
    return {
      channelPins: {
        ...s.channelPins,
        [channelID]: { ...job, done: job.done + 1 },
      },
    }
  })
}

function endChannelJob(set: PinSet, channelID: string): void {
  set((s) => {
    const { [channelID]: _, ...rest } = s.channelPins
    return { channelPins: rest }
  })
}

export const usePinStore = create<PinState>()(
  persist(
    (set, get) => ({
      pinned: [],
      account: null,
      pinning: new Set<string>(),
      channelPins: {},
      pin: async (client, input) => {
        const url = input.item.itemURL
        // Drift case: an existing pin matches the same logical post
        // (same channelID + publishedAt) but at a different itemURL
        // because the author edited. Re-pinning swaps your v1 for
        // v_current — single custody snapshot, updated. Library pins
        // (channelID 'library') aren't channel-bound, so they skip
        // this check and dedup purely by itemURL.
        const isLibrary = input.channel.channelID === 'library'
        const driftedFrom = isLibrary
          ? undefined
          : get().pinned.find(
              (p) =>
                p.channel.channelID === input.channel.channelID &&
                p.item.publishedAt === input.item.publishedAt,
            )
        if (driftedFrom && driftedFrom.item.itemURL === url) return
        if (get().pinned.some((p) => p.item.itemURL === url)) return
        const pinning = new Set(get().pinning)
        pinning.add(url)
        set({ pinning })
        try {
          // Pin new bytes first so a mid-operation failure can't
          // leave the user un-pinned. Whole-item: body + attachments.
          // Unpin of the old (body + its attachments) is best-effort —
          // orphan sweep catches strays.
          const { objectID, attachmentObjectIDs } = await pinItem(
            client,
            input.item,
          )
          if (driftedFrom) {
            // Release the stale version's bytes — but only those no other pin
            // (nor the freshly-pinned current version) still references. The
            // byte reclaim is journaled (durable, retried) rather than a
            // best-effort delete that a QUIC blip could silently drop.
            const referenced = objectIDsReferencedBy(
              get().pinned.filter((p) => p !== driftedFrom),
            )
            referenced.add(objectID)
            for (const aid of attachmentObjectIDs) referenced.add(aid)
            const stale = [
              driftedFrom.objectID,
              ...(driftedFrom.attachmentObjectIDs ?? []),
            ].filter((id) => !referenced.has(id))
            useActionStore.getState().enqueueDeleteObjects({
              objectIDs: stale,
              label: `Reclaiming old version of “${input.item.title || 'item'}”`,
            })
          }
          const ref: PinnedItemRef = {
            ...input,
            objectID,
            attachmentObjectIDs,
            pinnedAt: new Date().toISOString(),
          }
          const next = new Set(get().pinning)
          next.delete(url)
          set((s) => ({
            pinned: driftedFrom
              ? s.pinned.map((p) => (p === driftedFrom ? ref : p))
              : [...s.pinned, ref],
            pinning: next,
          }))
          void recordPin(ref)
          void endorsePin(ref)
          get().refreshAccount(client)
        } catch (e) {
          const next = new Set(get().pinning)
          next.delete(url)
          set({ pinning: next })
          throw e
        }
      },
      unpin: async (client, itemURL) => {
        const ref = get().pinned.find((p) => p.item.itemURL === itemURL)
        if (!ref) return
        // Reference-aware: reclaim only the bytes no other pin still holds.
        const referenced = objectIDsReferencedBy(
          get().pinned.filter((p) => p !== ref),
        )
        const toDelete = [
          ref.objectID,
          ...(ref.attachmentObjectIDs ?? []),
        ].filter((id) => !referenced.has(id))
        // Drop the local pin now (the reliable leg); the byte reclaim is
        // journaled — durable + retried — instead of a best-effort delete that
        // a QUIC blip could silently drop. The runner refreshes the storage
        // meter when the cleanup completes.
        set((s) => ({
          pinned: s.pinned.filter((p) => p.item.itemURL !== itemURL),
        }))
        useActionStore.getState().enqueueDeleteObjects({
          objectIDs: toDelete,
          label: `Reclaiming “${ref.item.title || 'item'}”`,
        })
        void forgetPin(ref)
        void unendorsePin(ref)
        get().refreshAccount(client)
      },
      pinChannel: async (client, items, channel) => {
        const { channelID } = channel
        startChannelJob(set, {
          channelID,
          channelName: channel.name,
          done: 0,
          total: items.length,
          mode: 'pin',
        })
        let failed = 0
        try {
          for (const item of items) {
            try {
              await get().pin(client, { item, channel })
            } catch {
              failed++
            }
            bumpChannelJob(set, channelID)
          }
        } finally {
          endChannelJob(set, channelID)
        }
        return { total: items.length, failed }
      },
      unpinChannel: async (client, channelID) => {
        const targets = get().pinned.filter(
          (p) => p.channel.channelID === channelID,
        )
        startChannelJob(set, {
          channelID,
          channelName: targets[0]?.channel.name ?? channelID,
          done: 0,
          total: targets.length,
          mode: 'unpin',
        })
        let failed = 0
        try {
          for (const p of targets) {
            try {
              await get().unpin(client, p.item.itemURL)
            } catch {
              failed++
            }
            bumpChannelJob(set, channelID)
          }
        } finally {
          endChannelJob(set, channelID)
        }
        return { total: targets.length, failed }
      },
      refreshAccount: async (client) => {
        if (accountRefreshInFlight) {
          accountRefreshPending = client
          return accountRefreshInFlight
        }
        accountRefreshInFlight = (async () => {
          try {
            const account = await client.accountSnapshot()
            set({ account })
          } catch {
            // best-effort
          } finally {
            accountRefreshInFlight = null
            const next = accountRefreshPending
            accountRefreshPending = null
            if (next) get().refreshAccount(next)
          }
        })()
        return accountRefreshInFlight
      },
      isPinned: (itemURL) =>
        get().pinned.some((p) => p.item.itemURL === itemURL),
      isPinning: (itemURL) => get().pinning.has(itemURL),
      replaceMany: (replacements) => {
        if (replacements.length === 0) return
        const byOldID = new Map(replacements.map((r) => [r.oldObjectID, r]))
        set((s) => ({
          pinned: s.pinned.map((p) => {
            const r = byOldID.get(p.objectID)
            if (!r) return p
            return {
              ...p,
              objectID: r.newObjectID,
              item: {
                ...p.item,
                id: r.newObjectID,
                itemURL: r.newURL,
                contentHash: r.newContentHash,
              },
            }
          }),
        }))
      },
      // Take the doc's version of the library as ours. Called only by the pin
      // mirror, and only once it has established that everything held locally is
      // already recorded — so this can't overwrite an unpushed local pin, and the
      // deletions it carries are another device's unpins arriving.
      adoptPinned: (pinned) => set({ pinned }),
      reset: () =>
        set({
          pinned: [],
          account: null,
          pinning: new Set<string>(),
          channelPins: {},
        }),
    }),
    {
      name: `sia-pins-${APP_KEY.slice(0, 16)}`,
      partialize: (state) => ({ pinned: state.pinned }),
    },
  ),
)
