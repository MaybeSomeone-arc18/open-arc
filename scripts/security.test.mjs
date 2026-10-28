#!/usr/bin/env node
/**
 * Logic/synthetic tests for IPC sender validation and the permission policy
 * (npm run test:security). These exercise src/main/security.ts with synthetic
 * events and a fake session. They are NOT native desktop tests: real
 * Electron IPC from a real subframe/foreign window is covered separately.
 */
import { build } from 'esbuild'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'oa-sec-')), 'security.mjs')
await build({ entryPoints: [join(root, 'src/main/security.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' })
const S = await import(pathToFileURL(out).href)

let pass = 0, fail = 0
const t = (name, ok) => { ok ? pass++ : (fail++, console.error('FAIL', name)); console.log(ok ? 'PASS' : 'FAIL', name) }

const dev = { shellWebContentsId: 7, devUrl: 'http://localhost:5173/' }
const pkgPath = '/Applications/Open Arc.app/Contents/Resources/app/out/renderer/index.html'
const pkg = { shellWebContentsId: 7, packagedIndexPath: pkgPath }
const ev = (id, url, parent = null) => ({ sender: { id }, senderFrame: url === undefined ? null : { url, parent } })
const pkgUrl = pathToFileURL(pkgPath).href

// allow
t('dev: shell main frame allowed', S.isTrustedSender(ev(7, 'http://localhost:5173/'), dev))
t('dev: shell main frame with path/hash allowed', S.isTrustedSender(ev(7, 'http://localhost:5173/index.html#x'), dev))
t('packaged: shell index.html allowed', S.isTrustedSender(ev(7, pkgUrl), pkg))
t('packaged: hash/query on index allowed', S.isTrustedSender(ev(7, pkgUrl + '?a=1#b'), pkg))
// deny
t('wrong webContents (tab view) rejected', !S.isTrustedSender(ev(9, 'http://localhost:5173/'), dev))
t('subframe of shell rejected', !S.isTrustedSender(ev(7, 'http://localhost:5173/', {}), dev))
t('missing senderFrame rejected', !S.isTrustedSender(ev(7, undefined), dev))
t('missing event rejected', !S.isTrustedSender(undefined, dev))
t('dev: foreign origin rejected', !S.isTrustedSender(ev(7, 'https://evil.example/'), dev))
t('dev: lookalike host rejected', !S.isTrustedSender(ev(7, 'http://localhost:5173.evil.example/'), dev))
t('dev: other port rejected', !S.isTrustedSender(ev(7, 'http://localhost:5174/'), dev))
t('packaged: http origin rejected', !S.isTrustedSender(ev(7, 'https://example.com/'), pkg))
t('packaged: other file rejected', !S.isTrustedSender(ev(7, 'file:///tmp/evil.html'), pkg))
t('packaged: dev URL not trusted', !S.isTrustedSender(ev(7, 'http://localhost:5173/'), pkg))
t('invalid url rejected', !S.isTrustedSender(ev(7, 'not a url'), dev))
t('about:blank / data: rejected', !S.isTrustedSender(ev(7, 'about:blank'), dev) && !S.isTrustedSender(ev(7, 'data:text/html,hi'), pkg))
t('no config fails closed', !S.isTrustedSender(ev(7, 'http://localhost:5173/'), { shellWebContentsId: 7 }))

// input validation
t('id: ok', S.id('tab-1_a.b:c') === 'tab-1_a.b:c')
t('id: rejects non-string/object/long/odd chars', S.id({}) === null && S.id(5) === null && S.id('x'.repeat(200)) === null && S.id('a b') === null && S.id('../x') === null)
t('str: length cap', S.str('x'.repeat(5000)) === null && S.str('ok') === 'ok' && S.str(null) === null)
t('oneOf: enum', S.oneOf('in', ['in', 'out']) === 'in' && S.oneOf('x', ['in']) === null && S.oneOf({}, ['in']) === null)
t('commandId: known only', S.commandId('new-tab') === 'new-tab' && S.commandId('rm-rf') === null && S.commandId(undefined) === null)
t('commandId: renderer-only goto-tab allowed', S.commandId('goto-tab') === 'goto-tab')
{
  const src = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const body = src.slice(src.indexOf('private runCommand('), src.indexOf('private ', src.indexOf('private runCommand(') + 10))
  const cases = [...body.matchAll(/^      case '([^']+)'/gm)].map((m) => m[1])
  const bad = cases.filter((c) => S.commandId(c) === null)
  t(`every runCommand case is reachable via the allowlist (${cases.length} cases; blocked: ${bad.join(',') || 'none'})`, cases.length > 10 && bad.length === 0)
}
t('userUrl: http/https/search/host allowed', ['https://a.com', 'http://a.com', 'wikipedia', 'a.com/x', 'localhost:3000'].every((u) => S.userUrl(u) === u))
t('userUrl: dangerous schemes rejected', ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://gpu', 'vbscript:x'].every((u) => S.userUrl(u) === null))
t('userUrl: non-string rejected', S.userUrl({}) === null && S.userUrl(null) === null)
t('profileId: valid alphanumeric and dash', S.profileId('work-123_a') === 'work-123_a' && S.profileId('personal') === 'personal')
t('profileId: rejects invalid/dangerous chars/length', S.profileId('../evil') === null && S.profileId('a b') === null && S.profileId('x'.repeat(100)) === null && S.profileId({}) === null)
t('partitionForProfile: empty/default maps to default session', S.partitionForProfile('') === '' && S.partitionForProfile(null) === '' && S.partitionForProfile('default') === '')
t('partitionForProfile: custom profile maps to persist:space-id', S.partitionForProfile('work') === 'persist:space-work')

// permissions
const calls = { req: [], chk: [], dev: 0 }
S.installPermissionPolicy({
  setPermissionRequestHandler: (h) => { calls.reqH = h },
  setPermissionCheckHandler: (h) => { calls.chkH = h },
  setDevicePermissionHandler: (h) => { calls.devH = h }
})
const perms = ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'openExternal', 'hid', 'serial', 'unknown-future']
t('request handler denies every permission', perms.every((p) => { let g = 'unset'; calls.reqH({}, p, (v) => (g = v)); return g === false }))
t('check handler denies every permission', perms.every((p) => calls.chkH({}, p) === false))
t('device handler denies', calls.devH() === false)
t('session without device handler ok', (() => { try { S.installPermissionPolicy({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }); return true } catch { return false } })())

// all-handler coverage (static): every channel the preload uses is registered, only via the guarded wrappers
const idx = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const pre = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
const preCh = [...pre.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1])
const reg = [...idx.matchAll(/\n\s+(handle|on)\('([^']+)'/g)].map((m) => m[2])
const missing = preCh.filter((c) => !reg.includes(c))
const orphan = reg.filter((c) => !preCh.includes(c))
t(`all ${preCh.length} preload channels registered (missing: ${missing.join(',') || 'none'})`, preCh.length > 0 && missing.length === 0)
t(`no registered channel without a preload caller (orphans: ${orphan.join(',') || 'none'})`, orphan.length === 0)
t('raw ipcMain.handle/on appears only inside the two guarded wrappers', (idx.match(/ipcMain\.(handle|on)\(/g) || []).length === 2 && /isTrustedSender\(e, this\.trust\(\)\) \? fn/.test(idx) && /if \(isTrustedSender\(e, this\.trust\(\)\)\) fn/.test(idx))
t('permission policy installed from main', /installPermissionPolicy\(session\.defaultSession\)/.test(idx))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
