// The create form's choices, as a person sees them before anything is published.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { CreateChannel } from '../components/channel/CreateChannel'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

describe('integration: the create-channel form', () => {
  beforeEach(() => {
    resetAllStores()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('offers the profile choice for a public channel and not for a secret one', async () => {
    // A Secret channel is in no directory, so it cannot reach a profile; a ticked box
    // beside it would read as its posts going to your followers.
    render(<CreateChannel onCancel={() => {}} onCreated={() => {}} />)

    const profile = () =>
      screen.queryByRole('checkbox', { name: /Include on your profile/ })
    expect(profile()).toBeChecked()

    await userEvent.click(screen.getByRole('radio', { name: /Secret/ }))
    expect(profile()).toBeNull()

    await userEvent.click(screen.getByRole('radio', { name: /Public/ }))
    expect(profile()).toBeChecked()
  })
})
