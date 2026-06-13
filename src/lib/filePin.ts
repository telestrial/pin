import type { AttachmentRef, ItemRef, ItemType } from '../core/types'

function typeForMime(mimeType: string): ItemType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'text/html') return 'app'
  return 'file'
}

// Synthesize a standalone library ItemRef from a post attachment so the file
// can be pinned on its own. The attachment's bytes already live on Sia, so the
// resulting pin just mirrors the existing object (no upload) into the
// LIBRARY_CHANNEL scope — a custody relationship separate from the whole-post
// pin. id falls back to the share URL when the publisher's objectID is absent
// (legacy attachments), matching how the rest of the pin machinery keys bytes.
export function itemRefFromAttachment(att: AttachmentRef): ItemRef {
  return {
    id: att.objectID ?? att.url,
    itemURL: att.url,
    type: typeForMime(att.mimeType),
    title: att.filename ?? '',
    publishedAt: new Date().toISOString(),
    mimeType: att.mimeType,
    byteSize: att.byteSize,
    contentHash: att.contentHash,
    filename: att.filename,
  }
}
