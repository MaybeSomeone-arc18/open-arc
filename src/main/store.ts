import { app } from 'electron'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  copyFileSync, readdirSync, statSync, openSync, fsyncSync, closeSync,
  appendFileSync, constants
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AppState, RecoveryMalformedNotice, RecoveryOfferInfo } from '../shared/types'

/** Timestamped file suffix; OPEN_ARC_FIXED_NOW is TEST-ONLY fault injection. */
const stamp = (): string => (process.env.OPEN_ARC_FIXED_NOW ?? new Date().toISOString()).replace(/[:.]/g, '-')
const isoOf = (ts: string): string => ts.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z')

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

interface Candidate {
  path: string
  name: string
  ts: string
  bytes: Buffer
  hash: string
  valid: boolean
  error?: string
  state?: AppState
}

interface Marker { name: string; sha256: string; decision: 'accepted' | 'declined' }

/** Strict structural validation for recovery candidates. Tolerant of
 *  missing optional fields (migrate() fills those); strict on wrong types
 *  for everything the app consumes. Throws on any violation. */
function validateStateShape(p: unknown): AppState {
  if (!p || typeof p !== 'object') throw new Error('state is not an object')
  const s = p as Record<string, unknown>
  if (!Array.isArray(s.spaces) || s.spaces.length === 0) throw new Error('state has no spaces')
  const checkTab = (t: unknown): void => {
    if (!t || typeof t !== 'object') throw new Error('tab is not an object')
    const tab = t as Record<string, unknown>
    if (typeof tab.id !== 'string' || typeof tab.url !== 'string' || typeof tab.title !== 'string') throw new Error('tab id/url/title must be strings')
    if (tab.favicon !== null && typeof tab.favicon !== 'string') throw new Error('tab favicon must be a string or null')
    if (typeof tab.pinned !== 'boolean') throw new Error('tab pinned must be a boolean')
    if (typeof tab.lastActiveAt !== 'number') throw new Error('tab lastActiveAt must be a number')
  }
  for (const sp of s.spaces) {
    if (!sp || typeof sp !== 'object') throw new Error('space is not an object')
    const space = sp as Record<string, unknown>
    for (const k of ['id', 'name', 'color', 'icon']) if (typeof space[k] !== 'string') throw new Error(`space ${k} must be a string`)
    for (const k of ['pinned', 'today', 'archived']) {
      if (!Array.isArray(space[k])) throw new Error(`space ${k} must be an array`)
      for (const t of space[k] as unknown[]) checkTab(t)
    }
    if (space.activeTabId !== null && typeof space.activeTabId !== 'string') throw new Error('space activeTabId must be a string or null')
    if (space.splitTabId !== null && typeof space.splitTabId !== 'string') throw new Error('space splitTabId must be a string or null')
  }
  if (typeof s.activeSpaceId !== 'string') throw new Error('activeSpaceId must be a string')
  if (s.sidebarVisible !== undefined && typeof s.sidebarVisible !== 'boolean') throw new Error('sidebarVisible must be a boolean')
  if (s.archiveAfterMs !== undefined && typeof s.archiveAfterMs !== 'number') throw new Error('archiveAfterMs must be a number')
  if (s.recentlyClosed !== undefined && !Array.isArray(s.recentlyClosed)) throw new Error('recentlyClosed must be an array')
  if (s.history !== undefined && !Array.isArray(s.history)) throw new Error('history must be an array')
  if (s.windowBounds !== undefined && s.windowBounds !== null) {
    const b = s.windowBounds as Record<string, unknown>
    for (const k of ['x', 'y', 'width', 'height']) if (typeof b[k] !== 'number') throw new Error(`windowBounds ${k} must be a number`)
  }
  return p as AppState
}

/**
 * JSON persistence for the sidebar data model (spaces, pins, today tabs).
 * Atomic writes (tmp + rename) so a crash mid-save never corrupts state.
 *
 * Recovery: when a previous session had to redirect saves into a
 * state.json.fresh-<ts> file, boot offers the user an explicit choice
 * before anything is moved or overwritten. Discovery is read-only;
 * housekeeping (retirement retries) never blocks boot and never deletes.
 */
