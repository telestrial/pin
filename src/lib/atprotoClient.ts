import { Agent } from '@atproto/api'
import {
  BrowserOAuthClient,
  type OAuthSession,
  buildAtprotoLoopbackClientId,
} from '@atproto/oauth-client-browser'
import { useAuthStore } from '../stores/auth'

const CLIENT_METADATA_URL = 'https://pin-liard.vercel.app/client-metadata.json'

let clientPromise: Promise<BrowserOAuthClient> | null = null

// Lazy singleton — first access constructs the client (including IndexedDB
// setup); subsequent accesses reuse the same instance. The whole app shares
// one OAuth client.
export function getOauthClient(): Promise<BrowserOAuthClient> {
  if (!clientPromise) clientPromise = createClient()
  return clientPromise
}

export type OAuthBootResult = {
  session: OAuthSession
  agent: Agent
  did: string
  handle: string | null
} | null

let bootPromise: Promise<OAuthBootResult> | null = null

// Memoized OAuth bootstrap. Calling once kicks off init() (which restores an
// existing session OR processes a callback if URL params are present) plus
// a handle lookup. Subsequent callers receive the same promise — no
// concurrent init() calls racing each other (which happens by default under
// React StrictMode, where effects run twice). Multiple consumers (App.tsx
// to hydrate the store, AuthFlow to decide the next step) can both await
// the same boot.
export function bootOauth(): Promise<OAuthBootResult> {
  if (!bootPromise) bootPromise = doBoot()
  return bootPromise
}

async function doBoot(): Promise<OAuthBootResult> {
  const client = await getOauthClient()
  const result = await client.init()
  if (!result) return null
  const session = result.session
  const agent = new Agent(session)

  // If the auth store already has a cached handle for this DID (persisted
  // from a prior session), reuse it and skip the network round-trip
  // entirely. Otherwise fall through to getProfile, accepting that with
  // the narrow OAuth scope ("atproto repo:dev.sia.pin.channel ...") the
  // call returns 403 — handle stays null in that case and the cache is
  // preserved by setATProtoIdentity's null-coalesce.
  const cached = useAuthStore.getState()
  if (cached.atprotoDID === session.did && cached.atprotoHandle) {
    return { session, agent, did: session.did, handle: cached.atprotoHandle }
  }

  let handle: string | null = null
  try {
    const profile = await agent.getProfile({ actor: session.did })
    handle = profile.data.handle
  } catch {
    // getProfile failed — handle stays null. Subscribe URLs and the handle
    // display will be missing until next boot, but auth itself works.
  }
  return { session, agent, did: session.did, handle }
}

async function createClient(): Promise<BrowserOAuthClient> {
  const hostname = window.location.hostname

  // RFC 8252 forbids "localhost" as a redirect URI hostname — only loopback
  // IPs (127.0.0.1, [::1]) are permitted. If the user loaded the page at
  // localhost, swap to 127.0.0.1 so the OAuth round-trip lands on the same
  // origin we started from (otherwise IndexedDB scoping splits the session).
  if (hostname === 'localhost') {
    const next = new URL(window.location.href)
    next.hostname = '127.0.0.1'
    window.location.replace(next.toString())
    return new Promise<BrowserOAuthClient>(() => {})
  }

  const isLoopback = hostname === '127.0.0.1' || hostname === '[::1]'

  if (isLoopback) {
    // Loopback dev mode: no hosted metadata required. The atproto-flavored
    // loopback client_id encodes scope and redirect_uris into the client_id
    // URL itself, which the auth server reads back to derive metadata. The
    // generic buildLoopbackClientId from oauth-client-browser doesn't carry
    // scope, so the auth server defaults to bare "atproto" and rejects any
    // request asking for "transition:generic".
    const port = window.location.port ? `:${window.location.port}` : ''
    const redirectURI = `http://${hostname}${port}/`
    // Narrow scope: just enough to write/delete records in the lexicon Pin
    // owns, plus delete-only on the legacy dev.sia.dispatch.channel for
    // retraction of pre-rename channels. atproto is the required base
    // scope. The auth screen shows users exactly these — no profile/posts/
    // likes/follows surface they'd otherwise be granting under
    // transition:generic.
    const scope =
      'atproto repo:dev.sia.pin.channel repo:dev.sia.dispatch.channel?action=delete'
    const clientId = buildAtprotoLoopbackClientId({
      scope,
      redirect_uris: [redirectURI],
    })
    return new BrowserOAuthClient({
      clientMetadata: {
        client_id: clientId,
        client_name: 'Pin (dev)',
        redirect_uris: [redirectURI],
        scope,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
      },
      handleResolver: 'https://bsky.social',
    })
  }

  // Production / preview: fetch the hosted metadata. Both pin-liard.vercel.app
  // and the dev branch preview share this client_id and metadata file.
  return BrowserOAuthClient.load({
    clientId: CLIENT_METADATA_URL,
    handleResolver: 'https://bsky.social',
  })
}
