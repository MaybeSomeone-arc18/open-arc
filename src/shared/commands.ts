import type { CommandDef } from './types'

/** Command-bar registry. Keep ids stable: the renderer fuzzy-matches on title. */
export const COMMANDS: CommandDef[] = [
  { id: 'new-tab', title: 'New Tab', hint: 'Ctrl+T then type a URL' },
  { id: 'close-tab', title: 'Close Current Tab', hint: 'Ctrl+W' },
  { id: 'reopen-closed-tab', title: 'Reopen Closed Tab', hint: 'Ctrl+Shift+T' },
  { id: 'duplicate-tab', title: 'Duplicate Tab', hint: 'Ctrl+Shift+K' },
  { id: 'hard-reload', title: 'Hard Reload (Ignore Cache)', hint: 'Ctrl+Shift+R' },
  { id: 'view-source', title: 'View Page Source', hint: 'Ctrl+U' },
  { id: 'toggle-sidebar', title: 'Show / Hide Sidebar', hint: 'Ctrl+S' },
  { id: 'reload', title: 'Reload Page', hint: 'Ctrl+R' },
  { id: 'go-back', title: 'Go Back in History', hint: 'Alt+\u2190' },
  { id: 'go-forward', title: 'Go Forward in History', hint: 'Alt+\u2192' },
  { id: 'next-tab', title: 'Next Tab', hint: 'Ctrl+Tab' },
  { id: 'prev-tab', title: 'Previous Tab', hint: 'Ctrl+Shift+Tab' },
  { id: 'new-space', title: 'New Space...' },
  { id: 'move-to-space', title: 'Move Tab to Space...', hint: 'Type the space name' },
  { id: 'delete-space', title: 'Delete Current Space' },
  { id: 'pin-tab', title: 'Pin Current Tab', hint: 'Ctrl+D' },
  { id: 'unpin-tab', title: 'Unpin Current Tab' },
  { id: 'split-view', title: 'Add Split View', hint: 'Ctrl+Shift+=' },
  { id: 'close-split', title: 'Close Split View', hint: 'Ctrl+Shift+-' },
  { id: 'clear-history', title: 'Clear Browsing History', hint: 'Remove all recorded history' },
  { id: 'close-others', title: 'Close Other Tabs', hint: 'Keep only the active tab' },
  { id: 'clear-today', title: 'Clear Today Tabs' },
  { id: 'archive-now', title: 'Archive Idle Tabs Now' }
]
