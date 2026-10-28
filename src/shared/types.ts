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
  /** ID of the tab that currently has active keyboard/navigation focus (activeTabId or splitTabId). */
  focusedTabId?: string | null
  /** Width fraction of the left (active) pane when splitTabId is set. In [0.1, 0.9], defaults to 0.5. */
  splitRatio?: number
  /** Profile/partition identifier for session and cookie isolation. Empty or undefined means default session. */
  profileId?: string
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
  /** Global favorite tabs (pinned permanently across all Spaces). */
  favorites?: TabItem[]
}

export interface CommandDef {
  id: string
  title: string
  hint?: string
}

/** Everything the renderer is allowed to ask the main process to do. */
export interface RecoveryOfferInfo {
  /** Basename of the offered state.json.fresh-<ts> candidate. */
  candidateName: string
  candidateTimestamp: string
  spaceCount: number
  spaceNames: string[]
  /** mtime of the current state.json; null when it does not exist. */
  currentTimestamp: string | null
  currentValid: boolean
  /** Other candidates kept on disk for later individual decisions. */
  otherNames: string[]
  /** Malformed files kept on disk, never loaded. */
  malformedNames: string[]
}

export interface RecoveryMalformedNotice {
  names: string[]
  currentValid: boolean
}

export interface RecoveryResult {
  ok: boolean
  accepted: boolean
  error?: string
  /** Post-commit durability/cleanup warning; the recovery still committed. */
  warning?: string
}

export interface OpenArcApi {
  getState(): Promise<AppState>
  onStateChanged(cb: (state: AppState) => void): () => void
  /** Transient (never persisted): tab page load start/stop. */
  onTabLoading(cb: (tabId: string, loading: boolean) => void): () => void
  /** Transient: a download finished (state: completed | cancelled | interrupted). */
  onDownloadDone(cb: (info: { filename: string; path: string; state: string; size?: number }) => void): () => void
  onStateRecovered(cb: (quarantinedPath: string) => void): () => void
  onSaveFailed(cb: (error: string) => void): () => void
  onRecoveryOffer(cb: (info: RecoveryOfferInfo) => void): () => void
  onRecoveryMalformed(cb: (notice: RecoveryMalformedNotice) => void): () => void
  onRecoveryResult(cb: (result: RecoveryResult) => void): () => void
  chooseRecovery(accept: boolean): void
  dismissRecoveryMalformed(keep: boolean): void

  switchSpace(spaceId: string): void
  createSpace(name: string): void
  renameSpace(spaceId: string, name: string): void

  openTab(url: string): void
  closeTab(tabId: string): void
  switchTab(tabId: string): void
  splitTabWith(tabId: string): void
  pinTab(tabId: string): void
  unpinTab(tabId: string): void
  restoreTab(tabId: string): void
  toggleFavorite(tabId: string): void

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

  /** Split divider drag controls. */
  startSplitDrag(): void
  previewSplitRatio(ratio: number): void
  commitSplitRatio(ratio: number): void
  cancelSplitRatio(): void
  resetSplitRatio(): void
}
