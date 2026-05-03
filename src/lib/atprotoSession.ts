import type { AtpPersistSessionHandler } from '../core/atproto'
import { useAuthStore } from '../stores/auth'

// Wires the AtpAgent's session lifecycle into the auth store.
//
// 'update' fires every time the agent rotates its access token via the
// refresh token — without this, the rotated session lives only in memory and
// the persisted localStorage copy goes stale. Next boot, resumeSession() then
// fails on the stale token and the user is prompted to re-authenticate.
//
// 'expired' fires when even the refresh token is dead. We clear the session
// so the next publish attempt prompts a clean re-login rather than failing
// silently.
export const persistAtprotoSession: AtpPersistSessionHandler = (
  evt,
  session,
) => {
  if (evt === 'update' && session) {
    const agent = useAuthStore.getState().atprotoAgent
    useAuthStore.getState().setATProtoSession(session, agent)
  } else if (evt === 'expired') {
    useAuthStore.getState().setATProtoSession(null, null)
  }
}
