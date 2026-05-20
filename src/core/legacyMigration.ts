import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { putChannelRecord } from './atproto'
import { fetchChannel } from './channels'
import { channelKeyFromBase64, encryptForChannel } from './crypto'
import { uploadItemsPacked } from './sia'
import type {
  AttachmentRef,
  ChannelManifest,
  ItemRef,
} from './types'

export type ItemReplacement = {
  oldObjectID: string
  newObjectID: string
  newURL: string
  newContentHash: string
  newItem: ItemRef
}

export type MigrationResult = {
  channelID: string
  migratedCount: number
  replacements: ItemReplacement[]
  manifest: ChannelManifest
}

function isLegacyItem(item: ItemRef): boolean {
  return item.type !== 'text'
}

// Fold any title (and existing summary, for legacy text-with-title posts) into
// the new body text. The migrated item is type='text' with title='', so
// without folding the journal's titled posts would lose their title from feed
// display. Bold prefix keeps the title visually distinct without an h1's heft.
function buildBodyText(item: ItemRef): string {
  const title = item.title ?? ''
  const summary = item.summary ?? ''
  if (title && summary) return `**${title}**\n\n${summary}`
  if (title) return `**${title}**`
  return summary
}

// Sia rejects 0-byte uploads (verified day-0). For empty-body migrated items
// (legacy media with no title), encode a single space byte. The summary string
// is always the canonical text — readers ignore the body bytes.
function bodyBytesFor(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array([0x20])
  return new TextEncoder().encode(text)
}

export async function migrateChannelManifest(
  sdk: Sdk,
  agent: Agent,
  channel: { channelID: string; channelKey: string },
): Promise<MigrationResult | null> {
  const did = agent.assertDid
  const current = await fetchChannel(did, channel.channelID, channel.channelKey)

  const legacyIndices: number[] = []
  current.items.forEach((it, i) => {
    if (isLegacyItem(it)) legacyIndices.push(i)
  })
  if (legacyIndices.length === 0) return null

  // Pack all new body bytes into one batch so they share slab capacity. Even
  // a channel with 100 migrated items uses < 100 bytes of actual content, so
  // the whole pack lands in one slab.
  const bodyTexts = legacyIndices.map((i) => buildBodyText(current.items[i]))
  const bodyByteArrays = bodyTexts.map(bodyBytesFor)
  const uploadedBodies = await uploadItemsPacked(sdk, bodyByteArrays)

  // Build new ItemRefs. The legacy item's URL/bytes become attachments[0] —
  // bytes don't move, only the pointer's structural location does. The old
  // top-level filename/mimeType/byteSize migrate down into the attachment;
  // the new top-level fields describe the 1-byte body wrapper.
  const replacements: ItemReplacement[] = legacyIndices.map((i, k) => {
    const old = current.items[i]
    const body = uploadedBodies[k]
    const text = bodyTexts[k]
    const attachment: AttachmentRef = {
      url: old.itemURL,
      mimeType: old.mimeType,
      filename: old.filename,
      byteSize: old.byteSize,
      contentHash: old.contentHash,
      objectID: old.id,
    }
    const newItem: ItemRef = {
      id: body.id,
      itemURL: body.itemURL,
      type: 'text',
      title: '',
      summary: text,
      publishedAt: old.publishedAt,
      mimeType: 'text/markdown',
      byteSize: body.byteSize,
      contentHash: body.contentHash,
      attachments: [attachment],
    }
    return {
      oldObjectID: old.id,
      newObjectID: body.id,
      newURL: body.itemURL,
      newContentHash: body.contentHash,
      newItem,
    }
  })

  const updatedItems = [...current.items]
  for (let k = 0; k < legacyIndices.length; k++) {
    updatedItems[legacyIndices[k]] = replacements[k].newItem
  }
  const updated: ChannelManifest = {
    ...current,
    publishedAt: new Date().toISOString(),
    items: updatedItems,
  }

  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  try {
    await putChannelRecord(agent, channel.channelID, ciphertext)
  } catch (e) {
    // Manifest write failed — roll back the new body uploads. The legacy
    // items + their bytes are untouched, so the channel returns to its
    // pre-migration state. Orphan sweep would also catch any survivors.
    for (const r of replacements) {
      sdk.deleteObject(r.newObjectID).catch(() => {})
    }
    throw e
  }

  return {
    channelID: channel.channelID,
    migratedCount: legacyIndices.length,
    replacements,
    manifest: updated,
  }
}
