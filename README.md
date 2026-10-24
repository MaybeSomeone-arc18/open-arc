# Open Arc

An open-source browser shell inspired by the browsing model of Arc (vertical sidebar, Spaces, pinned + Today tabs, command bar), built from scratch on Electron + React + TypeScript.

> **Trademark & independence notice.** "Open Arc" is a working name for an independent, community-driven project. It is **not affiliated with, endorsed by, or derived from** The Browser Company of New York or its Arc browser. No Arc code, assets, icons, fonts, or designs are used or redistributed here; every feature is a clean-room reimplementation based on publicly documented behavior. "Arc" is a trademark of The Browser Company. If the maintainers of Arc have any concern with this project, please open an issue.

## Status

Early proof of concept. What genuinely works today (verified by automated runs with screenshots):

- Real web browsing: tabs are live `WebContentsView`s; pages load, navigate (back/forward/reload), and report titles/favicons to the sidebar
- Vertical sidebar with **Spaces** (create, switch, rename, per-space theme color and icon)
- **Pinned** and **Today** tab tiers per Space; pin/unpin; close (button or middle-click); switch
- **Split view**: two tabs side by side (Ctrl+Alt+= or Ctrl+Shift+= to toggle, Ctrl+Alt+- or Ctrl+Shift+- to close), with a draggable divider
- **Command bar** (Ctrl+T): fuzzy search across commands, open tabs, archive and browsing history, URL/search entry
- **Auto-archive**: idle Today tabs move to a restorable Archive (12 h default, pinned tabs never archive)
- **History**: navigations are recorded (most recent 500) and searchable from the command bar
- **Persistence**: spaces, pins, favorites, tabs, archive and window state survive restarts (atomic JSON writes with fsync; interrupted writes are caught by the recovery flow below)
- Frameless window with working minimize / maximize / close and a drag region
- **Downloads**: files save to the system Downloads folder with a completion toast
- **Find-in-page** (Ctrl+F) with live match count and Enter / Shift+Enter navigation *(implemented; not yet verified on real hardware - see Known limitations)*
- **Per-tab zoom**: Ctrl+= / Ctrl+- / Ctrl+0 (50%-300%), with a zoom-level toast
- **Copy active URL**: Ctrl+Shift+C writes the tab's live URL to the clipboard
- **Mute tab**: Ctrl+M toggles the active tab's audio
- **Reader mode**: Ctrl+Alt+R extracts the article into a clean reading view (works best on article pages)
- **Save as PDF**: Ctrl+P writes the active tab to a PDF in the Downloads folder
- **Friendly error page**: failed navigations show an in-app error with the URL and reason instead of Chromium's default
- **Global favorites**: favorite a tab once and it stays pinned across every Space
- **State crash recovery**: if a previous save was interrupted, startup discovers the leftover (`state.json.fresh-*`), shows an explicit choice dialog, and commits the chosen candidate only after a byte-verified backup and atomic replace; declining keeps the current state untouched
- **Page context menu**: right-click links/images for open-in-new-tab, copy link/image, back/forward/reload, view source, inspect *(item behaviors verified; the native popup is not - see Known limitations)*
- Keyboard shortcuts that act on tabs, not the shell: Ctrl+T / Ctrl+L command bar, Ctrl+W close tab, Ctrl+Shift+T reopen closed tab, Ctrl+Shift+K duplicate tab, Ctrl+D pin, Ctrl+R reload tab, Ctrl+Shift+R hard reload, Ctrl+U view source, Ctrl+Alt+R reader mode, Ctrl+P save as PDF, F12 / Ctrl+Shift+I DevTools, Ctrl+F find, Ctrl+Tab / Ctrl+Shift+Tab cycle tabs, Ctrl+1..8 jump to tab, Ctrl+9 last tab, Alt+Left/Right history, Ctrl+S sidebar, Ctrl+/ shortcut reference

Honest gaps: no sync, no accounts, no extensions, no download manager UI (files save to the Downloads folder with a completion toast), no dedicated history page (history is searchable from the command bar), single window only. This is a PoC of the product experience, not a daily driver yet.

### Overlay layering (alpha fallback)

Electron's `WebContentsView` pages composite **above** the shell's DOM, so the
command bar, find bar and shortcuts overlay cannot simply float over a page.
The alpha approach is deliberately simple and preserves the live page: opening
a modal overlay (command bar, shortcuts) hides the attached page views via
`setVisible(false)` (no unload, no state loss, restored on close); the find
bar instead shrinks page views below a 48px top strip so the page and match
highlights stay visible. Toasts (downloads, zoom, PDF feedback) reserve a
64px bottom strip so confirmation/failure feedback is never hidden behind a
page. Keyboard focus follows: opening an overlay focuses the shell, closing
the last overlay returns focus to the active tab. A
dedicated native overlay view may replace this later; the fallback is covered
by composited-capture verification and lifecycle checks in the smoke suite.

