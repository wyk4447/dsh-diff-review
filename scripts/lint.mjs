/**
 * The lint: the mistakes this codebase has actually made before.
 *
 * It is not a general style checker. It checks three things that have each
 * broken the panel in the past and that nothing else would have caught:
 *
 *  - a file that does not parse at all (caught by `node --check`);
 *  - a Chinese sentence with no English one next to it, or the other way
 *    round — the panel falls back to a raw key, and a reader sees
 *    "editReasonStale" instead of a sentence;
 *  - a lookup for a key that no dictionary holds, which the panel answers
 *    with the generic failure text and hides the real reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
let passes = 0

function check(label, condition, detail) {
  if (condition) {
    passes += 1
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.claude' || name === '.dsh' || name === 'assets') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/* ---- every file parses ---- */
for (const file of walk(root)) {
  if (!/\.(?:js|mjs|cjs)$/.test(file)) continue
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  check(`${relative(root, file)} parses`, result.status === 0, (result.stderr ?? '').split('\n').slice(0, 3).join(' '))
}

/* ---- the two dictionaries say the same things ---- */
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** The keys of one dictionary literal, in order. */
function keysOf(name) {
  const start = client.indexOf(`const ${name} = {`)
  if (start === -1) return null
  const end = client.indexOf('\n\t\t};', start)
  if (end === -1) return null
  const body = client.slice(start, end)
  const keys = []
  for (const match of body.matchAll(/^\s*"([^"]+)":/gm)) keys.push(match[1])
  return keys
}

const zh = keysOf('zh')
const en = keysOf('en')
check('the Chinese dictionary is found', zh !== null)
check('the English dictionary is found', en !== null)

if (zh !== null && en !== null) {
  const zhSet = new Set(zh)
  const enSet = new Set(en)
  for (const key of zh) {
    if (!enSet.has(key)) check(`the English dictionary has ${key}`, false)
  }
  for (const key of en) {
    if (!zhSet.has(key)) check(`the Chinese dictionary has ${key}`, false)
  }
  check('the two dictionaries have the same keys', zh.length === en.length, `${zh.length} zh / ${en.length} en`)
  check('no key is used twice in Chinese', zhSet.size === zh.length)
  check('no key is used twice in English', enSet.size === en.length)
}

/* ---- every lookup finds a key ---- */
const used = new Set()
for (const match of client.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(match[1])
if (zh !== null) {
  const zhSet = new Set(zh)
  for (const key of used) {
    check(`the dictionary has ${key}`, zhSet.has(key))
  }
}
check('the panel looks up more than a handful of strings', used.size > 20, String(used.size))

console.log(`${failures === 0 ? 'LINT OK' : `${failures} FAILED`} (${passes} passed)`)
if (failures > 0) process.exit(1)
