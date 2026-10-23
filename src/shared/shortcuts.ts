/**
 * Single source of truth for app-level keyboard shortcuts.
 *
 * Two consumers, one table:
 * - the shell renderer's window keydown listener (shell-focused keys)
 * - the main process's before-input-event hook on each tab WebContentsView
 *   (page-focused keys, which the shell renderer never sees)
 *
 * Keeping the matcher here guarantees both paths recognize exactly the same
 * combos, so no shortcut works in one focus state but not the other.
 */
export interface ShortcutDescriptor {
  key: string
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export type ShortcutAction =
  | 'toggle-command-bar'
  | 'open-command-bar'
  | 'open-find-bar'
  | 'toggle-shortcuts'
  | 'toggle-sidebar'
  | 'reopen-closed-tab'
  | 'close-tab'
  | 'reload'
  | 'hard-reload'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-mute'
  | 'view-source'
  | 'print-pdf'
  | 'reader-toggle'
  | 'devtools'
  | 'duplicate-tab'
  | 'copy-url'
  | 'goto-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'go-back'
  | 'go-forward'
  | 'pin-tab'
  | 'split-view'
  | 'close-split'

export interface ShortcutMatch {
  id: ShortcutAction
  /** Extra payload for parameterized actions (e.g. goto-tab digit). */
  arg?: string
}

/**
 * Match a key event against the app shortcut table. Returns null for ordinary
 * typing and for combos the app does not own (those belong to the page).
 * Escape is deliberately NOT here: pages need it, so the shell handles it
 * locally and main never intercepts it from a focused page.
 */
export function matchShortcut(d: ShortcutDescriptor): ShortcutMatch | null {
  const mod = d.ctrl || d.meta
  const key = d.key.length === 1 ? d.key.toLowerCase() : d.key
  if (mod && d.shift && key === 't') return { id: 'reopen-closed-tab' }
  if (mod && key === 't') return { id: 'toggle-command-bar' }
  if (mod && key === 's') return { id: 'toggle-sidebar' }
  if (mod && key === 'w') return { id: 'close-tab' }
  if (mod && d.shift && key === 'r') return { id: 'hard-reload' }
  if (mod && !d.shift && !d.alt && key === 'r') return { id: 'reload' }
  if (mod && key === 'l') return { id: 'open-command-bar' }
  if (mod && key === 'f') return { id: 'open-find-bar' }
  if (mod && !d.shift && (key === '=' || key === '+')) return { id: 'zoom-in' }
  if (mod && !d.shift && key === '-') return { id: 'zoom-out' }
  if (mod && !d.shift && key === '0') return { id: 'zoom-reset' }
  if (mod && !d.shift && key === 'm') return { id: 'toggle-mute' }
  if (mod && !d.shift && key === 'u') return { id: 'view-source' }
  if (mod && !d.shift && !d.alt && key === 'p') return { id: 'print-pdf' }
  if (mod && d.alt && key === 'r') return { id: 'reader-toggle' }
  if (key === 'F12' || (mod && d.shift && key === 'i')) return { id: 'devtools' }
  if (mod && d.shift && key === 'k') return { id: 'duplicate-tab' }
  if (mod && d.shift && key === 'c') return { id: 'copy-url' }
  if (mod && !d.shift && key >= '1' && key <= '9') return { id: 'goto-tab', arg: key }
  if (mod && key === 'Tab') return { id: d.shift ? 'prev-tab' : 'next-tab' }
  if (d.alt && key === 'ArrowLeft') return { id: 'go-back' }
  if (d.alt && key === 'ArrowRight') return { id: 'go-forward' }
  if (mod && key === 'd') return { id: 'pin-tab' }
  if (mod && d.shift && (key === '+' || key === '=')) return { id: 'split-view' }
  if (mod && d.shift && (key === '_' || key === '-')) return { id: 'close-split' }
  if (mod && key === '/') return { id: 'toggle-shortcuts' }
  return null
}
