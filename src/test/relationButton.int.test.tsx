// What the button says WHILE it is working.
//
// Every relation in Pin toggles its store synchronously and then awaits the slow half — a
// directory resolve, a settings write. So by the first render after a click, the state
// already describes the destination rather than where the click came from, and a busy
// label derived from it names the opposite action: "Unfollowing…" while it follows you.
//
// The intent is knowable only at the click. These hold the async half open so there is a
// frame to look at, and RE-RENDER with the flipped state in between, which is what the
// real caller does the moment its store write lands. That middle step is the whole test:
// without it the state never moves and a state-derived label looks fine.
//
// It is also why nothing caught this — every other assertion in the suite reads a button
// at rest, where the label is right.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { RelationButton } from '../components/RelationButton'

/** A handler whose promise the test decides when to settle. */
function held() {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const LABELS = {
  onLabel: 'Following',
  offLabel: 'Follow',
  turningOnLabel: 'Following…',
  turningOffLabel: 'Unfollowing…',
  tone: 'public',
} as const

/** The button, plus a way to move the state under it without remounting — remounting
 *  would discard the pending intent, which is the thing under test. */
function mounted(active: boolean, onClick: () => Promise<void>) {
  const { rerender } = render(
    <RelationButton {...LABELS} active={active} onClick={onClick} />,
  )
  return (next: boolean) =>
    rerender(<RelationButton {...LABELS} active={next} onClick={onClick} />)
}

describe('integration: a relation button while its side-effect lands', () => {
  afterEach(cleanup)

  it('says it is following while it follows, once the store has flipped', async () => {
    // The reported bug, in order: click Follow, the store writes the edge synchronously,
    // the parent re-renders as active — and the label has to keep naming the action that
    // is still running rather than the state that already arrived.
    const { promise, release } = held()
    const setActive = mounted(false, () => promise)

    await userEvent.click(screen.getByText('Follow'))
    setActive(true)

    expect(screen.getByText('Following…')).toBeInTheDocument()
    expect(screen.queryByText('Unfollowing…')).toBeNull()

    release()
    await waitFor(() =>
      expect(screen.getByText('Following')).toBeInTheDocument(),
    )
  })

  it('says it is unfollowing while it unfollows', async () => {
    // The mirror, wrong in the same way: `removeFollow` flips it false first, so a
    // state-derived label read "Following…" while it dropped the follow.
    const { promise, release } = held()
    const setActive = mounted(true, () => promise)

    await userEvent.click(screen.getByText('Following'))
    setActive(false)

    expect(screen.getByText('Unfollowing…')).toBeInTheDocument()
    expect(screen.queryByText('Following…')).toBeNull()

    release()
    await waitFor(() => expect(screen.getByText('Follow')).toBeInTheDocument())
  })

  it('takes one click at a time', async () => {
    // The guard that moved out of each caller when the busy state did. Two relations
    // landing at once on one channel is two settings writes racing over one list.
    let calls = 0
    const { promise, release } = held()
    mounted(false, () => {
      calls++
      return promise
    })

    await userEvent.click(screen.getByText('Follow'))
    await userEvent.click(screen.getByText('Following…'))

    expect(calls).toBe(1)
    release()
  })
})