### Known limitations

- **Window drag is untested end-to-end.** The drag region is implemented with CSS `-webkit-app-region: drag` on the sidebar/top bar, and minimize / maximize / close are exercised in the automated verification runs, but the runs are headless (Xvfb), so pointer-dragging the window has not been verified in an automated run. It should work on a real desktop; treat it as unverified until someone drags it on a physical machine.
- **Minimize/maximize state reflection is not asserted headless.** The smoke suite executes the control path (same one the buttons call); under bare Xvfb there is no window manager to honor the state change, so the suite logs observed state instead of asserting it.
- **The context menu's native popup is unverified on real hardware.** The menu's construction and every item's behavior (copy link to the real clipboard, open link in a new tab, navigation) are asserted in the smoke suite, but right-clicking to summon the popup itself has only been exercised in a headless container.
- **Find-in-page (Ctrl+F) is unverified on real hardware.** The implementation uses the standard `webContents.findInPage` / `found-in-page` flow (proven working in a standalone Electron harness), but in headless containers the result event never dispatches to an app's WebContentsView, so the smoke suite cannot assert it. Treat it as unverified until someone runs Ctrl+F on a physical machine.
- **The first page capture of the smoke run intermittently never resolves in some headless CI containers.** `webContents.capturePage` is frame-dependent; on affected runners the promise never settles and the run used to die at the outer watchdog. The suite now logs the pending step and force-fails (exit 98) within 120s instead of hanging silently; the underlying intermittent stall is not root-caused. It has never affected functional checks, which do not depend on pixels.
- **The crash-recovery harness (`npm run test:shellcrash`) is not green in this headless container.** Its repeat-crash dialog expectation is not reached under bare Xvfb; treat the crash dialog as unverified until it runs on a real desktop. (`npm run test:security` and `npm run test:recovery` pass: 35/35 and 8/8.)
- **Tab-content screenshots can be unavailable in restricted containers.** The suite's functional checks (titles, URLs, state) do not depend on pixels; page-content captures are saved when the compositor cooperates and skipped with a log note when it does not.

### Related projects

