import { useState } from 'react'
import type { AppState, Space, TabItem } from '../../../shared/types'
import { TabRow } from './TabRow'

interface Props {
  state: AppState
  space: Space
  loadingTabs: Set<string>
  onOpenCommandBar: () => void
}

export function Sidebar({ state, space, loadingTabs, onOpenCommandBar }: Props): JSX.Element {
  const [urlDraft, setUrlDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [showAllArchived, setShowAllArchived] = useState(false)
  const [addingSpace, setAddingSpace] = useState(false)
  const [spaceDraft, setSpaceDraft] = useState('')
  const [armingDelete, setArmingDelete] = useState(false)
  const [nameDraft, setNameDraft] = useState(space.name)

  const submitUrl = (): void => {
    const v = urlDraft.trim()
    if (!v) return
    // PoC clarity: URL bar always opens a fresh tab (Arc replaces in place).
    window.openArc.openTab(v)
    setUrlDraft('')
  }

  const submitRename = (): void => {
    if (nameDraft.trim()) window.openArc.renameSpace(space.id, nameDraft.trim())
    setRenaming(false)
  }

  return (
    <aside className="sidebar">
      <div className="drag-strip" onDoubleClick={() => window.openArc.windowControl('maximize')} />
      <div className="window-controls">
        <button className="wc close" title="Close" onClick={() => window.openArc.windowControl('close')} />
        <button className="wc minimize" title="Minimize" onClick={() => window.openArc.windowControl('minimize')} />
        <button
          className="wc maximize"
          title={/Mac/.test(navigator.userAgent) ? 'Full screen' : 'Maximize'}
          onClick={() => window.openArc.windowControl('fullscreen')}
        />
      </div>

      <div className="url-row">
        <button className="nav-btn" title="Back" onClick={() => window.openArc.navigate('back')}>←</button>
        <button className="nav-btn" title="Forward" onClick={() => window.openArc.navigate('forward')}>→</button>
        <button className="nav-btn" title="Reload" onClick={() => window.openArc.navigate('reload')}>⟳</button>
        <input
          className="url-input"
          placeholder="Search or enter URL"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
          onFocus={(e) => e.target.select()}
        />
      </div>

      {state.favorites && state.favorites.length > 0 && (
        <div className="favorites-container">
          <div className="favorites-grid">
            {state.favorites.map((fav) => {
              const isActive = fav.id === space.activeTabId || fav.id === space.splitTabId
              const isFocused = space.splitTabId
                ? (space.focusedTabId ? fav.id === space.focusedTabId : fav.id === space.activeTabId)
                : fav.id === space.activeTabId
              return (
                <div
                  key={fav.id}
                  className={`favorite-tile ${isActive ? 'active' : ''} ${isFocused ? 'focused' : ''}`}
                  title={`${fav.title || fav.url}\n(Alt+click to split, right-click/action to unfavorite)`}
                  onClick={(e) => {
                    if (e.altKey) {
                      e.preventDefault()
                      window.openArc.splitTabWith(fav.id)
                    } else {
                      window.openArc.switchTab(fav.id)
                    }
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      e.stopPropagation()
                      window.openArc.closeTab(fav.id)
                    }
                  }}
                >
                  {loadingTabs.has(fav.id) ? (
                    <span className="favicon loading" title="Loading">⟳</span>
                  ) : fav.favicon ? (
                    <img className="favicon" src={fav.favicon} alt="" />
                  ) : (
                    <span className="favicon fallback">◦</span>
                  )}
                  <span className="favorite-title">{fav.title || fav.url}</span>
                  <button
                    className="favorite-remove"
                    title="Unfavorite"
                    onClick={(e) => {
                      e.stopPropagation()
                      window.openArc.toggleFavorite(fav.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="space-header" onDoubleClick={() => { setNameDraft(space.name); setRenaming(true) }}>
        {renaming ? (
          <input
            className="space-rename"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => e.key === 'Enter' && submitRename()}
          />
        ) : (
          <span className="space-title">{space.name}</span>
        )}
        {state.spaces.length > 1 && (
          <button
            className={`ghost-btn ${armingDelete ? 'danger' : ''}`}
            title={armingDelete ? `Click again to delete "${space.name}" and its tabs` : 'Delete this Space'}
            onClick={() => {
              if (armingDelete) {
                window.openArc.runCommand('delete-space')
                setArmingDelete(false)
              } else {
                setArmingDelete(true)
                setTimeout(() => setArmingDelete(false), 3000)
              }
            }}
          >
            ×
          </button>
        )}
        <button className="ghost-btn" title="Hide sidebar (Ctrl+S)" onClick={() => window.openArc.toggleSidebar()}>«</button>
      </div>

      <div className="tab-scroll">
        <div className="section-label">Pinned</div>
        {space.pinned.length === 0 && <div className="empty-hint">Pin tabs to keep them here</div>}
        {space.pinned.map((tab) => {
          const isSplitPartner = tab.id === space.splitTabId
          const isActive = tab.id === space.activeTabId || isSplitPartner
          const isFocused = space.splitTabId ? (space.focusedTabId ? tab.id === space.focusedTabId : tab.id === space.activeTabId) : tab.id === space.activeTabId
          return (
            <TabRow key={tab.id} tab={tab} active={isActive} focused={isFocused} loading={loadingTabs.has(tab.id)} />
          )
        })}

        <div className="section-label with-action">
          <span>Today</span>
          <span>
            <button className="ghost-btn" title="Split view (Ctrl+Shift+=)" onClick={() => window.openArc.runCommand('split-view')}>▦</button>
            <button className="ghost-btn" title="New tab (Ctrl+T)" onClick={onOpenCommandBar}>＋</button>
          </span>
        </div>
        {space.today.length === 0 && <div className="empty-hint">Open tabs appear here</div>}
        {space.today.map((tab) => {
          const isSplitPartner = tab.id === space.splitTabId
          const isActive = tab.id === space.activeTabId || isSplitPartner
          const isFocused = space.splitTabId ? (space.focusedTabId ? tab.id === space.focusedTabId : tab.id === space.activeTabId) : tab.id === space.activeTabId
          return (
            <TabRow key={tab.id} tab={tab} active={isActive} focused={isFocused} loading={loadingTabs.has(tab.id)} />
          )
        })}

        {space.archived.length > 0 && (
          <>
            <div className="section-label">Archived</div>
            {(showAllArchived ? space.archived : space.archived.slice(0, 5)).map((tab) => (
              <div key={tab.id} className="tab-row archived" title={`${tab.url} (click to restore)`} onClick={() => window.openArc.restoreTab(tab.id)}>
                {tab.favicon ? <img className="favicon" src={tab.favicon} alt="" /> : <span className="favicon fallback">◦</span>}
                <span className="tab-title">{tab.title || tab.url}</span>
                <span className="tab-actions" style={{ display: 'flex' }} onClick={(e) => e.stopPropagation()}>
                  <button className="row-btn" title="Delete forever" onClick={() => window.openArc.closeTab(tab.id)}>×</button>
                </span>
              </div>
            ))}
            {space.archived.length > 5 && (
              <div className="empty-hint clickable" onClick={() => setShowAllArchived((v) => !v)}>
                {showAllArchived ? 'Show less' : `+${space.archived.length - 5} more (click to expand)`}
              </div>
            )}
          </>
        )}
      </div>

      <div className="spaces-bar">
        {state.spaces.map((s) => (
          <button
            key={s.id}
            className={`space-dot ${s.id === state.activeSpaceId ? 'current' : ''}`}
            style={{ background: s.color }}
            title={s.name}
            onClick={() => window.openArc.switchSpace(s.id)}
          >
            {s.icon}
          </button>
        ))}
        {addingSpace ? (
          <input
            className="space-dot-input"
            autoFocus
            placeholder="Space name"
            value={spaceDraft}
            onChange={(e) => setSpaceDraft(e.target.value)}
            onBlur={() => { setAddingSpace(false); setSpaceDraft('') }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && spaceDraft.trim()) {
                window.openArc.createSpace(spaceDraft.trim())
                setSpaceDraft('')
                setAddingSpace(false)
              }
              if (e.key === 'Escape') { setAddingSpace(false); setSpaceDraft('') }
            }}
          />
        ) : (
          <button className="space-dot add" title="New Space" onClick={() => setAddingSpace(true)}>
            ＋
          </button>
        )}
      </div>
    </aside>
  )
}

export type { TabItem }
