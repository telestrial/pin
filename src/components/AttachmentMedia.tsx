import { AppWindow, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { type AttachmentRef, isValidAttachment } from '../core/types'
import { installAppBridge } from '../lib/appBridge'
import { APP_SANDBOX } from '../lib/constants'
import { formatBytes } from '../lib/format'
import { useItemBlobURL, useItemBytes } from '../lib/useItemBytes'

export type AttachmentKind = 'image' | 'audio' | 'video' | 'app' | 'file'

export function kindForMime(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'text/html') return 'app'
  return 'file'
}

export function MediaPreview({
  previewURL,
  kind,
  filename,
  byteSize,
}: {
  previewURL: string | null
  kind: AttachmentKind
  filename: string
  byteSize: number
}) {
  if (kind === 'image') {
    if (!previewURL) {
      return <div className="w-full h-48 bg-neutral-100 animate-pulse" />
    }
    return (
      <img
        src={previewURL}
        alt={filename}
        className="block w-full h-auto max-h-96 object-contain bg-neutral-100"
      />
    )
  }
  if (kind === 'audio') {
    return (
      <div className="p-3 space-y-1.5">
        <p className="text-xs text-neutral-700 truncate">{filename}</p>
        {previewURL ? (
          <audio src={previewURL} controls className="w-full" />
        ) : (
          <div className="h-8 bg-neutral-100 rounded animate-pulse" />
        )}
      </div>
    )
  }
  if (kind === 'video') {
    if (!previewURL) {
      return <div className="w-full h-48 bg-neutral-100 animate-pulse" />
    }
    return (
      <video
        src={previewURL}
        controls
        className="block w-full h-auto max-h-96 object-contain bg-black"
      />
    )
  }
  if (kind === 'app') {
    // Composer chip preview is intentionally static — the live sandboxed render
    // is the published behavior (AppAttachment below). Avoids running an
    // unfinished post's app in the chip with no stable appID yet.
    return (
      <div className="flex items-center gap-2 p-3">
        <AppWindow className="size-5 text-neutral-500 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-neutral-900 truncate">{filename}</p>
          <p className="text-xs text-neutral-500">
            App · {formatBytes(byteSize)}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 p-3">
      <FileText className="size-5 text-neutral-500 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-neutral-900 truncate">{filename}</p>
        <p className="text-xs text-neutral-500">{formatBytes(byteSize)}</p>
      </div>
    </div>
  )
}

function MediaAttachment({
  attachment,
  kind,
}: {
  attachment: AttachmentRef
  kind: AttachmentKind
}) {
  const { url } = useItemBlobURL(
    attachment.url,
    attachment.mimeType,
    attachment.contentHash,
  )
  return (
    <MediaPreview
      previewURL={url}
      kind={kind}
      filename={attachment.filename ?? 'item'}
      byteSize={attachment.byteSize}
    />
  )
}

function AppAttachment({ attachment }: { attachment: AttachmentRef }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { bytes, error } = useItemBytes(attachment.url, attachment.contentHash)
  const html = useMemo(
    () => (bytes ? new TextDecoder().decode(bytes) : null),
    [bytes],
  )

  // Scope app state by the bytes' identity. objectID is stable across repack
  // URL swaps; contentHash is stable across encryption regime changes too;
  // url is the last resort for legacy refs lacking both.
  const appID = attachment.objectID ?? attachment.contentHash ?? attachment.url

  useEffect(() => {
    return installAppBridge(() => iframeRef.current, appID)
  }, [appID])

  if (error) return <p className="p-3 text-xs text-red-600">{error}</p>
  if (!html) {
    return <div className="w-full aspect-4/3 bg-neutral-100 animate-pulse" />
  }
  return (
    <iframe
      ref={iframeRef}
      title={attachment.filename ?? 'app'}
      srcDoc={html}
      sandbox={APP_SANDBOX}
      allow="fullscreen"
      className="block w-full aspect-4/3 bg-white"
    />
  )
}

function AttachmentTile({ attachment }: { attachment: AttachmentRef }) {
  const kind = kindForMime(attachment.mimeType)
  return (
    <div className="bg-neutral-50 border border-neutral-200 rounded-lg overflow-hidden">
      {kind === 'app' ? (
        <AppAttachment attachment={attachment} />
      ) : (
        <MediaAttachment attachment={attachment} kind={kind} />
      )}
    </div>
  )
}

const DISPLAY_CAP = 4

export function AttachmentGrid({
  attachments,
}: {
  attachments: AttachmentRef[]
}) {
  // Drop malformed entries — pre-AttachmentRef-schema posts (slice 1's URL-only
  // shape) would arrive as bare strings here. Render nothing rather than crash;
  // the user can republish if they want them rendered.
  const valid = attachments.filter(isValidAttachment)
  if (valid.length === 0) return null
  const showAll = valid.length <= DISPLAY_CAP
  const visible = showAll ? valid : valid.slice(0, DISPLAY_CAP - 1)
  const overflow = showAll ? 0 : valid.length - visible.length
  const tilesCount = visible.length + (overflow > 0 ? 1 : 0)
  return (
    <div
      className={`mt-3 grid gap-2 ${
        tilesCount === 1 ? 'grid-cols-1' : 'grid-cols-2'
      }`}
    >
      {visible.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: attachments is a stable manifest array
        <AttachmentTile key={i} attachment={a} />
      ))}
      {overflow > 0 && (
        <div className="bg-neutral-100 border border-neutral-200 rounded-lg flex items-center justify-center min-h-32">
          <span className="text-sm font-medium text-neutral-600">
            +{overflow} more
          </span>
        </div>
      )}
    </div>
  )
}
