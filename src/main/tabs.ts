import { BrowserWindow, Menu, WebContentsView, type Rectangle } from 'electron'
import { buildPageContextMenu } from './contextmenu'
import type { Space, TabItem } from '../shared/types'
import { matchShortcut } from '../shared/shortcuts'

const SIDEBAR_WIDTH = 280

/**
 * TabLayer owns the Chromium content layer: one WebContentsView per open tab,
 * only the active view attached to the window. This is the seam where a future
 * Chromium-foundation swap (CEF/ungoogled-chromium) would replace Electron:
 * everything above this file talks to the data model, not to Electron APIs.
 */
export class TabLayer {
  private views = new Map<string, WebContentsView>()
  private win: BrowserWindow
  private sidebarVisible = true
  private onTabUpdated: (tab: TabItem) => void
  private onLoading: (tabId: string, loading: boolean) => void

  constructor(
    win: BrowserWindow,
    onTabUpdated: (tab: TabItem) => void,
    onLoading: (tabId: string, loading: boolean) => void = () => {},
    private onNavigate: (tab: TabItem) => void = () => {},
    private onOpenInNewTab: (url: string) => void = () => {},
    private onShortcut: (action: string, arg?: string) => void = () => {}
  ) {
    this.win = win
    this.onTabUpdated = onTabUpdated
    this.onLoading = onLoading
    win.on('resize', () => this.layout())
    // macOS full-screen transitions are animated/asynchronous; relayout when
    // they finish so tab panes track the final content size.
    win.on('enter-full-screen', () => this.layout())
    win.on('leave-full-screen', () => this.layout())
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible
    this.layout()
  }

  private attachedIds: string[] = []
  /** Shell overlays: modals cover the page area (views hidden, since child
   * views composite above the shell DOM); the find bar needs the page to
   * stay visible, so views shrink to a reserved strip at the top instead. */
  private modalOpen = false
  private findBarOpen = false
  private static FIND_BAR_INSET = 48

  setOverlayState(modal: boolean, findBar: boolean): void {
    this.modalOpen = modal
    this.findBarOpen = findBar
    this.applyOverlayState()
    this.layout()
  }

  private applyOverlayState(): void {
    for (const id of this.attachedIds) {
      const view = this.views.get(id)
      if (view && this.win.contentView.children.includes(view)) view.setVisible(!this.modalOpen)
    }
  }

  private layout(): void {
    const [w, h] = this.win.getContentSize()
    const x = this.sidebarVisible ? SIDEBAR_WIDTH : 0
    const width = Math.max(0, w - x)
    const top = this.findBarOpen && !this.modalOpen ? TabLayer.FIND_BAR_INSET : 0
    const n = this.attachedIds.length || 1
    this.attachedIds.forEach((id, i) => {
      const view = this.views.get(id)
      if (!view) return
      const paneWidth = Math.floor(width / n)
      view.setBounds({ x: x + i * paneWidth, y: top, width: i === n - 1 ? width - i * paneWidth : paneWidth, height: Math.max(0, h - top) })
    })
  }

