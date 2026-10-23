import { pathToFileURL } from 'node:url'
import { COMMANDS } from '../shared/commands'

/**
 * IPC sender validation + permission policy. No runtime dependency on
 * electron (type-only shapes below) so the logic is unit-testable in plain Node.
 * Reference: electronjs.org/docs/latest/tutorial/security (item 17) and the
 * ipcMain / session API docs.
 */

export interface FrameLike {
  url: string
  parent?: unknown | null
}
export interface SenderEvent {
  sender: { id: number }
  senderFrame?: FrameLike | null
}
export interface TrustConfig {
  /** webContents id of the shell BrowserWindow. */
  shellWebContentsId: number
  /** Dev server URL (ELECTRON_RENDERER_URL) when running in development. */
  devUrl?: string
  /** Absolute path of the packaged renderer index.html. */
  packagedIndexPath?: string
}

/** True only for the exact shell page: dev origin, or the packaged index file. */
export function isTrustedOrigin(rawUrl: string, cfg: TrustConfig): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (cfg.devUrl) {
    try {
      return u.origin !== 'null' && u.origin === new URL(cfg.devUrl).origin
    } catch {
      return false
    }
  }
  if (cfg.packagedIndexPath) {
    if (u.protocol !== 'file:') return false
    return u.pathname === pathToFileURL(cfg.packagedIndexPath).pathname
  }
  return false
}

/** Shell WebContents, main frame only, trusted origin. Fails closed. */
export function isTrustedSender(e: SenderEvent, cfg: TrustConfig): boolean {
  if (!e || !e.sender || e.sender.id !== cfg.shellWebContentsId) return false
  const f = e.senderFrame
  if (!f || f.parent) return false // missing frame or subframe
  return isTrustedOrigin(f.url, cfg)
}

// ---- input validation (return the clean value, or null to reject) ----
const MAX_STR = 2048
export const str = (v: unknown, max = MAX_STR): string | null =>
  typeof v === 'string' && v.length <= max ? v : null
export const id = (v: unknown): string | null => {
  const s = str(v, 128)
  return s && /^[\w.:-]+$/.test(s) ? s : null
}
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null
/** Palette commands plus renderer-only ids that runCommand handles (Ctrl+1..9). */
const COMMAND_IDS = [...COMMANDS.map((c) => c.id), 'goto-tab']
export const commandId = (v: unknown): string | null => oneOf(v, COMMAND_IDS)
/** Only http(s) or a bare query/host the app already normalizes; never file:/javascript:/data:. */
export function userUrl(v: unknown): string | null {
  const s = str(v)
  if (s === null) return null
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(s)
  if (m && !['http', 'https', 'view-source'].includes(m[1].toLowerCase())) {
    // "host:port" style input has no scheme: allow when followed by digits
    if (!/^\s*[^:/\s]+:\d+(\/|$)/.test(s)) return null
  }
  return s
}

// ---- permissions: explicit fail-closed ----
export interface SessionLike {
  setPermissionRequestHandler(h: (wc: unknown, permission: string, cb: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(h: (wc: unknown, permission: string) => boolean): void
  setDevicePermissionHandler?(h: () => boolean): void
}
export function installPermissionPolicy(ses: SessionLike): void {
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler?.(() => false)
}
