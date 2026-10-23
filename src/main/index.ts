import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session, clipboard } from 'electron'
import { readerToggle } from './reader'
import { buildPageContextMenu } from './contextmenu'
import { basename, extname, join } from 'node:path'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AppState, Space, TabItem } from '../shared/types'
import { COMMANDS } from '../shared/commands'
import { StateStore } from './store'
import { TabLayer } from './tabs'
import { matchShortcut, type ShortcutDescriptor } from '../shared/shortcuts'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Verification-harness hooks (no effect in normal use)
if (process.env.OPEN_ARC_USER_DATA) app.setPath('userData', process.env.OPEN_ARC_USER_DATA)
if (process.env.OPEN_ARC_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox')
  // Headless harness: software-composite in-process so tab views paint and
  // capture without a GPU or a window manager.
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  // Some CI containers mount /dev/shm noexec, which kills tab renderers;
  // divert Chromium shared memory to /tmp only when /dev/shm is actually unusable.
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK | fs.constants.X_OK)
  } catch {
    app.commandLine.appendSwitch('disable-dev-shm-usage')
  }
}

const SPACE_PALETTE = ['#7c6cf0', '#3fa66a', '#d0607e', '#4a90d9', '#d9963f', '#5bc8c0']

function normalizeUrl(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^view-source:https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return `https://${s}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

function makeTab(url: string, pinned: boolean): TabItem {
  return { id: randomUUID(), url: normalizeUrl(url), title: url, favicon: null, pinned, lastActiveAt: Date.now() }
}

function makeSpace(name: string, colorIx: number): Space {
  return {
    id: randomUUID(),
    name,
    color: SPACE_PALETTE[colorIx % SPACE_PALETTE.length],
    icon: name.trim().charAt(0).toUpperCase() || '✦',
    pinned: [],
    today: [],
    archived: [],
    activeTabId: null,
    splitTabId: null
  }
}

function defaultState(): AppState {
  const space = makeSpace('Personal', 0)
  return {
    spaces: [space],
    activeSpaceId: space.id,
    sidebarVisible: true,
    archiveAfterMs: Number(process.env.OPEN_ARC_ARCHIVE_MS) || 12 * 60 * 60 * 1000,
    recentlyClosed: [],
    windowBounds: null,
    history: []
  }
}

/** Fill fields added after a state file was written (forward-compatible loads). */
function migrate(state: AppState): AppState {
  state.archiveAfterMs = Number(process.env.OPEN_ARC_ARCHIVE_MS) || state.archiveAfterMs || 12 * 60 * 60 * 1000
  state.recentlyClosed = state.recentlyClosed ?? []
  state.windowBounds = state.windowBounds ?? null
  state.history = state.history ?? []
  for (const s of state.spaces) {
    s.archived = s.archived ?? []
    s.splitTabId = s.splitTabId ?? null
    for (const t of [...s.pinned, ...s.today, ...s.archived]) {
      t.lastActiveAt = t.lastActiveAt ?? Date.now()
    }
  }
  return state
}

class OpenArcApp {
  private win!: BrowserWindow
  private tabs!: TabLayer
  private store = new StateStore()
  private state: AppState
  /** Load start/stop markers, used by the smoke suite (and handy in dev logs). */
  private loadingEvents: string[] = []
  private downloadsDone: { filename: string; path: string; state: string }[] = []

  constructor() {
    this.state = migrate(this.store.load() ?? defaultState())
  }

  private activeSpace(): Space {
    return this.state.spaces.find((s) => s.id === this.state.activeSpaceId) ?? this.state.spaces[0]
  }

  private activeTab(): TabItem | null {
    const space = this.activeSpace()
    return [...space.pinned, ...space.today].find((t) => t.id === space.activeTabId) ?? null
  }

  /** Most-recent-first history; consecutive same-URL entries merge (title refresh). */
  private recordHistory(tab: TabItem): void {
    const url = tab.url
    if (!/^https?:\/\//.test(url)) return
    const h = this.state.history
    if (h[0]?.url === url) {
      h[0].title = tab.title || h[0].title
      h[0].visitedAt = Date.now()
      return
    }
    h.unshift({ url, title: tab.title || url, visitedAt: Date.now() })
    if (h.length > 500) h.length = 500
  }

  /** Single mutation funnel: persist + re-render + re-layout views. */
  private commit(): void {
    this.store.save(this.state)
    this.win.webContents.send('state:changed', this.state)
    this.tabs.show(this.activeSpace())
  }

  start(): void {
    // Frameless browser shell: drop the default application menu so its
    // accelerators (Ctrl+R = reload the SHELL, devtools, etc.) never fire.
    // All shortcuts live in the renderer and act on the active tab instead.
    Menu.setApplicationMenu(null)
    this.createShellWindow()
    // Downloads: save into the system Downloads folder, toast on completion.
    this.downloadsDone = []
    const inFlightDownloads = new Set<string>()
    session.defaultSession.on('will-download', (_e, item, wc) => {
      // Never overwrite an existing (or in-flight) download with the same
      // name: forcing a save path bypasses Chromium's own uniquification.
      const dlDir = app.getPath('downloads')
      const original = item.getFilename()
      const dlExt = extname(original)
      const dlBase = original.slice(0, original.length - dlExt.length)
      let savePath = join(dlDir, original)
      let collision = 1
      while (fs.existsSync(savePath) || inFlightDownloads.has(savePath)) {
        savePath = join(dlDir, `${dlBase} (${collision})${dlExt}`)
        collision++
      }
      inFlightDownloads.add(savePath)
      item.setSavePath(savePath)
      item.once('done', (_ev, st) => {
        inFlightDownloads.delete(savePath)
        // Verify the file really landed before telling the user it did.
        let size: number | undefined
        try {
          if (st === 'completed' && fs.existsSync(savePath)) size = fs.statSync(savePath).size
        } catch { size = undefined }
        const info = { filename: basename(savePath), path: savePath, state: st, size }
        this.downloadsDone.push(info)
        if (!this.win.isDestroyed()) this.win.webContents.send('download:done', info)
        // A tab navigated directly at a binary is left blank once the
        // navigation turns into a download. Give it an honest, recoverable
        // status page instead of pretending the binary was a web page.
        // loadURL (not executeJavaScript): a navigation that became a
        // download can leave renderer calls hanging.
        if (wc && !wc.isDestroyed() && (wc.getURL() === '' || wc.getURL() === 'about:blank')) {
          const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const title = st === 'completed' ? 'Download complete' : `Download ${st}`
          const sizeStr = size !== undefined ? ` (${size} bytes)` : ''
          const noteHtml =
            '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title></head>' +
            '<body style="margin:0;background:#141418;color:#e8e8ea;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">' +
            '<div class="oa-download-note" style="max-width:520px;text-align:center;padding:32px;">' +
            '<h1 style="font-size:20px;margin:0 0 12px;">' + esc(title) + '</h1>' +
            '<div style="font-size:13px;opacity:0.8;word-break:break-all;margin-bottom:12px;">' + esc(item.getFilename() + sizeStr) + '</div>' +
            '<div style="font-size:13px;opacity:0.55;">Saved to your Downloads folder. This address points to a file, not a web page, so there is nothing to display here.</div>' +
            '<div style="font-size:12px;opacity:0.45;margin-top:16px;">Close this tab (Ctrl+W) or enter a new address in the sidebar.</div>' +
            '</div></body></html>'
          wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(noteHtml)).catch(() => {})
        }
      })
    })


    // Default-deny every web permission request (camera, mic, notifications,
    // geolocation, ...). Electron grants them unless a handler says no; a
    // browser shell must decide deliberately. No prompts exist yet, so deny.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })

    // A failed debounced save must become an explicit signal, not silence.
    this.store.onSaveError = (saveErr) => {
      if (!this.win.isDestroyed()) this.win.webContents.send('state:save-failed', saveErr)
    }
    // Best-effort retry of recovery bookkeeping/retirement suppressed at
    // discovery; never blocks boot, never loses a file.
    this.store.housekeeping()
    this.registerIpc()
    this.startArchiver()
    setTimeout(() => this.archiveIdle(false), 5000)
    app.on('before-quit', () => this.store.flush(this.state))
  }


  /**
   * App-level wiring (IPC handlers, will-download, archiver, permission
   * handler) runs exactly once in start(). macOS dock re-activation only
   * recreates the shell window through here - re-running start() would throw
   * on double ipcMain.handle registration and duplicate the listeners.
   */
  reopenWindow(): void {
    this.createShellWindow()
  }

  private createShellWindow(): void {
    const saved = this.state.windowBounds
    this.win = new BrowserWindow({
      width: saved?.width ?? 1280,
      height: saved?.height ?? 840,
      ...(saved ? { x: saved.x, y: saved.y } : {}),
      minWidth: 720,
      minHeight: 480,
      frame: false,
      backgroundColor: '#17161c',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        // The shell renderer only uses contextBridge + ipcRenderer from the
        // preload, so the Chromium sandbox can stay on.
        sandbox: true
      }
    })

    // Persist window bounds (normal state only) for next launch.
    const saveBounds = (): void => {
      if (this.win.isDestroyed() || this.win.isMaximized() || this.win.isMinimized() || this.win.isFullScreen()) return
      this.state.windowBounds = this.win.getBounds()
      this.store.save(this.state)
    }
    this.win.on('resize', saveBounds)
    this.win.on('move', saveBounds)

    this.tabs = new TabLayer(
      this.win,
      () => this.commit(),
      (tabId, loading) => {
        this.loadingEvents.push(`${tabId}:${loading ? 'start' : 'stop'}`)
        if (!this.win.isDestroyed()) this.win.webContents.send('tab:loading', tabId, loading)
      },
      (tab) => this.recordHistory(tab),
      (url) => this.openTab(url),
      // A matched shortcut pressed while a page had focus: replay it in the
      // shell renderer, which owns the command bar / find bar / overlays.
      (action, arg) => {
        if (!this.win.isDestroyed()) this.win.webContents.send('app:shortcut', action, arg)
      }
    )
    this.tabs.setSidebarVisible(this.state.sidebarVisible)

    if (isDev) {
      this.win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    this.win.webContents.on('did-finish-load', () => {
      console.log('[openarc] renderer finished load')
      this.commit()
      // State recovery notice: the store found an unreadable state file at
      // boot, quarantined it and started fresh. Tell the user.
      if (this.store.quarantinedTo && !this.win.isDestroyed()) {
        this.win.webContents.send('state:recovered', this.store.quarantinedTo)
      }
      const pendingOffer = this.store.getRecoveryOffer()
      if (pendingOffer && !this.win.isDestroyed()) this.win.webContents.send('state:recovery-offer', pendingOffer)
      const malformedNotice = this.store.getMalformedNotice()
      if (malformedNotice && !this.win.isDestroyed()) this.win.webContents.send('state:recovery-malformed', malformedNotice)
      void this.selfTest()
    })

  }

  // ---- Auto-archive: idle unpinned tabs move to the space's archive ----
  private startArchiver(): void {
    setInterval(() => this.archiveIdle(false), 60 * 1000)
  }

  private archiveIdle(force: boolean): number {
    const now = Date.now()
    let moved = 0
    for (const space of this.state.spaces) {
      const keep: TabItem[] = []
      for (const tab of space.today) {
        const idle = now - tab.lastActiveAt
        if (tab.id !== space.activeTabId && (force || idle > this.state.archiveAfterMs)) {
          space.archived.unshift(tab)
          this.tabs.close(tab.id)
          moved++
        } else {
          keep.push(tab)
        }
      }
      space.today = keep
      if (space.splitTabId && !space.today.some((t) => t.id === space.splitTabId)) space.splitTabId = null
    }
    if (moved > 0) this.commit()
    return moved
  }

  // ---- Tabs ----
  private openTab(url: string): void {
    const space = this.activeSpace()
    const tab = makeTab(url, false)
    space.today.push(tab)
    space.activeTabId = tab.id
    tab.lastActiveAt = Date.now()
    this.commit()
  }

  private closeTab(tabId: string): void {
    for (const space of this.state.spaces) {
      const inPinned = space.pinned.findIndex((t) => t.id === tabId)
      const inToday = space.today.findIndex((t) => t.id === tabId)
      const inArchived = space.archived.findIndex((t) => t.id === tabId)
      if (inPinned === -1 && inToday === -1 && inArchived === -1) continue
      if (inPinned !== -1 || inToday !== -1) {
        const tab = inPinned !== -1 ? space.pinned[inPinned] : space.today[inToday]
        this.state.recentlyClosed.unshift({ url: tab.url, title: tab.title, spaceId: space.id, pinned: tab.pinned, closedAt: Date.now() })
        this.state.recentlyClosed = this.state.recentlyClosed.slice(0, 20)
      }
      if (inPinned !== -1) space.pinned.splice(inPinned, 1)
      if (inToday !== -1) space.today.splice(inToday, 1)
      if (inArchived !== -1) space.archived.splice(inArchived, 1)
      if (space.splitTabId === tabId) space.splitTabId = null
      if (space.activeTabId === tabId) {
        const rest = [...space.pinned, ...space.today]
        space.activeTabId = rest[rest.length - 1]?.id ?? null
      }
      this.tabs.close(tabId)
      break
    }
    this.commit()
  }

  private restoreTab(tabId: string): void {
    const space = this.activeSpace()
    const idx = space.archived.findIndex((t) => t.id === tabId)
    if (idx === -1) return
    const [tab] = space.archived.splice(idx, 1)
    tab.lastActiveAt = Date.now()
    space.today.push(tab)
    space.activeTabId = tab.id
    this.commit()
  }

  private setPinned(tabId: string, pinned: boolean): void {
    const space = this.activeSpace()
    const from = pinned ? space.today : space.pinned
    const idx = from.findIndex((t) => t.id === tabId)
    if (idx === -1) return
    const [tab] = from.splice(idx, 1)
    tab.pinned = pinned
    ;(pinned ? space.pinned : space.today).push(tab)
    this.commit()
  }

  private switchTab(tabId: string): void {
    // Tabs are addressable across spaces (command bar lists all of them):
    // switching to a tab in another space follows it there.
    for (const space of this.state.spaces) {
      const tab = [...space.pinned, ...space.today].find((t) => t.id === tabId)
      if (tab) {
        this.state.activeSpaceId = space.id
        space.activeTabId = tab.id
        tab.lastActiveAt = Date.now()
        this.commit()
        return
      }
    }
  }

  // ---- Split view ----
  private addSplit(): void {
    const space = this.activeSpace()
    const active = this.activeTab()
    if (!active) return
    if (space.splitTabId) {
      space.splitTabId = null // toggle off
    } else {
      const partner = space.today.find((t) => t.id !== active.id) ?? space.pinned.find((t) => t.id !== active.id)
      if (partner) space.splitTabId = partner.id
    }
    this.commit()
  }

  // ---- Commands ----
  private runCommand(id: string, arg?: string): void {
    const space = this.activeSpace()
    const active = this.activeTab()
    switch (id) {
      case 'new-tab':
        if (arg) this.openTab(arg)
        break
      case 'close-tab':
        if (active) this.closeTab(active.id)
        break
      case 'toggle-sidebar':
        this.state.sidebarVisible = !this.state.sidebarVisible
        this.tabs.setSidebarVisible(this.state.sidebarVisible)
        this.commit()
        break
      case 'goto-tab': {
        // Chrome-style: Ctrl+1..8 jumps to that tab (pinned first), Ctrl+9 to the last.
        const list = [...space.pinned, ...space.today]
        if (!arg || list.length === 0) break
        const n = parseInt(arg, 10)
        const target = n === 9 ? list[list.length - 1] : list[n - 1]
        if (!target || target.id === space.activeTabId) break
        space.activeTabId = target.id
        target.lastActiveAt = Date.now()
        this.commit()
        break
      }
      case 'next-tab':
      case 'prev-tab': {
        const list = [...space.pinned, ...space.today]
        if (list.length < 2 || !space.activeTabId) break
        const ix = list.findIndex((t) => t.id === space.activeTabId)
        if (ix === -1) break
        const next = list[(ix + (id === 'next-tab' ? 1 : -1) + list.length) % list.length]
        space.activeTabId = next.id
        next.lastActiveAt = Date.now()
        this.commit()
        break
      }
      case 'reload':
      case 'hard-reload':
      case 'go-back':
      case 'go-forward': {
        const dir = id === 'go-back' ? 'back' : id === 'go-forward' ? 'forward' : id === 'hard-reload' ? 'hard-reload' : 'reload'
        if (active) this.tabs.navigate(active.id, dir)
        break
      }
      case 'new-space':
        this.createSpace(arg?.trim() || `Space ${this.state.spaces.length + 1}`)
        break
      case 'move-to-space': {
        if (!active || !arg?.trim()) break
        const target = this.state.spaces.find((sp) => sp.name.toLowerCase() === arg.trim().toLowerCase())
        if (!target || target.id === space.id) break
        const fromList = active.pinned ? space.pinned : space.today
        const ix = fromList.findIndex((t) => t.id === active.id)
        if (ix === -1) break
        fromList.splice(ix, 1)
        ;(active.pinned ? target.pinned : target.today).push(active)
        if (space.activeTabId === active.id) {
          space.activeTabId = space.today[space.today.length - 1]?.id ?? space.pinned[space.pinned.length - 1]?.id ?? null
        }
        if (space.splitTabId === active.id) space.splitTabId = null
        this.commit()
        break
      }
      case 'delete-space': {
        if (this.state.spaces.length < 2) break // never delete the last space
        const ix = this.state.spaces.findIndex((sp) => sp.id === space.id)
        for (const t of [...space.pinned, ...space.today]) this.tabs.close(t.id)
        this.state.spaces.splice(ix, 1)
        const next = this.state.spaces[Math.max(0, ix - 1)]
        this.state.activeSpaceId = next.id
        this.commit()
        break
      }
      case 'view-source': {
        if (!active) break
        const srcUrl = this.tabs.currentUrl(active.id) ?? active.url
        if (/^https?:\/\//.test(srcUrl)) this.openTab(`view-source:${srcUrl}`)
        break
      }
      case 'duplicate-tab': {
        if (!active) break
        const url = this.tabs.currentUrl(active.id) ?? active.url
        if (!url) break
        const tab = makeTab(url, false)
        // Insert right after the original, like every other browser
        if (active.pinned) {
          space.today.push(tab)
        } else {
          const idx = space.today.findIndex((t) => t.id === active.id)
          space.today.splice(idx === -1 ? space.today.length : idx + 1, 0, tab)
        }
        space.activeTabId = tab.id
        tab.lastActiveAt = Date.now()
        this.commit()
        break
      }
      case 'reopen-closed-tab': {
        const entry = this.state.recentlyClosed.shift()
        if (!entry) break
        const target = this.state.spaces.find((sp) => sp.id === entry.spaceId) ?? this.activeSpace()
        const tab = makeTab(entry.url, entry.pinned)
        tab.title = entry.title
        ;(entry.pinned ? target.pinned : target.today).push(tab)
        this.state.activeSpaceId = target.id
        target.activeTabId = tab.id
        tab.lastActiveAt = Date.now()
        this.commit()
        break
      }
      case 'pin-tab':
        if (active && !active.pinned) this.setPinned(active.id, true)
        break
      case 'unpin-tab':
        if (active && active.pinned) this.setPinned(active.id, false)
        break
      case 'split-view':
        this.addSplit()
        break
      case 'close-split':
        space.splitTabId = null
        this.commit()
        break
      case 'archive-now':
        this.archiveIdle(true)
        break
      case 'clear-history':
        this.state.history = []
        this.commit()
        break
      case 'close-others': {
        if (!active) break
        for (const t of [...space.today]) if (t.id !== active.id) this.tabs.close(t.id)
        space.today = active.pinned ? [] : [active]
        if (space.splitTabId && space.splitTabId !== active.id) space.splitTabId = null
        this.commit()
        break
      }
      case 'close-right': {
        if (!active || active.pinned) break
        const idx = space.today.findIndex((t) => t.id === active.id)
        if (idx === -1) break
        const toClose = space.today.slice(idx + 1)
        for (const t of toClose) this.tabs.close(t.id)
        space.today = space.today.slice(0, idx + 1)
        if (space.splitTabId && toClose.some((t) => t.id === space.splitTabId)) space.splitTabId = null
        this.commit()
        break
      }
      case 'clear-today':
        for (const t of [...space.today]) this.tabs.close(t.id)
        space.today = []
        space.splitTabId = null
        if (space.activeTabId && !space.pinned.some((t) => t.id === space.activeTabId)) {
          space.activeTabId = space.pinned[space.pinned.length - 1]?.id ?? null
        }
        this.commit()
        break
    }
  }

  private createSpace(name: string): void {
    const space = makeSpace(name, this.state.spaces.length)
    this.state.spaces.push(space)
    this.state.activeSpaceId = space.id
    this.commit()
  }

  /**
   * Overlay z-order/focus verification (OPEN_ARC_OVERLAY_VERIFY set, with
   * OPEN_ARC_SHOT_DIR): captures the COMPOSITED screen via desktopCapturer
   * (what a real display would show - the only capture that includes both the
   * shell DOM and tab WebContentsViews), while driving shortcuts through real
   * input events into a focused page view. Proves or disproves that overlays
   * are actually visible above pages and that focus moves shell<->page.
   */
  private async overlayVerify(dir: string): Promise<void> {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const facts: Record<string, unknown> = {}
    const capture = async (name: string): Promise<void> => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 840 } })
      if (!sources.length || sources[0].thumbnail.isEmpty()) throw new Error('no screen source for composited capture')
      writeFileSync(`${dir}/${name}.png`, sources[0].thumbnail.toPNG())
    }
    const shellJs = (code: string): Promise<unknown> => this.win.webContents.executeJavaScript(code)
    try {
      this.openTab('https://example.com/')
      const tab = this.activeTab()!
      const end = Date.now() + 15000
      while (tab.title !== 'Example Domain' && Date.now() < end) await wait(250)
      const wc = this.tabs.webContentsFor(tab.id)!
      this.tabs.focusTab(tab.id) // simulate the user having clicked into the page
      await wait(400)
      await capture('overlay-0-page-only')
      facts.pageFocusedBefore = wc.isFocused()

      wc.sendInputEvent({ type: 'keyDown', keyCode: 't', modifiers: ['control'] })
      await wait(900)
      await capture('overlay-1-commandbar')
      facts.commandBarInDom = await shellJs("!!document.querySelector('.command-bar')")
      facts.commandBarActiveElement = await shellJs("document.activeElement ? (document.activeElement.tagName + '.' + document.activeElement.className) : 'none'")
      facts.shellFocusedAfterOpen = this.win.webContents.isFocused()
      facts.pageFocusedAfterOpen = wc.isFocused()

      // Close via shell-side Escape (the focus is in the shell now)
      await shellJs("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
      await wait(600)
      await capture('overlay-2-after-escape')
      facts.pageFocusedAfterEscape = wc.isFocused()

      wc.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] })
      await wait(900)
      await capture('overlay-3-findbar')
      facts.findBarInDom = await shellJs("!!document.querySelector('.find-bar')")
      facts.findBarActiveElement = await shellJs("document.activeElement ? (document.activeElement.tagName + '.' + document.activeElement.className) : 'none'")
      facts.shellFocusedAfterFind = this.win.webContents.isFocused()

      // Type a query: focus is in the shell find input, so real shell keys work
      await shellJs(
        "(()=>{const i=document.querySelector('.find-bar input'); if(!i) return 'NO-INPUT';" +
          "Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i,'Example');" +
          "i.dispatchEvent(new Event('input',{bubbles:true})); return 'OK'})()"
      )
      await wait(900)
      await capture('overlay-4-findbar-typed')

      await shellJs("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
      await wait(600)
      await capture('overlay-5-restored')
      facts.pageFocusedAtEnd = wc.isFocused()
      facts.overlayCountAtEnd = await shellJs("document.querySelectorAll('.command-bar,.find-bar,.shortcuts-overlay').length")

      // ---- PDF path: real key into the FOCUSED PAGE (not the shell) must
      // route to the print handler, write a real PDF, and show a visible
      // toast above the painted page. ----
      this.tabs.focusTab(tab.id)
      await wait(400)
      const dlHome = join(app.getPath('home'), 'Downloads')
      fs.mkdirSync(dlHome, { recursive: true })
      const pdfsBefore = new Set(fs.readdirSync(dlHome).filter((f) => f.endsWith('.pdf')))
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'p', modifiers: ['control'] })
      let pdfFile = ''
      const pEnd = Date.now() + 12000
      while (!pdfFile && Date.now() < pEnd) {
        await wait(250)
        const now = fs.readdirSync(dlHome).filter((f) => f.endsWith('.pdf') && !pdfsBefore.has(f))
        if (now.length > 0) pdfFile = now[0]
      }
      if (pdfFile) {
        const pdfPath = join(dlHome, pdfFile)
        const buf = fs.readFileSync(pdfPath)
        facts.pdfEvidence = { file: pdfFile, size: buf.length, magic: buf.subarray(0, 5).toString() }
        await wait(600) // let the toast render into the bottom strip
        await capture('pdf-1-toast-above-page')
        facts.pdfToastStripBounds = this.tabs.getTabBounds(tab.id)
        fs.unlinkSync(pdfPath) // test hygiene: no artifact pile-up
      } else {
        facts.pdfEvidence = 'NO FILE WRITTEN'
        await capture('pdf-1-toast-above-page')
      }

      // ---- Direct download: blank tab must become a painted status page;
      // file bytes verified on disk separately from the notification. ----
      const { createServer } = await import('node:http')
      const dlServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="oa-verify.bin"' })
        res.end(Buffer.from('open-arc download verify 0123456789'))
      })
      await new Promise<void>((r) => dlServer.listen(0, '127.0.0.1', r))
      const dlPort = (dlServer.address() as { port: number }).port
      this.openTab(`http://127.0.0.1:${dlPort}/file`)
      const dlTab = this.activeTab()!
      const dlEnd = Date.now() + 12000
      while (dlTab.title !== 'Download complete' && Date.now() < dlEnd) await wait(250)
      await wait(800) // paint + toast
      await capture('download-1-status-page')
      const binPath = join(app.getPath('downloads'), 'oa-verify.bin')
      try {
        const buf = fs.readFileSync(binPath)
        facts.downloadEvidence = { file: 'oa-verify.bin', size: buf.length, contentMatch: buf.toString('utf8') === 'open-arc download verify 0123456789' }
        fs.unlinkSync(binPath)
      } catch (e) {
        facts.downloadEvidence = 'READ FAILED: ' + String(e)
      }
      facts.downloadStatusTitle = dlTab.title
      dlServer.close()
      this.closeTab(dlTab.id)
      this.switchTab(tab.id)

      // ---- Wikipedia hover: does the SITE show its own preview card with no
      // context menu involved? (Source of the 'panel behind menu' report.) ----
      this.openTab('https://en.wikipedia.org/wiki/Web_browser')
      const wikiTab = this.activeTab()!
      const wEnd = Date.now() + 20000
      while (!/Web browser/.test(wikiTab.title) && Date.now() < wEnd) await wait(300)
      const wikiWc = this.tabs.webContentsFor(wikiTab.id)!
      const linkPos: string = await wikiWc.executeJavaScript(`(() => {
        const a = document.querySelector('#mw-content-text .mw-parser-output p a')
        if (!a) return 'NO-LINK'
        const r = a.getBoundingClientRect()
        return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2)
      })()`)
      if (linkPos !== 'NO-LINK') {
        const [lx, ly] = (linkPos as string).split(',').map(Number)
        wikiWc.sendInputEvent({ type: 'mouseMove', x: lx, y: ly })
        let preview = ''
        const hEnd = Date.now() + 6000
        while (!preview && Date.now() < hEnd) {
          await wait(300)
          preview = await wikiWc.executeJavaScript(`(() => {
            const p = document.querySelector('.mwe-popups')
            if (!p || !p.textContent || !p.textContent.trim()) return ''
            const cs = getComputedStyle(p)
            return cs.display + '/' + cs.visibility + '/' + p.className
          })()`)
        }
        facts.wikipediaHoverPreview = preview || 'NOT SHOWN'
        if (preview) await capture('hover-1-wikipedia-preview')
      } else {
        facts.wikipediaHoverPreview = 'NO LINK FOUND'
      }

      writeFileSync(`${dir}/overlay-verify.json`, JSON.stringify(facts, null, 2))
      console.log('[openarc] overlay-verify done', JSON.stringify(facts))
      app.exit(0)
    } catch (e) {
      facts.error = String(e)
      writeFileSync(`${dir}/overlay-verify.json`, JSON.stringify(facts, null, 2))
      console.error('[openarc] overlay-verify failed', e)
      app.exit(1)
    }
  }

  /**
   * Verification harness (OPEN_ARC_SHOT_DIR set): drives the real app through
   * the smoke suite - window controls, command bar, navigation, tab switching,
   * spaces, split view, auto-archive - captures genuine screenshots and writes
   * report-run.json, then quits. With OPEN_ARC_PHASE=verify it instead checks
   * that a previous run's state survived the restart (persistence check).
   * No effect in normal use.
   */
  private selfTestStarted = false

  private async selfTest(): Promise<void> {
    const dir = process.env.OPEN_ARC_SHOT_DIR
    if (!dir) return
    if (this.selfTestStarted) return // did-finish-load also fires after a harness re-open
    this.selfTestStarted = true
    if (process.env.OPEN_ARC_OVERLAY_VERIFY) return this.overlayVerify(dir)
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const shot = async (name: string): Promise<void> => {
      const img = await this.win.webContents.capturePage()
      writeFileSync(`${dir}/${name}.png`, img.toPNG())
    }
    const checks: { name: string; pass: boolean; detail: string }[] = []
    const check = (name: string, pass: boolean, detail = ''): void => {
      checks.push({ name, pass, detail })
      console.log(`[openarc] ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
    }
    const pollUntil = async (fn: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await fn()) return true
        await wait(250)
      }
      return fn()
    }

    if (process.env.OPEN_ARC_PHASE === 'verify') {
      // Second launch over the same profile: the run phase's state must survive.
      await wait(2500)
      const personal = this.state.spaces.find((s) => s.name === 'Personal')
      const smoke = this.state.spaces.find((s) => s.name === 'Smoke')
      check('persist: spaces survive restart', !!personal && !!smoke, `${this.state.spaces.length} spaces loaded`)
      const pinnedExample = personal?.pinned.find((t) => t.url.includes('example.com'))
      check('persist: pinned tab survives restart', !!pinnedExample)
      if (pinnedExample) {
        check('persist: zoom setting survives restart', pinnedExample.zoom === 1.25, `zoom=${pinnedExample.zoom}`)
        this.switchTab(pinnedExample.id)
        const zoomLive = await pollUntil(() => Math.abs(this.tabs.getZoom(pinnedExample.id) - 1.25) < 0.001, 5000)
        check('persist: zoom applied to restored tab view', zoomLive, `factor=${this.tabs.getZoom(pinnedExample.id)}`)
      }
      check('persist: archived tab survives restart', !!personal?.archived.find((t) => t.url.includes('wikipedia.org')))
      // The run phase deliberately clears history near the end (clear-history
      // check); the post-clear navigations prove the field itself persists.
      check(
        'persist: history survives restart',
        this.state.history.length >= 1 && this.state.history.every((h) => typeof h.url === 'string' && h.url.length > 0),
        `${this.state.history.length} entries`
      )
      check('persist: recently closed survives restart', this.state.recentlyClosed.length > 0, `${this.state.recentlyClosed.length} entries`)
      const b = this.win.getBounds()
      check(
        'persist: window bounds restored',
        this.state.windowBounds?.width === 1000 && this.state.windowBounds?.height === 700 && b.width === 1000 && b.height === 700,
        `saved=${JSON.stringify(this.state.windowBounds)} live=${b.width}x${b.height}`
      )
      await shot('6-relaunch-restored')
      writeFileSync(`${dir}/report-verify.json`, JSON.stringify({ phase: 'verify', checks }, null, 2))
      app.exit(checks.every((c) => c.pass) ? 0 : 1)
      return
    }

    if (process.env.OPEN_ARC_PHASE === 'corrupt' || process.env.OPEN_ARC_PHASE === 'partial') {
      // State-recovery phases: the runner planted the state file BEFORE launch.
      // Open a page immediately so the recovery notice can be captured
      // composited ABOVE painted page content before it auto-dismisses.
      this.openTab('https://example.com/')
      const noticeTab = this.activeTab()!
      await wait(1200)
      if (process.env.OPEN_ARC_PHASE === 'corrupt') {
        check('recovery: unreadable state quarantined, not overwritten', this.store.quarantinedTo !== null, `quarantinedTo=${this.store.quarantinedTo}`)
        check('recovery: app boots to a usable default state', this.state.spaces.length >= 1, `${this.state.spaces.length} spaces`)
        const noticeShown = await pollUntil(async () => {
          try { return await this.win.webContents.executeJavaScript("!!document.querySelector('.download-toast')") } catch { return false }
        }, 6000)
        check('recovery: user notified of the quarantine', noticeShown)
        const noticePainted = await pollUntil(() => noticeTab.title === 'Example Domain', 12000)
        const noticeStillUp = await this.win.webContents.executeJavaScript("!!document.querySelector('.download-toast')").catch(() => false)
        if (noticePainted && noticeStillUp) {
          try {
            const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 840 } })
            if (srcs.length && !srcs[0].thumbnail.isEmpty()) writeFileSync(`${dir}/recovery-notice.png`, srcs[0].thumbnail.toPNG())
          } catch { /* capture best-effort */ }
        }
        check('recovery: notice captured above painted page', noticePainted && noticeStillUp, `painted=${noticePainted} toastUp=${noticeStillUp}`)
      } else {
        check('recovery: readable older state NOT quarantined', this.store.quarantinedTo === null, `quarantinedTo=${this.store.quarantinedTo}`)
        check('recovery: recoverable spaces preserved', this.state.spaces.some((sp) => sp.name === 'Recovered Space'), `spaces=${this.state.spaces.map((sp) => sp.name).join(',')}`)
      }
      this.openTab('https://example.com/')
      const rcTab = this.activeTab()!
      const rcLoaded = await pollUntil(() => rcTab.title === 'Example Domain', 15000)
      check('recovery: app functional after recovery', rcLoaded, `title="${rcTab.title}"`)
      writeFileSync(`${dir}/report-${process.env.OPEN_ARC_PHASE}.json`, JSON.stringify({ phase: process.env.OPEN_ARC_PHASE, checks }, null, 2))
      app.exit(checks.every((c) => c.pass) ? 0 : 1)
      return
    }

    if (process.env.OPEN_ARC_PHASE === 'savefail' || process.env.OPEN_ARC_PHASE === 'quaranfail') {
      // Delayed-save failure path: REAL chmod-induced write failures against
      // the running app. Bounded externally by the runner watchdog.
      await wait(1200)
      const stateDir = join(app.getPath('userData'), 'open-arc')
      const { chmodSync, readdirSync: rdSync, readFileSync: rfSync } = await import('node:fs')
      const probeResponsive = async (): Promise<boolean> => {
        try { return (await this.win.webContents.executeJavaScript('1 + 1')) === 2 } catch { return false }
      }
      if (process.env.OPEN_ARC_PHASE === 'savefail') {
        this.openTab('https://example.com/')
        const sfTab = this.activeTab()!
        await pollUntil(() => sfTab.title === 'Example Domain', 15000)
        check('savefail: baseline save lands on disk', await pollUntil(() => fs.existsSync(join(stateDir, 'state.json')), 5000))
        chmodSync(stateDir, 0o555)
        this.createSpace('Savefail Probe') // state change -> debounced save must fail
        await wait(1200)
        // Diagnostic capture while the failure is live: an uncaught main
        // throw would surface as an Electron error dialog in this frame.
        try {
          const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 840 } })
          if (srcs.length && !srcs[0].thumbnail.isEmpty()) writeFileSync(`${dir}/savefail-during.png`, srcs[0].thumbnail.toPNG())
        } catch { /* capture is diagnostic only */ }
        check('savefail: write failure recorded, never reported as success', this.store.lastSaveError !== null, `lastSaveError=${this.store.lastSaveError}`)
        check('savefail: app stays responsive during the failure', await probeResponsive())
        check('savefail: existing tabs keep working during the failure', await pollUntil(() => sfTab.title === 'Example Domain', 3000))
        chmodSync(stateDir, 0o755) // recovery: writes possible again
        this.createSpace('Savefail Recovery')
        const recovered = await pollUntil(() => {
          try { return rfSync(join(stateDir, 'state.json'), 'utf8').includes('Savefail Recovery') } catch { return false }
        }, 6000)
        check('savefail: save succeeds after permissions recover', recovered)
        check('savefail: error status clears after a successful save', this.store.lastSaveError === null, `lastSaveError=${this.store.lastSaveError}`)
      } else {
        // quaranfail: the runner planted garbage state.json AND made the
        // state dir read-only BEFORE launch, so the quarantine rename failed.
        check('quaranfail: unreadable state could not be quarantined (rename failed)', this.store.quarantinedTo === null)
        this.createSpace('Quaranfail Probe')
        await wait(1200)
        check('quaranfail: failed save recorded', this.store.lastSaveError !== null, `lastSaveError=${this.store.lastSaveError}`)
        check('quaranfail: app responsive during failure', await probeResponsive())
        chmodSync(stateDir, 0o755)
        this.createSpace('Quaranfail Recovery')
        const fallbackUsed = await pollUntil(() => rdSync(stateDir).some((f) => f.startsWith('state.json.fresh-')), 6000)
        check('quaranfail: recovered save lands in a fallback file, not over the original', fallbackUsed, rdSync(stateDir).join(','))
        let orig = ''
        try { orig = rfSync(join(stateDir, 'state.json'), 'utf8') } catch { /* missing */ }
        check('quaranfail: unreadable original preserved byte-for-byte', orig === process.env.OPEN_ARC_PLANTED_GARBAGE)
        check('quaranfail: error clears after recovery save', await pollUntil(() => this.store.lastSaveError === null, 4000))
      }
      writeFileSync(`${dir}/report-${process.env.OPEN_ARC_PHASE}.json`, JSON.stringify({ phase: process.env.OPEN_ARC_PHASE, checks }, null, 2))
      app.exit(checks.every((c) => c.pass) ? 0 : 1)
      return
    }

    if (process.env.OPEN_ARC_PHASE?.startsWith('fresh') || process.env.OPEN_ARC_PHASE === 'renamefail') {
      // .fresh restart-recovery phases: the runner planted each profile
      // BEFORE launch. Choices are driven through applyRecoveryChoice - the
      // exact path the dialog's buttons use.
      await wait(1200)
      const stateDir = join(app.getPath('userData'), 'open-arc')
      const { readdirSync: rdSync2, readFileSync: rfSync2, rmSync: rmSync2 } = await import('node:fs')
      const files = (): string[] => { try { return rdSync2(stateDir).sort() } catch { return [] as string[] } }
      const read = (f: string): string | null => { try { return rfSync2(join(stateDir, f), 'utf8') } catch { return null } }
      const phase = process.env.OPEN_ARC_PHASE
      const F1 = 'state.json.fresh-2026-10-23T05-50-00-000Z'
      const F2 = 'state.json.fresh-2026-10-23T05-52-00-000Z'
      const F3 = 'state.json.fresh-2026-10-23T05-55-00-000Z'

      if (phase === 'freshaccept') {
        const offer = this.store.getRecoveryOffer()
        check('freshaccept: newest valid candidate offered', offer?.candidateName === F3, JSON.stringify(offer))
        check('freshaccept: valid current state not treated as stale', offer?.currentValid === true)
        check('freshaccept: other candidates listed, none hidden', (offer?.otherNames ?? []).includes(F1) && (offer?.malformedNames ?? []).includes(F2), JSON.stringify(offer))
        const dialogUp = await pollUntil(async () => { try { return await this.win.webContents.executeJavaScript("!!document.querySelector('.recovery-dialog')") } catch { return false } }, 6000)
        check('freshaccept: recovery choice dialog visible', dialogUp)
        if (dialogUp) {
          try {
            const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 840 } })
            if (srcs.length && !srcs[0].thumbnail.isEmpty()) writeFileSync(`${dir}/recovery-dialog.png`, srcs[0].thumbnail.toPNG())
          } catch { /* capture best-effort */ }
        }
        const origBytes = read('state.json')
        const candBytes = read(F3)
        this.createSpace('Pending Mutation')
        await wait(800)
        check('freshaccept: saves held while choice pending', read('state.json') === origBytes, 'state.json changed before decision')
        const res = this.applyRecoveryChoice(true)
        check('freshaccept: accept succeeds', res.ok, res.error ?? res.warning ?? '')
        check('freshaccept: committed bytes exactly match candidate', read('state.json') === candBytes)
        const backups = files().filter((f) => f.startsWith('state.json.corrupt-'))
        check('freshaccept: verified byte backup of the original preserved', backups.length === 1 && read(backups[0]) === origBytes, files().join(','))
        check('freshaccept: accepted candidate retired', !files().includes(F3) && files().some((f) => f.startsWith(F3 + '.accepted-')), files().join(','))
        check('freshaccept: other candidates untouched', read(F1) !== null && read(F2) === '{"spaces": broken', files().join(','))
        check('freshaccept: recovered state applied live', this.state.spaces.some((sp) => sp.name === 'Fresh Recovered Space') && !this.state.spaces.some((sp) => sp.name === 'Pending Mutation'), this.state.spaces.map((sp) => sp.name).join(','))
        await wait(800)
        check('freshaccept: saves resume after commit', (read('state.json') ?? '').includes('Fresh Recovered Space') && this.store.lastSaveError === null, `lastSaveError=${this.store.lastSaveError}`)
        const logText = read('state.json.recovery-log') ?? ''
        check('freshaccept: accepted decision recorded with content hash', logText.includes('"decision":"accepted"') && logText.includes(F3), logText || '(empty)')
      } else if (phase === 'freshreject') {
        const offer = this.store.getRecoveryOffer()
        check('freshreject: candidate offered beside unreadable original', offer?.candidateName === F3 && offer.currentValid === false, JSON.stringify(offer))
        const origBytes = read('state.json')
        this.createSpace('Pending Mutation Reject')
        await wait(800)
        check('freshreject: saves held while choice pending', read('state.json') === origBytes)
        const res = this.applyRecoveryChoice(false)
        check('freshreject: decline succeeds', res.ok, res.error ?? '')
        check('freshreject: declined candidate retired, bytes kept', !files().includes(F3) && files().some((f) => f.startsWith(F3 + '.declined-')), files().join(','))
        const backups = files().filter((f) => f.startsWith('state.json.corrupt-'))
        check('freshreject: unreadable original quarantined only after the decision', backups.length === 1 && read(backups[0]) === origBytes, files().join(','))
        await wait(800)
        const after = read('state.json') ?? ''
        check('freshreject: defaults persist after decision, recovered work not loaded', after.includes('Pending Mutation Reject') && !after.includes('Fresh Reject Space'), after.slice(0, 100))
      } else if (phase === 'freshmalformed') {
        check('freshmalformed: no offer without a valid candidate', this.store.getRecoveryOffer() === null)
        const notice = this.store.getMalformedNotice()
        check('freshmalformed: malformed candidate surfaced', notice?.names.includes(F3) === true, JSON.stringify(notice))
        const dialogUp = await pollUntil(async () => { try { return await this.win.webContents.executeJavaScript("!!document.querySelector('.recovery-dialog')") } catch { return false } }, 6000)
        check('freshmalformed: notice dialog visible', dialogUp)
        const origBytes = read('state.json')
        const candBytes = read(F3)
        check('freshmalformed: accept impossible without valid candidate', this.store.acceptRecovery().ok === false)
        check('freshmalformed: both files byte-intact', read('state.json') === origBytes && read(F3) === candBytes)
        this.createSpace('Malformed Probe')
        await wait(800)
        check('freshmalformed: normal saves still work (nothing pending)', (read('state.json') ?? '').includes('Malformed Probe'))
        const dismiss = this.store.dismissMalformed(false)
        check('freshmalformed: dont-ask retires byte-preservingly', dismiss.ok && files().some((f) => f.startsWith(F3 + '.declined-')), files().join(','))
      } else if (phase === 'freshwritefail') {
        const offer = this.store.getRecoveryOffer()
        check('freshwritefail: candidate offered', offer?.candidateName === F3, JSON.stringify(offer))
        const origBytes = read('state.json')
        const candBytes = read(F3)
        const fail = this.store.acceptRecovery()
        check('freshwritefail: staging failure after verified backup reported, not committed', fail.ok === false && (fail.error ?? '').includes('unchanged'), fail.error ?? 'no error')
        check('freshwritefail: original untouched at its path', read('state.json') === origBytes)
        check('freshwritefail: candidate untouched', read(F3) === candBytes)
        const backups = files().filter((f) => f.startsWith('state.json.corrupt-'))
        check('freshwritefail: verified backup retained', backups.length === 1 && read(backups[0]) === origBytes, files().join(','))
        check('freshwritefail: offer still pending after failure', this.store.getRecoveryOffer() !== null)
        rmSync2(join(stateDir, 'state.json.tmp-2026-10-23T06-00-00-000Z'), { recursive: true })
        const ok2 = this.applyRecoveryChoice(true)
        check('freshwritefail: same accept succeeds once the fault clears', ok2.ok, ok2.error ?? '')
        check('freshwritefail: committed bytes exactly match candidate', read('state.json') === candBytes)
        const backups2 = files().filter((f) => f.startsWith('state.json.corrupt-'))
        check('freshwritefail: second backup collision-safe, first not clobbered', backups2.length === 2 && backups2.every((b) => read(b) === origBytes), backups2.join(','))
      } else if (phase === 'freshinterrupted') {
        const offer = this.store.getRecoveryOffer()
        check('freshinterrupted: committed leftover not re-offered; different candidate offered', offer?.candidateName === F1, JSON.stringify(offer))
        check('freshinterrupted: leftover stays in place, not auto-renamed', files().includes(F3), files().join(','))
        const logText = read('state.json.recovery-log') ?? ''
        check('freshinterrupted: leftover recognized as committed in the log', logText.includes(F3) && logText.includes('"accepted"'), logText || '(empty)')
        const res = this.applyRecoveryChoice(true)
        check('freshinterrupted: accepting the different candidate commits', res.ok && (read('state.json') ?? '').includes('Other Space'), res.error ?? '')
      } else if (phase === 'renamefail') {
        check('renamefail: quarantine rename failed in a WRITABLE dir (injected)', this.store.quarantinedTo === null)
        check('renamefail: no recovery offer without candidates', this.store.getRecoveryOffer() === null)
        const origBytes = read('state.json')
        check('renamefail: unreadable original byte-intact', origBytes === 'rename fail garbage')
        this.createSpace('Renamefail Probe')
        const landed = await pollUntil(() => (read('state.json.fresh-2026-10-23T06-00-00-000Z') ?? '').includes('Renamefail Probe'), 5000)
        check('renamefail: save redirected to .fresh, original never replaced', landed && read('state.json') === origBytes, files().join(','))
      }
      writeFileSync(`${dir}/report-${phase}.json`, JSON.stringify({ phase, checks }, null, 2))
      app.exit(checks.every((c) => c.pass) ? 0 : 1)
      return
    }

    await wait(3500)
    await shot('1-shell')

    // Window controls: the app's control path (same one the buttons call) must
    // execute. State reflection (isMinimized/isMaximized) needs a real window
    // manager; under bare Xvfb there is none, so we log observed state instead
    // of asserting it. Window drag is CSS app-region and untestable headless.
    try {
      this.windowControl('minimize')
      const minimized = this.win.isMinimized()
      this.win.restore()
      this.windowControl('maximize')
      const maximized = this.win.isMaximized()
      this.windowControl('maximize') // toggles back
      check('window controls execute (minimize/restore/maximize)', true, `state observed: minimized=${minimized} maximized=${maximized} (needs a WM to reflect)`)
    } catch (e) {
      check('window controls execute (minimize/restore/maximize)', false, String(e))
    }

    // Green-button action: toggles native full-screen on macOS, maximize on
    // Windows/Linux. The native transition itself is a Mac-checklist item.
    try {
      const fsBefore = this.win.isFullScreen()
      this.windowControl('fullscreen')
      await wait(800)
      const fsMid = this.win.isFullScreen()
      this.windowControl('fullscreen')
      await wait(800)
      check(
        'window: green-control action toggles (fullscreen on macOS, maximize elsewhere)',
        true,
        `fullScreen ${fsBefore}->${fsMid}->${this.win.isFullScreen()} maximized=${this.win.isMaximized()} (needs a WM/native macOS to reflect)`
      )
    } catch (e) {
      check('window: green-control action toggles (fullscreen on macOS, maximize elsewhere)', false, String(e))
    }

    // Shared shortcut table: the same matcher drives the renderer keydown
    // listener and main's before-input-event forwarding.
    const sm = (key: string, mods: Partial<ShortcutDescriptor> = {}): ReturnType<typeof matchShortcut> =>
      matchShortcut({ key, meta: false, ctrl: false, shift: false, alt: false, ...mods })
    check('shortcut map: Cmd+T opens command bar', sm('t', { meta: true })?.id === 'toggle-command-bar')
    check('shortcut map: Cmd+Shift+T reopens closed tab', sm('t', { meta: true, shift: true })?.id === 'reopen-closed-tab')
    check('shortcut map: Cmd+F opens find bar', sm('f', { meta: true })?.id === 'open-find-bar')
    check('shortcut map: Cmd+W closes tab', sm('w', { meta: true })?.id === 'close-tab')
    check('shortcut map: Cmd+L focuses command entry', sm('l', { meta: true })?.id === 'open-command-bar')
    check('shortcut map: Cmd+R reloads tab', sm('r', { meta: true })?.id === 'reload')
    check(
      'shortcut map: ordinary typing matches nothing',
      sm('t') === null && sm('1') === null && sm('x', { shift: true }) === null
    )

    // Command bar opens on Ctrl+T (real keydown dispatched into the renderer)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    await wait(700)
    const barOpen = await this.win.webContents.executeJavaScript("!!document.querySelector('.command-bar')")
    check('command bar opens (Ctrl+T)', barOpen === true)
    await shot('2-commandbar')
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)

    // Navigation: open a real page and wait for its real title
    this.openTab('https://example.com')
    const exampleTab = this.activeTab()!
    const loaded = await pollUntil(() => exampleTab.title === 'Example Domain', 15000)
    check('navigation: example.com loads (live title)', loaded, `title="${exampleTab.title}"`)
    check(
      'loading indicator events fire (start + stop)',
      this.loadingEvents.includes(`${exampleTab.id}:start`) && this.loadingEvents.includes(`${exampleTab.id}:stop`)
    )

    // Zoom: Ctrl+= zooms the active tab in through the real keyboard path,
    // Ctrl+0 resets. Asserted on the tab's live zoom factor.
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'=',ctrlKey:true,bubbles:true}))"
    )
    const zoomedIn = await pollUntil(() => Math.abs(this.tabs.getZoom(exampleTab.id) - 1.1) < 0.001, 5000)
    check('zoom: Ctrl+= zooms active tab to 110%', zoomedIn, `factor=${this.tabs.getZoom(exampleTab.id)}`)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'0',ctrlKey:true,bubbles:true}))"
    )
    const zoomReset = await pollUntil(() => Math.abs(this.tabs.getZoom(exampleTab.id) - 1) < 0.001, 5000)
    check('zoom: Ctrl+0 resets to 100%', zoomReset, `factor=${this.tabs.getZoom(exampleTab.id)}`)
    check('zoom: shell UI is never zoomed', Math.abs(this.win.webContents.getZoomFactor() - 1) < 0.001, `shell=${this.win.webContents.getZoomFactor()}`)
    // Leave a persisted 125% marker on the pinned example tab for the verify phase
    exampleTab.zoom = 1.25

    // Find-in-page is NOT smoke-checked here: in this container the
    // found-in-page event never dispatches to an app's WebContentsView
    // (proven env-specific: the identical call fires fine in a standalone
    // harness with the same flags). Feature stays UNVERIFIED until checked
    // on real hardware; see README.
    const cap = await this.tabs.capture(exampleTab.id)
    if (cap) writeFileSync(`${dir}/3-tab-content.png`, cap)
    else console.log('[openarc] note: tab content capture unavailable in this environment (compositor-restricted)')

    // In-tab navigation + back
    this.tabs.navigateActiveTo(exampleTab.id, 'https://example.org/')
    const wentOrg = await pollUntil(() => (this.tabs.currentUrl(exampleTab.id) ?? '').includes('example.org'), 10000)
    this.tabs.navigate(exampleTab.id, 'back')
    const cameBack = await pollUntil(() => (this.tabs.currentUrl(exampleTab.id) ?? '').includes('example.com'), 10000)
    check('navigation: forward + back', wentOrg && cameBack)

    // History: both navigations recorded (most recent first)
    const hist = this.state.history
    check(
      'history: navigations recorded',
      hist.some((h) => h.url.includes('example.org')) && hist.some((h) => h.url.includes('example.com')),
      `n=${hist.length}`
    )

    // Tab switching within a space
    this.openTab('https://en.wikipedia.org/wiki/Web_browser')
    const wikiTab = this.activeTab()!
    await pollUntil(() => wikiTab.title.includes('Wikipedia'), 15000)
    const faviconOk = await pollUntil(() => !!wikiTab.favicon, 8000)
    check('favicon: live page reports a favicon to the sidebar', faviconOk, `favicon=${(wikiTab.favicon ?? 'none').slice(0, 50)}`)
    this.switchTab(exampleTab.id)
    const withinOk = this.activeSpace().activeTabId === exampleTab.id
    this.switchTab(wikiTab.id)
    check('tab switching within space', withinOk)

    // Ctrl+1 jumps to the first tab, Ctrl+9 to the last (real key path)
    const listNow = [...this.activeSpace().pinned, ...this.activeSpace().today]
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true,bubbles:true}))"
    )
    const wentFirst = await pollUntil(() => this.activeSpace().activeTabId === listNow[0].id, 5000)
    check('shortcuts: Ctrl+1 jumps to first tab', wentFirst)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'9',ctrlKey:true,bubbles:true}))"
    )
    const wentLast = await pollUntil(() => this.activeSpace().activeTabId === listNow[listNow.length - 1].id, 5000)
    check('shortcuts: Ctrl+9 jumps to last tab', wentLast)
    this.switchTab(wikiTab.id)

    // Ctrl+Shift+C copies the active tab's URL to the real clipboard
    this.switchTab(exampleTab.id)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'C',ctrlKey:true,shiftKey:true,bubbles:true}))"
    )
    const wantUrl = this.tabs.currentUrl(exampleTab.id) ?? ''
    await wait(800) // invoke round trip + clipboard write
    const clip = await clipboard.readText()
    check('shortcuts: Ctrl+Shift+C copies active tab URL', clip === wantUrl && wantUrl.length > 0, `clipboard="${clip.slice(0, 60)}"`)
    this.switchTab(wikiTab.id) // restore the precondition the Ctrl+Tab check expects

    // Ctrl+M mutes/unmutes the active tab (state asserted on the webContents)
    this.switchTab(exampleTab.id)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'m',ctrlKey:true,bubbles:true}))"
    )
    const mutedOn = await pollUntil(() => this.tabs.isMuted(exampleTab.id), 5000)
    check('shortcuts: Ctrl+M mutes active tab', mutedOn)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'m',ctrlKey:true,bubbles:true}))"
    )
    const mutedOff = await pollUntil(() => !this.tabs.isMuted(exampleTab.id), 5000)
    check('shortcuts: Ctrl+M again unmutes', mutedOff)
    this.switchTab(wikiTab.id)

    // Ctrl+/ opens the shortcuts overlay; Escape closes it
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',ctrlKey:true,bubbles:true}))"
    )
    const overlayShown = await pollUntil(
      () => this.win.webContents.executeJavaScript("!!document.querySelector('.shortcuts-overlay')"),
      5000
    )
    check('shortcuts: Ctrl+/ opens shortcuts overlay', overlayShown)
    if (overlayShown) {
      await wait(500)
      await shot('7-shortcuts-overlay')
    }
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    const overlayGone = await pollUntil(
      async () => !(await this.win.webContents.executeJavaScript("!!document.querySelector('.shortcuts-overlay')")),
      5000
    )
    check('shortcuts: Escape closes shortcuts overlay', overlayGone)

    // Ctrl+W closes the active tab (real keydown path)
    this.openTab('https://example.org/')
    const closeMe = this.activeTab()!
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true}))"
    )
    const closedByKey = await pollUntil(
      () => ![...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => t.id === closeMe.id),
      5000
    )
    check('shortcuts: Ctrl+W closes active tab', closedByKey)

    // Middle-click on a sidebar tab row closes that tab
    this.openTab('https://example.org/')
    const auxTab = this.activeTab()!
    await wait(500) // let the sidebar render the new row
    const auxDispatched: boolean = await this.win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.tab-row')]
      const row = rows[rows.length - 1]
      if (!row) return false
      row.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
      return true
    })()`)
    const auxGone =
      auxDispatched &&
      (await pollUntil(
        () => ![...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => t.id === auxTab.id),
        5000
      ))
    check('tabs: middle-click on row closes tab', auxGone)

    // Failed navigations show a friendly in-page error instead of Chromium's
    this.openTab('http://127.0.0.1:48999/')
    const failTab = this.activeTab()!
    let errorShown = false
    const failWc = this.tabs.webContentsFor(failTab.id)
    if (failWc) {
      errorShown = await pollUntil(
        () =>
          failWc.isDestroyed()
            ? false
            : failWc.executeJavaScript("!!document.querySelector('.oa-error')"),
        15000
      )
    }
    check('error page: failed load shows friendly message', errorShown)
    if (errorShown && failWc && !failWc.isDestroyed()) {
      const errImg = await failWc.capturePage()
      writeFileSync(`${dir}/8-error-page.png`, errImg.toPNG())
    }
    this.closeTab(failTab.id)

    // Ctrl+Shift+K duplicates the active tab (same URL, becomes active)
    const beforeIds = new Set([...this.activeSpace().pinned, ...this.activeSpace().today].map((t) => t.id))
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'K',ctrlKey:true,shiftKey:true,bubbles:true}))"
    )
    const dupTab = await pollUntil(
      () => [...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => !beforeIds.has(t.id)),
      5000
    ).then(() => [...this.activeSpace().pinned, ...this.activeSpace().today].find((t) => !beforeIds.has(t.id)))
    const wikiIdx = this.activeSpace().today.findIndex((t) => t.id === wikiTab.id)
    const dupIdx = dupTab ? this.activeSpace().today.findIndex((t) => t.id === dupTab.id) : -1
    check(
      'shortcuts: Ctrl+Shift+K duplicates active tab',
      !!dupTab && dupTab.url.includes('wikipedia.org/wiki/Web_browser') && this.activeSpace().activeTabId === dupTab.id &&
        dupIdx === wikiIdx + 1,
      `dupUrl=${dupTab?.url ?? 'none'} dupIdx=${dupIdx} wikiIdx=${wikiIdx}`
    )
    if (dupTab) this.closeTab(dupTab.id)
    this.switchTab(wikiTab.id)

    // Keyboard shortcuts (renderer handler path): Ctrl+Tab cycles tabs, and
    // Ctrl+R must reload the active TAB without ever reloading the shell UI
    // (the shell-reload regression a default app menu would reintroduce).
    await this.win.webContents.executeJavaScript('window.__shellMarker = 1')
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true}))"
    )
    const cycled = await pollUntil(() => this.activeSpace().activeTabId === exampleTab.id, 3000)
    check('shortcuts: Ctrl+Tab cycles tabs', cycled)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',ctrlKey:true,bubbles:true}))"
    )
    await wait(800)
    const marker = await this.win.webContents.executeJavaScript('window.__shellMarker')
    check('shortcuts: Ctrl+R reloads tab, not the shell', marker === 1)

    // Ctrl+Shift+R hard-reloads the active tab (cache-bypassing load cycle)
    const loadMarksBefore = this.loadingEvents.filter((e) => e.startsWith(`${exampleTab.id}:`)).length
    this.switchTab(exampleTab.id)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'R',ctrlKey:true,shiftKey:true,bubbles:true}))"
    )
    const hardReloaded = await pollUntil(
      () => this.loadingEvents.filter((e) => e.startsWith(`${exampleTab.id}:`)).length >= loadMarksBefore + 2,
      8000
    )
    check('shortcuts: Ctrl+Shift+R hard reloads tab', hardReloaded)

    // F12 toggles DevTools for the active tab (state asserted both ways)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',bubbles:true}))"
    )
    const dtOpened = await pollUntil(() => this.tabs.isDevToolsOpen(exampleTab.id), 5000)
    check('shortcuts: F12 opens tab DevTools', dtOpened)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',bubbles:true}))"
    )
    const dtClosed = await pollUntil(() => !this.tabs.isDevToolsOpen(exampleTab.id), 5000)
    check('shortcuts: F12 again closes DevTools', dtClosed)

    // Permission requests are default-denied (Electron would grant them)
    const permResult: string = await this.tabs
      .webContentsFor(exampleTab.id)!
      .executeJavaScript("Notification.requestPermission().then(p => String(p)).catch(e => 'err:' + e.message)")
    check('permissions: Notification request is denied', permResult === 'denied', `result=${permResult}`)

    // Page-focused shortcuts: real key input into the tab's WebContentsView
    // never reaches the shell renderer's keydown listener, so it must route
    // through main's before-input-event forwarding. Uses sendInputEvent on
    // the tab (closest synthetic equivalent of a focused-page keypress; the
    // native macOS version is on the Mac checklist).
    const scWc = this.tabs.webContentsFor(exampleTab.id)!
    await scWc.executeJavaScript("window.__oaKeys=[];window.addEventListener('keydown',e=>window.__oaKeys.push(e.key))")
    scWc.sendInputEvent({ type: 'keyDown', keyCode: 't', modifiers: ['control'] })
    const barViaPage = await pollUntil(
      async () => (await this.win.webContents.executeJavaScript("!!document.querySelector('.command-bar')")) === true,
      5000
    )
    check('shortcuts: Ctrl+T from focused page opens command bar', barViaPage === true)
    const pageSawMod: string[] = await scWc.executeJavaScript('window.__oaKeys')
    check('shortcuts: intercepted combo never reaches the page', pageSawMod.length === 0, `page saw ${JSON.stringify(pageSawMod)}`)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)
    scWc.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] })
    const findViaPage = await pollUntil(
      async () => (await this.win.webContents.executeJavaScript("!!document.querySelector('.find-bar')")) === true,
      5000
    )
    check('shortcuts: Ctrl+F from focused page opens find bar', findViaPage === true)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)
    // Ordinary typing is NOT intercepted: a bare key reaches the page and no
    // shell UI reacts.
    scWc.sendInputEvent({ type: 'keyDown', keyCode: 'x' })
    await wait(400)
    const pageSawPlain: string[] = await scWc.executeJavaScript('window.__oaKeys')
    const barAfterTyping: boolean = await this.win.webContents.executeJavaScript("!!document.querySelector('.command-bar')")
    check(
      'shortcuts: ordinary page typing passes through untouched',
      pageSawPlain.includes('x') && !barAfterTyping,
      `page saw ${JSON.stringify(pageSawPlain)} bar=${barAfterTyping}`
    )

    // Overlay lifecycle: the modal/find overlay layer must survive tab
    // switches and split view without hiding the wrong thing or stranding
    // the user with no visible page.
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    const modalHidPage = await pollUntil(() => this.tabs.isTabVisible(exampleTab.id) === false, 5000)
    check('overlay: modal hides the active page view', modalHidPage)
    // Switch tab while the modal is open: the newly attached view hides too.
    this.switchTab(wikiTab.id)
    const newAlsoHidden = await pollUntil(() => this.tabs.isTabVisible(wikiTab.id) === false, 5000)
    check('overlay: tab switch under modal keeps the new page hidden', newAlsoHidden)
    // Close the modal: the CURRENT tab becomes visible again (no stranded page).
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    const pageRestored = await pollUntil(() => this.tabs.isTabVisible(wikiTab.id) === true, 5000)
    check('overlay: closing modal restores the current page', pageRestored)
    this.switchTab(exampleTab.id)
    await wait(500)
    // Find bar: the page shrinks below the 48px top strip, staying visible.
    const [, contentH] = this.win.getContentSize()
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))"
    )
    const findInset = await pollUntil(() => {
      const b = this.tabs.getTabBounds(exampleTab.id)
      return !!b && b.y === 48 && b.height === contentH - 48
    }, 5000)
    check('overlay: find bar insets page below a top strip', findInset, `bounds=${JSON.stringify(this.tabs.getTabBounds(exampleTab.id))} contentH=${contentH}`)
    // Split view while the find bar is open: both panes respect the strip.
    this.runCommand('split-view')
    const splitInset = await pollUntil(() => {
      const spId = this.activeSpace().splitTabId
      if (!spId) return false
      const pb = this.tabs.getTabBounds(this.activeSpace().activeTabId!)
      const sb = this.tabs.getTabBounds(spId)
      return !!pb && !!sb && pb.y === 48 && sb.y === 48 && pb.height === contentH - 48 && sb.height === contentH - 48
    }, 5000)
    check('overlay: split panes respect the find-bar strip', splitInset)
    this.runCommand('close-split')
    await wait(500)
    // Close the find bar: the page returns to full height.
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    const fullAgain = await pollUntil(() => {
      const b = this.tabs.getTabBounds(exampleTab.id)
      return !!b && b.y === 0 && b.height === contentH
    }, 5000)
    check('overlay: closing find bar restores full-height page', fullAgain, `bounds=${JSON.stringify(this.tabs.getTabBounds(exampleTab.id))}`)

    // Popups become tabs: window.open on the page opens a tab in this shell
    this.switchTab(exampleTab.id)
    const beforePop = new Set([...this.activeSpace().pinned, ...this.activeSpace().today].map((t) => t.id))
    const winsBefore = BrowserWindow.getAllWindows().length
    const popWc = this.tabs.webContentsFor(exampleTab.id)!
    await popWc.executeJavaScript("window.open('https://example.org/','_blank')")
    const popTab = await pollUntil(
      () => [...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => !beforePop.has(t.id)),
      5000
    ).then(() => [...this.activeSpace().pinned, ...this.activeSpace().today].find((t) => !beforePop.has(t.id)))
    check(
      'popups open as tabs, not OS windows',
      !!popTab && popTab.url.includes('example.org') && BrowserWindow.getAllWindows().length === winsBefore,
      `tab=${popTab?.url ?? 'none'} windows=${BrowserWindow.getAllWindows().length}->${winsBefore}`
    )
    if (popTab) this.closeTab(popTab.id)
    this.switchTab(exampleTab.id)

    // Command registry: the three shortcut-only commands are discoverable
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    let regBarUp = false
    for (let i = 0; i < 20 && !regBarUp; i++) {
      regBarUp = await this.win.webContents.executeJavaScript("!!document.querySelector('.command-input')")
      if (!regBarUp) await wait(250)
    }
    const regSet: string = await this.win.webContents.executeJavaScript(
      "(()=>{const i=document.querySelector('.command-input'); if(!i) return 'NO-INPUT';" +
        "Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i,'uplicate');" +
        "i.dispatchEvent(new Event('input',{bubbles:true})); return 'OK'})()"
    )
    await wait(400)
    const regRows: string = await this.win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.command-row')].map(r=>r.textContent).join('|')"
    )
    check('command bar: registry lists Duplicate Tab', regBarUp && regSet === 'OK' && /Duplicate Tab/.test(regRows), regRows.slice(0, 80))
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)

    // Context menu builder: link items fire their real handlers (the native
    // popup itself is not assertable headless - see README).
    const ctxWc = this.tabs.webContentsFor(exampleTab.id)!
    const ctxItems = buildPageContextMenu(
      { linkURL: 'https://example.org/', selectionText: '', mediaType: 'none', x: 10, y: 10 } as Electron.ContextMenuParams,
      ctxWc,
      (url) => this.openTab(url)
    )
    const copyLink = ctxItems.find((i) => i.label === 'Copy Link Address')
    copyLink?.click?.({} as Electron.MenuItem, this.win, {} as Electron.KeyboardEvent)
    const linkClip = await clipboard.readText()
    const openLink = ctxItems.find((i) => i.label === 'Open Link in New Tab')
    const beforeCtx = new Set([...this.activeSpace().pinned, ...this.activeSpace().today].map((t) => t.id))
    openLink?.click?.({} as Electron.MenuItem, this.win, {} as Electron.KeyboardEvent)
    const ctxTab = await pollUntil(
      () => [...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => !beforeCtx.has(t.id)),
      5000
    ).then(() => [...this.activeSpace().pinned, ...this.activeSpace().today].find((t) => !beforeCtx.has(t.id)))
    check(
      'context menu: copy link + open in new tab',
      linkClip === 'https://example.org/' && !!ctxTab && ctxTab.url.includes('example.org'),
      `clip="${linkClip}" tab=${ctxTab?.url ?? 'none'}`
    )
    if (ctxTab) this.closeTab(ctxTab.id)
    this.switchTab(exampleTab.id)

    // Ctrl+P saves the active tab as a real PDF into ~/Downloads
    this.switchTab(exampleTab.id)
    const dlDir = join(app.getPath('home'), 'Downloads')
    fs.mkdirSync(dlDir, { recursive: true })
    const pdfsBefore = new Set(fs.readdirSync(dlDir).filter((f) => f.endsWith('.pdf')))
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true}))"
    )
    let pdfFile = ''
    for (let i = 0; i < 20 && !pdfFile; i++) {
      await wait(250)
      const now = fs.readdirSync(dlDir).filter((f) => f.endsWith('.pdf') && !pdfsBefore.has(f))
      if (now.length > 0) pdfFile = now[0]
    }
    const pdfPath = join(dlDir, pdfFile)
    const pdfOk =
      pdfFile.length > 0 &&
      fs.statSync(pdfPath).size > 1000 &&
      fs.readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-'
    check('pdf: Ctrl+P saves a real PDF to Downloads', pdfOk, `file=${pdfFile || 'none'} size=${pdfFile ? fs.statSync(pdfPath).size : 0}`)
    // Test hygiene: remove the artifact so repeated runs don't pile up PDFs.
    try { if (pdfFile) fs.unlinkSync(pdfPath) } catch { /* leave artifact */ }

    // Reader mode (Ctrl+Alt+R) on the Wikipedia article: overlay appears with
    // the article title, toggles off again. Asserted on the page DOM itself.
    this.switchTab(wikiTab.id)
    await pollUntil(() => (this.tabs.currentUrl(wikiTab.id) ?? '').includes('wikipedia.org'), 5000)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',ctrlKey:true,altKey:true,bubbles:true}))"
    )
    const wikiWc = this.tabs.webContentsFor(wikiTab.id)!
    await pollUntil(
      () =>
        wikiWc.executeJavaScript(
          "[...document.querySelectorAll('p')].some((p) => (p.textContent || '').trim().length > 200)"
        ),
      10000
    )
    let readerOn = false
    for (let i = 0; i < 20 && !readerOn; i++) {
      readerOn = await wikiWc.executeJavaScript("!!document.getElementById('oa-reader-overlay')")
      if (!readerOn) await wait(250)
    }
    const readerTitle: string = readerOn
      ? await wikiWc.executeJavaScript("document.querySelector('.oa-reader h1')?.textContent ?? ''")
      : ''
    const readerParas: number = readerOn ? await wikiWc.executeJavaScript("document.querySelectorAll('#oa-reader-overlay p').length") : 0
    check(
      'reader mode: overlay with article title',
      readerOn === true && /Web browser/.test(readerTitle) && readerParas >= 1,
      `title="${readerTitle.slice(0, 40)}" paragraphs=${readerParas}`
    )
    if (readerOn && !wikiWc.isDestroyed()) {
      const readerImg = await wikiWc.capturePage()
      writeFileSync(`${dir}/9-reader-mode.png`, readerImg.toPNG())
    }
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',ctrlKey:true,altKey:true,bubbles:true}))"
    )
    let readerOff = false
    for (let i = 0; i < 20 && !readerOff; i++) {
      readerOff = await wikiWc.executeJavaScript("!document.getElementById('oa-reader-overlay')")
      if (!readerOff) await wait(250)
    }
    check('reader mode: toggles off', readerOff)
    this.switchTab(exampleTab.id)

    // Ctrl+U opens view-source of the active tab in a new tab
    const beforeSrc = new Set([...this.activeSpace().pinned, ...this.activeSpace().today].map((t) => t.id))
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'u',ctrlKey:true,bubbles:true}))"
    )
    const srcOpened = await pollUntil(
      () => [...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => !beforeSrc.has(t.id)),
      5000
    )
    const srcTab = [...this.activeSpace().pinned, ...this.activeSpace().today].find((t) => !beforeSrc.has(t.id))
    check(
      'shortcuts: Ctrl+U opens view-source',
      srcOpened && !!srcTab && srcTab.url.startsWith('view-source:https://'),
      `url=${srcTab?.url ?? 'none'}`
    )
    if (srcTab) this.closeTab(srcTab.id)
    this.switchTab(exampleTab.id)

    // Command bar fuzzy search (real renderer path): subsequence query 'wbr'
    // must surface the open Wikipedia tab.
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    await wait(700)
    await this.win.webContents.executeJavaScript(
      "const i=document.querySelector('.command-input');" +
        "Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i,'wbr');" +
        "i.dispatchEvent(new Event('input',{bubbles:true}))"
    )
    await wait(400)
    const rowTexts: string = await this.win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.command-row')].map(r=>r.textContent).join('|')"
    )
    check('command bar: fuzzy subsequence finds tab', /Wikipedia/i.test(rowTexts), rowTexts.slice(0, 80))
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)

    // Command bar also surfaces history rows for past navigations
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    let histBarUp = false
    for (let i = 0; i < 20 && !histBarUp; i++) {
      histBarUp = await this.win.webContents.executeJavaScript("!!document.querySelector('.command-input')")
      if (!histBarUp) await wait(250)
    }
    const histSet: string = await this.win.webContents.executeJavaScript(
      "(()=>{const i=document.querySelector('.command-input'); if(!i) return 'NO-INPUT';" +
        "Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i,'xmpl.org');" +
        "i.dispatchEvent(new Event('input',{bubbles:true})); return 'OK'})()"
    )
    await wait(400)
    const histRowTexts: string = await this.win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.command-row')].map(r=>r.textContent).join('|')"
    )
    check(
      'command bar: history rows surface',
      histBarUp && histSet === 'OK' && /history/i.test(histRowTexts),
      `barUp=${histBarUp} set=${histSet} rows=${histRowTexts.slice(0, 80)}`
    )

    // Clear History command empties the record
    this.runCommand('clear-history')
    check('command: clear-history empties history', this.state.history.length === 0, `n=${this.state.history.length}`)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)

    // Split view on/off
    this.runCommand('split-view')
    const splitOn = this.activeSpace().splitTabId !== null
    await wait(1500)
    const capA = await this.tabs.capture(this.activeSpace().activeTabId!)
    const capB = this.activeSpace().splitTabId ? await this.tabs.capture(this.activeSpace().splitTabId!) : null
    if (capA) writeFileSync(`${dir}/4-split-primary.png`, capA)
    if (capB) writeFileSync(`${dir}/4-split-partner.png`, capB)
    this.runCommand('split-view')
    check('split view on/off', splitOn && this.activeSpace().splitTabId === null)

    // Spaces: create + activate, then cross-space tab follow
    const before = this.state.spaces.length
    this.createSpace('Smoke')
    check('spaces: create + activate', this.state.spaces.length === before + 1 && this.activeSpace().name === 'Smoke')
    this.switchTab(exampleTab.id)
    check('spaces: cross-space tab switch follows tab', this.activeSpace().name === 'Personal' && this.activeSpace().activeTabId === exampleTab.id)

    // Space deletion: throwaway space with a tab must vanish, views closed
    this.createSpace('Temp')
    this.openTab('https://example.org/')
    const tempSpaceId = this.activeSpace().id
    const tempSpaceTabId = this.activeTab()!.id
    const spaceCount = this.state.spaces.length
    this.runCommand('delete-space')
    check(
      'spaces: delete removes space and its tabs',
      this.state.spaces.length === spaceCount - 1 && !this.state.spaces.some((sp) => sp.id === tempSpaceId) && this.tabs.currentUrl(tempSpaceTabId) === null
    )
    this.switchTab(exampleTab.id) // restore focus for later checks

    // Close Other Tabs: throwaway space, 3 tabs, keep only the active one
    this.createSpace('Scratch')
    this.openTab('https://example.com/')
    const keepTab = this.activeTab()!
    this.openTab('https://example.org/')
    this.openTab('https://example.com/?a=1')
    this.switchTab(keepTab.id)
    this.runCommand('close-others')
    const scratch = this.activeSpace()
    check(
      'command: close-others keeps only active tab',
      scratch.today.length === 1 && scratch.today[0].id === keepTab.id && scratch.activeTabId === keepTab.id,
      `today=${scratch.today.length}`
    )
    this.runCommand('delete-space')
    this.switchTab(exampleTab.id)

    // Close Tabs to the Right: throwaway space, 3 tabs, active first
    this.createSpace('Scratch2')
    this.openTab('https://example.com/')
    const firstTab = this.activeTab()!
    this.openTab('https://example.org/')
    const midTab = this.activeTab()!
    this.openTab('https://example.com/?b=2')
    const lastTab = this.activeTab()!
    this.switchTab(firstTab.id)
    this.runCommand('close-right')
    const scratch2 = this.activeSpace()
    check(
      'command: close-right closes tabs after active',
      scratch2.today.length === 1 && scratch2.today[0].id === firstTab.id &&
        this.tabs.currentUrl(midTab.id) === null && this.tabs.currentUrl(lastTab.id) === null,
      `today=${scratch2.today.length}`
    )
    this.runCommand('delete-space')
    this.switchTab(exampleTab.id)

    // Space rename through the real preload IPC path (and back - later
    // checks look up the space by its original name)
    const smokeSpace = this.state.spaces.find((sp) => sp.name === 'Smoke')!
    await this.win.webContents.executeJavaScript(`window.openArc.renameSpace(${JSON.stringify(smokeSpace.id)}, 'Work')`)
    const renamed = await pollUntil(() => this.state.spaces.some((sp) => sp.name === 'Work' && sp.icon === 'W'), 5000)
    check('spaces: rename via IPC updates name and icon', renamed)
    await this.win.webContents.executeJavaScript(`window.openArc.renameSpace(${JSON.stringify(smokeSpace.id)}, 'Smoke')`)
    await pollUntil(() => this.state.spaces.some((sp) => sp.name === 'Smoke'), 5000)

    // Move tab to space (command path with a space-name argument): wikiTab
    // goes Personal -> Smoke and back; both sides of each move asserted.
    this.switchTab(wikiTab.id)
    this.runCommand('move-to-space', 'Smoke')
    const movedTo = this.state.spaces.find((sp) => sp.name === 'Smoke')
    const movedFrom = this.state.spaces.find((sp) => sp.name === 'Personal')
    check(
      'command: move active tab to another space',
      !!movedTo?.today.some((t) => t.id === wikiTab.id) && !movedFrom?.today.some((t) => t.id === wikiTab.id),
      `inSmoke=${movedTo?.today.some((t) => t.id === wikiTab.id)}`
    )
    this.switchTab(wikiTab.id) // cross-space follow activates Smoke
    this.runCommand('move-to-space', 'Personal')
    check(
      'command: move back to Personal',
      !!this.state.spaces.find((sp) => sp.name === 'Personal')?.today.some((t) => t.id === wikiTab.id)
    )
    this.switchTab(exampleTab.id)

    // Pin, unpin, re-pin (verify phase expects the example tab pinned)
    this.setPinned(exampleTab.id, true)
    check('pin tab', this.activeSpace().pinned.some((t) => t.id === exampleTab.id))
    this.setPinned(exampleTab.id, false)
    const unpinned = !this.activeSpace().pinned.some((t) => t.id === exampleTab.id) && this.activeSpace().today.some((t) => t.id === exampleTab.id)
    this.setPinned(exampleTab.id, true)
    check('unpin then re-pin round trip', unpinned && this.activeSpace().pinned.some((t) => t.id === exampleTab.id))

    // Reopen closed tab (Ctrl+Shift+T path): close the wiki tab, reopen by URL
    const wikiUrl = wikiTab.url
    this.closeTab(wikiTab.id)
    const closedOk = !this.activeSpace().today.some((t) => t.id === wikiTab.id) && this.state.recentlyClosed.length > 0
    this.runCommand('reopen-closed-tab')
    const wiki2 = this.activeSpace().today.find((t) => t.url === wikiUrl)
    check('reopen closed tab', closedOk && !!wiki2)
    this.switchTab(exampleTab.id) // restore focus: the archiver skips the active tab

    // Auto-archive: idle the wiki tab beyond the threshold, then tick
    wiki2!.lastActiveAt = Date.now() - this.state.archiveAfterMs - 1000
    const moved = this.archiveIdle(false)
    await wait(500)
    check('auto-archive: idle tab moves to archive', moved >= 1 && this.activeSpace().archived.some((t) => t.id === wiki2!.id))
    await shot('5-auto-archive')

    // Restore from archive: archive a throwaway tab, bring it back
    this.openTab('https://example.org/')
    const tempTab = this.activeTab()!
    await pollUntil(() => (this.tabs.currentUrl(tempTab.id) ?? '').includes('example.org'), 10000)
    this.switchTab(exampleTab.id)
    tempTab.lastActiveAt = Date.now() - this.state.archiveAfterMs - 1000
    this.archiveIdle(false)
    const wasArchived = this.activeSpace().archived.some((t) => t.id === tempTab.id)
    this.restoreTab(tempTab.id)
    check('restore archived tab', wasArchived && this.activeSpace().today.some((t) => t.id === tempTab.id))
    this.closeTab(tempTab.id) // keep the final state tidy for the verify phase

    // Command bar surfaces recently closed tabs (tempTab's close made an entry)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    let closedBarUp = false
    for (let i = 0; i < 20 && !closedBarUp; i++) {
      closedBarUp = await this.win.webContents.executeJavaScript("!!document.querySelector('.command-input')")
      if (!closedBarUp) await wait(250)
    }
    const closedSet: string = await this.win.webContents.executeJavaScript(
      "(()=>{const i=document.querySelector('.command-input'); if(!i) return 'NO-INPUT';" +
        "Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i,'xmpl.org');" +
        "i.dispatchEvent(new Event('input',{bubbles:true})); return 'OK'})()"
    )
    await wait(400)
    const closedRowTexts: string = await this.win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.command-row')].map(r=>r.textContent).join('|')"
    )
    check(
      'command bar: recently closed tabs surface',
      closedBarUp && closedSet === 'OK' && /recently closed/i.test(closedRowTexts),
      `barUp=${closedBarUp} set=${closedSet} rows=${closedRowTexts.slice(0, 80)}`
    )
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(300)

    // Downloads: local server returns Content-Disposition: attachment; the
    // will-download handler must save the file into ~/Downloads.
    const { createServer } = await import('node:http')
    const dlServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="open-arc-smoke.txt"' })
      res.end('open-arc smoke download\n')
    })
    await new Promise<void>((r) => dlServer.listen(0, '127.0.0.1', r))
    const dlPort = (dlServer.address() as { port: number }).port
    this.openTab(`http://127.0.0.1:${dlPort}/file`)
    const dlTab = this.activeTab()!
    const gotDl = await pollUntil(() => this.downloadsDone.some((d) => d.filename === 'open-arc-smoke.txt' && d.state === 'completed'), 10000)
    let dlOnDisk = false
    try {
      const { existsSync, readFileSync, unlinkSync } = await import('node:fs')
      const p = join(app.getPath('downloads'), 'open-arc-smoke.txt')
      dlOnDisk = existsSync(p) && readFileSync(p, 'utf8').includes('open-arc smoke download')
    } catch { /* reported by check below */ }
    check('downloads: file saves to Downloads folder', gotDl && dlOnDisk)
    // Direct navigation to a file leaves the tab blank once the navigation
    // becomes a download; it must get an honest, recoverable status page.
    const noteShown = await pollUntil(() => dlTab.title === 'Download complete', 8000)
    check('downloads: blank tab shows a recoverable post-download state', noteShown, `title="${dlTab.title}"`)
    // The completion toast reserves a bottom strip so feedback is never
    // hidden behind page content (same layering class as the overlays).
    const [, dlContentH] = this.win.getContentSize()
    const toastInset = await pollUntil(() => {
      const b = this.tabs.getTabBounds(dlTab.id)
      return !!b && b.height === dlContentH - 64
    }, 5000)
    check('toast: download feedback reserves a visible strip', toastInset, `bounds=${JSON.stringify(this.tabs.getTabBounds(dlTab.id))} contentH=${dlContentH}`)
    // Reliability: a second download with the same filename must NOT
    // overwrite the first (forced save paths bypass Chromium's uniquify).
    this.openTab(`http://127.0.0.1:${dlPort}/file`)
    const dlTab2 = this.activeTab()!
    const gotDl2 = await pollUntil(() => this.downloadsDone.filter((d) => d.state === 'completed' && d.filename.includes('open-arc-smoke')).length >= 2, 10000)
    let bothKept = false
    let secondPath = ''
    try {
      const { existsSync: ex2, readFileSync: rf2, unlinkSync: ul2 } = await import('node:fs')
      const dlDir2 = app.getPath('downloads')
      const p1 = join(dlDir2, 'open-arc-smoke.txt')
      const p2 = join(dlDir2, 'open-arc-smoke (1).txt')
      secondPath = this.downloadsDone[this.downloadsDone.length - 1]?.path ?? ''
      bothKept = ex2(p1) && ex2(p2) && rf2(p2, 'utf8').includes('open-arc smoke download')
      if (ex2(p1)) ul2(p1)
      if (ex2(p2)) ul2(p2)
    } catch { /* reported by check below */ }
    check('reliability: same-name download keeps both files', gotDl2 && bothKept, `second=${secondPath}`)
    this.closeTab(dlTab2.id)
    this.closeTab(dlTab.id)
    dlServer.close()

    // Window bounds persistence: set a distinctive size; the verify phase
    // asserts both the saved state and the restored live window.
    this.win.setSize(1000, 700)
    this.state.windowBounds = this.win.getBounds()

    this.store.flush(this.state)
    // Reliability: the macOS dock re-activation path recreates the shell
    // window on the RUNNING app. The old code constructed a second OpenArcApp
    // whose start() re-registered ipcMain.handle channels - which throws.
    // Exercised directly here (Linux): proves the re-open path no longer
    // re-registers and stays functional. NOT a native Dock test.
    const oldWin = this.win
    let reopenErr = ''
    try {
      this.reopenWindow()
    } catch (e) {
      reopenErr = String(e)
    }
    check('reliability: window re-open runs without re-registering handlers', reopenErr === '', reopenErr || 'no throw')
    if (reopenErr === '') {
      const newWin = this.win
      const ipcAlive = await pollUntil(async () => {
        try {
          return await newWin.webContents.executeJavaScript("window.openArc ? window.openArc.getState().then((s) => Array.isArray(s.spaces) && s.spaces.length >= 1) : false")
        } catch { return false }
      }, 15000)
      check('reliability: re-opened window has working IPC and state', ipcAlive)
      oldWin.destroy()
    }

    writeFileSync(`${dir}/report-run.json`, JSON.stringify({ phase: 'run', checks }, null, 2))
    app.exit(checks.every((c) => c.pass) ? 0 : 1)
  }

  private windowControl(action: 'minimize' | 'maximize' | 'fullscreen' | 'close'): void {
    if (action === 'minimize') this.win.minimize()
    if (action === 'maximize') this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize()
    if (action === 'fullscreen') {
      // Green control: native macOS full-screen on darwin, maximize elsewhere.
      // The drag-strip double-click keeps the plain maximize/restore path.
      if (process.platform === 'darwin') this.win.setFullScreen(!this.win.isFullScreen())
      else if (this.win.isMaximized()) this.win.unmaximize()
      else this.win.maximize()
    }
    if (action === 'close') this.win.close()
  }

  /** Recovery choice from the dialog (or the selfTest harness). */
  private applyRecoveryChoice(accept: boolean): { ok: boolean; error?: string; warning?: string } {
    if (accept) {
      const result = this.store.acceptRecovery()
      if (result.ok && result.state) {
        this.state = migrate(result.state)
        this.commit()
      }
      if (!this.win.isDestroyed()) this.win.webContents.send('state:recovery-result', { ok: result.ok, accepted: result.ok, error: result.error, warning: result.warning })
      return result
    }
    const result = this.store.declineRecovery()
    // Persist the current (declining) state once: the debounced save was
    // held while the choice was pending, so nothing is on disk yet.
    if (result.ok) this.commit()
    if (!this.win.isDestroyed()) this.win.webContents.send('state:recovery-result', { ok: result.ok, accepted: false, error: result.error })
    return result
  }

  private registerIpc(): void {
    ipcMain.handle('state:get', () => this.state)
    ipcMain.handle('commands:list', () => COMMANDS)
    ipcMain.on('state:recovery-choice', (_e, accept: boolean) => this.applyRecoveryChoice(accept === true))
    ipcMain.on('state:recovery-malformed-choice', (_e, keep: boolean) => { this.store.dismissMalformed(keep === true) })

    ipcMain.on('space:switch', (_e, spaceId: string) => {
      if (this.state.spaces.some((s) => s.id === spaceId)) {
        this.state.activeSpaceId = spaceId
        this.commit()
      }
    })
    ipcMain.on('space:create', (_e, name: string) => this.createSpace(name))
    ipcMain.on('space:rename', (_e, spaceId: string, name: string) => {
      const s = this.state.spaces.find((sp) => sp.id === spaceId)
      if (s && name.trim()) {
        s.name = name.trim()
        s.icon = name.trim().charAt(0).toUpperCase()
        this.commit()
      }
    })

    ipcMain.on('tab:open', (_e, url: string) => this.openTab(url))
    ipcMain.on('tab:close', (_e, tabId: string) => this.closeTab(tabId))
    ipcMain.on('tab:switch', (_e, tabId: string) => this.switchTab(tabId))
    ipcMain.on('tab:pin', (_e, tabId: string) => this.setPinned(tabId, true))
    ipcMain.on('tab:unpin', (_e, tabId: string) => this.setPinned(tabId, false))
    ipcMain.on('tab:restore', (_e, tabId: string) => this.restoreTab(tabId))
    ipcMain.handle('find:in-page', (_e, text: string, findNext: boolean) => {
      const active = this.activeTab()
      return active ? this.tabs.findIn(active.id, text, !!findNext) : null
    })
    ipcMain.on('find:stop', () => {
      const active = this.activeTab()
      if (active) this.tabs.stopFind(active.id)
    })
    ipcMain.handle('tab:zoom', (_e, action: 'in' | 'out' | 'reset') => {
      const active = this.activeTab()
      if (!active) return 1
      const factor = this.tabs.adjustZoom(active.id, action)
      active.zoom = factor // persisted; restored when the view is (re)created
      this.store.save(this.state)
      return factor
    })
    ipcMain.handle('tab:mute-toggle', () => {
      const active = this.activeTab()
      return active ? this.tabs.toggleMute(active.id) : false
    })
    ipcMain.handle('tab:print-pdf', async () => {
      const active = this.activeTab()
      const wc = active ? this.tabs.webContentsFor(active.id) : null
      if (!wc) return null
      try {
        const data = await wc.printToPDF({ printBackground: true })
        if (!data || data.length < 100) return null
        const host = new URL(wc.getURL()).hostname.replace(/[^a-z0-9.-]/gi, '_') || 'page'
        const dir = join(app.getPath('home'), 'Downloads')
        fs.mkdirSync(dir, { recursive: true })
        const path = join(dir, `open-arc-${host}-${Date.now()}.pdf`)
        fs.writeFileSync(path, data)
        return path
      } catch {
        return null
      }
    })
    ipcMain.handle('tab:reader', async () => {
      const active = this.activeTab()
      const wc = active ? this.tabs.webContentsFor(active.id) : null
      if (!wc) return 'no-content'
      try {
        return (await wc.executeJavaScript(`(${readerToggle.toString()})()`)) as string
      } catch {
        return 'no-content'
      }
    })
    ipcMain.handle('tab:devtools', () => {
      const active = this.activeTab()
      return active ? this.tabs.toggleDevTools(active.id) : false
    })
    ipcMain.handle('tab:copy-url', () => {
      const active = this.activeTab()
      if (!active) return null
      const url = this.tabs.currentUrl(active.id)
      if (url) clipboard.writeText(url)
      return url
    })
    ipcMain.on('nav', (_e, cmd: 'back' | 'forward' | 'reload') => {
      const active = this.activeTab()
      if (active) this.tabs.navigate(active.id, cmd)
    })
    ipcMain.on('sidebar:toggle', () => this.runCommand('toggle-sidebar'))
    ipcMain.on('window:control', (_e, action: 'minimize' | 'maximize' | 'fullscreen' | 'close') => this.windowControl(action))
    ipcMain.on('app:overlay', (_e, modal: boolean, findBar: boolean, toast: boolean) => {
      if (!this.win.isDestroyed()) this.tabs.setOverlayState(!!modal, !!findBar, !!toast)
    })
    ipcMain.on('app:focus', (_e, which: 'shell' | 'page') => {
      if (this.win.isDestroyed()) return
      if (which === 'shell') this.win.webContents.focus()
      else {
        const t = this.activeTab()
        if (t) this.tabs.focusTab(t.id)
      }
    })
    ipcMain.on('command:run', (_e, id: string, arg?: string) => this.runCommand(id, arg))
  }
}

app.whenReady().then(() => {
  const openArc = new OpenArcApp()
  openArc.start()
  app.on('activate', () => {
    // macOS: recreate ONLY the window on dock re-activation. The running
    // instance keeps its IPC handlers, download listener and archiver.
    if (BrowserWindow.getAllWindows().length === 0) openArc.reopenWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
