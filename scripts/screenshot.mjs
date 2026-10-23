#!/usr/bin/env node
/**
 * Open Arc smoke suite (npm run shot).
 *
 * Launches the REAL production build (out/, run `npm run build` first) twice
 * against a fresh temporary profile:
 *   phase=run     drives window controls, command bar, navigation, tab
 *                 switching, spaces, split view, pin and auto-archive, and
 *                 captures genuine screenshots (shell via the window, page
 *                 content via each tab's WebContentsView).
 *   phase=verify  relaunches on the same profile and checks that spaces,
 *                 pinned tabs and the archive survived the restart.
 *
 * Output: shots/*.png, shots/report-run.json, shots/report-verify.json.
 * Exit code is non-zero if any check fails.
 *
 * Requirements: Linux with a display, or xvfb-run for headless use; network
 * access (the suite loads example.com, example.org and wikipedia.org for real).
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'shots')
const profile = mkdtempSync(join(tmpdir(), 'open-arc-smoke-'))

if (!existsSync(join(root, 'out/main/index.js'))) {
  console.error('out/ not found - run `npm run build` first')
  process.exit(1)
}

function launch(phase, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      OPEN_ARC_SHOT_DIR: outDir,
      OPEN_ARC_PHASE: phase,
      OPEN_ARC_USER_DATA: profile,
      OPEN_ARC_NO_SANDBOX: '1',
      ...extraEnv
    }
    // Software-compositing flags must ride the real command line; some
    // Chromium switches are unreliable via appendSwitch in every environment.
    const gpuFlags = [
      '--no-sandbox',
      '--in-process-gpu',
      '--disable-gpu-compositing',
      // Containers can end up with a broken zygote spawn path (renderer
      // processes die silently right after did-start-loading, which also
      // stalls findInPage/executeJavaScript). Launching renderers directly
      // keeps the suite reliable there; harmless on a normal desktop.
      '--no-zygote',
      '--disable-dev-shm-usage'
    ]
    let cmd = electronPath
    let args = ['.', ...gpuFlags]
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      cmd = 'xvfb-run'
      args = ['-a', '-s', '-screen 0 1280x840x24', electronPath, '.', ...gpuFlags]
    }
    // macOS/Windows launch Electron directly: they always have a window server.
    console.log(`[smoke] launching phase=${phase}`)
    const p = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
    // A phase must never hang the suite: kill it past the watchdog.
    const watchdog = setTimeout(() => {
      console.error(`[smoke] phase=${phase} exceeded 150s watchdog - killing (recorded as exit 124)`)
      p.kill('SIGKILL')
      resolve(124)
    }, 150000)
    p.on('error', (e) => { console.error(`[smoke] launch failed: ${e.message}`); clearTimeout(watchdog); resolve(1) })
    p.on('exit', (code) => { clearTimeout(watchdog); resolve(code ?? 1) })
  })
}

function report(file) {
  try {
    return JSON.parse(readFileSync(join(outDir, file), 'utf8'))
  } catch {
    return null
  }
}

const runCode = await launch('run')
const verifyCode = runCode === 0 ? await launch('verify') : 1

// State-recovery phases: plant an unreadable, then an older-but-readable
// state file and boot the real app over each.
const stateDir = join(profile, 'open-arc')
const stateFile = join(stateDir, 'state.json')
const garbage = '{"spaces":[{"id":"broken","name":"Half","pinned":[],' // truncated JSON
writeFileSync(stateFile, garbage)
const corruptCode = verifyCode === 0 ? await launch('corrupt') : 1
writeFileSync(stateFile, JSON.stringify({
  spaces: [{ id: 's1', name: 'Recovered Space', color: '#8888ff', icon: 'R', pinned: [], today: [], archived: [], activeTabId: null }],
  activeSpaceId: 's1',
  sidebarVisible: true
}))
const partialCode = corruptCode === 0 ? await launch('partial') : 1
const savefailCode = partialCode === 0 ? await launch('savefail') : 1
// quaranfail: the quarantine rename itself fails (read-only dir at boot).
writeFileSync(stateFile, garbage)
chmodSync(stateDir, 0o555)
const quaranCode = savefailCode === 0 ? await launch('quaranfail', { OPEN_ARC_PLANTED_GARBAGE: garbage }) : 1
chmodSync(stateDir, 0o755) // restore so the profile can be cleaned up
// The unreadable original must survive as a quarantined copy, byte-for-byte.
let preserved = false
let preserveDetail = 'no quarantine file'
try {
  const q = readdirSync(stateDir).filter((f) => f.startsWith('state.json.corrupt-'))
  preserved = q.length === 1 && readFileSync(join(stateDir, q[0]), 'utf8') === garbage
  preserveDetail = q.length + ' quarantine file(s), bytes ' + (preserved ? 'match' : 'MISMATCH')
} catch (e) { preserveDetail = String(e) }
console.log((preserved ? 'PASS' : 'FAIL') + '  recovery: quarantined original bytes preserved  (' + preserveDetail + ')')
rmSync(profile, { recursive: true, force: true })

let failed = runCode !== 0 || verifyCode !== 0 || corruptCode !== 0 || partialCode !== 0 || savefailCode !== 0 || quaranCode !== 0 || !preserved
for (const file of ['report-run.json', 'report-verify.json', 'report-corrupt.json', 'report-partial.json', 'report-savefail.json', 'report-quaranfail.json']) {
  const r = report(file)
  if (!r) { console.error(`[smoke] missing ${file}`); failed = true; continue }
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
console.log(`[smoke] screenshots in ${outDir}`)
process.exit(failed ? 1 : 0)
