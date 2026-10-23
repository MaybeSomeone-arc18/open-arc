import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState } from '../shared/types'

/**
 * JSON persistence for the sidebar data model (spaces, pins, today tabs).
 * Atomic writes (tmp + rename) so a crash mid-save never corrupts state.
 */
export class StateStore {
  private file: string
  private timer: NodeJS.Timeout | null = null

  constructor() {
    const dir = join(app.getPath('userData'), 'open-arc')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'state.json')
  }

  load(): AppState | null {
    try {
      if (!existsSync(this.file)) return null
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as AppState
      if (!Array.isArray(parsed.spaces) || parsed.spaces.length === 0) {
        this.quarantine()
        return null
      }
      return parsed
    } catch {
      this.quarantine()
      return null
    }
  }

  /** Unreadable state is kept aside (never silently overwritten by the next save). */
  private quarantine(): void {
    try {
      if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
    } catch { /* best effort */ }
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
