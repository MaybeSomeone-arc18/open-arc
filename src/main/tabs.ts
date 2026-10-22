import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import type { Space, TabItem } from '../shared/types'

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
    private onNavigate: (tab: TabItem) => void = () => {}
  ) {
    this.win = win
    this.onTabUpdated = onTabUpdated
    this.onLoading = onLoading
    win.on('resize', () => this.layout())
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible
    this.layout()
  }

  private attachedIds: string[] = []

  private layout(): void {
    const [w, h] = this.win.getContentSize()
    const x = this.sidebarVisible ? SIDEBAR_WIDTH : 0
    const width = Math.max(0, w - x)
    const n = this.attachedIds.length || 1
    this.attachedIds.forEach((id, i) => {
      const view = this.views.get(id)
      if (!view) return
      const paneWidth = Math.floor(width / n)
      view.setBounds({ x: x + i * paneWidth, y: 0, width: i === n - 1 ? width - i * paneWidth : paneWidth, height: h })
    })
  }

  private ensureView(tab: TabItem): WebContentsView {
    const existing = this.views.get(tab.id)
    if (existing) return existing
    const view = new WebContentsView()
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
    view.webContents.on('did-start-loading', () => this.onLoading(tab.id, true))
    view.webContents.on('did-stop-loading', () => this.onLoading(tab.id, false))
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] ?? null
      this.onTabUpdated({ ...tab })
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
      if (!this.attachedIds.includes(tab.id)) this.attachedIds.push(tab.id)
    }
    this.layout()
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
