import type { ShortcutAction } from './shortcuts'
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
  /** Per-tab zoom factor (1 = 100%); restored when the tab's view is created. */
  zoom?: number
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

export interface HistoryEntry {
  url: string
  title: string
  visitedAt: number
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
  /** Navigation history, most recent first, capped at 500. */
  history: HistoryEntry[]
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
  onDownloadDone(cb: (info: { filename: string; path: string; state: string; size?: number }) => void): () => void
  onStateRecovered(cb: (quarantinedPath: string) => void): () => void

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
  toggleMute(): Promise<boolean>
  toggleDevTools(): Promise<boolean>
  toggleReader(): Promise<string>
  printToPdf(): Promise<string | null>
  toggleSidebar(): void
  windowControl(action: 'minimize' | 'maximize' | 'fullscreen' | 'close'): void
  /** Move keyboard focus to the shell UI (overlay opened) or back to the active page (overlay closed). */
  focusShell(): void
  focusPage(): void
  /** Shell overlay state, so main can keep tab views from covering them. */
  setOverlayState(modal: boolean, findBar: boolean, toast: boolean): void
  /** App shortcut forwarded by main when a page (WebContentsView) had keyboard focus. */
  onShortcut(cb: (action: ShortcutAction, arg?: string) => void): () => void

  runCommand(commandId: string, arg?: string): void
  listCommands(): Promise<CommandDef[]>
}
