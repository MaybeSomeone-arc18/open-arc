# Open Arc

An open-source browser shell inspired by the browsing model of Arc (vertical sidebar, Spaces, pinned + Today tabs, command bar), built from scratch on Electron + React + TypeScript.

> **Trademark & independence notice.** "Open Arc" is a working name for an independent, community-driven project. It is **not affiliated with, endorsed by, or derived from** The Browser Company of New York or its Arc browser. No Arc code, assets, icons, fonts, or designs are used or redistributed here; every feature is a clean-room reimplementation based on publicly documented behavior. "Arc" is a trademark of The Browser Company. If the maintainers of Arc have any concern with this project, please open an issue.

## Status

Early proof of concept. What genuinely works today (verified by automated runs with screenshots):

- Real web browsing: tabs are live `WebContentsView`s; pages load, navigate (back/forward/reload), and report titles/favicons to the sidebar
- Vertical sidebar with **Spaces** (create, switch, rename, per-space theme color and icon)
- **Pinned** and **Today** tab tiers per Space; pin/unpin; close; switch
- **Split view**: two tabs side by side (Ctrl+Shift+= to toggle, Ctrl+Shift+- to close)
- **Command bar** (Ctrl+T): fuzzy search across commands and open tabs, URL/search entry
- **Auto-archive**: idle Today tabs move to a restorable Archive (12 h default, pinned tabs never archive)
- **Persistence**: spaces, pins, tabs, archive and window state survive restarts (atomic JSON writes)
- Frameless window with working minimize / maximize / close and a drag region

Honest gaps: no sync, no accounts, no extensions, no downloads UI, no history search, single window only. This is a PoC of the product experience, not a daily driver yet.

### Known limitations

- **Window drag is untested end-to-end.** The drag region is implemented with CSS `-webkit-app-region: drag` on the sidebar/top bar, and minimize / maximize / close are exercised in the automated verification runs, but the runs are headless (Xvfb), so pointer-dragging the window has not been verified in an automated run. It should work on a real desktop; treat it as unverified until someone drags it on a physical machine.
- **Minimize/maximize state reflection is not asserted headless.** The smoke suite executes the control path (same one the buttons call); under bare Xvfb there is no window manager to honor the state change, so the suite logs observed state instead of asserting it.
- **Tab-content screenshots can be unavailable in restricted containers.** The suite's functional checks (titles, URLs, state) do not depend on pixels; page-content captures are saved when the compositor cooperates and skipped with a log note when it does not.

## Verifying

From a clean checkout (Node 22+, Linux/macOS/Windows):

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # electron-vite build into out/
npm run shot        # smoke suite: launches the real app twice and checks it
```

`npm run shot` (`scripts/screenshot.mjs`) runs the production build against a fresh temporary profile, twice:

- **Run phase** - window controls execute, command bar opens on Ctrl+T, example.com loads with its real title, in-tab forward/back navigation, tab switching within a space, split view on/off, space creation, cross-space tab switching, pinning, auto-archive of an idle tab. Genuine screenshots land in `shots/` alongside `report-run.json`.
- **Verify phase** - relaunches on the same profile and checks that spaces, pinned tabs and the archive survived the restart (`report-verify.json`).

The suite exits non-zero if any check fails. On headless Linux it wraps itself in `xvfb-run`. It needs network access - the navigation checks load example.com, example.org and wikipedia.org for real.

What the suite does **not** cover: pointer-driven window dragging, minimize/maximize state reflection (needs a real window manager), downloads, extensions, multi-window, and any manual UI interaction.

## Architecture

```
src/main/     Electron main process: window, tab layer, state store, IPC
  tabs.ts     TabLayer - owns WebContentsViews (the Chromium content layer)
  store.ts    Atomic JSON persistence of the sidebar data model
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

`npm audit` (2026-10-23) reports 9 advisories, all in **development-time** dependencies:

- `electron` 33.4.11: known advisories including an ASAR integrity bypass (GHSA-vmqv-hx8q-j7mg). These matter for a packaged, distributed app; this PoC runs unpackaged in development. A major-version Electron upgrade is deliberately deferred until the PoC matures.
- `esbuild` / `vite`: dev-server request forgery (GHSA-67mh-4wv8-2f99) - only affects `npm run dev` on an untrusted network.
- `extract-zip` via `@electron/get`: install-time download tooling only.

Runtime dependencies shipped to the app (`react`, `react-dom`) have no known advisories at audit time. Re-run `npm audit` before any packaged release.

## License

MIT (see LICENSE). Chromium and Electron carry their own licenses (BSD / MIT); no third-party browser assets are bundled.
