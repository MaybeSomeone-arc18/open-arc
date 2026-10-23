#!/usr/bin/env node
/** Logic tests for crash-recovery helpers (npm run test:recovery). Native crash behavior is covered in the Electron smoke suite. */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'oa-rec-')), 'r.mjs')
await build({ entryPoints: [join(root, 'src/main/recovery.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' })
const R = await import(pathToFileURL(out).href)
let fail = 0
const t = (n, ok) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', n) }
const g = new R.CrashGate(1000)
t('first crash auto-recovers', g.shouldAutoRecover('a', 0))
t('repeat inside window does not', !g.shouldAutoRecover('a', 500))
t('other key independent', g.shouldAutoRecover('b', 500))
t('after window recovers again', g.shouldAutoRecover('a', 1500))
t('forget resets', (g.forget('a'), g.shouldAutoRecover('a', 1600)))
t('clean-exit is not a crash', !R.isCrashReason('clean-exit'))
t('crashed/oom/launch-failed/killed are crashes', ['crashed', 'oom', 'launch-failed', 'abnormal-exit', 'killed'].every(R.isCrashReason))
const u = decodeURIComponent(R.crashedPageUrl('http://x/<script>alert(1)</script>"', '<b>oom'))
t('crashed page escapes url and reason, has no script', !u.includes('<script') && !u.includes('<b>oom') && u.includes('&lt;script&gt;') && u.startsWith('data:text/html'))
process.exit(fail ? 1 : 0)
