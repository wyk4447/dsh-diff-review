/**
 * The `/diff-review` command.
 *
 * The panel carries the two switches — "do not review this conversation" and
 * "allow everything" — and the composer carries none. That is a hole exactly
 * where it hurts: a silenced conversation shows no panel, so the panel cannot
 * be where it is woken up again. The command reaches the same switch from the
 * place the reader already is.
 *
 * The registry is faked here, the way the host offers it: a service the plugin
 * asks for by name and registers a definition with.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

// The switch list lives next to the snapshots. A test must not write to the
// real one: the reader's own conversations are in it.
const root = mkdtempSync(join(tmpdir(), 'diff-review-command-'))
process.env.DSH_DIFF_REVIEW_HISTORY_ROOT = root

const results = []
const check = (label, value) => results.push([label, value === true])

const registered = []
const ctx = {
  get: (name) =>
    name === 'commands'
      ? {
          register: (definition) => {
            registered.push(definition)
            return () => {}
          },
        }
      : undefined,
  effect: (fn) => {
    const disposer = fn()
    return () => disposer && disposer()
  },
  on: () => () => {},
  webServer: { register: () => () => {} },
  connection: { requestRejection: () => undefined },
  fs: {},
}

apply(ctx, { trace: false })

check('the command is registered', registered.length === 1)
const definition = registered[0]
check('it is named diff-review', definition?.name === 'diff-review')
check('it says what it is for', typeof definition?.description === 'string' && definition.description !== '')
check('it takes an argument', definition?.input?.hint !== undefined)

const handler = definition?.handler
const run = (rawInput, id = 'session-under-test') => handler({ agent: { id }, rawInput, attachments: [], signal: new AbortController().signal })

/* ---- status ---- */
const status = run('status')
check('status succeeds', status?.kind === 'success')
check('status says the review is on', String(status?.text ?? '').includes('Review: on'))
check('status counts nothing pending', String(status?.text ?? '').includes('Pending: 0'))

/* ---- off ---- */
const off = run('off')
check('off succeeds', off?.kind === 'success')
check('off says so in words', String(off?.text ?? '').includes('Review is off'))
const table = JSON.parse(readFileSync(join(root, 'review-off.json'), 'utf8'))
check('off reaches the disk', table?.off?.['session-under-test'] === true)
check('status now says off', String(run('status').text ?? '').includes('Review: off'))

/* ---- on ---- */
const on = run('on')
check('on succeeds', on?.kind === 'success')
check('on says so in words', String(on?.text ?? '').includes('Review is on'))
const after = JSON.parse(readFileSync(join(root, 'review-off.json'), 'utf8'))
check('on takes the conversation off the list', after?.off?.['session-under-test'] === undefined)
check('status says on again', String(run('status').text ?? '').includes('Review: on'))

/* ---- the id the host hands out ---- */
// The host's session id carries the working directory (`session-…@D:\wp`)
// while the gate and the panel key everything by the bare id. A switch that
// landed on the wrong one would look like it worked and change nothing.
const composite = run('off', 'session-with-cwd@D:\\wp')
check('a composite id is accepted', composite?.kind === 'success')
const compositeTable = JSON.parse(readFileSync(join(root, 'review-off.json'), 'utf8'))
check('a composite id lands on the bare key', compositeTable?.off?.['session-with-cwd'] === true)
check('a composite id leaves no second key', compositeTable?.off?.['session-with-cwd@D:\\wp'] === undefined)

/* ---- nonsense ---- */
const wrong = run('maybe')
check('an unknown argument is refused', wrong?.kind === 'error')
check('the refusal says what is accepted', String(wrong?.text ?? '').includes('on | off | status'))
const empty = run('')
check('an empty argument means status', empty?.kind === 'success' && String(empty.text ?? '').includes('Review:'))

const failures = results.filter(([, ok]) => !ok)
for (const [label] of failures) console.error(`FAIL: ${label}`)
console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`} (${results.length} passed)`)
if (failures.length > 0) process.exit(1)
