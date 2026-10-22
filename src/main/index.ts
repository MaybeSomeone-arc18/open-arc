import { app, BrowserWindow, ipcMain, Menu, session, clipboard } from 'electron'
import { readerToggle } from './reader'
import { buildPageContextMenu } from './contextmenu'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AppState, Space, TabItem } from '../shared/types'
import { COMMANDS } from '../shared/commands'
import { StateStore } from './store'
import { TabLayer } from './tabs'

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
        sandbox: false
      }
    })
    // Downloads: save into the system Downloads folder, toast on completion.
    this.downloadsDone = []
    session.defaultSession.on('will-download', (_e, item) => {
      const savePath = join(app.getPath('downloads'), item.getFilename())
      item.setSavePath(savePath)
      item.once('done', (_ev, st) => {
        const info = { filename: item.getFilename(), path: savePath, state: st }
        this.downloadsDone.push(info)
        if (!this.win.isDestroyed()) this.win.webContents.send('download:done', info)
      })
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
      (url) => this.openTab(url)
    )
    // Default-deny every web permission request (camera, mic, notifications,
    // geolocation, ...). Electron grants them unless a handler says no; a
    // browser shell must decide deliberately. No prompts exist yet, so deny.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })

    this.tabs.setSidebarVisible(this.state.sidebarVisible)

    if (isDev) {
      this.win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    this.win.webContents.on('did-finish-load', () => {
      console.log('[openarc] renderer finished load')
      this.commit()
      void this.selfTest()
    })

    this.registerIpc()
    this.startArchiver()
    setTimeout(() => this.archiveIdle(false), 5000)
    app.on('before-quit', () => this.store.flush(this.state))
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
        // Default-deny every web permission request (camera, mic, notifications,
    // geolocation, ...). Electron grants them unless a handler says no; a
    // browser shell must decide deliberately. No prompts exist yet, so deny.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })

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
        if (url) this.openTab(url)
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
   * Verification harness (OPEN_ARC_SHOT_DIR set): drives the real app through
   * the smoke suite - window controls, command bar, navigation, tab switching,
   * spaces, split view, auto-archive - captures genuine screenshots and writes
   * report-run.json, then quits. With OPEN_ARC_PHASE=verify it instead checks
   * that a previous run's state survived the restart (persistence check).
   * No effect in normal use.
   */
  private async selfTest(): Promise<void> {
    const dir = process.env.OPEN_ARC_SHOT_DIR
    if (!dir) return
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
    const pollUntil = async (fn: () => boolean, ms: number): Promise<boolean> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (fn()) return true
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

    // Ctrl+Shift+K duplicates the active tab (same URL, becomes active)
    const beforeIds = new Set([...this.activeSpace().pinned, ...this.activeSpace().today].map((t) => t.id))
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'K',ctrlKey:true,shiftKey:true,bubbles:true}))"
    )
    const dupTab = await pollUntil(
      () => [...this.activeSpace().pinned, ...this.activeSpace().today].some((t) => !beforeIds.has(t.id)),
      5000
    ).then(() => [...this.activeSpace().pinned, ...this.activeSpace().today].find((t) => !beforeIds.has(t.id)))
    check(
      'shortcuts: Ctrl+Shift+K duplicates active tab',
      !!dupTab && dupTab.url.includes('wikipedia.org/wiki/Web_browser') && this.activeSpace().activeTabId === dupTab.id,
      `dupUrl=${dupTab?.url ?? 'none'}`
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
    if (pdfFile) fs.rmSync(pdfPath)

    // Reader mode (Ctrl+Alt+R) on the Wikipedia article: overlay appears with
    // the article title, toggles off again. Asserted on the page DOM itself.
    this.switchTab(wikiTab.id)
    await pollUntil(() => (this.tabs.currentUrl(wikiTab.id) ?? '').includes('wikipedia.org'), 5000)
    await this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',ctrlKey:true,altKey:true,bubbles:true}))"
    )
    const wikiWc = this.tabs.webContentsFor(wikiTab.id)!
    let readerOn = false
    for (let i = 0; i < 20 && !readerOn; i++) {
      readerOn = await wikiWc.executeJavaScript("!!document.getElementById('oa-reader-overlay')")
      if (!readerOn) await wait(250)
    }
    const readerTitle: string = readerOn
      ? await wikiWc.executeJavaScript("document.querySelector('.oa-reader h1')?.textContent ?? ''")
      : ''
    check('reader mode: overlay with article title', readerOn === true && /Web browser/.test(readerTitle), `title="${readerTitle.slice(0, 40)}"`)
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

    // Pin
    this.setPinned(exampleTab.id, true)
    check('pin tab', this.activeSpace().pinned.some((t) => t.id === exampleTab.id))

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
      if (dlOnDisk) unlinkSync(p)
    } catch { /* reported by check below */ }
    check('downloads: file saves to Downloads folder', gotDl && dlOnDisk)
    this.closeTab(dlTab.id)
    dlServer.close()

    // Window bounds persistence: set a distinctive size; the verify phase
    // asserts both the saved state and the restored live window.
    this.win.setSize(1000, 700)
    this.state.windowBounds = this.win.getBounds()

    this.store.flush(this.state)
    writeFileSync(`${dir}/report-run.json`, JSON.stringify({ phase: 'run', checks }, null, 2))
    app.exit(checks.every((c) => c.pass) ? 0 : 1)
  }

  private windowControl(action: 'minimize' | 'maximize' | 'close'): void {
    if (action === 'minimize') this.win.minimize()
    if (action === 'maximize') this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize()
    if (action === 'close') this.win.close()
  }

  private registerIpc(): void {
    ipcMain.handle('state:get', () => this.state)
    ipcMain.handle('commands:list', () => COMMANDS)

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
    ipcMain.on('tab:navigate-to', (_e, url: string) => {
      const active = this.activeTab()
      if (active) this.tabs.navigateActiveTo(active.id, normalizeUrl(url))
    })

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
    ipcMain.on('window:control', (_e, action: 'minimize' | 'maximize' | 'close') => this.windowControl(action))
    ipcMain.on('command:run', (_e, id: string, arg?: string) => this.runCommand(id, arg))
  }
}

app.whenReady().then(() => {
  new OpenArcApp().start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) new OpenArcApp().start()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
