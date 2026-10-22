import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { CommandBar } from './components/CommandBar'
import { FindBar } from './components/FindBar'

export function App(): JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [commandBarOpen, setCommandBarOpen] = useState(false)
  const [findBarOpen, setFindBarOpen] = useState(false)
  const [loadingTabs, setLoadingTabs] = useState<Set<string>>(new Set())
  const [downloadToast, setDownloadToast] = useState<string | null>(null)
  const [zoomToast, setZoomToast] = useState<string | null>(null)

  useEffect(() => {
    window.openArc.getState().then(setState)
    const off = window.openArc.onStateChanged(setState)
    let toastTimer: ReturnType<typeof setTimeout> | null = null
    let zoomTimer: ReturnType<typeof setTimeout> | null = null
    const applyZoom = (action: 'in' | 'out' | 'reset'): void => {
      window.openArc.zoom(action).then((factor) => {
        setZoomToast(`Zoom ${Math.round(factor * 100)}%`)
        if (zoomTimer) clearTimeout(zoomTimer)
        zoomTimer = setTimeout(() => setZoomToast(null), 1500)
      })
    }
    const offDownload = window.openArc.onDownloadDone((info) => {
      setDownloadToast(
        info.state === 'completed' ? `Downloaded ${info.filename}` : `Download ${info.state}: ${info.filename}`
      )
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => setDownloadToast(null), 6000)
    })
    const offLoading = window.openArc.onTabLoading((tabId, loading) => {
      setLoadingTabs((prev) => {
        const next = new Set(prev)
        if (loading) next.add(tabId)
        else next.delete(tabId)
        return next
      })
    })
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        window.openArc.runCommand('reopen-closed-tab')
      } else if (mod && e.key.toLowerCase() === 't') {
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
      if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        window.openArc.runCommand('hard-reload')
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'r') {
        // Reload the active TAB, never the shell (default menu is removed).
        e.preventDefault()
        window.openArc.runCommand('reload')
      }
      if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        setCommandBarOpen(true)
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindBarOpen(true)
      }
      if (mod && !e.shiftKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        applyZoom('in')
      }
      if (mod && !e.shiftKey && e.key === '-') {
        e.preventDefault()
        applyZoom('out')
      }
      if (mod && !e.shiftKey && e.key === '0') {
        e.preventDefault()
        applyZoom('reset')
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        window.openArc.toggleMute().then((muted) => {
          setZoomToast(muted ? 'Tab muted' : 'Tab unmuted')
          setTimeout(() => setZoomToast(null), 1500)
        })
      }
      if (e.key === 'F12' || (mod && e.shiftKey && e.key.toLowerCase() === 'i')) {
        e.preventDefault()
        window.openArc.toggleDevTools()
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        window.openArc.runCommand('duplicate-tab')
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        window.openArc.copyActiveUrl().then((url) => {
          if (!url) return
          setZoomToast('Copied URL')
          setTimeout(() => setZoomToast(null), 1500)
        })
      }
      if (mod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        window.openArc.runCommand('goto-tab', e.key)
      }
      if (mod && e.key === 'Tab') {
        e.preventDefault()
        window.openArc.runCommand(e.shiftKey ? 'prev-tab' : 'next-tab')
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        window.openArc.runCommand('go-back')
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        window.openArc.runCommand('go-forward')
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
      if (e.key === 'Escape') { setCommandBarOpen(false); setFindBarOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      offLoading()
      offDownload()
      if (toastTimer) clearTimeout(toastTimer)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const closeCommandBar = useCallback(() => setCommandBarOpen(false), [])

  if (!state) return <div className="boot">Loading…</div>
  const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]

  return (
    <div className="app" style={{ ['--space-color' as string]: space.color }}>
      {state.sidebarVisible && <Sidebar state={state} space={space} loadingTabs={loadingTabs} onOpenCommandBar={() => setCommandBarOpen(true)} />}
      {commandBarOpen && <CommandBar state={state} onClose={closeCommandBar} />}
      {findBarOpen && <FindBar onClose={() => setFindBarOpen(false)} />}
      {downloadToast && <div className="download-toast">{downloadToast}</div>}
      {zoomToast && <div className="download-toast">{zoomToast}</div>}
      {!state.sidebarVisible && (
        <button className="sidebar-reopen" title="Show sidebar (Ctrl+S)" onClick={() => window.openArc.toggleSidebar()}>
          »
        </button>
      )}
    </div>
  )
}
