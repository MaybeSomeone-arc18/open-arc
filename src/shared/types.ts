/** Shared model types: the contract between main process, preload and renderer. */

export interface TabItem {
  id: string
  url: string
  title: string
  favicon: string | null
  /** Pinned tabs live above the line and never auto-archive. */
  pinned: boolean
  /** Last time the tab was focused (epoch ms); drives auto-archive. */
  lastActiveAt: number
}

export interface Space {
  id: string
  name: string
  /** Theme accent color (hex). */
  color: string
  /** Single-character icon (emoji or letter). */
  icon: string
  pinned: TabItem[]
  today: TabItem[]
  /** Auto-archived tabs, restorable. */
  archived: TabItem[]
  /** Tab currently focused inside this space. */
  activeTabId: string | null
  /** When set, this tab renders beside the active tab (2-pane split). */
  splitTabId: string | null
}

export interface ClosedTab {
  url: string
  title: string
  spaceId: string
  pinned: boolean
  closedAt: number
}

export interface AppState {
  spaces: Space[]
  activeSpaceId: string
  sidebarVisible: boolean
  /** Idle threshold (ms) after which unpinned tabs auto-archive. */
  archiveAfterMs: number
  /** Recently closed tabs (most recent first, capped), for Ctrl+Shift+T. */
  recentlyClosed: ClosedTab[]
  /** Last non-maximized window bounds, restored on launch. */
  windowBounds: { x: number; y: number; width: number; height: number } | null
}

export interface CommandDef {
  id: string
  title: string
  hint?: string
}

/** Everything the renderer is allowed to ask the main process to do. */
export interface OpenArcApi {
  getState(): Promise<AppState>
  onStateChanged(cb: (state: AppState) => void): () => void
  /** Transient (never persisted): tab page load start/stop. */
  onTabLoading(cb: (tabId: string, loading: boolean) => void): () => void
  /** Transient: a download finished (state: completed | cancelled | interrupted). */
  onDownloadDone(cb: (info: { filename: string; path: string; state: string }) => void): () => void

  switchSpace(spaceId: string): void
  createSpace(name: string): void
  renameSpace(spaceId: string, name: string): void

  openTab(url: string): void
  closeTab(tabId: string): void
  switchTab(tabId: string): void
  pinTab(tabId: string): void
  unpinTab(tabId: string): void
  restoreTab(tabId: string): void

  navigate(command: 'back' | 'forward' | 'reload'): void
  findInPage(text: string, findNext?: boolean): Promise<{ matches: number; activeMatchOrdinal: number } | null>
  stopFind(): void
  zoom(action: 'in' | 'out' | 'reset'): Promise<number>
  copyActiveUrl(): Promise<string | null>
  toggleSidebar(): void
  windowControl(action: 'minimize' | 'maximize' | 'close'): void

  runCommand(commandId: string, arg?: string): void
  listCommands(): Promise<CommandDef[]>
}
