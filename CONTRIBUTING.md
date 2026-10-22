# Contributing to Open Arc

Open Arc is an early proof of concept. Contributions are welcome, with one hard rule and a few conventions.

## The hard rule: clean room only

Open Arc is a clean-room reimplementation. Never copy code, assets, icons, or internal structure from Arc (The Browser Company) or from reverse-engineering dumps of it. Public screenshots, public docs and publicly visible behavior are fine as references. If you are unsure whether something crosses the line, open an issue and ask before writing code.

## Development setup

```bash
npm install
npm run dev        # live-reload development build
```

Node 22+ required.

## Before you open a PR

```bash
npm run typecheck  # must pass
npm run build      # must pass
npm run shot       # the smoke suite; all checks must pass
```

The smoke suite drives the real app end to end (window controls, command bar, navigation, tabs, spaces, split view, auto-archive, persistence) and writes genuine screenshots plus JSON reports into `shots/`. If you change behavior, extend the suite - every feature in this repo ships with an automated check.

## Conventions

- Keep Electron API use inside `src/main/tabs.ts` (the seam for a future engine swap); everything above it talks to the data model.
- State changes go through the single `commit()` funnel so persistence and rendering stay in step.
- Transient UI state (e.g. loading spinners) never goes into the persisted state file.
- Honest claims only: README and commit messages describe what the smoke suite actually verifies.
