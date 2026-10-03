// The channel round-trip over Tauri IPC — the desktop half of the seam in
// channelLocatorNative.ts.
//
// The payload shapes are `pin_channel::Published` / `Resolved` serialized by the same
// serde derives the wasm path returns, so both hops deliver one shape and there is no
// per-platform mapping to keep in step.

import type { PublishedLocator, ResolvedLocator } from './channelLocatorNative'

export async function makeTauriChannelLocator() {
  const { invoke } = await import('@tauri-apps/api/core')

  return {
    publishLocator: (
      appKeyHex: string,
      channelKey: Uint8Array,
      manifestJson: string,
    ) =>
      invoke<PublishedLocator>('channel_publish', {
        appKeyHex,
        channelKey: Array.from(channelKey),
        manifestJson,
      }),

    resolveLocator: async (
      channelKey: Uint8Array,
      author: string,
      appKeyHex: string | undefined,
    ) =>
      // Rust's `Option<Resolved>` arrives as null, which the seam reports as null.
      (await invoke<ResolvedLocator | null>('channel_resolve', {
        channelKey: Array.from(channelKey),
        author,
        appKeyHex,
      })) ?? null,

    resolveProfile: async (channelKey: Uint8Array, author: string) =>
      (await invoke<string | null>('channel_resolve_profile', {
        channelKey: Array.from(channelKey),
        author,
      })) ?? null,

    openBlob: (
      channelKey: Uint8Array,
      author: string,
      blob: string,
      appKeyHex: string | undefined,
    ) =>
      invoke<string>('channel_open_blob', {
        channelKey: Array.from(channelKey),
        author,
        blob,
        appKeyHex,
      }),

    republishPointer: (channelKey: Uint8Array, itemURL: string) =>
      invoke<void>('channel_republish_pointer', {
        channelKey: Array.from(channelKey),
        itemUrl: itemURL,
      }),

    resolveConversationsUrl: async (channelKey: Uint8Array) =>
      (await invoke<string | null>('channel_resolve_conversations_url', {
        channelKey: [...channelKey],
      })) ?? null,
    fetchConversations: (
      channelKey: Uint8Array,
      author: string,
      itemURL: string,
      appKeyHex: string | undefined,
    ) =>
      invoke<string>('channel_fetch_conversations', {
        channelKey: [...channelKey],
        author,
        itemUrl: itemURL,
        appKeyHex,
      }),
    resolveTalliesUrl: async (channelKey: Uint8Array) =>
      (await invoke<string | null>('channel_resolve_tallies_url', {
        channelKey: Array.from(channelKey),
      })) ?? null,

    fetchTallies: (
      channelKey: Uint8Array,
      author: string,
      itemURL: string,
      appKeyHex: string | undefined,
    ) =>
      invoke<string>('channel_fetch_tallies', {
        channelKey: Array.from(channelKey),
        author,
        itemUrl: itemURL,
        appKeyHex,
      }),
  }
}
