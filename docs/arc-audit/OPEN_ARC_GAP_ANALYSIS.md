# Open Arc Gap Analysis & Source Validation

This document audits the current Open Arc codebase (`open-arc-alpha-check`) against the verified Arc specification.

---

## 1. Verified Source Audit

### 1.1 Split View Data Model
- **File:** [`src/shared/types.ts`](file:///Users/sanskarkharya/openarc/open-arc-alpha-check/src/shared/types.ts#L30-L32)
  ```typescript
  export interface Space {
    ...
    /** Tab currently focused inside this space. */
    activeTabId: string | null
    /** When set, this tab renders beside the active tab (2-pane split). */
    splitTabId: string | null
  }
  ```
- **Validated Gap:**
  - The model only supports a single optional companion tab (`splitTabId`).
  - It cannot represent vertical splits, 3- or 4-pane layouts, custom divider ratios, or independent focused pane identity.
  - Arc's model supports multi-pane directional additions (`AddRightSplitCodingKeys`, `AddTopSplitCodingKeys`, etc.).

### 1.2 Active Tab & Focused Pane Representation
- **File:** [`src/main/index.ts`](file:///Users/sanskarkharya/openarc/open-arc-alpha-check/src/main/index.ts#L2057-L2060)
  ```typescript
  ipcMain.on('nav', (_e, cmd: 'back' | 'forward' | 'reload') => {
    const active = this.activeTab()
    if (active) this.tabs.navigate(active.id, cmd)
  })
  ```
- **Validated Gap:**
  - IPC navigation commands (`back`, `forward`, `reload`) route exclusively to `activeTabId`.
  - There is no concept of a `focusedPaneId`. When a user interacts with the secondary pane (`splitTabId`), navigation actions still mistakenly dispatch to the primary tab (`activeTabId`).

### 1.3 WebContentsView Layout Math
- **File:** [`src/main/tabs.ts`](file:///Users/sanskarkharya/openarc/open-arc-alpha-check/src/main/tabs.ts#L73-L88)
  ```typescript
  private layout(): void {
    const [w, h] = this.win.getContentSize()
    const x = this.sidebarVisible ? SIDEBAR_WIDTH : 0
    const width = Math.max(0, w - x)
    ...
    const n = this.attachedIds.length || 1
    this.attachedIds.forEach((id, i) => {
      const view = this.views.get(id)
      if (!view) return
      const paneWidth = Math.floor(width / n)
      view.setBounds({ x: x + i * paneWidth, y: top, width: i === n - 1 ? width - i * paneWidth : paneWidth, height: Math.max(0, h - top - bottom) })
    })
  }
  ```
- **Validated Gap:**
  - Hardcoded to split horizontal panes with equal width (`Math.floor(width / n)`).
  - No draggable divider handle or custom proportion state is supported.

### 1.4 Global Favorites Collection
- **File:** [`src/shared/types.ts`](file:///Users/sanskarkharya/openarc/open-arc-alpha-check/src/shared/types.ts#L48-L60)
  - `AppState` lacks a global `favorites: TabItem[]` list.
  - Tabs can only be pinned per-space (`space.pinned`). Arc provides a distinct top-level `sidebarFavoritesCollectionView` visible across all Spaces.

### 1.5 Profile Isolation
- **File:** [`src/main/tabs.ts`](file:///Users/sanskarkharya/openarc/open-arc-alpha-check/src/main/tabs.ts#L94)
  ```typescript
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  ```
- **Validated Gap:**
  - All `WebContentsView` instances are instantiated without a custom `partition`.
  - All Spaces and tabs share a single default session; cookies, caches, and logins leak across Spaces. Arc partitions storage via `ADKModels.Profile` / `ArcBrowserContext`.
