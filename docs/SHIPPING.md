# Shipping policy (minimal)

Product principle: ship a useful, working browser early; keep improving it
continuously without compromising user data, security, or core functionality.
Do not chase perfection before allowing people to use it.

- `main` stays buildable. CI (typecheck + production build) must pass on
  every merge; the smoke suite must pass on Linux.
- New work happens on short-lived branches, merged by pull request. No
  direct pushes to `main`, no history rewrites.
- Every feature has acceptance criteria and appropriate regression tests in
  the smoke suite. Features whose native behavior cannot be automated are
  labeled experimental until verified on real hardware - they do not block
  releases by themselves.
- Every release has installation instructions, known limitations, and a
  recoverable previous version (tagged releases; binaries only after the
  packaging gates in docs/PACKAGING.md pass).
- Critical data-loss or security bugs take priority over feature
  development.
- Minor cosmetic issues do not indefinitely delay a usable release.
- User feedback informs the next features instead of assuming we know what
  everyone needs.
