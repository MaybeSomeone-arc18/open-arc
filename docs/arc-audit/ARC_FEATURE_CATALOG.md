# Arc Feature Catalog

**Application:** Arc Browser 1.169.0 (Build 88758)  
**Target Platform:** macOS 13.0+ (Universal Mach-O)

---

## 1. Window & Application Lifecycle
- **Single Window Shell:** A unified frameless `NSWindow` (`bigBrowserWindow-*`) housing a 232 pt fixed sidebar and an adjacent web content region.
- **Auxiliary Windows:**
  - *Blank Window (`Cmd + Option + N`):* Opens a standalone browser window without the persistent sidebar or spaces.
  - *Little Arc (`Cmd + Shift + N`):* Lightweight popup window for previewing external links without adding them to active spaces.
- **Traffic Light Offsets:** Integrated directly into the sidebar header, aligned with `Hide sidebar` button.

## 2. Navigation & Browser Engine
- **Chromium Content API Embedding:** Powered by `ArcCore.framework` (495 MB). Does not use Electron or Safari's `WKWebView`.
- **Multi-Process Model:** Uses out-of-process helper binaries (`Browser Helper (Renderer).app`, `Browser Helper.app` for audio/utility).
- **Navigation Controllers:** Each tab embeds an `ArcWebContents` wrapping an independent Chromium `WebContents` instance with dedicated `ArcBackForwardList`.

## 3. Tab Hierarchy & Spaces
- **Three-Tier Tab Organization:**
  1. *Global Favorites:* Stored in top `sidebarFavoritesCollectionView`. Pinned permanently across all Spaces.
  2. *Space-Pinned Tabs:* Stored in upper outline of `sidebarAllTabList`. Persistent across app reboots; exempt from auto-archive.
  3. *Today / Unpinned Tabs:* Stored below the separator line in `sidebarAllTabList`. Ephemeral session tabs.
- **Spaces System:**
  - User-configurable workspaces (`Work`, `Create`, `Random`).
  - Switched via horizontal paging (`SidebarPagingContainerCollectionViewLayout`) or bottom dock icons (`SidebarDockItem-*`).
  - Outline hierarchies for background spaces remain resident in memory.

## 4. Split View System
- **Supported Layouts:** Horizontal side-by-side splits and vertical top-and-bottom splits (`ConvertToHorizontalSplitViewCodingKeys`, `ConvertToVerticalSplitViewCodingKeys`).
- **Pane Ingress / Egress:**
  - Dragging a tab from the sidebar to the content area triggers `SplitDragPreviewView`.
  - Native hotkey `Ctrl + Cmd + Option + =` (`Add Split View`) creates a new split.
  - Native hotkey `Ctrl + Cmd + Option + -` (`Close this Split Pane`) closes the active pane and expands the remaining pane.
  - Dedicated menu actions: `Separate Page from Split View` and `Expand Current Split`.
- **Focus Routing:**
  - Window title tracks the focused pane's page title.
  - Toolbar controls mount dynamic buttons (`copyLinkButton`, `siteControlCenterButton`) bound to the active pane.

## 5. Command Bar & Shortcuts
- **Floating Command Overlay:** Rested state is `commandBarPlaceholderTextField` (200 × 18 pt). Activated via `Cmd + L` (`Open Command Bar`) or `Cmd + T` (`New Tab…`).
- **Core Shortcuts:**
  - `Cmd + T`: New Tab
  - `Cmd + L`: Open Command Bar / Edit URL
  - `Cmd + S`: Hide / Show Sidebar
  - `Cmd + Shift + T`: Restore Last Closed Tab
  - `Cmd + Shift + D`: Show / Hide Toolbar
  - `Ctrl + Cmd + Option + =`: Add Split View
  - `Ctrl + Cmd + Option + -`: Close Focused Split Pane
  - `Cmd + E`: New Easel
  - `Cmd + Option + N`: Blank Window
  - `Cmd + Shift + N`: Little Arc Window
