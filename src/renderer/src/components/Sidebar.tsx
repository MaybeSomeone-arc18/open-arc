import { useState } from 'react'
import type { AppState, Space, TabItem } from '../../../shared/types'
import { TabRow } from './TabRow'

interface Props {
  state: AppState
  space: Space
  onOpenCommandBar: () => void
}

export function Sidebar({ state, space, onOpenCommandBar }: Props): JSX.Element {
  const [urlDraft, setUrlDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(space.name)

  const activeTab = [...space.pinned, ...space.today].find((t) => t.id === space.activeTabId) ?? null

  const submitUrl = (): void => {
    const v = urlDraft.trim()
    if (!v) return
    if (activeTab) {
      // Navigate the current tab by closing over it? Arc replaces; we open fresh for PoC clarity.
      window.openArc.openTab(v)
    } else {
      window.openArc.openTab(v)
    }
    setUrlDraft('')
  }

  const submitRename = (): void => {
    if (nameDraft.trim()) window.openArc.renameSpace(space.id, nameDraft.trim())
    setRenaming(false)
  }

  return (
    <aside className="sidebar">
      <div className="drag-strip" />
      <div className="window-controls">
        <button className="wc close" title="Close" onClick={() => window.openArc.windowControl('close')} />
        <button className="wc minimize" title="Minimize" onClick={() => window.openArc.windowControl('minimize')} />
        <button className="wc maximize" title="Maximize" onClick={() => window.openArc.windowControl('maximize')} />
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
        <button className="ghost-btn" title="Hide sidebar (Ctrl+S)" onClick={() => window.openArc.toggleSidebar()}>«</button>
      </div>

      <div className="tab-scroll">
        <div className="section-label">Pinned</div>
        {space.pinned.length === 0 && <div className="empty-hint">Pin tabs to keep them here</div>}
        {space.pinned.map((tab) => (
          <TabRow key={tab.id} tab={tab} active={tab.id === space.activeTabId} />
        ))}

        <div className="section-label with-action">
          <span>Today</span>
          <span>
            <button className="ghost-btn" title="Split view (Ctrl+Shift+=)" onClick={() => window.openArc.runCommand('split-view')}>◫</button>
            <button className="ghost-btn" title="New tab (Ctrl+T)" onClick={onOpenCommandBar}>＋</button>
          </span>
        </div>
        {space.today.length === 0 && <div className="empty-hint">Open tabs appear here</div>}
        {space.today.map((tab) => (
          <TabRow key={tab.id} tab={tab} active={tab.id === space.activeTabId || tab.id === space.splitTabId} />
        ))}

        {space.archived.length > 0 && (
          <>
            <div className="section-label">Archived</div>
            {space.archived.slice(0, 5).map((tab) => (
              <div key={tab.id} className="tab-row archived" title={`${tab.url} (click to restore)`} onClick={() => window.openArc.restoreTab(tab.id)}>
                {tab.favicon ? <img className="favicon" src={tab.favicon} alt="" /> : <span className="favicon fallback">◦</span>}
                <span className="tab-title">{tab.title || tab.url}</span>
                <span className="tab-actions" style={{ display: 'flex' }} onClick={(e) => e.stopPropagation()}>
                  <button className="row-btn" title="Delete forever" onClick={() => window.openArc.closeTab(tab.id)}>×</button>
                </span>
              </div>
            ))}
            {space.archived.length > 5 && <div className="empty-hint">+{space.archived.length - 5} more</div>}
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
        <button
          className="space-dot add"
          title="New Space"
          onClick={() => {
            const name = window.prompt('Name this Space')
            if (name) window.openArc.createSpace(name)
          }}
        >
          ＋
        </button>
      </div>
    </aside>
  )
}

export type { TabItem }
