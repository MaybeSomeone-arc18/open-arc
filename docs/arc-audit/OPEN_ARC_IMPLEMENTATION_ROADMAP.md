# Open Arc Implementation Roadmap

A phased, dependency-ordered engineering plan for bridging verified Arc functionality into Open Arc.

---

## Milestone 1: Generalized Split View & Focus Architecture (Highest Value)

### Objectives
1. Eliminate binary `splitTabId: string | null` in favor of a flexible `SplitGroup` model.
2. Introduce explicit `focusedPaneId` tracking in main and renderer processes.
3. Route navigation, reload, URL copying, and keyboard shortcuts strictly to the focused pane.
4. Add Arc-equivalent native shortcuts: `Add Split View` (`Ctrl+Cmd+Option+=`) and `Close this Split Pane` (`Ctrl+Cmd+Option+-`).

### Acceptance Criteria
- [ ] User can create a split from any two tabs in the current Space.
- [ ] Clicking a pane sets `focusedPaneId` to that pane's tab ID.
- [ ] Pressing `Cmd + R` or `Cmd + [` dispatches only to the focused pane's `WebContentsView`.
- [ ] Pressing `Ctrl + Cmd + Option + -` closes only the focused pane; the sibling pane expands to 100% width.
- [ ] Closing a tab in a split does not close the other pane or crash the application.

### Regression Risks & Mitigations
- *Risk:* Breaking existing smoke tests expecting `splitTabId` in state serialization.
- *Mitigation:* Retain backward-compatible migration logic in `src/main/store.ts` that maps legacy `splitTabId` to a 2-pane `SplitGroup`.

---

## Milestone 2: Global Favorites Grid

### Objectives
1. Add `favorites: TabItem[]` to root `AppState` in `src/shared/types.ts`.
2. Implement top-level Favorites bar in `src/renderer/src/components/Sidebar.tsx` above the Space switcher.
3. Allow users to drag any tab into Favorites or right-click -> "Pin to Favorites".
4. Selecting a Favorite switches to that tab regardless of active Space.

---

## Milestone 3: Profile Partitions for Spaces

### Objectives
1. Add `profileId?: string` to `Space` model in `src/shared/types.ts`.
2. In `src/main/tabs.ts`, instantiate `WebContentsView` with `{ webPreferences: { partition: partitionForProfile(space.profileId) } }`.
3. Provide cookie, storage, and login isolation between distinct Spaces (e.g. Work vs. Personal).
4. Maintain default session compatibility for legacy state (Space index 0 / default session) and global favorites.
5. Dynamically attach fail-closed permission policies and safe download routing to newly configured session partitions.
6. Handle dynamic session reassignment when moving tabs between spaces without leaking cross-space session states.

### Acceptance Criteria
- [x] Newly created spaces receive isolated persistent partitions (`persist:space-<profileId>`).
- [x] Legacy default space and favorites use default session for backward compatibility.
- [x] Cookie and storage data between distinct Space partitions do not cross-pollinate.
- [x] Moving a tab between spaces tears down the old view and reconstructs it with the target space's partition.
- [x] Every session partition is secured with fail-closed permissions and safe collision-free downloads.
