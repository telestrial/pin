import { describe, expect, it } from 'vitest'
import type { ChannelManifest, ItemRef } from '../core/types'
import { objectIDsInManifests } from './scopeRefs'

function item(
  id: string,
  attachmentObjectIDs: (string | undefined)[] = [],
): ItemRef {
  return {
    id,
    itemURL: `url-${id}`,
    type: 'text',
    title: '',
    publishedAt: '',
    mimeType: 'text/markdown',
    byteSize: 0,
    attachments: attachmentObjectIDs.map((objectID) => ({
      url: `att-${objectID ?? 'x'}`,
      mimeType: 'image/png',
      byteSize: 1,
      objectID,
    })),
  }
}

function manifest(items: ItemRef[]): ChannelManifest {
  return {
    version: 1,
    name: '',
    description: '',
    authorPubkey: '',
    authorATProtoDID: '',
    publishedAt: '',
    items,
  }
}

describe('objectIDsInManifests', () => {
  it('collects item body ids + attachment objectIDs', () => {
    const m = { c1: manifest([item('b1', ['a1', 'a2']), item('b2')]) }
    expect([...objectIDsInManifests(m)].sort()).toEqual([
      'a1',
      'a2',
      'b1',
      'b2',
    ])
  })

  it('excludes the named channel', () => {
    const m = { c1: manifest([item('b1')]), c2: manifest([item('b2')]) }
    expect([...objectIDsInManifests(m, 'c1')]).toEqual(['b2'])
  })

  it('skips attachments without an objectID (legacy)', () => {
    const m = { c1: manifest([item('b1', [undefined])]) }
    expect([...objectIDsInManifests(m)]).toEqual(['b1'])
  })

  it('is empty for no manifests', () => {
    expect(objectIDsInManifests({}).size).toBe(0)
  })
})
