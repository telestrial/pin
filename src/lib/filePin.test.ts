import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../core/types'
import { itemRefFromAttachment } from './filePin'

describe('itemRefFromAttachment', () => {
  const base = { url: 'sia://x', byteSize: 10 }

  it('maps mime types to item types', () => {
    expect(itemRefFromAttachment({ ...base, mimeType: 'image/png' }).type).toBe(
      'image',
    )
    expect(
      itemRefFromAttachment({ ...base, mimeType: 'audio/mpeg' }).type,
    ).toBe('audio')
    expect(itemRefFromAttachment({ ...base, mimeType: 'video/mp4' }).type).toBe(
      'video',
    )
    expect(itemRefFromAttachment({ ...base, mimeType: 'text/html' }).type).toBe(
      'app',
    )
    expect(
      itemRefFromAttachment({ ...base, mimeType: 'application/pdf' }).type,
    ).toBe('file')
  })

  it('carries url, size, hash, and filename through', () => {
    const att: AttachmentRef = {
      url: 'sia://abc#k=1',
      mimeType: 'image/png',
      filename: 'cat.png',
      byteSize: 1234,
      contentHash: 'bafy',
      objectID: 'obj1',
    }
    const ref = itemRefFromAttachment(att)
    expect(ref.itemURL).toBe('sia://abc#k=1')
    expect(ref.id).toBe('obj1')
    expect(ref.title).toBe('cat.png')
    expect(ref.filename).toBe('cat.png')
    expect(ref.byteSize).toBe(1234)
    expect(ref.contentHash).toBe('bafy')
    expect(ref.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('falls back to the share URL for id when objectID is absent', () => {
    const ref = itemRefFromAttachment({
      url: 'sia://x',
      mimeType: 'image/png',
      byteSize: 1,
    })
    expect(ref.id).toBe('sia://x')
  })
})
