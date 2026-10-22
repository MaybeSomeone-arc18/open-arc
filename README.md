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

## License

MIT (see LICENSE). Chromium and Electron carry their own licenses (BSD / MIT); no third-party browser assets are bundled.
