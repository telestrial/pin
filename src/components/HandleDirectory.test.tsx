import { render, screen } from '@testing-library/react'
import {
  MemoryRouter,
  Route,
  Routes,
  useParams,
} from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { handleFromCatchAllPath } from './HandleDirectory'

// React Router v7's matcher requires a `/` before any `:param` or `*`,
// so `/@:handle` and `/@*` both fail to match `/@anything` (the matcher
// reads them as literal segments). Workaround: catch-all splat route
// `*` that captures whatever the URL is, then a tiny pure helper
// (handleFromCatchAllPath) inspects the captured path and decides
// whether it's a handle URL. The component renders HandleDirectory or
// Home accordingly. The helper is exported so it can be unit-tested
// without dragging the full component (and its network calls) in.

function HandleStub() {
  const params = useParams()
  const handle = handleFromCatchAllPath(params['*'] ?? '')
  if (handle) return <div data-testid="handle">handle:{handle}</div>
  return <div data-testid="home">home</div>
}

function HomeStub() {
  return <div data-testid="home">home</div>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<HomeStub />} />
        <Route path="*" element={<HandleStub />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('handleFromCatchAllPath', () => {
  it('extracts a plain handle (no dots)', () => {
    expect(handleFromCatchAllPath('@alice')).toBe('alice')
  })

  it('extracts a dotted handle (Bluesky-style TLD)', () => {
    expect(handleFromCatchAllPath('@john.bsky.social')).toBe('john.bsky.social')
  })

  it('extracts a custom-domain handle (multi-dot)', () => {
    expect(handleFromCatchAllPath('@johnwilliams.codes')).toBe(
      'johnwilliams.codes',
    )
  })

  it('returns null for a path without leading @', () => {
    expect(handleFromCatchAllPath('whatever')).toBeNull()
  })

  it('returns null for a path with extra segments after the handle', () => {
    // Deeper paths shouldn't be misinterpreted as a handle directory.
    expect(handleFromCatchAllPath('@alice/posts')).toBeNull()
  })

  it('returns null for an empty path', () => {
    expect(handleFromCatchAllPath('')).toBeNull()
  })

  it('returns null for just "@" (no handle)', () => {
    expect(handleFromCatchAllPath('@')).toBeNull()
  })
})

describe('catch-all router with handle helper', () => {
  it('routes /@alice to the handle view', () => {
    renderAt('/@alice')
    expect(screen.getByTestId('handle').textContent).toBe('handle:alice')
  })

  it('routes /@johnwilliams.codes to the handle view', () => {
    renderAt('/@johnwilliams.codes')
    expect(screen.getByTestId('handle').textContent).toBe(
      'handle:johnwilliams.codes',
    )
  })

  it('routes / to home', () => {
    renderAt('/')
    expect(screen.getByTestId('home')).toBeDefined()
  })

  it('falls back to home for unknown routes', () => {
    renderAt('/nope/whatever')
    expect(screen.getByTestId('home')).toBeDefined()
  })
})
