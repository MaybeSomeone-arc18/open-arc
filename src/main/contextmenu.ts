import { clipboard, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

/**
 * Right-click menu for page content inside a tab. Kept as a pure builder so
 * the smoke suite can construct it and fire the items' click handlers
 * directly (the native popup itself can't be asserted headless).
 */
export function buildPageContextMenu(
  params: ContextMenuParams,
  wc: WebContents,
  openInNewTab: (url: string) => void
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []

  if (params.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => openInNewTab(params.linkURL) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    )
  }
  if (params.mediaType === 'image') {
    items.push(
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      { type: 'separator' }
    )
  }
  if (params.selectionText.trim()) {
    items.push({ label: 'Copy', role: 'copy' }, { type: 'separator' })
  }

  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'View Page Source', click: () => openInNewTab(`view-source:${wc.getURL()}`) },
    { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }
  )
  return items
}
