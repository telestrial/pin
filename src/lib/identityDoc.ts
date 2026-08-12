// Read an identity's public directory document — the atproto-free directory: profile + advertised public channels + follows, as one
// public Sia blob pointed at by a chunked `_dir` record under the did:dht key.
//
// Unlike a channel locator, the blob is NOT app-encrypted under a secret — the
// directory is public. Sia's own per-object encryption (key in the share URL, which
// IS the `_dir` pointer anyone resolving the did:dht receives) is the only layer, so
// it's public-by-capability. Anyone who can resolve your did:dht can read it.
//
// READ ONLY. Publishing is the Curator's (`pin_curator`'s identity loop), because the
// record it goes in carries the doc namespace and every live endpoint too — parts no
// single instance knows on its own, which is why two writers used to overwrite each
// other. Resolving someone ELSE's directory is still here: that's a read of a stranger,
// and moving it belongs with the crawl rather than with publishing.

import { DIRECTORY_DOC_VERSION, type DirectoryDoc } from '../core/identityDoc'
import type { SiaClient } from '../core/siaClient'
import { reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'

// TXT record name prefix for the chunked Sia pointer in an identity document.
const POINTER_PREFIX = '_dir'

/** Resolve an identity's directory document from its did:dht (or bare pkarr key).
 *  null when no `_dir` pointer is published / resolvable. */
export async function resolveIdentityDoc(
  client: SiaClient,
  didDht: string,
): Promise<DirectoryDoc | null> {
  const records = await (await pkarrTransport()).resolve(didDht)
  const url = await reassembleTxt(records, POINTER_PREFIX)
  if (!url) return null

  const bytes = await client.downloadItem(url)
  const doc = JSON.parse(new TextDecoder().decode(bytes))
  if (doc?.version !== DIRECTORY_DOC_VERSION) {
    throw new Error(
      `Unsupported directory doc version (got ${doc?.version}, expected ${DIRECTORY_DOC_VERSION})`,
    )
  }
  return doc as DirectoryDoc
}
