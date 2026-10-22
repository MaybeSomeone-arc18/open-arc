import { app, BrowserWindow, ipcMain, Menu } from 'electron'
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
    windowBounds: null
  }
}

/** Fill fields added after a state file was written (forward-compatible loads). */
function migrate(state: AppState): AppState {
  state.archiveAfterMs = Number(process.env.OPEN_ARC_ARCHIVE_MS) || state.archiveAfterMs || 12 * 60 * 60 * 1000
  state.recentlyClosed = state.recentlyClosed ?? []
  state.windowBounds = state.windowBounds ?? null
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
        this.tabs.setSidebarVisible(this.state.sidebarVisible)
        this.commit()
        break
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
      case 'go-back':
      case 'go-forward': {
        const dir = id === 'go-back' ? 'back' : id === 'go-forward' ? 'forward' : 'reload'
        if (active) this.tabs.navigate(active.id, dir)
        break
      }
      case 'new-space':
        this.createSpace(arg?.trim() || `Space ${this.state.spaces.length + 1}`)
        break
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
      check('persist: pinned tab survives restart', !!personal?.pinned.find((t) => t.url.includes('example.com')))
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
    const cap = await this.tabs.capture(exampleTab.id)
    if (cap) writeFileSync(`${dir}/3-tab-content.png`, cap)
    else console.log('[openarc] note: tab content capture unavailable in this environment (compositor-restricted)')

    // In-tab navigation + back
    this.tabs.navigateActiveTo(exampleTab.id, 'https://example.org/')
    const wentOrg = await pollUntil(() => (this.tabs.currentUrl(exampleTab.id) ?? '').includes('example.org'), 10000)
    this.tabs.navigate(exampleTab.id, 'back')
    const cameBack = await pollUntil(() => (this.tabs.currentUrl(exampleTab.id) ?? '').includes('example.com'), 10000)
    check('navigation: forward + back', wentOrg && cameBack)

    // Tab switching within a space
    this.openTab('https://en.wikipedia.org/wiki/Web_browser')
    const wikiTab = this.activeTab()!
    await pollUntil(() => wikiTab.title.includes('Wikipedia'), 15000)
    this.switchTab(exampleTab.id)
    const withinOk = this.activeSpace().activeTabId === exampleTab.id
    this.switchTab(wikiTab.id)
    check('tab switching within space', withinOk)

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
