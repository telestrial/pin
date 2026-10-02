// The members wrapper under Tauri, and its reading of a roster.
//
// The argument names are asserted because a plain `#[tauri::command]` takes them in
// camelCase as Tauri spells it, which knows word boundaries and not acronyms: this repo
// shipped `itemURL` to a command that read `itemUrl`, and the failure was silent.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./openExternal', () => ({ inTauri: () => true }))

const invoke = vi.fn(
  async (_cmd: string, _args: Record<string, unknown>) => ({}),
)
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const records = new Map<string, Uint8Array>()
vi.mock('./docs', () => ({
  listRecords: async (collection: string) =>
    [...records.keys()]
      .filter((k) => k.startsWith(`${collection}/`))
      .map((k) => k.slice(collection.length + 1)),
  getRecord: async (collection: string, rkey: string) =>
    records.get(`${collection}/${rkey}`),
}))

vi.mock('../core/wasm', () => ({ ensureWasm: async () => {} }))
vi.mock('../../crates/pin-core/pkg/pin_core.js', () => ({
  members_collection: () => 'members',
  membership_collection: () => 'membership',
  members_invite: () => {
    throw new Error('reached wasm on desktop')
  },
  members_remove: () => {
    throw new Error('reached wasm on desktop')
  },
}))

const put = (key: string, value: unknown) =>
  records.set(key, new TextEncoder().encode(JSON.stringify(value)))

describe('the members wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    records.clear()
  })

  it('invites and removes through the native backend, named as Tauri reads them', async () => {
    const { inviteMember, removeMember } = await import('./members')
    const key = new Uint8Array(32)
    await inviteMember('ab'.repeat(32), key, 'did:dht:bob', 'ZW5j')
    await removeMember('chan', 'did:dht:bob')
    const [inviteCall, removeCall] = invoke.mock.calls
    expect(inviteCall[0]).toBe('members_invite')
    expect(Object.keys(inviteCall[1]).sort()).toEqual([
      'appKeyHex',
      'channelKey',
      'did',
      'encKeyB64',
      'nowIso',
    ])
    expect(removeCall[0]).toBe('members_remove')
    expect(Object.keys(removeCall[1]).sort()).toEqual([
      'channelId',
      'did',
      'nowIso',
    ])
  })

  it('reads one channel’s roster and seats each person once', async () => {
    const { readRoster, standingMembers } = await import('./members')
    const seat = (id: string, did: string, removedAt?: string) => ({
      id,
      did,
      encKey: 'k',
      leaf: 0,
      addedAt: '2026-10-01T00:00:00Z',
      ...(removedAt ? { removedAt } : {}),
    })
    put('members/chan:a', seat('a', 'did:dht:bob', '2026-10-02T00:00:00Z'))
    put('members/chan:b', seat('b', 'did:dht:bob'))
    put('members/chan:c', seat('c', 'did:dht:carol'))
    put('members/other:d', seat('d', 'did:dht:dave'))
    records.set('members/chan:broken', new TextEncoder().encode('not json'))

    const roster = await readRoster('chan')
    expect(roster.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
    expect(
      standingMembers(roster)
        .map((s) => s.did)
        .sort(),
    ).toEqual(['did:dht:bob', 'did:dht:carol'])
  })
})
