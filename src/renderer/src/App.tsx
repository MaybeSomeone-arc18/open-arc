import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { CommandBar } from './components/CommandBar'

export function App(): JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [commandBarOpen, setCommandBarOpen] = useState(false)

  useEffect(() => {
    window.openArc.getState().then(setState)
    const off = window.openArc.onStateChanged(setState)
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setCommandBarOpen((v) => !v)
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        window.openArc.toggleSidebar()
      }
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        window.openArc.runCommand('close-tab')
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        window.openArc.runCommand('pin-tab')
      }
      if (mod && e.shiftKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        window.openArc.runCommand('split-view')
      }
      if (mod && e.shiftKey && (e.key === '_' || e.key === '-')) {
        e.preventDefault()
        window.openArc.runCommand('close-split')
      }
      if (e.key === 'Escape') setCommandBarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const closeCommandBar = useCallback(() => setCommandBarOpen(false), [])

  if (!state) return <div className="boot">Loading…</div>
  const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]

  return (
    <div className="app" style={{ ['--space-color' as string]: space.color }}>
      {state.sidebarVisible && <Sidebar state={state} space={space} onOpenCommandBar={() => setCommandBarOpen(true)} />}
      {commandBarOpen && <CommandBar state={state} onClose={closeCommandBar} />}
      {!state.sidebarVisible && (
        <button className="sidebar-reopen" title="Show sidebar (Ctrl+S)" onClick={() => window.openArc.toggleSidebar()}>
          »
        </button>
      )}
    </div>
  )
}
