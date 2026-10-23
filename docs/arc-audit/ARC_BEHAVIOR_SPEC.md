# Arc Behavioral Specification

This document details verified interaction workflows, state transitions, and edge cases in Arc 1.169.0.

---

## 1. Split View Workflows

### Scenario 1.1: Creating a Split View
- **Preconditions:** A single tab is active in the current Space.
- **Trigger Actions:**
  1. *Drag-and-Drop:* Drag an unpinned or pinned tab row from `sidebarAllTabList` onto the web content area. Arc renders `SplitDragPreviewView`, showing left/right or top/bottom drop targets. Dropping establishes the split.
  2. *Menu / Shortcut:* Press `Ctrl + Cmd + Option + =` (`Add Split View`). Arc mounts an empty split pane or presents the command bar to select/navigate a partner page.
  3. *Option-Click:* Holding Option while clicking an inactive tab in the sidebar opens it alongside the active tab.
- **Observed State Transitions:**
  - Content viewport bounds remain at `(x: 232.0, y: 43.0, w: 1228.0, h: 903.0)`.
  - The content area is divided equally by default with a central divider handle (`SplitViewControllerDefaultDraggerHandleView`).
  - The sidebar outline updates: the two individual tab rows combine into a composite item (`SidebarSpaceState+SplitView.swift`).
  - Top control bar dynamically mounts per-pane actions (`copyLinkButton`, `siteControlCenterButton`).

### Scenario 1.2: Switching Focus Between Split Panes
- **Trigger Action:** User clicks anywhere within pane B.
- **Observed State Transitions:**
  - Pane B receives keyboard and mouse focus.
  - The main window title (`AXTitle`) immediately updates to pane B's document title.
  - The URL placeholder (`commandBarPlaceholderTextField`) updates to pane B's URL.
  - Standard navigation commands (`Cmd + R` reload, `Cmd + [` back, `Cmd + ]` forward) dispatch strictly to pane B. Pane A remains undisturbed.

### Scenario 1.3: Closing a Split Pane
- **Trigger Actions:**
  1. Press `Ctrl + Cmd + Option + -` (`Close this Split Pane`).
  2. Or click the close button on the active pane's top header.
- **Observed State Transitions:**
  - The focused pane's `ArcWebContents` is destroyed.
  - The remaining pane expands to fill the full `1228 × 903 pt` content viewport.
  - In the sidebar, the composite split item dissolves; the surviving tab reverts to an ordinary standalone row.

### Scenario 1.4: Separating or Expanding a Pane
- **Separating:** Triggering `Separate Page from Split View` in the menu detaches the active pane from the split and places it as an independent tab in the sidebar without closing either page.
- **Expanding:** Triggering `Expand Current Split` temporarily hides the sibling pane and gives 100% width to the focused pane.

---

## 2. Spaces & Tab Lifecycle Workflows

### Scenario 2.1: Switching Spaces
- **Trigger Action:** User clicks a bottom dock icon (`SidebarDockItem-*`) or swipes horizontally.
- **Observed State Transitions:**
  - `SidebarPagingContainerViewController` scrolls to the selected Space page index.
  - The sidebar title (`sidebarSpaceName`) updates to the new Space name (`Work`, `Create`, or `Random`).
  - The outline view swaps to display the tabs of the newly focused Space.
  - The main web content area displays the last-active tab/split of that Space.
  - Background Spaces remain resident in memory.

### Scenario 2.2: Reopening a Closed Tab
- **Trigger Action:** Press `Cmd + Shift + T` (`Restore Last Closed Tab`).
- **Observed State Transitions:**
  - Arc pops the most recently closed tab from `ClosedSidebarItemsCache`.
  - The tab is re-inserted into the active Space's Today section.
  - The web content is restored and navigated to the cached URL.

---

## 3. Command Bar Workflows

### Scenario 3.1: Activating & Dismissing Command Bar
- **Trigger Action:** Press `Cmd + L` or `Cmd + T`.
- **Observed State Transitions:**
  - Arc overlays `CommandBarInstance` over the window content.
  - Focus moves from the web content to the command bar input field.
  - Typing executes fuzzy matching across open tabs, search history, and browser commands.
  - Pressing `Escape` dismisses the overlay and returns focus directly to the active web pane.
