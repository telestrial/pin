// The share URL shape both fakes speak — in one module because they speak it to EACH
// OTHER. `fakeSia` mints a URL and `fakeModules` resolves it, so the shape was a
// contract held in two places by coincidence, and a change to one silently broke the
// other. Neither imports the production code it stands in for, so this stays safe to
// pull into a `vi.mock` factory.
//
// It mirrors real Sia rather than inventing a shape: the object id IS the path
// (`sia://<authority>/objects/<id>/shared`) and the key rides in the fragment. The
// fake does not encrypt, so its fragment just carries the id back — but the PATH is
// load-bearing, because reading an id out of it is a thing the app now does.

export function fakeShareURL(objectID: string): string {
  return `sia://fake/objects/${objectID}/shared#k=${objectID}`
}

/** The id a fake share URL names, or null when it names none. Null rather than a throw:
 *  a caller deciding what an unreadable snapshot means has to be able to tell "this URL
 *  says nothing" from "this URL says the object is gone". */
export function fakeObjectID(url: string): string | null {
  return (
    /^sia:\/\/fake\/objects\/([^/]+)\/shared(?:[#?]|$)/.exec(url)?.[1] ?? null
  )
}
