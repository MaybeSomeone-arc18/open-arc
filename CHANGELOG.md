# Changelog

## overnight-improvements branch (pending merge to main)

37 commits on top of `main` (b42bdd7). Every commit passed typecheck, build
and the full headless smoke suite before push; the suite grew from 13 to 57
checks over the night.

### New features
- Command bar: fuzzy matching (9beb00d), searches archived tabs and restores them (f1811ed), surfaces recently closed tabs (742fa51), registry now includes Duplicate Tab / Hard Reload / View Source (6cf7672)
- Tabs: reopen closed tab Ctrl+Shift+T (b757224), duplicate Ctrl+Shift+K (94d5250), jump Ctrl+1..9 (40f4e53), copy URL Ctrl+Shift+C (0a89e05), mute Ctrl+M (97b556f), close others (34bff77), close tabs to the right (d44ac20), move to space (0f5b916)
- Page tools: find-in-page Ctrl+F (3fc21c0), zoom Ctrl+= / Ctrl+- / Ctrl+0 with per-tab persistence (1020485, b609e2e), hard reload Ctrl+Shift+R (f8a71f1), DevTools F12 / Ctrl+Shift+I (2fa2fae), view-source Ctrl+U (f14bd29), reader mode Ctrl+Alt+R (65dff2c), save-as-PDF Ctrl+P (5966c2e), page context menu (3e7b3ac)
- History: browsing history searchable from the command bar (b74b612), clear-history command (9129a53)
- Spaces: space deletion + fixed broken New Space button (7860b5d), rename via IPC verified by smoke check (5c65ca8)
- Downloads: save to Downloads folder with completion toast (3845457)
- UI: tab loading indicator (191df22), sidebar polish (ae115a0), keyboard shortcut reference overlay Ctrl+/ (5bd9889)
- Persistence: window bounds across restarts (070b620), per-tab zoom across restarts (b609e2e)

### Security hardening
- Popups route into tabs instead of OS windows (4efd20c)
- All web permission requests default-denied (81b7eba)
- Tab-scoped shortcuts: page JS can no longer trigger shell commands (9031a46)

### Docs and testing
- CONTRIBUTING.md: clean-room rule, dev setup, PR checklist (e30a686)
- Demo GIF from genuine app captures (6965543)
- README accuracy passes: complete shortcut list (47d9409, 226a014), claims audit annotating partially-unverified features and refreshed security notes (5c65ca8)
- Smoke suite 13 -> 57 checks; stability audits green across multiple consecutive runs at several HEADs
