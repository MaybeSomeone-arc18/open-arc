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

  constructor(win: BrowserWindow, onTabUpdated: (tab: TabItem) => void, onLoading: (tabId: string, loading: boolean) => void = () => {}) {
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
    view.webContents.on('page-title-updated', push)
    view.webContents.on('did-navigate', () => {
      tab.url = view.webContents.getURL()
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

  navigate(tabId: string, command: 'back' | 'forward' | 'reload'): void {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return
    if (command === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (command === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (command === 'reload') wc.reload()
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
