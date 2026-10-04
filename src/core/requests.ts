// Which requests to read a private channel are still waiting on its author.
//
// One rule, for the panel that lists them and the count that says there are some, so the two
// cannot disagree about who is waiting. Pure: it is handed what the doc holds.

/** A request as the inbox holds it — the newest per person per channel. */
export type InboxRequest = {
  channelID: string
  actor: string
  createdAt: string
  withdrawn?: boolean
}

/** The author's answer to one request, as the decision record holds it. */
export type RequestDecision = {
  decision: 'approved' | 'denied'
  requestCreatedAt: string
}

/** The requests waiting on an answer, for one channel: standing, not already answered, and
 *  from somebody who is not a member.
 *
 *  A decision answers the request it was made for and nothing newer, so somebody turned down
 *  who asks again is waiting again. Somebody already seated is not waiting, whatever their
 *  request says — invited by hand while their request stood, say.
 *
 *  People this identity already follows or watches come first, the rest oldest first: the
 *  graph is the cheapest signal that a request is from somebody real, and nothing else here
 *  ranks anyone. */
export function pendingRequests(
  channelID: string,
  inbox: readonly InboxRequest[],
  decisions: ReadonlyMap<string, RequestDecision>,
  members: ReadonlySet<string>,
  graph: ReadonlySet<string>,
): InboxRequest[] {
  return inbox
    .filter(
      (r) =>
        r.channelID === channelID &&
        !r.withdrawn &&
        !members.has(r.actor) &&
        decisions.get(r.actor)?.requestCreatedAt !== r.createdAt,
    )
    .sort((a, b) => {
      const known = Number(graph.has(b.actor)) - Number(graph.has(a.actor))
      return known !== 0 ? known : a.createdAt.localeCompare(b.createdAt)
    })
}
