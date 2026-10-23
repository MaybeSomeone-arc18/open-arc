#!/usr/bin/env node
/** Native shell-renderer crash test (npm run test:shellcrash). Needs `npm run build` first; own profile, separate from the smoke suite. */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const electronPath = createRequire(import.meta.url)('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(root, 'out/main/index.js'))) { console.error('run `npm run build` first'); process.exit(1) }
const profile = mkdtempSync(join(tmpdir(), 'open-arc-shellcrash-'))
const outDir = mkdtempSync(join(tmpdir(), 'open-arc-shellcrash-out-'))
const env = { ...process.env, OPEN_ARC_SHOT_DIR: outDir, OPEN_ARC_PHASE: 'shellcrash', OPEN_ARC_USER_DATA: profile, OPEN_ARC_NO_SANDBOX: '1' }
const flags = ['--no-sandbox', '--in-process-gpu', '--disable-gpu-compositing', '--no-zygote', '--disable-dev-shm-usage']
let cmd = electronPath, args = ['.', ...flags]
if (process.platform === 'linux' && !process.env.DISPLAY) { cmd = 'xvfb-run'; args = ['-a', '-s', '-screen 0 1280x840x24', electronPath, '.', ...flags] }
const code = await new Promise((res) => { const p = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] }); p.on('exit', (c) => res(c ?? 1)); p.on('error', () => res(1)) })
let ok = code === 0
try { for (const c of JSON.parse(readFileSync(join(outDir, 'report-shellcrash.json'), 'utf8')).checks) console.log(c.pass ? 'PASS' : 'FAIL', c.name, c.detail || '') } catch { console.error('missing report'); ok = false }
rmSync(profile, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
