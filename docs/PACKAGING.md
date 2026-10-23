# Packaging a macOS alpha (audit + recommendation)

Status: audited, NOT yet executed. No binary is published; the gates at the
bottom must pass first.

## What the project needs for a downloadable alpha

1. A packaging tool (none configured today - the app only runs from source).
2. An app icon in `.icns` form (none exists yet).
3. Build metadata: appId, productName, artifact naming, mac targets.
4. A release workflow producing the artifact on a free runner.
5. Honest install instructions for an unsigned build.

## Recommended tool: electron-builder

- Most widely used, actively maintained open-source packager for Electron
  (github.com/electron-userland/electron-builder). One config block in
  package.json plus one devDependency; produces `.zip` and `.dmg` for macOS,
  and later NSIS/AppImage for Windows/Linux with no rework.
- electron-forge is the official alternative and also maintained; it needs
  more boilerplate for the same GitHub-release flow. electron-builder is the
  simpler fit here.

Suggested config (for when the gates pass - not applied yet):

```json
"build": {
  "appId": "dev.openarc.app",
  "productName": "Open Arc",
  "files": ["out", "package.json"],
  "mac": { "category": "public.app-category.productivity", "target": ["zip", "dmg"] }
}
```

## Free release workflow (no paid service, no new account)

GitHub Actions job on `macos-latest` (free for public repos):

1. checkout, setup-node 22, `npm ci`
2. `npm run typecheck && npm run build`
3. `npx electron-builder --mac zip dmg` (unsigned)
4. upload the artifacts; create a **draft** GitHub Release by hand, attach
   the zip+dmg, mark it pre-release (alpha).

Cost: zero. Apple Silicon and Intel: build twice (matrix `macos-14` arm64,
`macos-13` intel) or ship arm64 first - his Mac and most users are arm64.

## Code signing - honest limitations

- Without an Apple Developer ID ($99/year), the app is unsigned. macOS
  Gatekeeper will warn "Open Arc can't be opened because Apple cannot check
  it for malicious software" (or "unidentified developer").
- User workarounds for the alpha: right-click the app > Open > Open, or
  `xattr -cr "/Applications/Open Arc.app"` after copying. Both must be
  documented in the release notes.
- Ad-hoc signing (`codesign --sign -`) does NOT satisfy Gatekeeper for
  downloaded apps - don't waste time on it.
- The clean path is a Developer ID certificate + notarization, which
  requires the paid Apple Developer Program. That is the single unavoidable
  recurring cost for signed macOS releases (already flagged in the strategy
  doc). Alpha can ship unsigned with instructions; signed releases need the
  account decision.

## Gates before any binary is published

1. Security assessment green: the remaining toolchain advisories (3
   vulnerable dev-time packages / 9 advisories in vite/esbuild/launch-editor,
   affecting dev servers and install-time tooling) are either resolved by
   the breaking upgrade (vite 8 / electron-vite 6) or explicitly accepted in
   writing as dev-only. Note what gets bundled: electron-builder packs
   `electron` plus production deps (react/react-dom) - the vulnerable
   dev tooling does NOT ship inside the app.
2. Packaging checks pass: the artifact launches on a clean Mac, quarantine
   instructions verified, correct version string, and no harness behavior
   active in production (the OPEN_ARC_* hooks are inert without their env
   vars - verified by code read, worth one runtime confirmation).
3. Owner approval to publish (Sanskar). Nothing is ever auto-published.
