# Mac validation checklist (alpha)

Steps to install and validate the `overnight-improvements` branch on a Mac.
Expected time: ~20 minutes plus the manual checks.

## 1. Setup

```sh
xcode-select --install          # developer tools (git, clang) if not present
# Node 22 LTS - pick one:
brew install node@22            # or: nvm install 22
git clone https://github.com/MaybeSomeone-arc18/open-arc.git
cd open-arc
git checkout overnight-improvements
npm ci
npm run build
```

## 2. Automated suite (validates logic, not native chrome)

```sh
npm run shot
```

Expected: every check PASS, exit code 0 (62 checks across two launches; the
second launch verifies persistence). Screenshots land in `shots/`.

Know what this proves: the suite drives the real app through synthetic
keyboard events and handler calls under a headless display. It verifies
navigation, state, spaces, archive, downloads and persistence. It cannot
verify native window-manager behavior - that is what the manual pass below
is for.

## 3. Run the app

```sh
npm run preview    # production build (what CI builds)
# or: npm run dev  # live-reload development mode
```

## 4. Manual native checks (the parts automation cannot prove)

| # | Check | How | Expected |
|---|-------|-----|----------|
| 1 | Window dragging | Drag the sidebar/top area | Window moves with the pointer |
| 2 | Native window controls | Click the custom minimize / maximize / close buttons | Window minimizes / maximizes / closes |
| 2a | Green control = native full-screen | Click the green window button, then click it again (or Esc) | Enters and exits real macOS full-screen (own Space in Mission Control), NOT just maximize; tab layout reflows after the transition |
| 2b | Drag-strip double-click | Double-click the sidebar drag strip | Maximizes/restores, does NOT enter full-screen |
| 3 | Command bar | Ctrl+T, type a URL, Enter | New tab loads it |
| 4 | Tabs | Ctrl+T several times, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1..9, Ctrl+W, Ctrl+Shift+T | Cycle, jump, close, reopen all behave |
| 4a | Shortcuts WITH A PAGE FOCUSED | Click into a web page first, then Cmd+T, Cmd+F, Cmd+W, Cmd+L, Cmd+R, Cmd+Shift+T | Command bar / find bar open visible and focused, tab closes, entry focuses, page reloads, closed tab reopens; ordinary typing in the page is unaffected |
| 5 | Spaces | Create a space, switch between spaces | Tabs stay scoped to their space |
| 6 | Split view | Ctrl+Shift+= then Ctrl+Shift+- | Two tabs side by side, then back |
| 7 | Find-in-page | Ctrl+F on any page, type a word | Page shifts down under a top strip holding the find bar; matches highlight with a live count (**experimental**: bar+layout verified in composited captures, match event unverified until real hardware) |
| 8 | Context menu | Right-click a link and an image | Native menu with open/copy items (**experimental**: items verified headless, the popup itself is not) |
| 9 | Downloads | Download any file (and navigate directly to a binary, e.g. https://httpbin.org/bytes/1024) | Lands in ~/Downloads with a completion toast showing filename + size; a direct file navigation shows a 'Download complete' status page, not a blank tab |
| 10 | Save as PDF | Ctrl+P on any page | Page lifts off a bottom strip showing a 'Saved PDF' toast (or a clear failure toast); PDF written to ~/Downloads, opens in Preview |
| 11 | Reader mode | Ctrl+Alt+R on an article | Clean reading view; cosmetic leftovers known (orphaned headings possible) |
| 12 | Per-tab zoom | Ctrl+= / Ctrl+- / Ctrl+0 on one tab | Only that tab zooms; shell UI unaffected |
| 13 | Session persistence | Open tabs, pin one, quit (Cmd+Q), relaunch | Spaces, pins, tabs, archive, window position all restored |
| 14 | Navigation failure | Visit a dead URL (e.g. http://127.0.0.1:48999/) | Friendly in-app error page, then Ctrl+R or navigate away recovers |

Features marked **experimental** are unverified on real hardware only - they
are not release blockers, but please report whatever they actually do.

## 5. Report

Send back: macOS version, chip (Intel/Apple silicon), which numbered checks
passed/failed, and a screenshot of anything wrong.
