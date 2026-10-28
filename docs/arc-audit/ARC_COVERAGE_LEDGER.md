# Arc Feature Coverage Ledger

Target: **Arc Browser 1.169.0 (Build 88758)**  
Evidence Ratings: **E1 (Runtime Observed)**, **E2 (Static Artifact)**, **E3 (Strong Inference)**, **E4 (Hypothesis)**, **E5 (Unknown/Blocked)**

---

## 1. Feature Coverage Status Table

| Category | Subfeature | Evidence Level | Status | Evidence Reference | Notes / Limitations |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Window Lifecycle** | Single frameless window layout | **E1** | RUNTIME VERIFIED | `AX_WIN_001` | Borderless `AXStandardWindow` with custom traffic light padding. |
| | Window bounds restoration | **E2** | STATIC EVIDENCE FOUND | `WindowState+WindowLayout.swift` | Auto-save frame keys present in string table. |
| | Blank Window | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Mapped to `Cmd + Option + N`. |
| | Little Arc Auxiliary Window | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Mapped to `Cmd + Shift + N`. |
| **B. Navigation** | Per-tab Back/Forward list | **E2** | STATIC EVIDENCE FOUND | `ArcBackForwardList`, `ArcWebContentsNavigationController` | Clean Obj-C bridge over Chromium history. |
| | Multi-process Chromium rendering | **E1** | RUNTIME VERIFIED | `ps aux` showing 32 helper renderers | Sandboxed `Browser Helper (Renderer).app` processes. |
| | Independent pane navigation in split | **E1 / E3** | RUNTIME VERIFIED | Post-split toolbar & title tracking | Window title changes when switching pane focus. |
| **C. Tab Lifecycle** | Global Favorites Collection | **E1** | RUNTIME VERIFIED | `AX_WIN_001` (`sidebarFavoritesCollectionView`) | Pinned globally above the Spaces pager. |
| | Space-Pinned Tabs | **E1** | RUNTIME VERIFIED | `sidebarAllTabList` upper section | Separated from Today tabs by a blank row. |
| | Today / Unpinned Tabs | **E1** | RUNTIME VERIFIED | `sidebarAllTabList` lower section | Ephemeral tabs subject to auto-archive. |
| | Restore closed tab | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Bound to `Cmd + Shift + T`. |
| | Auto-archive logic | **E2** | STATIC EVIDENCE FOUND | `ArchiveFeatureAction`, `AutoArchiveEducationAction` | Configurable idle timer logic present in binary. |
| **D. Sidebar** | Fixed width resting layout (232 pt) | **E1** | RUNTIME VERIFIED | `AX_WIN_001` | Sidebar bounds: `width: 232.0, height: 751.0`. |
| | Hide / Toggle Sidebar | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Bound to `Cmd + S` (`Hide Sidebar`). |
| | Horizontal Space Paging Dock | **E1** | RUNTIME VERIFIED | `AX_SPACES_001` (`SidebarDockItem-*`) | Bottom dock contains dock icons for all configured Spaces. |
| **E. Spaces System** | Multi-space concurrent residency | **E1** | RUNTIME VERIFIED | `AX_SPACES_001` | 3 distinct `sidebarAllTabList` trees active in memory. |
| | Space switching | **E2 / E3** | STATIC EVIDENCE FOUND | `SidebarPagingContainerCollectionViewLayout` | Paged horizontal scroll container. |
| **F. Profiles** | Partitioned storage context | **E1 / E2** | RUNTIME VERIFIED | `ArcBrowserContext`, `ADKModels.Profile` | Storage, cookies, and downloads partitioned per Space session. |
| **G. Split View** | Dual-pane horizontal layout | **E1** | RUNTIME VERIFIED | `AX_SPLIT_001` | Main viewport splits at `x=232.0`. |
| | Vertical split serialization keys | **E2** | STATIC EVIDENCE FOUND | `ConvertToVerticalSplitViewCodingKeys` | Proves vertical layout is supported by data model. |
| | Directional pane addition keys | **E2** | STATIC EVIDENCE FOUND | `AddLeftSplitCodingKeys`, `AddRightSplitCodingKeys`, etc. | Model supports 4-way pane additions. |
| | Add Split View Shortcut | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Native shortcut: `Ctrl + Cmd + Option + =`. |
| | Close this Split Pane Shortcut | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Native shortcut: `Ctrl + Cmd + Option + -`. |
| | Separate Page from Split View | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Menu action to decouple pane into normal tab. |
| | Expand Current Split | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | Menu action to maximize focused pane. |
| **H. Folders** | Collapsible tab folders | **E2** | STATIC EVIDENCE FOUND | `OpenFolderCodingKeys`, `WindowFolderPreview.swift` | Nested tab hierarchy in sidebar. |
| **I. Command Bar** | Focus Address / Command Palette | **E1** | RUNTIME VERIFIED | `AX_MENU_001` | `Cmd + L` opens Command Bar; resting state is `commandBarPlaceholderTextField`. |
| | Autocomplete & Ranking Model | **E2** | STATIC EVIDENCE FOUND | `ArcCommandBarRankingModel`, `ArcAIDistilBertClassifier` | CoreML/DistilBERT ranking candidates. |
| **J. Favorites & Routing** | Air Traffic Control | **E2** | STATIC EVIDENCE FOUND | `OpenAirTrafficControlCodingKeys` | Domain-based routing to specific Spaces/Profiles. |
| **K. Archive & History** | Tab archive separation | **E2** | STATIC EVIDENCE FOUND | `ArchiveFeatureAction`, `ClosedSidebarItemsCache` | Archived tabs preserved in separate cache from closed tabs. |
| **L. Customization** | Boosts / Site customizer | **E2** | STATIC EVIDENCE FOUND | `ArcWebContentsBoostIDE` | CSS/JS injection interface. |
| **M. Creative Tools** | Easels & Notes | **E1 / E2** | RUNTIME VERIFIED (Menu) | `AX_MENU_001` (`New Easel`: `Cmd + E`), `NewArcNoteCodingKeys` | Native canvas and note tools. |
| **N. Sync & Import** | Cloud sync infrastructure | **E2** | STATIC EVIDENCE FOUND | `SidebarSyncCloudKit`, `FirebaseSidebarSyncClient` | Dual cloud sync client references. |