export class StateStore {
  private dir: string
  private file: string
  private timer: NodeJS.Timeout | null = null
  /** Set when load() found an unreadable state file and moved it aside. */
  quarantinedTo: string | null = null
  /** Last save failure; null when the most recent flush succeeded. */
  lastSaveError: string | null = null
  /** Called when a debounced save fails (assigned by the app shell). */
  onSaveError: ((err: string) => void) | null = null
  /** While a recovery choice is pending, saves must not touch disk. */
  private holdSaves = false

  private candidates: Candidate[] = []
  private pendingCandidate: Candidate | null = null
  private offerInfo: RecoveryOfferInfo | null = null
  private malformedNotice: RecoveryMalformedNotice | null = null
  private pendingOriginalUnreadable = false

  constructor() {
    this.dir = join(app.getPath('userData'), 'open-arc')
    mkdirSync(this.dir, { recursive: true })
    this.file = join(this.dir, 'state.json')
  }

  private uniquePath(base: string): string {
    if (!existsSync(base)) return base
    for (let n = 2; ; n++) {
      const p = `${base}-${n}`
      if (!existsSync(p)) return p
    }
  }

  private markerPath(): string { return join(this.dir, 'state.json.recovery-log') }

  private readMarkers(): Map<string, Marker> {
    const map = new Map<string, Marker>()
    let text: string
    try { text = readFileSync(this.markerPath(), 'utf8') } catch { return map }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line) as Marker
        if (typeof m.name === 'string' && typeof m.sha256 === 'string') map.set(m.name, m)
      } catch { /* tolerate a torn line */ }
    }
    return map
  }

  private appendMarker(m: Marker): void {
    appendFileSync(this.markerPath(), JSON.stringify(m) + '\n', 'utf8')
  }

  /**
   * Read-only discovery: classify every state.json.fresh-<ts> file.
   * Nothing is moved, renamed or written here. A candidate whose bytes are
   * identical to the current state.json is an already-committed leftover
   * from an interrupted recovery and is suppressed (housekeeping retries
   * its bookkeeping later). Markers suppress only when the content hash
   * matches, so reused names with different bytes are never hidden.
   */
  private scanCandidates(statePath: string, stateBytes: Buffer | null): void {
    this.candidates = []
    let names: string[] = []
    try { names = readdirSync(this.dir) } catch { return }
    const markers = this.readMarkers()
    for (const name of names) {
      const m = /^state\.json\.fresh-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.exec(name)
      if (!m) continue
      const path = join(this.dir, name)
      let bytes: Buffer
      try { bytes = readFileSync(path) } catch { continue }
      const hash = sha256(bytes)
      const marker = markers.get(name)
      if (marker && marker.sha256 === hash) continue // decided already; housekeeping retires
      let valid = false
      let error: string | undefined
      let state: AppState | undefined
      try {
        state = validateStateShape(JSON.parse(bytes.toString('utf8')))
        valid = true
      } catch (err) { error = String(err) }
      if (valid && stateBytes && bytes.equals(stateBytes)) continue // committed leftover; housekeeping books it
      this.candidates.push({ path, name, ts: m[1], bytes, hash, valid, error, state })
    }
    this.candidates.sort((a, b) => (a.ts < b.ts ? -1 : 1))
  }

  /** Post-boot housekeeping, best-effort: retry bookkeeping/retirement for
   *  candidates discovery suppressed. Never throws, never blocks boot. */
  housekeeping(): void {
    let names: string[] = []
    try { names = readdirSync(this.dir) } catch { return }
    const markers = this.readMarkers()
    const statePath = join(this.dir, 'state.json')
    let stateBytes: Buffer | null = null
    try { stateBytes = readFileSync(statePath) } catch { /* absent or unreadable */ }
    for (const name of names) {
      if (!/^state\.json\.fresh-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name)) continue
      const path = join(this.dir, name)
      let bytes: Buffer
      try { bytes = readFileSync(path) } catch { continue }
      const hash = sha256(bytes)
      const marker = markers.get(name)
      if (!marker && stateBytes && bytes.equals(stateBytes)) {
        // Recognized as already-committed: record the bookkeeping WITHOUT
        // renaming the file (discovery stays non-destructive); the marker
        // alone suppresses re-offers, even after state.json diverges.
        try { this.appendMarker({ name, sha256: hash, decision: 'accepted' }) } catch { /* retry next boot */ }
        continue
      }
      if (!marker || marker.sha256 !== hash) continue
      // A recorded user decision whose retirement was interrupted: retry it.
      try { renameSync(path, this.uniquePath(`${path}.${marker.decision}-${stamp()}`)) } catch { /* retry next boot */ }
    }
  }

  private quarantineUnreadable(statePath: string, err: unknown): void {
    // Deterministic stamped name; collision-safe against an existing FILE
    // (an older backup is never clobbered). A DIRECTORY at the plain name
    // is the test-injected EISDIR fault and must reach the rename unchanged.
    let backup = `${statePath}.corrupt-${stamp()}`
    try {
      if (existsSync(backup) && statSync(backup).isFile()) backup = this.uniquePath(backup)
      renameSync(statePath, backup)
      this.quarantinedTo = backup
      console.warn(`[openarc] saved state unreadable (${String(err)}); original moved to ${backup}; starting fresh`)
    } catch (moveErr) {
      console.warn(`[openarc] saved state unreadable (${String(err)}); could not move it aside (${String(moveErr)}); starting fresh without touching it`)
      // Redirect future saves to a fresh file so they never replace the
      // unreadable original.
      this.file = `${statePath}.fresh-${stamp()}`
    }
  }

  load(): AppState | null {
    const statePath = join(this.dir, 'state.json')
    this.file = statePath

    // Read the normal state without any side effects.
    let parsed: AppState | null = null
    let unreadableErr: unknown = null
    let stateBytes: Buffer | null = null
    if (existsSync(statePath)) {
      try {
        stateBytes = readFileSync(statePath)
        const p = JSON.parse(stateBytes.toString('utf8'))
        if (!Array.isArray(p.spaces) || p.spaces.length === 0) throw new Error('state has no spaces')
        parsed = p as AppState
      } catch (err) { unreadableErr = err }
    }

    // Read-only candidate discovery, then the decision matrix.
    this.scanCandidates(statePath, unreadableErr ? null : stateBytes)
    const offerable = this.candidates.filter((c) => c.valid)
    const malformed = this.candidates.filter((c) => !c.valid)

    if (offerable.length > 0) {
      // A recoverable candidate exists: hold saves and offer a choice,
      // even when the normal state is valid (valid != stale).
      const chosen = offerable[offerable.length - 1]
      this.pendingCandidate = chosen
      this.pendingOriginalUnreadable = unreadableErr !== null
      this.offerInfo = {
        candidateName: chosen.name,
        candidateTimestamp: isoOf(chosen.ts),
        spaceCount: chosen.state!.spaces.length,
        spaceNames: chosen.state!.spaces.map((s) => s.name).slice(0, 5),
        currentTimestamp: existsSync(statePath) ? statSync(statePath).mtime.toISOString() : null,
        currentValid: parsed !== null,
        otherNames: offerable.slice(0, -1).map((c) => c.name),
        malformedNames: malformed.map((c) => c.name)
      }
      this.holdSaves = true
      if (unreadableErr) console.warn(`[openarc] saved state unreadable (${String(unreadableErr)}); holding it untouched while the recovery choice is pending`)
      return parsed
    }

    if (malformed.length > 0) {
      this.malformedNotice = { names: malformed.map((c) => c.name), currentValid: parsed !== null }
    }

    if (unreadableErr) {
      // No recovery pending: existing quarantine behavior.
      this.quarantineUnreadable(statePath, unreadableErr)
      return null
    }
    return parsed
  }

  getRecoveryOffer(): RecoveryOfferInfo | null { return this.offerInfo }
  getMalformedNotice(): RecoveryMalformedNotice | null { return this.malformedNotice }

  /**
   * Accept the offered candidate. Order: verified byte backup of the
   * original (which never leaves its path) -> stage candidate raw bytes to
   * a unique tmp, fsync, one atomic rename -> directory fsync -> marker ->
   * retire. Once the rename lands the recovery is COMMITTED: later
   * failures are warnings, never a rollback.
   */
  acceptRecovery(): { ok: boolean; error?: string; warning?: string; state?: AppState } {
    const cand = this.pendingCandidate
    if (!cand || !cand.valid || !cand.state) return { ok: false, error: 'no valid recovery candidate' }
    const statePath = join(this.dir, 'state.json')
    try {
      if (existsSync(statePath)) {
        const backup = this.uniquePath(`${statePath}.corrupt-${stamp()}`)
        copyFileSync(statePath, backup, constants.COPYFILE_EXCL)
        const a = readFileSync(statePath)
        const b = readFileSync(backup)
        if (a.length !== b.length || !a.equals(b)) throw new Error('backup verification failed')
      }
      // No uniquePath here: a stale tmp from a crashed recovery is our own
      // staging file and may be overwritten; a DIRECTORY at this exact path
      // is the test-injected staging-write failure (EISDIR).
      const tmp = `${statePath}.tmp-${stamp()}`
      writeFileSync(tmp, cand.bytes)
      const fd = openSync(tmp, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, statePath)
      // Committed. Everything below is durability/bookkeeping.
      const warnings: string[] = []
      try {
        if (process.env.OPEN_ARC_FAULT_INJECT === 'dirsync') throw new Error('injected dirsync failure') // TEST-ONLY
        const dfd = openSync(this.dir, 'r')
        try { fsyncSync(dfd) } finally { closeSync(dfd) }
      } catch { warnings.push('directory sync failed; the rename may not survive a power loss') }
      try {
        this.appendMarker({ name: cand.name, sha256: cand.hash, decision: 'accepted' })
      } catch { warnings.push('recovery bookkeeping write failed; the recovery file may be offered once more') }
      try {
        if (process.env.OPEN_ARC_FAULT_INJECT === 'retire') throw new Error('injected retire failure') // TEST-ONLY
        renameSync(cand.path, this.uniquePath(`${cand.path}.accepted-${stamp()}`))
      } catch { warnings.push(`recovery file ${cand.name} left in place (retire failed); its contents are already committed`) }
      this.pendingCandidate = null
      this.offerInfo = null
      this.holdSaves = false
      this.pendingOriginalUnreadable = false
      this.file = statePath
      return { ok: true, warning: warnings.length ? warnings.join('; ') : undefined, state: cand.state }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `recovery failed before any change was committed (${message}); the original and the recovery file are unchanged` }
    }
  }

  /** Reject the offered candidate: record first (failure = nothing moves),
   *  then retire it byte-preservingly. An unreadable original is only
   *  quarantined now, after the explicit decision. */
  declineRecovery(): { ok: boolean; error?: string } {
    const cand = this.pendingCandidate
    if (!cand) return { ok: false, error: 'no recovery candidate pending' }
    try {
      this.appendMarker({ name: cand.name, sha256: cand.hash, decision: 'declined' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `could not record the decision; nothing was changed (${message})` }
    }
    try { renameSync(cand.path, this.uniquePath(`${cand.path}.declined-${stamp()}`)) } catch { /* retried at next boot */ }
    this.pendingCandidate = null
    this.offerInfo = null
    if (this.pendingOriginalUnreadable) {
      this.quarantineUnreadable(join(this.dir, 'state.json'), new Error('state unreadable'))
      this.pendingOriginalUnreadable = false
    }
    this.holdSaves = false
    return { ok: true }
  }

  /** Malformed-only notice: keep=true means decide later (re-noticed next
   *  launch); keep=false retires each malformed file byte-preservingly. */
  dismissMalformed(keep: boolean): { ok: boolean; error?: string } {
    if (!this.malformedNotice) return { ok: false, error: 'no malformed notice pending' }
    if (!keep) {
      for (const c of this.candidates.filter((c) => !c.valid)) {
        try {
          this.appendMarker({ name: c.name, sha256: c.hash, decision: 'declined' })
          try { renameSync(c.path, this.uniquePath(`${c.path}.declined-${stamp()}`)) } catch { /* retried at next boot */ }
        } catch { /* marker failed: leave the file, re-noticed next launch */ }
      }
    }
    this.malformedNotice = null
    return { ok: true }
  }

  /** Debounced save: rapid tab churn coalesces into one write. */
  save(state: AppState): void {
    if (this.holdSaves) return // recovery choice pending: touch nothing
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(state), 300)
  }

  flush(state: AppState): void {
    if (this.holdSaves) return
    try {
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, this.file)
      this.lastSaveError = null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastSaveError = message
      console.warn(`[openarc] state save failed: ${message}`)
      if (this.onSaveError) {
        try {
          this.onSaveError(message)
        } catch {
          /* listener errors must not escape the timer */
        }
      }
    }
  }
}
