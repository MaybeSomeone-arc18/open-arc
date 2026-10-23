import type { TabItem } from '../../../shared/types'

interface Props {
  tab: TabItem
  active: boolean
  focused?: boolean
  loading?: boolean
}

export function TabRow({ tab, active, focused, loading }: Props): JSX.Element {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.altKey) {
      e.preventDefault()
      window.openArc.splitTabWith(tab.id)
    } else {
      window.openArc.switchTab(tab.id)
    }
  }

  return (
    <div
      className={`tab-row ${active ? 'active' : ''} ${focused ? 'focused' : ''}`}
      onClick={handleClick}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          window.openArc.closeTab(tab.id)
        }
      }}
      title={tab.url}
    >
      {loading ? (
        <span className="favicon loading" title="Loading">⟳</span>
      ) : tab.favicon ? (
        <img className="favicon" src={tab.favicon} alt="" />
      ) : (
        <span className="favicon fallback">◦</span>
      )}
      <span className="tab-title">{tab.title || tab.url}</span>
      <span className="tab-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="row-btn"
          aria-label={tab.pinned ? 'Unpin tab' : 'Pin tab'}
          title={tab.pinned ? 'Unpin' : 'Pin'}
          onClick={() => (tab.pinned ? window.openArc.unpinTab(tab.id) : window.openArc.pinTab(tab.id))}
        >
          {tab.pinned ? '⊖' : '📌'}
        </button>
        <button
          className="row-btn"
          aria-label="Favorite tab"
          title="Favorite"
          onClick={() => window.openArc.toggleFavorite(tab.id)}
        >
          ★
        </button>
        <button className="row-btn" aria-label="Close tab" title="Close" onClick={() => window.openArc.closeTab(tab.id)}>×</button>
      </span>
    </div>
  )
}
