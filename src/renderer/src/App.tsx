import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '../../shared/types'
import { matchShortcut, type ShortcutAction } from '../../shared/shortcuts'
import { Sidebar } from './components/Sidebar'
import { CommandBar } from './components/CommandBar'
import { FindBar } from './components/FindBar'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'

export function App(): JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [commandBarOpen, setCommandBarOpen] = useState(false)
  const [findBarOpen, setFindBarOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
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
    // One dispatch for both key paths: shell-focused keys arrive via the
    // window keydown listener below; page-focused keys are matched in main
    // (before-input-event on the tab's WebContentsView) and arrive via IPC.
    const runShortcut = (action: ShortcutAction, arg?: string): void => {
      if (action === 'reopen-closed-tab') window.openArc.runCommand('reopen-closed-tab')
      if (action === 'toggle-command-bar') { setCommandBarOpen((v) => !v); focusAfterToggle('.command-bar') }
      if (action === 'open-command-bar') { setCommandBarOpen(true); window.openArc.focusShell() }
      if (action === 'open-find-bar') { setFindBarOpen(true); window.openArc.focusShell() }
      if (action === 'toggle-shortcuts') { setShortcutsOpen((v) => !v); focusAfterToggle('.shortcuts-overlay') }
      if (action === 'toggle-sidebar') window.openArc.toggleSidebar()
      if (action === 'close-tab') window.openArc.runCommand('close-tab')
      if (action === 'hard-reload') window.openArc.runCommand('hard-reload')
      if (action === 'reload') {
        // Reload the active TAB, never the shell (default menu is removed).
        window.openArc.runCommand('reload')
      }
      if (action === 'zoom-in') applyZoom('in')
      if (action === 'zoom-out') applyZoom('out')
      if (action === 'zoom-reset') applyZoom('reset')
      if (action === 'toggle-mute') {
        window.openArc.toggleMute().then((muted) => {
          setZoomToast(muted ? 'Tab muted' : 'Tab unmuted')
          setTimeout(() => setZoomToast(null), 1500)
        })
      }
      if (action === 'view-source') window.openArc.runCommand('view-source')
      if (action === 'print-pdf') {
        window.openArc.printToPdf().then((path) => {
          setZoomToast(path ? `Saved PDF: ${path.split('/').pop()}` : 'PDF export failed')
          setTimeout(() => setZoomToast(null), 2500)
        })
      }
      if (action === 'reader-toggle') {
        window.openArc.toggleReader().then((res) => {
          setZoomToast(res === 'on' ? 'Reader mode on' : res === 'off' ? 'Reader mode off' : 'No readable article found')
          setTimeout(() => setZoomToast(null), 1500)
        })
      }
      if (action === 'devtools') window.openArc.toggleDevTools()
      if (action === 'duplicate-tab') window.openArc.runCommand('duplicate-tab')
      if (action === 'copy-url') {
        window.openArc.copyActiveUrl().then((url) => {
          if (!url) return
          setZoomToast('Copied URL')
          setTimeout(() => setZoomToast(null), 1500)
        })
      }
      if (action === 'goto-tab' && arg) window.openArc.runCommand('goto-tab', arg)
      if (action === 'next-tab') window.openArc.runCommand('next-tab')
      if (action === 'prev-tab') window.openArc.runCommand('prev-tab')
      if (action === 'go-back') window.openArc.runCommand('go-back')
      if (action === 'go-forward') window.openArc.runCommand('go-forward')
      if (action === 'pin-tab') window.openArc.runCommand('pin-tab')
      if (action === 'split-view') window.openArc.runCommand('split-view')
      if (action === 'close-split') window.openArc.runCommand('close-split')
    }
    const focusAfterToggle = (selector: string): void => {
      setTimeout(() => {
        if (document.querySelector(selector)) window.openArc.focusShell()
        else window.openArc.focusPage()
      }, 50)
    }
    const offShortcut = window.openArc.onShortcut((action, arg) => runShortcut(action, arg))
    const onKey = (e: KeyboardEvent): void => {
      // Escape stays shell-local: pages own it when a page has focus.
      if (e.key === 'Escape') {
        setCommandBarOpen(false); setFindBarOpen(false); setShortcutsOpen(false)
        window.openArc.focusPage()
        return
      }
      const m = matchShortcut({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey })
      if (!m) return
      e.preventDefault()
      runShortcut(m.id, m.arg)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      offLoading()
      offDownload()
      offShortcut()
      if (toastTimer) clearTimeout(toastTimer)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Keep main informed so tab views never cover shell overlays: modals hide
  // the page views, the find bar reserves a top strip and keeps pages visible.
  useEffect(() => {
    window.openArc.setOverlayState(commandBarOpen || shortcutsOpen, findBarOpen)
  }, [commandBarOpen, shortcutsOpen, findBarOpen])

  const closeCommandBar = useCallback(() => {
    setCommandBarOpen(false)
    window.openArc.focusPage()
  }, [])

  if (!state) return <div className="boot">Loading…</div>
  const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]

  return (
    <div className="app" style={{ ['--space-color' as string]: space.color }}>
      {state.sidebarVisible && <Sidebar state={state} space={space} loadingTabs={loadingTabs} onOpenCommandBar={() => setCommandBarOpen(true)} />}
      {commandBarOpen && <CommandBar state={state} onClose={closeCommandBar} />}
      {findBarOpen && <FindBar onClose={() => { setFindBarOpen(false); window.openArc.focusPage() }} />}
      {shortcutsOpen && <ShortcutsOverlay onClose={() => { setShortcutsOpen(false); window.openArc.focusPage() }} />}
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