- [REA (Reverse Engineering Arc)](https://github.com/morluto/rea) was evaluated during planning as a potential shortcut for understanding Arc's UI structure. It was **not used**: Open Arc is a clean-room reimplementation built only from public sources (public screenshots, public documentation, and the publicly visible behavior of the Arc UI). No code, assets, or internal structure from Arc was taken, and no part of REA's output was incorporated.

## Screenshots

All captures below are genuine output of the app running under Xvfb (no mockups, no renders). The demo GIF is assembled from real app captures (shell + tab panes composited at their true layout positions) because screen recording under a headless X server lags; every pixel comes from the running app.

![Open Arc demo: command bar, tabs, split view, auto-archive](docs/screenshots/demo.gif)

| Split view (Wikipedia + Hacker News) | Auto-archive (archived tab in sidebar, live page in pane) | Command bar |
| --- | --- | --- |
| ![Split view](docs/screenshots/split-view.png) | ![Auto-archive](docs/screenshots/auto-archive.png) | ![Command bar](docs/screenshots/command-bar.png) |

## Verifying

From a clean checkout (Node 22+, Linux/macOS/Windows):

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # electron-vite build into out/
npm run shot        # smoke suite: launches the real app twice and checks it
```

`npm run shot` (`scripts/screenshot.mjs`) runs the production build through 17 phases over fresh and planted temporary profiles - 189 distinct checks as of this writing:

- **Run phase** - window controls execute, command bar opens on Ctrl+T (with fuzzy-search matching), example.com loads with its real title, loading start/stop events fire, per-tab zoom in and reset via real keydowns, in-tab forward/back navigation, tab switching within a space, Ctrl+1 / Ctrl+9 tab jumps, copy-URL to the real clipboard, tab mute/unmute, Ctrl+Tab cycling, Ctrl+R reloading the tab (never the shell), split view on/off, space creation, cross-space tab switching, pinning, favorites, reopen-closed-tab, auto-archive of an idle tab with restore, a real download landing in the Downloads folder, and space deletion. Genuine screenshots land in `shots/` alongside `report-run.json`.
- **Verify phase** - relaunches on the same profile and checks that spaces, pinned tabs, zoom, the archive, history, recently-closed tabs and window bounds survived the restart (`report-verify.json`).
- **Persistence and recovery phases** - corrupt state is quarantined byte-preservingly, partial writes never clobber the last good state, save failures surface honestly and clear after a later success, quarantine never overwrites an existing backup, and the `.fresh` recovery flow is exercised end to end: discovery beside valid or malformed state, accept with byte-exact commit and verified backup, decline that preserves current work, malformed-candidate handling, staging-write failure after backup, interrupted recovery, rename failure in a writable folder, and post-commit warning paths (directory-sync, retirement, bookkeeping) that must never roll back committed state.

The suite exits non-zero if any check fails, and it force-fails loudly (distinct exit codes) if a phase stalls or the process does not exit cleanly, instead of hanging silently. On headless Linux it wraps itself in `xvfb-run`. It needs network access - the navigation checks load example.com, example.org and wikipedia.org for real.

Three focused harnesses sit beside the suite: `npm run test:security` (35 checks: every IPC handler goes through the guarded wrappers with origin validation, permission policy installed), `npm run test:recovery` (8 checks: crash-gate windowing, crash-vs-clean-exit classification, crash-page escaping), and `npm run test:shellcrash` (repeat-crash dialog, quit-during-crash, save-during-crash - currently not green in headless containers; see Known limitations).

What the suite does **not** cover: find-in-page (the `found-in-page` event never dispatches in headless containers - see Known limitations), pointer-driven window dragging, minimize/maximize state reflection (needs a real window manager), extensions, multi-window, and any manual UI interaction.

## Architecture

```
src/main/     Electron main process: window, tab layer, state store, IPC
  tabs.ts     TabLayer - owns WebContentsViews (the Chromium content layer)
  store.ts    Atomic JSON persistence of the sidebar data model
  security.ts IPC sender/origin validation + fail-closed permission policy
  recovery.ts Crash gate + crash-page helpers (no electron dependency)
src/preload/  contextBridge API (the only renderer <-> main channel)
src/renderer/ React shell: sidebar, spaces bar, command bar
src/shared/   Model types + command registry shared by both sides
```

**The Electron ceiling.** Electron embeds Chromium's *content* layer only. Tabs-as-views work well; but Chrome extensions, full profile/session machinery, downloads and permission UIs must be rebuilt by hand on this stack. If Open Arc graduates to a daily driver, the foundation should move to a Chromium-fork approach (e.g. an ungoogled-chromium base with a custom shell, similar to Arc's own ADK concept). Everything above `tabs.ts` (data model, spaces, sidebar, command bar) is foundation-agnostic by design, so that swap touches one file's contract, not the product.

## Run it

```bash
npm install
npm run dev        # live-reload dev mode
npm run build      # typecheck-safe production build into out/
npm run preview    # run the production build
```

Node 22+ required. Linux/macOS/Windows.

## Security notes

`npm audit` (re-checked 2026-10-24) reports 3 advisories, all in **development-time** dependencies:

- `esbuild` / `vite` / `electron-vite`: dev-server request forgery (GHSA-67mh-4wv8-2f99) and a vite path-traversal issue in optimized-deps sourcemap handling - these only affect `npm run dev` on an untrusted network. They are build tooling; none of this code ships in the app.

Electron was upgraded from 33.4.11 (EOL, 6 open advisories including an ASAR integrity bypass, GHSA-vmqv-hx8q-j7mg) to **44.9.3**, a currently supported release. The upgrade is verified: `npm run typecheck`, `npm run build` and the full `npm run shot` smoke suite pass on 44.9.3 (the suite has since grown to 189 checks across 17 phases), and the suite's live-page captures render real content.

Browser-shell hardening: every web permission request (camera, mic, notifications, geolocation, ...) is default-denied until a consent UI exists - Electron grants them by default otherwise. Popups (`window.open`, `target=_blank`) are denied as OS windows and reopened as tabs inside the shell. All 35 IPC channels are guarded: the main process validates the sender's origin (`isTrustedSender` - only the shell page, dev or packaged) and sanitizes parameters before acting. Tab and shell crashes pass through a crash gate: one automatic recovery per 30s window, then a visible crashed page with the URL and reason instead of a loop. All of these behaviors are smoke- or harness-checked.

Note on framing: `electron` is listed under devDependencies (electron-vite convention), but it IS the shipped browser runtime the moment the app is packaged - npm's runtime-dependency count is not the browser's security surface. At audit time electron@44.9.3 has no open advisories, and the UI libraries bundled into the app (`react`, `react-dom`) have none either. The repo deliberately has **no packaging configured** (no electron-builder/forge), so nothing is distributed today; do not package or distribute a build until the remaining dev-tooling advisories are re-checked and packaging is set up deliberately.

## License

MIT (see LICENSE). Chromium and Electron carry their own licenses (BSD / MIT); no third-party browser assets are bundled.
