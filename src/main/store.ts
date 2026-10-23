import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState } from '../shared/types'

/**
 * JSON persistence for the sidebar data model (spaces, pins, today tabs).
 * Atomic writes (tmp + rename) so a crash mid-save never corrupts state.
 */
export class StateStore {
  private file: string
  private timer: NodeJS.Timeout | null = null
  /** Set when load() found an unreadable state file and moved it aside. */
  quarantinedTo: string | null = null

  constructor() {
    const dir = join(app.getPath('userData'), 'open-arc')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'state.json')
  }

  load(): AppState | null {
    if (!existsSync(this.file)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as AppState
      if (!Array.isArray(parsed.spaces) || parsed.spaces.length === 0) throw new Error('state has no spaces')
      return parsed
    } catch (err) {
      // Never silently overwrite a state file we cannot read: move it aside
      // so the original bytes survive for inspection or manual recovery,
      // then boot with defaults. A missing file (first run) is NOT this path.
      const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try {
        renameSync(this.file, backup)
        this.quarantinedTo = backup
        console.warn(`[openarc] saved state unreadable (${String(err)}); original moved to ${backup}; starting fresh`)
      } catch (moveErr) {
        console.warn(`[openarc] saved state unreadable (${String(err)}); could not move it aside (${String(moveErr)}); starting fresh without touching it`)
      }
      return null
    }
  }

  /** Debounced save: rapid tab churn coalesces into one write. */
  save(state: AppState): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(state), 300)
  }

  flush(state: AppState): void {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
