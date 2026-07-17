// Phase D step 3 — publish/resolve an identity's public directory document. The
// atproto-free directory: profile + advertised public channels + follows, as one
// public Sia blob pointed at by a chunked `_dir` record under the did:dht key.
//
// Unlike a channel locator, the blob is NOT app-encrypted under a secret — the
// directory is public. Sia's own per-object encryption (key in the share URL, which
// IS the `_dir` pointer anyone resolving the did:dht receives) is the only layer, so
// it's public-by-capability. Anyone who can resolve your did:dht can read it.

import type { Sdk } from '@siafoundation/sia-storage'
import {
  DIRECTORY_DOC_VERSION,
  type DirectoryDoc,
} from '../core/identityDoc'
import { downloadItem, uploadItem } from '../core/sia'
import {
  chunkForTxt,
  deriveDidDht,
  publishRecords,
  reassembleTxt,
  resolveDidDht,
} from './pkarr'

// TXT record name prefix for the chunked Sia pointer in an identity document.
const POINTER_PREFIX = '_dir'

/** Publish the directory blob to Sia and the pointer under this identity's did:dht.
 *  Browser owns the record (option i): a plain publish, which overwrites whatever
 *  was under the key (incl. a keeper's `_iroh`/`_ns` — no live consumer yet; true
 *  keeper↔browser convergence is the deferred multi-instance problem). Returns the
 *  Sia object id (for the caller to reclaim the superseded one) + URL. */
export async function publishIdentityDoc(
  sdk: Sdk,
  appKeyBytes: Uint8Array,
  doc: DirectoryDoc,
): Promise<{ id: string; url: string }> {
  const uploaded = await uploadItem(
    sdk,
    new TextEncoder().encode(JSON.stringify(doc)),
  )
  const { keypair } = await deriveDidDht(appKeyBytes)
  await publishRecords(keypair, chunkForTxt(POINTER_PREFIX, uploaded.itemURL))
  return { id: uploaded.id, url: uploaded.itemURL }
}

/** Resolve an identity's directory document from its did:dht (or bare pkarr key).
 *  null when no `_dir` pointer is published / resolvable. */
export async function resolveIdentityDoc(
  sdk: Sdk,
  didDht: string,
): Promise<DirectoryDoc | null> {
  const records = await resolveDidDht(didDht)
  const url = reassembleTxt(records, POINTER_PREFIX)
  if (!url) return null

  const bytes = await downloadItem(sdk, url)
  const doc = JSON.parse(new TextDecoder().decode(bytes))
  if (doc?.version !== DIRECTORY_DOC_VERSION) {
    throw new Error(
      `Unsupported directory doc version (got ${doc?.version}, expected ${DIRECTORY_DOC_VERSION})`,
    )
  }
  return doc as DirectoryDoc
}
