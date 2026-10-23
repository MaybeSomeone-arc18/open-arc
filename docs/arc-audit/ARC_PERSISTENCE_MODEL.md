# Arc Persistence & State Model

This document specifies entity scopes, persistence boundaries, and recovery behaviors.

---

## 1. Entity Hierarchy & Scopes

```
Global Scope (Application / User)
├── Profiles (ADKModels.Profile / ArcBrowserContext)
│   ├── Cookies & Cache Partition
│   ├── Extension Instances
│   ├── Site Permissions
│   └── Autofill & Login Credentials
├── Global Favorites (sidebarFavoritesCollectionView)
└── Spaces (Workspaces)
    ├── Space Metadata (ID, Title, Theme, Icon, ProfileID)
    ├── Pinned Tabs (sidebarAllTabList: upper section)
    ├── Today / Unpinned Tabs (sidebarAllTabList: lower section)
    └── Active Layout State
        ├── Single: TabID
        └── Split: SplitGroup (Orientation, PaneIDs, Ratios, FocusedPaneID)
```

---

## 2. Persistence Scopes

1. **Persistent Across App Restarts:**
   - Window frames and layout constraints (`WindowState+WindowLayout.swift`).
   - Profile definitions and credential stores.
   - Space definitions (names, colors, icons, profile bindings).
   - Global Favorites and Space-Pinned tabs.
   - Pinned Split Groups (serialized as compound entities).
2. **Session-Ephemeral (Subject to Auto-Archive):**
   - Unpinned Today tabs (`TabCellState.swift`).
   - Closed tabs history (`ClosedSidebarItemsCacheProvider`, purged according to LRU/capacity rules).
3. **Transient Runtime State (Not Persisted):**
   - In-flight network requests and loading progress.
   - Active Command Bar search query and autocomplete popup.
   - Page zoom overrides (re-applied dynamically on page finish).

---

## 3. Lifecycle Transitions

- **Close vs. Archive:**
  - *Closing a tab (`Cmd + W`):* Removes tab from the active outline; caches its metadata in `ClosedSidebarItemsCache` for `Cmd + Shift + T` restoration.
  - *Archiving a tab:* Triggered by user action or idle timer (`AutoArchiveEducationAction`). Tab is removed from the active Space list and serialized into the Archive library.
- **Split Closure Transitions:**
  - Closing a pane in a split destroys only that pane's `WebContents` and unlinks it from the parent split group; the surviving sibling pane is promoted to an independent tab.