  private ensureView(tab: TabItem): WebContentsView {
    const existing = this.views.get(tab.id)
    if (existing) return existing
    // Tab views load untrusted web content: sandboxed renderers, no preload.
    const view = new WebContentsView({ webPreferences: { sandbox: true } })
    this.views.set(tab.id, view)
    // Attach listeners BEFORE loadURL: with in-process rendering the
    // load events can dispatch synchronously and would be missed.
    const push = (): void => {
      tab.title = view.webContents.getTitle() || tab.url
      this.onTabUpdated({ ...tab, title: tab.title })
    }
    view.webContents.on('page-title-updated', () => {
      push()
      this.onNavigate(tab) // dedupe path refreshes the recorded title
    })
    view.webContents.on('did-navigate', () => {
      tab.url = view.webContents.getURL()
      this.onNavigate(tab)
      push()
    })
    view.webContents.on('did-navigate-in-page', () => {
      tab.url = view.webContents.getURL()
      push()
    })
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED (a newer navigation superseded this one): not an error.
      if (!isMainFrame || errorCode === -3) return
      const info = JSON.stringify({ url: validatedURL, desc: errorDescription })
      view.webContents
        .executeJavaScript(`(() => {
          const info = ${info}
          document.head.innerHTML = ''
          document.body.innerHTML = ''
          document.body.style.cssText = 'margin:0;background:#141418;color:#e8e8ea;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;'
          const box = document.createElement('div')
          box.className = 'oa-error'
          box.style.cssText = 'max-width:520px;text-align:center;padding:32px;'
          const h = document.createElement('h1')
          h.textContent = "Couldn't load this page"
          h.style.cssText = 'font-size:20px;margin:0 0 12px;'
          const u = document.createElement('div')
          u.textContent = info.url
          u.style.cssText = 'font-size:13px;opacity:0.7;word-break:break-all;margin-bottom:12px;'
          const d = document.createElement('div')
          d.textContent = info.desc
          d.style.cssText = 'font-size:13px;opacity:0.55;'
          const hint = document.createElement('div')
          hint.textContent = 'Check the address or your connection, then reload (Ctrl+R).'
          hint.style.cssText = 'font-size:12px;opacity:0.45;margin-top:16px;'
          box.append(h, u, d, hint)
          document.body.appendChild(box)
        })()`)
        .catch(() => {})
    })
    // App shortcuts must work while the PAGE has keyboard focus: key events
    // inside this view never reach the shell renderer's keydown listener.
    // Matched combos are consumed here and forwarded to the shell; everything
    // else (ordinary typing, page-owned combos) passes through untouched.
    // Attached only to tab views, never the shell webContents, so each key is
    // handled by exactly one path.
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const m = matchShortcut({
        key: input.key,
        meta: !!input.meta,
        ctrl: !!input.control,
        shift: !!input.shift,
        alt: !!input.alt
      })
      if (!m) return
      event.preventDefault()
      this.onShortcut(m.id, m.arg)
    })
    view.webContents.on('did-start-loading', () => this.onLoading(tab.id, true))
    view.webContents.on('did-stop-loading', () => this.onLoading(tab.id, false))
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] ?? null
      this.onTabUpdated({ ...tab })
    })
    view.webContents.on('context-menu', (_e, params) => {
      Menu.buildFromTemplate(buildPageContextMenu(params, view.webContents, (url) => this.onOpenInNewTab(url))).popup()
    })
    // Popups (window.open, target=_blank) become tabs in this shell, never OS windows.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) this.onOpenInNewTab(url)
      return { action: 'deny' }
    })
    // Navigation resets zoom to the origin default, so a stored factor must
    // be (re)applied after the page finishes loading.
    if (tab.zoom && tab.zoom !== 1) {
      view.webContents.on('did-stop-loading', () => {
        const z = tab.zoom
        if (z && z !== 1 && !view.webContents.isDestroyed()) view.webContents.setZoomFactor(z)
      })
    }
    view.webContents.loadURL(tab.url)
    return view
  }

  /** Attach views for the active tab (and split partner), detach everything else. */
  show(space: Space): void {
    const all = [...space.pinned, ...space.today]
    const active = all.find((t) => t.id === space.activeTabId)
    const split = space.splitTabId ? all.find((t) => t.id === space.splitTabId) : undefined
    const wanted = [active, split].filter((t): t is TabItem => !!t && t.id !== undefined)
    const wantedIds = [...new Set(wanted.map((t) => t.id))]
    for (const [id, view] of this.views) {
      if (!wantedIds.includes(id) && this.win.contentView.children.includes(view)) {
        this.win.contentView.removeChildView(view)
      }
    }
    this.attachedIds = []
    for (const tab of wanted) {
      const view = this.ensureView(tab)
      if (!this.win.contentView.children.includes(view)) {
        this.win.contentView.addChildView(view)
      }
      if (this.modalOpen) view.setVisible(false)
      if (!this.attachedIds.includes(tab.id)) this.attachedIds.push(tab.id)
    }
    this.layout()
  }

  focusTab(tabId: string): void {
    const view = this.views.get(tabId)
    if (view && this.win.contentView.children.includes(view)) view.webContents.focus()
  }

  close(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    if (this.win.contentView.children.includes(view)) this.win.contentView.removeChildView(view)
    view.webContents.close()
    this.views.delete(tabId)
  }

  findIn(tabId: string, text: string, findNext = false): Promise<Electron.FoundInPageResult | null> {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return Promise.resolve(null)
    if (!text.trim()) {
      wc.stopFindInPage('clearSelection')
      return Promise.resolve(null)
    }
    // Clear any stale find session first; a wedged session can swallow the
    // next request's found-in-page dispatch.
    wc.stopFindInPage('clearSelection')
    const attempt = (): Promise<Electron.FoundInPageResult | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 4000) // no-match environments must not hang
        wc.once('found-in-page', (_e, result) => {
          clearTimeout(timer)
          resolve(result)
        })
        wc.findInPage(text, { forward: true, findNext })
      })
    return attempt().then((r) => r ?? attempt())
  }

  stopFind(tabId: string): void {
    this.views.get(tabId)?.webContents.stopFindInPage('clearSelection')
  }

  private static readonly ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

  adjustZoom(tabId: string, action: 'in' | 'out' | 'reset'): number {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return 1
    if (action === 'reset') {
      wc.setZoomFactor(1)
      return 1
    }
    const cur = wc.getZoomFactor()
    const steps = TabLayer.ZOOM_STEPS
    const next =
      action === 'in'
        ? (steps.find((z) => z > cur + 0.001) ?? steps[steps.length - 1])
        : ([...steps].reverse().find((z) => z < cur - 0.001) ?? steps[0])
    wc.setZoomFactor(next)
    return next
  }

  getZoom(tabId: string): number {
    return this.views.get(tabId)?.webContents.getZoomFactor() ?? 1
  }

  toggleMute(tabId: string): boolean {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return false
    const next = !wc.isAudioMuted()
    wc.setAudioMuted(next)
    return next
  }

  toggleDevTools(tabId: string): boolean {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return false
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
    return wc.isDevToolsOpened()
  }

  webContentsFor(tabId: string): Electron.WebContents | null {
    return this.views.get(tabId)?.webContents ?? null
  }

  isDevToolsOpen(tabId: string): boolean {
    return this.views.get(tabId)?.webContents.isDevToolsOpened() ?? false
  }

  isMuted(tabId: string): boolean {
    return this.views.get(tabId)?.webContents.isAudioMuted() ?? false
  }

  navigate(tabId: string, command: 'back' | 'forward' | 'reload' | 'hard-reload'): void {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return
    if (command === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (command === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (command === 'reload') wc.reload()
    if (command === 'hard-reload') wc.reloadIgnoringCache()
  }

  navigateActiveTo(tabId: string, url: string): void {
    this.views.get(tabId)?.webContents.loadURL(url)
  }

  currentUrl(tabId: string): string | null {
    return this.views.get(tabId)?.webContents.getURL() ?? null
  }

  /** Genuine pixels of one tab's page (used by the smoke suite for evidence).
   *  Returns null when the compositor cannot produce frames (restricted
   *  headless containers) - callers treat that as "no pixels", never a failure. */
  async capture(tabId: string): Promise<Buffer | null> {
    const view = this.views.get(tabId)
    if (!view) return null
    const img = await view.webContents.capturePage()
    if (img.isEmpty()) return null
    return img.toPNG()
  }
}

export { SIDEBAR_WIDTH }
