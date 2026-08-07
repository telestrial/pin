// Publish state is what stands between superseding a Sia object and leaking it
// permanently (the orphan sweep was removed on the positive-id principle), so the
// properties that matter are: it round-trips, it's sealed, and not knowing is a
// survivable answer rather than a thrown one.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./docs', async () =>
  (await import('../test/fakeModules')).fakeDocsModule(),
)

import { fakeDocStore } from '../test/fakeModules'
import {
  channelPublishKey,
  clearPublished,
  readPublished,
  writePublished,
} from './publishState'

const APP_KEY_HEX = 'a1'.repeat(32)

describe('publish state', () => {
  beforeEach(() => {
    fakeDocStore.clear()
  })

  it('round-trips what was published', async () => {
    const rkey = await channelPublishKey('chan-1')
    await writePublished(APP_KEY_HEX, rkey, {
      id: 'obj-2',
      url: 'sia://obj-2#encryption_key=k',
      olderId: 'obj-1',
    })
    expect(await readPublished(APP_KEY_HEX, rkey)).toEqual({
      id: 'obj-2',
      url: 'sia://obj-2#encryption_key=k',
      olderId: 'obj-1',
    })
  })

  it('seals the record', async () => {
    // The URL's fragment IS the object's decryption key, so this must not sit in the
    // doc as readable JSON — the doc syncs between instances and is mirrored to Sia.
    const rkey = await channelPublishKey('chan-1')
    await writePublished(APP_KEY_HEX, rkey, {
      id: 'obj-1',
      url: 'sia://obj-1#encryption_key=secret',
    })
    const stored = new TextDecoder().decode(
      fakeDocStore.get(`published/${rkey}`),
    )
    expect(stored).not.toContain('secret')
    expect(stored).not.toContain('obj-1')
  })

  it('reads back nothing rather than throwing when it does not know', async () => {
    // A caller that doesn't know what it published skips the reclaim and the
    // keep-alive; throwing would fail a publish over its own bookkeeping.
    expect(
      await readPublished(APP_KEY_HEX, await channelPublishKey('never')),
    ).toBeNull()

    // Present but unreadable — a record sealed under a different identity's key,
    // which is what a shared doc could hand us. Same answer.
    const rkey = await channelPublishKey('chan-1')
    await writePublished('b2'.repeat(32), rkey, { id: 'obj-1' })
    expect(await readPublished(APP_KEY_HEX, rkey)).toBeNull()
  })

  it('forgets a record when its subject is gone', async () => {
    const rkey = await channelPublishKey('chan-1')
    await writePublished(APP_KEY_HEX, rkey, { id: 'obj-1' })
    await clearPublished(APP_KEY_HEX, rkey)
    expect(await readPublished(APP_KEY_HEX, rkey)).toBeNull()
  })

  it('keeps channels apart, and apart from identity-level publishers', async () => {
    await writePublished(APP_KEY_HEX, await channelPublishKey('a'), {
      id: 'obj-a',
    })
    await writePublished(APP_KEY_HEX, await channelPublishKey('b'), {
      id: 'obj-b',
    })
    expect(
      (await readPublished(APP_KEY_HEX, await channelPublishKey('a')))?.id,
    ).toBe('obj-a')
    // Prefixed, so a channel named like a future identity-level rkey can't collide.
    expect(await channelPublishKey('directory')).not.toBe('directory')
  })
})
