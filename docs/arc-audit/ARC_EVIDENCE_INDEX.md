# Arc Audit Evidence Index

**Target Application:** Arc Browser (`/Applications/Arc.app`)  
**Version:** `1.169.0` (Build `88758`)  
**Commit Info:** `Release-88758-f641642e5497f3b97ccbfc6fe31eff7a5a27cb54`  
**Host Architecture:** macOS universal (`x86_64` / `arm64`)  
**Bundle ID:** `company.thebrowser.Browser`

---

## 1. Evidence Level Definitions

- **E1 — Direct runtime observation:** Observed directly in Arc during live, verifiable interaction or inspected via active OS accessibility / display APIs.
- **E2 — Static artifact evidence:** Verified via binary symbols, load commands, Mach-O slices, string tables, plists, or package graph entries.
- **E3 — Strong inference:** Logically necessitated by multiple converging findings, but not directly seen executing in isolation.
- **E4 — Hypothesis:** Plausible design or mechanism requiring further verification.
- **E5 — Unknown / blocked:** Inaccessible, uninspected, or unsupported.

---

## 2. Master Evidence Ledger

| Evidence ID / Resource | Level | Tool / Method | Target Path / Subject | Provenance & Proved Facts | Limitations & What It Does NOT Prove |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ev_499869bd2692...` | **E2** | `rea:inspect_plist` | `/Applications/Arc.app/Contents/Info.plist` | Proves `CFBundleIdentifier`: `company.thebrowser.Browser`, `CFBundleShortVersionString`: `1.169.0`, `CFBundleVersion`: `88758`, `NSPrincipalClass`: `Arc.BrowserApp`. | Does not prove runtime behavior of AppDelegate initialization. |
| `ev_5818ae9899d8...` | **E2** | `rea:inspect_artifact` | `/Applications/Arc.app` | Proves directory graph has 1,486 nodes, 1,958 occurrences, and **no** `Contents/Resources/app.asar` or extracted JS tree. | Does not analyze internal WebKit/Chromium resources inside embedded frameworks. |
| `ev_53b3c44bb054...` | **E2** | `rea:inspect_macho` | `Contents/MacOS/Arc` | Universal Mach-O binary (165.9 MB), 86 dylib dependencies, 8,029 symbol imports, 862 exports. | Stripped binary; names combined with nm/dyld_info. |
| `ev_fb0371dd05a5...` | **E2** | `rea:inspect_analysis_view` | `Contents/MacOS/Arc` (Dependencies) | Proves explicit linking to `@executable_path/../Frameworks/ArcCore.framework`, `@rpath/Lottie.framework`, `@rpath/Sparkle.framework`, `SwiftUI`, `Combine`, and `AppKit`. | Does not prove dynamic runtime loading order or optional lazy modules. |
| `ev_fcc6ff86c768...` | **E2** | `rea:inspect_signature` | `Contents/MacOS/Arc` | Proves signed by Developer ID `The Browser Company of New York Inc. (S6N382Y83G)`, Hardened Runtime enabled, `cdhash`: `5aab701664f20f69d7c512216d03de9ea4991a6a`. | Does not validate live notarization ticket with Apple servers. |
| `ev_a1ce9b3dd32b...` | **E2** | `rea:inspect_electron_fuses` | `Contents/MacOS/Arc` | 0 Electron fuse sentinels found across both slices. Confirms Arc is **not** an Electron app. | Does not prove absence of other embedded web views. |
| `ev_342972015baa...` | **E2** | `rea:inspect_electron_fuses` | `Contents/Frameworks/ArcCore.framework/...` | 0 Electron fuse sentinels found in `ArcCore`. | Does not evaluate CEF/Chromium internal build flags. |
| `ev_6c9db5980da3...` | **E2** | `rea:inspect_macho` | `ArcCore.framework/Versions/A/ArcCore` | Mach-O universal (495.7 MB), exports Chromium symbols (`ChromeMain`) and `Arc*` Objective-C bridge classes. | Does not decompile C++ Chromium internals. |
| `AX_MENU_001` | **E1** | Native AX API (`kAXMenuBarAttribute`) | Arc Menu Bar (PID 1633) | Directly extracted live menu shortcuts: `Add Split View` (`Ctrl+Cmd+Option+=`), `Close this Split Pane` (`Ctrl+Cmd+Option+-`), `New Tab…` (`Cmd+T`), `Open Command Bar` (`Cmd+L`), `Hide Sidebar` (`Cmd+S`). | Does not prove whether secondary undocumented keyboard overrides exist. |
| `AX_WIN_001` | **E1** | Native AX API (`AXUIElementCopyAttributeValue`) | Main Window (`bigBrowserWindow-...`) | Verified resting sidebar width is 232.0 pt, content viewport bounds are (232, 43, 1228, 903), top controls include `Hide sidebar`, `Go back`, `Go forward`, `Reload`. | Does not expose internal WebContents accessibility nodes (rendered outside AppKit). |
| `AX_SPACES_001` | **E1** | Native AX API | Main Window Outlines | Proves 3 concurrent `sidebarAllTabList` outline hierarchies (`Work` with 18 tabs, `Create` with 12 tabs, `Random` with 7 tabs) reside simultaneously in memory. | Does not prove whether background web renderers are suspended or discarded. |
| `AX_SPLIT_001` | **E1** | Native AX API (Post-Split Verification) | Main Window Post-Split | Proves window title synchronizes with the active focused pane title; toolbar dynamically mounts per-pane action buttons (`copyLinkButton`, `siteControlCenterButton`). | Does not expose divider coordinate ratio as an accessible slider. |
| `STR_SPLIT_001` | **E2** | String extraction (`strings`) | `Contents/MacOS/Arc` | Discovered serialization keys: `NewVerticalSplitViewPaneCodingKeys`, `ConvertToHorizontalSplitViewCodingKeys`, `ConvertToVerticalSplitViewCodingKeys`, `AddRightSplitCodingKeys`, etc. | Does not prove live UI allows >2 panes without performance degradation. |
