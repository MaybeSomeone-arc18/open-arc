import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppState, Space, TabItem } from '../shared/types'
import { COMMANDS } from '../shared/commands'
import { StateStore } from './store'
import { TabLayer } from './tabs'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Verification-harness hooks (no effect in normal use)
if (process.env.OPEN_ARC_USER_DATA) app.setPath('userData', process.env.OPEN_ARC_USER_DATA)
if (process.env.OPEN_ARC_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox')

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
    archiveAfterMs: Number(process.env.OPEN_ARC_ARCHIVE_MS) || 12 * 60 * 60 * 1000
  }
}

/** Fill fields added after a state file was written (forward-compatible loads). */
function migrate(state: AppState): AppState {
  state.archiveAfterMs = state.archiveAfterMs || Number(process.env.OPEN_ARC_ARCHIVE_MS) || 12 * 60 * 60 * 1000
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
    this.win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 720,
      minHeight: 480,
      frame: false,
      backgroundColor: '#17161c',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    this.tabs = new TabLayer(this.win, () => this.commit())
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
    const space = this.activeSpace()
    const tab = [...space.pinned, ...space.today].find((t) => t.id === tabId)
    if (tab) {
      space.activeTabId = tab.id
      tab.lastActiveAt = Date.now()
      this.commit()
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
   * Verification harness (OPEN_ARC_SHOT_DIR set): captures real screenshots of
   * the shell UI, the command bar, and the live tab content layer, then quits.
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
    await wait(3500) // let the active tab's WebContentsView load
    console.log('[openarc] capturing 1-shell')
    await shot('1-shell')
    // window controls: exercise the same path the traffic-light buttons use
    this.windowControl('minimize')
    await wait(300)
    this.win.restore()
    this.windowControl('maximize')
    await wait(300)
    this.windowControl('maximize') // toggles back
    console.log('[openarc] window controls OK (minimize/restore/maximize/unmaximize)')
    // archiver: startup tick fires at 5s; capture its effect if any
    await wait(5000)
    await shot('1b-after-archive-tick')
    console.log('[openarc] archive tick captured')
    this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true}))"
    )
    await wait(700)
    await shot('2-commandbar')
    this.win.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    await wait(400)
    const active = this.activeTab()
    if (active) {
      const view = (this.tabs as unknown as { views: Map<string, { webContents: Electron.WebContents }> }).views.get(active.id)
      if (view) {
        const img = await view.webContents.capturePage()
        writeFileSync(`${dir}/3-tab-content.png`, img.toPNG())
      }
    }
    console.log('[openarc] selftest done, exiting')
    app.exit(0)
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
