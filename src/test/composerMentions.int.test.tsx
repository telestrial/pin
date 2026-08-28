// What an `@` actually PUBLISHES, driven through the composer both surfaces share.
//
// `buildMentionFacets` is well covered on its own and so is what a reader does with a facet
// once it is on a record. The gap was the wiring between them: nothing drove a box from a
// keystroke to a submission, so replacing the facets with `[]` at submit passed every tier
// while every mention in the app silently stopped anchoring to anybody.
//
// A mention is only a mention by virtue of the DID underneath it, and that DID is what makes
// it deliverable — so a mention that renders as text and carries no facet is indistinguishable
// from one that works, right up until nobody is notified.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The candidate pool only. Resolving it walks the network (an identity-doc per reachable
// person), which is its own subject with its own tests — what is under test here starts at
// the moment somebody is offered.
vi.mock('../core/network', () => ({
  buildReachablePeople: async () => [
    { did: 'did:dht:alice', handle: 'alice.test', username: 'alice', hop: 1 },
    { did: 'did:dht:bob', handle: 'bob.test', username: 'bob', hop: 2 },
  ],
  countReachablePeople: async () => 0,
}))

import { Composer, type ComposerSubmission } from '../components/Composer'
import { mentionOf } from '../lib/facets'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

/** The one facet a submission is expected to carry, plus the text it points at. */
function soleMention(submission: ComposerSubmission) {
  expect(submission.facets).toHaveLength(1)
  const facet = submission.facets[0]
  const { byteStart, byteEnd } = facet.index
  const bytes = new TextEncoder().encode(submission.body)
  return {
    did: mentionOf(facet)?.did,
    // What a READER would slice out of the published body using this facet. Anchoring is
    // the whole value of a facet, so the assertion has to be about the bytes it selects
    // rather than about the numbers themselves.
    surface: new TextDecoder().decode(bytes.slice(byteStart, byteEnd)),
  }
}

function composer(onSubmit: (s: ComposerSubmission) => void) {
  return (
    <Composer
      avatar={<div data-testid="avatar" />}
      placeholder="Say something"
      submitLabel="Post"
      limit={{ unit: 'chars', max: 300 }}
      onSubmit={onSubmit}
      startExpanded
    />
  )
}

/** Type an `@`, take the person the picker offers. */
async function mention(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByPlaceholderText('Say something')
  await user.click(box)
  await user.type(box, text)
  const option = await screen.findByRole('option', { name: /alice/ })
  await user.click(option)
}

describe('integration: a mention makes it from the box to the submission', () => {
  beforeEach(() => {
    resetAllStores()
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:me',
        handle: 'me.test',
      }),
    )
  })

  it('carries the picked identity as a facet anchored to its surface', async () => {
    const user = userEvent.setup()
    const submitted = vi.fn()
    render(composer(submitted))

    await mention(user, 'hello @ali')
    await user.click(screen.getByRole('button', { name: 'Post' }))

    await waitFor(() => expect(submitted).toHaveBeenCalled())
    const submission = submitted.mock.calls[0][0] as ComposerSubmission
    expect(submission.body).toBe('hello @alice')
    expect(soleMention(submission)).toEqual({
      did: 'did:dht:alice',
      surface: '@alice',
    })
  })

  it('anchors against the body as SUBMITTED, not as typed', async () => {
    // The composer trims before it publishes, so facets resolved against the untrimmed
    // draft would be offset by whatever the author left in front — every mention in the
    // body sliding by the same amount, pointing at the wrong words rather than at nothing.
    const user = userEvent.setup()
    const submitted = vi.fn()
    render(composer(submitted))

    await mention(user, '   hey @ali')
    await user.click(screen.getByRole('button', { name: 'Post' }))

    await waitFor(() => expect(submitted).toHaveBeenCalled())
    const submission = submitted.mock.calls[0][0] as ComposerSubmission
    expect(submission.body).toBe('hey @alice')
    expect(soleMention(submission).surface).toBe('@alice')
  })
})
