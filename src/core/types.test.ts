import { describe, expect, it } from 'vitest'
import { isValidAttachment } from './types'

describe('isValidAttachment', () => {
  it('accepts a minimum-shape attachment (url + mimeType)', () => {
    expect(
      isValidAttachment({ url: 'https://sia.test/x', mimeType: 'image/jpeg' }),
    ).toBe(true)
  })

  it('accepts a full-shape attachment (url + mimeType + filename + byteSize + contentHash + objectID)', () => {
    expect(
      isValidAttachment({
        url: 'https://sia.test/x',
        mimeType: 'image/jpeg',
        filename: 'photo.jpg',
        byteSize: 1024,
        contentHash: 'bafkrei...',
        objectID: 'obj-1',
      }),
    ).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['a bare string (slice-1 shape)', 'https://sia.test/x'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['https://sia.test/x']],
    ['object missing url', { mimeType: 'image/jpeg' }],
    ['object missing mimeType', { url: 'https://sia.test/x' }],
    ['object with non-string url', { url: 123, mimeType: 'image/jpeg' }],
    ['object with non-string mimeType', { url: 'x', mimeType: 123 }],
    ['object with null url', { url: null, mimeType: 'image/jpeg' }],
  ])('rejects %s', (_label, input) => {
    expect(isValidAttachment(input)).toBe(false)
  })

  it('narrows the type for TypeScript via the guard', () => {
    const candidates: unknown[] = [
      { url: 'https://sia.test/a', mimeType: 'image/png' },
      'bad',
      null,
      { url: 123 },
    ]
    const valid = candidates.filter(isValidAttachment)
    // If the guard narrows correctly, .url is typed as string here.
    expect(valid.map((a) => a.url)).toEqual(['https://sia.test/a'])
  })
})
