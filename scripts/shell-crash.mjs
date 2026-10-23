#!/usr/bin/env node
/**
 * Native shell-renderer crash test (npm run test:shellcrash). Linux only: it
 * starts its own Xvfb and answers the REAL native dialog with xdotool.
 * Needs `npm run build` first. Separate profile, separate from the smoke suite.
 *   scenario reload: crash, auto-reload, crash again -> dialog -> Return (Reload) -> shell responds
 *   scenario quit:   crash, auto-reload, crash again -> dialog -> Escape (Quit)   -> app exits, state on disk
 * Writes the dialog screenshot to $OPEN_ARC_CRASH_SHOT (default: tmp).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const electronPath = createRequire(import.meta.url)('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'linux') { console.error('linux only (needs Xvfb + xdotool)'); process.exit(2) }
if (!existsSync(join(root, 'out/main/index.js'))) { console.error('run `npm run build` first'); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const flags = ['--no-sandbox', '--in-process-gpu', '--disable-gpu-compositing', '--no-zygote', '--disable-dev-shm-usage']
let overall = true
const say = (ok, name, d = '') => { if (!ok) overall = false; console.log(ok ? 'PASS' : 'FAIL', name, d) }

async function scenario(kind, display) {
  const profile = mkdtempSync(join(tmpdir(), 'oa-sc-p-'))
  const outDir = mkdtempSync(join(tmpdir(), 'oa-sc-o-'))
  const env = { ...process.env, DISPLAY: display, OPEN_ARC_SHOT_DIR: outDir, OPEN_ARC_PHASE: 'shellcrash', OPEN_ARC_USER_DATA: profile, OPEN_ARC_NO_SANDBOX: '1', OPEN_ARC_SHELLCRASH_EXPECT: kind }
  const p = spawn(electronPath, ['.', ...flags], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
  let exited = null
  p.on('exit', (c) => { exited = c ?? 1 })
  const prog = join(outDir, 'report-shellcrash-progress.json')
  const t0 = Date.now()
  while (!existsSync(prog) && exited === null && Date.now() - t0 < 60000) await sleep(250)
  say(existsSync(prog), `[${kind}] harness reached the repeat crash and the dialog is expected`)
  if (existsSync(prog)) {
    await sleep(1500)
    const shot = process.env.OPEN_ARC_CRASH_SHOT || join(tmpdir(), `shellcrash-dialog-${kind}.png`)
    const img = join(outDir, 'dialog.png')
    spawnSync('import', ['-display', display, '-window', 'root', img])
    if (existsSync(img)) copyFileSync(img, shot.replace(/\.png$/, `-${kind}.png`))
    const tree = spawnSync('xwininfo', ['-display', display, '-root', '-tree'], { encoding: 'utf8' }).stdout || ''
    const wins = tree.split('\n').filter((l) => /\d+x\d+\+/.test(l))
    console.log(`[${kind}] named X windows while dialog open:\n` + wins.slice(0, 12).join('\n'))
    spawnSync('xdotool', ['key', kind === 'quit' ? 'Escape' : 'Return'], { env })
  }
  const t1 = Date.now()
  while (exited === null && Date.now() - t1 < 45000) await sleep(250)
  if (kind === 'quit') {
    say(exited === 0, '[quit] Escape (Quit) closed the app', `exit=${exited}`)
    const sf = join(profile, 'open-arc', 'state.json')
    let ok = false
    try { ok = JSON.parse(readFileSync(sf, 'utf8')).spaces.length >= 1 } catch { /* below */ }
    say(ok, '[quit] saved state present on disk after Quit')
  } else {
    let rep = null
    try { rep = JSON.parse(readFileSync(join(outDir, 'report-shellcrash.json'), 'utf8')) } catch { /* below */ }
    say(exited === 0 && !!rep, '[reload] app exited cleanly after tests', `exit=${exited}`)
    for (const c of rep?.checks ?? []) say(c.pass, c.name, c.detail || '')
  }
  if (exited === null) p.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true })
}

const display = ':97'
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x840x24'], { stdio: 'ignore' })
await sleep(1500)
try {
  await scenario('reload', display)
  await scenario('quit', display)
} finally { xvfb.kill() }
process.exit(overall ? 0 : 1)
