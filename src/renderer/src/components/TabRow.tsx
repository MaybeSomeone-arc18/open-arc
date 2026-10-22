import type { TabItem } from '../../../shared/types'

interface Props {
  tab: TabItem
  active: boolean
}

export function TabRow({ tab, active }: Props): JSX.Element {
  return (
    <div
      className={`tab-row ${active ? 'active' : ''}`}
      onClick={() => window.openArc.switchTab(tab.id)}
      title={tab.url}
    >
      {tab.favicon ? <img className="favicon" src={tab.favicon} alt="" /> : <span className="favicon fallback">◦</span>}
      <span className="tab-title">{tab.title || tab.url}</span>
      <span className="tab-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="row-btn"
          title={tab.pinned ? 'Unpin' : 'Pin'}
          onClick={() => (tab.pinned ? window.openArc.unpinTab(tab.id) : window.openArc.pinTab(tab.id))}
        >
          {tab.pinned ? '⊖' : '📌'}
        </button>
        <button className="row-btn" title="Close" onClick={() => window.openArc.closeTab(tab.id)}>×</button>
      </span>
    </div>
  )
}
