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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function launch(phase) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      OPEN_ARC_SHOT_DIR: outDir,
      OPEN_ARC_PHASE: phase,
      OPEN_ARC_USER_DATA: profile,
      OPEN_ARC_NO_SANDBOX: '1'
    }
    // Software-compositing flags must ride the real command line; some
    // Chromium switches are unreliable via appendSwitch in every environment.
    const gpuFlags = ['--no-sandbox', '--in-process-gpu', '--disable-gpu-compositing']
    let cmd = electronPath
    let args = ['.', ...gpuFlags]
    if (!process.env.DISPLAY) {
      cmd = 'xvfb-run'
      args = ['-a', '-s', '-screen 0 1280x840x24', electronPath, '.', ...gpuFlags]
    }
    console.log(`[smoke] launching phase=${phase}`)
    const p = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('error', (e) => { console.error(`[smoke] launch failed: ${e.message}`); resolve(1) })
    p.on('exit', (code) => resolve(code ?? 1))
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
rmSync(profile, { recursive: true, force: true })

let failed = runCode !== 0 || verifyCode !== 0
for (const file of ['report-run.json', 'report-verify.json']) {
  const r = report(file)
  if (!r) { console.error(`[smoke] missing ${file}`); failed = true; continue }
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
console.log(`[smoke] screenshots in ${outDir}`)
process.exit(failed ? 1 : 0)
