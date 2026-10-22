import type { CommandDef } from './types'

/** Command-bar registry. Keep ids stable: the renderer fuzzy-matches on title. */
export const COMMANDS: CommandDef[] = [
  { id: 'new-tab', title: 'New Tab', hint: 'Ctrl+T then type a URL' },
  { id: 'close-tab', title: 'Close Current Tab', hint: 'Ctrl+W' },
  { id: 'toggle-sidebar', title: 'Show / Hide Sidebar', hint: 'Ctrl+S' },
  { id: 'reload', title: 'Reload Page', hint: 'Ctrl+R' },
  { id: 'go-back', title: 'Go Back in History' },
  { id: 'go-forward', title: 'Go Forward in History' },
  { id: 'new-space', title: 'New Space...' },
  { id: 'pin-tab', title: 'Pin Current Tab', hint: 'Ctrl+D' },
  { id: 'unpin-tab', title: 'Unpin Current Tab' },
  { id: 'split-view', title: 'Add Split View', hint: 'Ctrl+Shift+=' },
  { id: 'close-split', title: 'Close Split View', hint: 'Ctrl+Shift+-' },
  { id: 'clear-today', title: 'Clear Today Tabs' },
  { id: 'archive-now', title: 'Archive Idle Tabs Now' }
]
