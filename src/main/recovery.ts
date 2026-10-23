/** Crash-recovery helpers. No electron dependency, so they are unit-testable. */

/** Allows one automatic recovery per key per window; repeated crashes fall through to a visible page. */
export class CrashGate {
  private last = new Map<string, number>()
  constructor(private windowMs = 30_000) {}
  shouldAutoRecover(key: string, now = Date.now()): boolean {
    const prev = this.last.get(key)
    if (prev !== undefined && now - prev < this.windowMs) return false
    this.last.set(key, now)
    return true
  }
  forget(key: string): void {
    this.last.delete(key)
  }
}

/** Clean exits and deliberate kills are not crashes. */
export function isCrashReason(reason: string): boolean {
  return reason !== 'clean-exit'
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** Static page shown when a tab keeps crashing. Inert HTML: no script. */
export function crashedPageUrl(url: string, reason: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>This page crashed</title>
<body style="margin:0;background:#141418;color:#e8e8ea;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<div class="oa-crashed" style="max-width:520px;text-align:center;padding:32px">
<h1 style="font-size:20px;margin:0 0 12px">This page crashed</h1>
<div style="font-size:13px;opacity:.7;word-break:break-all;margin-bottom:12px">${esc(url)}</div>
<div style="font-size:13px;opacity:.55">Reason: ${esc(reason)}</div>
<div style="font-size:12px;opacity:.45;margin-top:16px">It crashed again right after a reload. Press Ctrl+R to try this page again.</div>
</div></body>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}
