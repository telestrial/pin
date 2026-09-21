// What this identity has taken back, remembered across sessions.
//
// Withdrawing is a deletion — an endorsement or a comment is withdrawn by removing the
// record, and every reader takes the absence for the retraction. That works while the
// deletion is durable, and on web it is not immediately: the doc is a fresh MemStore each
// session and the snapshot that makes it durable is taken seconds later. A tab closed in
// between leaves a snapshot that still carries the record, and the boot restore then puts
// it back — so a withdrawal becomes an endorsement again, with nothing left that knows it
// was taken back. The restore is what makes this certain; before it the record was merely
// lost along with everything else.
//
// The catch-up that rebuilds endorsements cannot help, and must not: it is additive
// precisely because from there an absence is unreadable — a record it does not recognize
// belongs to another device, and deleting it would be deletion by absence. Only the
// action that withdrew knows, which is why the knowledge is kept here rather than
// inferred.
//
// LOCALSTORAGE, deliberately, where most things device-local have moved into the doc: the
// doc is the thing this outlives. A ledger inside it would be restored, lost and
// resurrected by exactly the mechanism it exists to survive.

import { deleteRecord, getRecord } from './docs'
import { inTauri } from './openExternal'

const KEY = 'pin:withdrawn'

/** A record's address, spelled the way `listAll` and the snapshot spell it. */
export function addressOf(collection: string, rkey: string): string {
  return `${collection}/${rkey}`
}

export function withdrawnAddresses(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    // Unavailable, full, or holding something that will not parse. An empty set restores
    // as much as the old behaviour did, which is the safe direction for a read.
    return new Set()
  }
}

function write(addresses: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...addresses]))
  } catch {
    // Quota or a private window. A withdrawal that cannot be remembered still deletes
    // the record; what is lost is the protection against a restore putting it back.
  }
}

/** Remember that this address was withdrawn. Called BEFORE the delete, so a delete that
 *  lands and a delete that fails are remembered alike — the record's absence is what a
 *  later restore would undo, and a failed delete leaves it present to be retried. */
export function rememberWithdrawn(collection: string, rkey: string): void {
  const held = withdrawnAddresses()
  held.add(addressOf(collection, rkey))
  write(held)
}

/** Forget these addresses, each having been shown absent from the durable snapshot.
 *
 *  That absence is the whole condition, and it is the only one that settles the question:
 *  a snapshot lacking the record can no longer put it back, so nothing here needs to
 *  outlive it. Forgetting on a successful delete instead would drop the entry while the
 *  snapshot still carried the record, which is the case this exists for. */
export function forgetWithdrawn(addresses: Iterable<string>): void {
  const held = withdrawnAddresses()
  let changed = false
  for (const a of addresses) changed = held.delete(a) || changed
  if (changed) write(held)
}

/** Put the ledger and the doc back in agreement.
 *
 *  Two jobs, and they are the same pass because they read the same record. A deletion
 *  that did not land leaves the record in the doc, still assembled into everything this
 *  identity publishes, so it is retried. An address the doc is rid of has nothing left
 *  to retry, and whether it can be forgotten is the one question the two platforms
 *  answer differently.
 *
 *  WHAT MAKES A DELETION DURABLE DIFFERS, and it is the physical difference rather than
 *  a device tier: the desktop's doc is a redb store that survives a restart, so a record
 *  absent from it is gone for good. A tab's doc is a MemStore rebuilt from the snapshot,
 *  so a record absent from it says nothing at all — the snapshot may still carry it, and
 *  the restore is what sees that. So the desktop forgets here and a tab forgets in
 *  `hydrateFromSia`. Forgetting here on web would drop the entry a moment before the
 *  next restore put the record back.
 *
 *  Answers how many deletions it retried. */
export async function settleWithdrawals(): Promise<number> {
  const held = withdrawnAddresses()
  if (held.size === 0) return 0
  const docIsDurable = inTauri()
  const settled: string[] = []
  let retried = 0
  for (const address of held) {
    // Split on the FIRST separator: a collection carries no slash and an rkey may.
    const cut = address.indexOf('/')
    if (cut < 0) {
      settled.push(address)
      continue
    }
    const collection = address.slice(0, cut)
    const rkey = address.slice(cut + 1)
    try {
      if (await getRecord(collection, rkey)) {
        await deleteRecord(collection, rkey)
        retried += 1
      } else if (docIsDurable) {
        settled.push(address)
      }
    } catch {
      // The engine is not up, or the write failed. The entry stays, which is the whole
      // point of it being durable.
    }
  }
  forgetWithdrawn(settled)
  return retried
}
