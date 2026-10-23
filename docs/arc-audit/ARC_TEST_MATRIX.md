# Arc Behavioral Test Matrix

Standardized, reproducible verification scenarios for validating Arc-equivalent browser behaviors.

---

## Test Suite 1: Split View System

### TC-SPLIT-01: Split Creation via Native Shortcut
- **Preconditions:** Arc running, single tab open (`https://example.com/`).
- **Action:** Press `Ctrl + Cmd + Option + =`.
- **Expected Result:** Content area splits into two equal horizontal panes. Command Bar opens or new pane navigates to default blank page.
- **Verification:** Native menu item `Add Split View` triggers action; window content area partitions at 50% width.

### TC-SPLIT-02: Pane Focus Switch & Title Synchronization
- **Preconditions:** Dual-pane split active (`Pane A` = Page A, `Pane B` = Page B). `Pane A` is focused.
- **Action:** Click inside `Pane B`.
- **Expected Result:**
  - Window title (`kAXTitleAttribute`) updates from Page A title to Page B title.
  - URL placeholder reflects Page B address.
  - Pressing `Cmd + R` reloads Page B; Page A does not reload.
- **Verification:** Observed in Arc 1.169.0 (Window title switched from `"Enhance Open Arc Prompt"` to `"Sanskar Kharya (@MaybeSansk) / X"`).

### TC-SPLIT-03: Close Focused Pane
- **Preconditions:** Dual-pane split active (`Pane A` and `Pane B`). `Pane B` is focused.
- **Action:** Press `Ctrl + Cmd + Option + -` (`Close this Split Pane`).
- **Expected Result:**
  - `Pane B` is destroyed.
  - `Pane A` expands to occupy 100% of the content viewport (`1228 × 903 pt`).
  - Sidebar split composite item dissolves into a single tab row.

---

## Test Suite 2: Spaces & Tab Navigation

### TC-SPACE-01: Space Paging with Active Content Retention
- **Preconditions:** Three Spaces configured (`Work`, `Create`, `Random`). `Create` is active.
- **Action:** Click `SidebarDockItem-Work` in the bottom dock.
- **Expected Result:**
  - Sidebar horizontal pager transitions to `Work`.
  - Active tab of `Work` mounts into the content viewport.
  - Returning to `Create` restores its previously active tab/split without re-initializing the sidebar outline.

### TC-TAB-01: Restore Last Closed Tab
- **Preconditions:** User closes a tab via `Cmd + W`.
- **Action:** Press `Cmd + Shift + T`.
- **Expected Result:** The closed tab reappears in the active Space's Today list and navigates to its prior URL.
