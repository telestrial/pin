// Open a URL in the user's real browser.
//
// In a normal browser this is just `window.open(_, '_blank')`. Inside the Tauri
// desktop shell a webview won't pop `target="_blank"` / `window.open` to the
// system browser, so we route through the opener plugin instead. The plugin is
// dynamically imported only when running under Tauri, so its JS never enters the
// web bundle.

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function openExternal(url: string): Promise<void> {
  if (inTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
