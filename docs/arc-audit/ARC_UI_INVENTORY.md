# Arc UI Inventory & Accessibility Hierarchy

Verified against live runtime window: `bigBrowserWindow-76A7D544-FE2C-48C8-84D9-1856D7FC4EB1` (PID: `1633`).

---

## 1. Window Element Inventory

| Element Index | AX Role | AX Identifier / Description | Bounding Rect (x, y, w, h) | Function / Notes |
| :--- | :--- | :--- | :--- | :--- |
| **0** | `AXButton` | *(Traffic light / Window control)* | (13.0, 40.5, 32.0, 32.0) | Top window control / back affordance. |
| **1** | `AXButton` | `desc: "Hide sidebar"` | (126.0, 40.5, 32.0, 32.0) | Toggles sidebar visibility (`Cmd + S`). |
| **2** | `AXButton` | `desc: "Go back"` | (160.0, 40.5, 32.0, 32.0) | Back history navigation (`Cmd + [`). |
| **3** | `AXButton` | `desc: "Go forward"` | (194.0, 40.5, 32.0, 32.0) | Forward history navigation (`Cmd + ]`). |
| **4** | `AXStaticText` | `id: commandBarPlaceholderTextField` | (20.0, 88.0, 200.0, 18.0) | Resting URL placeholder; triggers Command Bar on click. |
| **5 (Dynamic)**| `AXButton` | `id: copyLinkButton` | (162.0, 82.0, 30.0, 30.0) | Copies active URL to clipboard (surfaces during splits/links). |
| **6 (Dynamic)**| `AXButton` | `id: siteControlCenterButton` | (190.0, 82.0, 30.0, 30.0) | Site security, certificates, and permissions dropdown. |
| **7** | `AXScrollArea` | *(Sidebar Main Container)* | (0.0, 115.0, 232.0, 751.0) | Contains Favorites collection and tab outlines. |
| **8** | `AXList` | `id: sidebarFavoritesCollectionView` | (0.0, 115.0, 232.0, 80.0) | Global favorites grid tiles. |
| **9** | `AXStaticText` | `id: sidebarSpaceName` | (42.0, 242.0, 174.0, 18.0) | Name of the active Space (`Work`, `Create`, `Random`). |
| **10** | `AXButton` | `id: sidebarSpaceEditButton` | (190.0, 238.0, 26.0, 26.0) | Space settings and color theme customization. |
| **11** | `AXOutline` | `id: sidebarAllTabList` | (0.0, 269.0, 232.0, 597.0) | Tab list outline for the Space (Pinned + Today). |
| **12** | `AXButton` | `id: sidebarPlusButton` | (192.0, 915.0, 32.0, 32.0) | New Tab / Add action shortcut at bottom of sidebar. |
| **13** | `AXScrollArea` | *(Spaces Pager Dock)* | (42.0, 906.0, 148.0, 50.0) | Horizontal dock holding `SidebarDockItem-*` buttons. |
| **14** | `AXSplitGroup` | *(Content Region)* | (232.0, 43.0, 1228.0, 903.0) | Hosts active web viewports (1..4 panes). |

---

## 2. Dynamic Toolbar States

- **Single Pane Mode:** Displays 4 primary buttons (`Hide sidebar`, `Go back`, `Go forward`, `Reload this page`) alongside `commandBarPlaceholderTextField`.
- **Split View Mode:** Expands to include `copyLinkButton` and `siteControlCenterButton` for the focused pane, allowing quick URL operations without obscuring the active page.
