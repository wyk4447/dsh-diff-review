/**
 * dsh-diff-review — host half.
 *
 * Gates mutating file tools (`write`, `edit`) behind a user review in the
 * sidebar: the call parks on a `tools/pre-execute` waterfall until the user
 * accepts or rejects the pending change, then either delegates to `next()`
 * (the tool really runs) or denies it.
 *
 * Transport to the browser half is a small same-origin HTTP surface fenced by
 * `ctx.connection.requestRejection`, mirroring the official `dsh-better-sidebar`
 * pattern. No typert descriptors, no profile surgery.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NS = 'diff-review'
const API_PREFIX = '/diff-review/api'
const MAX_BODY_BYTES = 1 << 20
const MAX_STORED_CHARS = 800_000
const MAX_DIFF_CELLS = 4_000_000
const CONTEXT_LINES = 3

const GATED_TOOLS = new Set(['write', 'edit', 'pwsh'])

/** PowerShell statements that destroy or rewrite a file without a `fs` call. */
const SHELL_DELETE_CMDLETS = new Set([
  'remove-item',
  'ri',
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
  'clear-content',
  'clc',
  'clear-item',
  'cli',
  'remove-itemproperty',
  'rename-item',
  'ren',
  'rni',
  'move-item',
  'mi',
  'move',
  'mv',
  'restore-item',
  'clear-recyclebin',
])
const SHELL_TRUNCATE_CMDLETS = new Set(['clear-content', 'clc', 'clear-item', 'cli'])
const SHELL_WRITE_CMDLETS = new Set([
  'set-content',
  'sc',
  'out-file',
  'add-content',
  'ac',
  'set-item',
  'si',
  'new-item',
  'ni',
  'set-itemproperty',
  'sp',
  'copy-item',
  'cpi',
  'copy',
  'cp',
  'tee-object',
  'tee',
  'export-csv',
  'epcsv',
  'export-clixml',
  'epcxml',
  'compress-archive',
  'expand-archive',
  'set-acl',
  'save-module',
  'stop-transcript',
  'mkdir',
  'md',
])
/** Of the write cmdlets, the ones that extend the file instead of replacing it. */
const SHELL_APPEND_CMDLETS = new Set(['add-content', 'ac'])
/** Flags whose following token is a value; only path-ish ones count as targets. */
const SHELL_VALUE_FLAGS = new Set([
  '-path',
  '-literalpath',
  '-filepath',
  '-destination',
  '-value',
  '-filter',
  '-include',
  '-exclude',
  '-credential',
  '-erroraction',
  '-stream',
  '-encoding',
  '-name',
  '-itemtype',
  '-delimiter',
  '-width',
  '-inputobject',
])
const SHELL_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-destination'])

/**
 * Everything below widens the net from "cmdlets we listed" to "anything that
 * looks like it writes".
 *
 * A whitelist of cmdlets can never cover PowerShell: `Set-Item`, `New-Item`,
 * `Tee-Object`, `Export-Csv`, `Rename-Item`, `Move-Item`, `Copy-Item`,
 * `[IO.File]::WriteAllText`, `cmd /c del`, `iex`, `git clean` and an open-ended
 * tail of community modules each rewrite files without mentioning a name we
 * happened to list. That is why the same class of report kept coming back after
 * every single-name patch. The rules now key off *shape* instead of inventory:
 * PowerShell's own verb-noun convention, .NET member calls, programs that take
 * code as a string, and the handful of external tools that mutate in place.
 */
const SHELL_MUTATING_PREFIXES = [
  'set-',
  'new-',
  'remove-',
  'clear-',
  'rename-',
  'move-',
  'copy-',
  'add-',
  'out-',
  'tee-',
  'write-',
  'save-',
  'export-',
  'import-',
  'compress-',
  'expand-',
  'restore-',
  'block-',
  'unblock-',
  'mount-',
  'format-',
]

/**
 * Verbs that carry a mutating prefix but only touch the pipeline or the session.
 * Kept as an explicit list so every exemption is a decision, not an accident.
 */
const SHELL_HARMLESS_VERBS = new Set([
  'write-host',
  'write-output',
  'write-verbose',
  'write-information',
  'write-debug',
  'write-progress',
  'write-warning',
  'out-host',
  'out-string',
  'out-null',
  'out-gridview',
  'out-default',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'format-hex',
  'start-sleep',
  'start-transcript',
  'stop-transcript',
  'set-location',
  'set-variable',
  'set-strictmode',
  'push-location',
  'pop-location',
  'invoke-command',
  'invoke-webrequest',
  'invoke-restmethod',
  // In-memory only: they build objects, variables or aliases in the session.
  'add-member',
  'add-type',
  'add-history',
  'new-object',
  'new-variable',
  'set-alias',
  'set-psdebug',
  'write-error',
  'clear-host',
  'remove-variable',
  'remove-module',
  'remove-job',
  'remove-psdrive',
  'remove-alias',
  'import-module',
  'import-csv',
  'import-clixml',
  'import-localizeddata',
])

/** A .NET member call that writes: `[IO.File]::WriteAllText(...)` and friends. */
const SHELL_MUTATING_MEMBER_RE = /::\s*(?:write|append|create|delete|move|copy|replace|open|truncate|save|remove|rename|set)\w*\s*\(/i
/** The subset of those that removes the target rather than filling it. */
const SHELL_MEMBER_DELETE_RE = /::\s*(?:delete|remove)\w*\s*\(/i
/** The subset of those that extend the target instead of replacing it. */
const SHELL_MEMBER_APPEND_RE = /::\s*append\w*\s*\(/i

/**
 * Verbs that execute or launch whatever they are handed, so the files they touch
 * only exist at run time: `iex $code`, `cmd /c del x`, `Start-Process x`.
 */
const SHELL_EXEC_ALWAYS = new Set([
  'iex',
  'invoke-expression',
  'invoke-item',
  'start-process',
  'saps',
  'mshta',
  'rundll32',
  'regsvr32',
])

/** Hosts that run supplied code only when one of the flags below is present. */
const SHELL_CODE_HOSTS = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'wsl',
  'cscript',
  'wscript',
  'node',
  'nodejs',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'php',
])
/** Flags that turn a host into `program "<code>"`. */
const SHELL_INLINE_CODE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '-command',
  '-com',
  '-encodedcommand',
  '-ec',
  '-enc',
  '/c',
  '/k',
])

/** `git` subcommands that rewrite the working tree or the index. */
const SHELL_GIT_MUTATING = new Set([
  'clean',
  'checkout',
  'reset',
  'restore',
  'rm',
  'mv',
  'switch',
  'stash',
  'gc',
  'prune',
  'update-ref',
  'submodule',
  'branch',
  'worktree',
])

/** Unix tools that rewrite or remove files in place. */
const SHELL_UNIX_MUTATORS = new Set(['truncate', 'dd', 'shred', 'unlink', 'touch'])

/** Prefixes that remove rather than fill; every other prefix is treated as a write. */
const SHELL_DELETE_PREFIXES = ['remove-', 'clear-']

/** Defaults, overridable from `cordis.patch.yml` via `config:`. */
const DEFAULT_SETTINGS = {
  files: true,
  shell: true,
  skipTemp: true,
  skipScratch: true,
  skipSelf: true,
  trace: true,
  timeoutMs: 300_000,
  shellTimeoutMs: 120_000,
}

/**
 * The plugin must never gate its own source. A broken sidebar half would
 * otherwise lock the only path to repairing it, which is a deadlock, not a
 * review. Both the checkout and any profile copy carry this segment.
 */
const SELF_SEGMENT = 'dsh-diff-review'

/** Absolute package root of this module (undefined when it cannot be derived). */
const SELF_ROOT = (() => {
  try {
    const here = fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase()
    const cut = here.lastIndexOf('/lib/index.js')
    return cut === -1 ? undefined : here.slice(0, cut)
  } catch {
    return undefined
  }
})()

/** True for paths inside this plugin's own package (checkout or profile copy). */
function isSelfPath(displayPath) {
  const normalised = String(displayPath).replace(/\\/g, '/').toLowerCase()
  const insideRoot = SELF_ROOT !== undefined
    && (normalised === SELF_ROOT || normalised.startsWith(`${SELF_ROOT}/`))
  if (insideRoot) return true
  return normalised.includes(`/node_modules/${SELF_SEGMENT}/`)
}

/**
 * A review gate is only armed while a browser half is actually alive.
 *
 * Without this the plugin would happily park a `write` forever whenever the
 * sidebar is not mounted (plugin failed to load, page reloaded, window closed),
 * deadlocking the agent on a decision nobody can make. The browser half pings
 * `heartbeat` on every poll tick; a missing ping means "nobody is watching, let
 * the tool through".
 *
 * The window has to survive background throttling: a Chromium page that is not
 * visible clamps `setInterval` to roughly one tick per minute, so a short window
 * (the original 8s) read as "nobody is watching" the moment the user switched
 * windows — the panel then never appeared at all, which is exactly the failure
 * this constant used to cause. Anything above the clamp keeps the gate armed
 * across a hidden window while still going quiet once the page is really gone.
 */
const HEARTBEAT_TTL_MS = 180_000

/** An unanswered review never wedges the session: `DEFAULT_SETTINGS.timeoutMs`. */

/**
 * Append-only trace file, because the panel is not always observable.
 *
 * The diagnostics inside the sidebar only exist while that tab is mounted and
 * readable, which is exactly what fails when the gate misbehaves. A plain log
 * line per gate call is the only evidence that survives a reload, and it costs
 * nothing when tracing is off.
 */
const TRACE_FILE = (() => {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (typeof home !== 'string' || home.trim() === '') return undefined
    const dir = `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.dsh/logs`
    mkdirSync(dir, { recursive: true })
    return `${dir}/diff-review.log`
  } catch {
    return undefined
  }
})()

/** Never throws: a trace failure must not change a tool's fate. */
function trace(settings, event, fields) {
  if (settings === undefined || settings.trace !== true) return
  if (TRACE_FILE === undefined) return
  try {
    const stamp = new Date().toISOString()
    const detail = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
    appendFileSync(TRACE_FILE, `${stamp} ${event}${detail}\n`)
  } catch {
    /* tracing is a courtesy, not a contract */
  }
}

const inject = ['tools', 'webServer', 'connection', 'fs']

/* ------------------------------------------------------------------ diff -- */

/** LCS line diff over two string arrays; `null` when the pair is too large. */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null
  const W = m + 1
  const dp = new Int32Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * W
    const nextRow = row + W
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[row + j] = a[i] === b[j]
        ? dp[nextRow + j + 1] + 1
        : Math.max(dp[nextRow + j], dp[row + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'equal', ai: i, bi: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ t: 'del', ai: i })
      i += 1
    } else {
      ops.push({ t: 'add', bi: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ t: 'del', ai: i })
    i += 1
  }
  while (j < m) {
    ops.push({ t: 'add', bi: j })
    j += 1
  }
  return ops
}

function splitLines(text) {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function buildRows(beforeText, afterText) {
  const a = splitLines(beforeText ?? '')
  const b = splitLines(afterText ?? '')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  const rows = []
  for (let i = 0; i < prefix; i += 1) rows.push({ t: 'equal', a: i + 1, b: i + 1, text: a[i] })

  const ops = lcsOps(midA, midB)
  if (ops === null) {
    for (let i = 0; i < midA.length; i += 1) rows.push({ t: 'del', a: prefix + i + 1, b: null, text: midA[i] })
    for (let i = 0; i < midB.length; i += 1) rows.push({ t: 'add', a: null, b: prefix + i + 1, text: midB[i] })
  } else {
    for (const op of ops) {
      if (op.t === 'equal') {
        rows.push({ t: 'equal', a: prefix + op.ai + 1, b: prefix + op.bi + 1, text: midA[op.ai] })
      } else if (op.t === 'del') {
        rows.push({ t: 'del', a: prefix + op.ai + 1, b: null, text: midA[op.ai] })
      } else {
        rows.push({ t: 'add', a: null, b: prefix + op.bi + 1, text: midB[op.bi] })
      }
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const ai = a.length - suffix + i
    const bi = b.length - suffix + i
    rows.push({ t: 'equal', a: ai + 1, b: bi + 1, text: a[ai] })
  }

  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.t === 'add') added += 1
    else if (row.t === 'del') removed += 1
  }
  return { rows, added, removed, oldLineCount: a.length, newLineCount: b.length }
}

/** Collapse long unchanged runs into `gap` rows, keeping CONTEXT_LINES around edits. */
function toHunks(rows) {
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].t === 'equal') continue
    const from = Math.max(0, i - CONTEXT_LINES)
    const to = Math.min(rows.length - 1, i + CONTEXT_LINES)
    for (let k = from; k <= to; k += 1) keep[k] = true
  }
  const out = []
  let skipped = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ t: 'gap', count: skipped })
        skipped = 0
      }
      out.push(rows[i])
    } else {
      skipped += 1
    }
  }
  if (skipped > 0) out.push({ t: 'gap', count: skipped })
  return out
}

/* ------------------------------------------------------------------ shell -- */

/**
 * `pwsh` carries a single command string, so destructive shell work has to be
 * recognised from the text itself. The parsing below is deliberately
 * conservative: when a statement does not look like a delete/overwrite we let it
 * through, and when a target cannot be resolved we still ask, but without a diff.
 */
const SHELL_MAX_STATEMENTS = 40
const SHELL_MAX_TARGETS = 20
/** Tokens a shell would expand; we cannot predict what they hit. */
const SHELL_WILDCARD_RE = /[*?[\]]/

/**
 * True for a path the shell expands *before* any cmdlet sees it: `$p`,
 * `$(Get-Item x)`, `${env:TEMP}\a.txt`, `$env:TEMP\a.txt`, `D:\$name\x`.
 *
 * This matters more than it looks. `Remove-Item -LiteralPath $p` used to arrive
 * here as the literal string `$p`, resolve to nothing, and be dropped by the
 * "nothing to delete" branch — so deleting a file through a variable went
 * through completely unreviewed. Anything we cannot resolve up front has to be
 * treated as an unknown target and reviewed as a command, never as a no-op.
 */
function isShellExpanded(displayPath) {
  const value = String(displayPath)
  if (value.startsWith('$')) return true
  if (value.includes('$(') || value.includes('${')) return true
  // A variable at the head of a path segment: `D:\$name\x`. A literal `$` inside
  // a file name (`a$b.txt`) has no separator in front of it and stays reviewable.
  return /[\\/]\$/.test(value)
}

const TEMP_ROOTS = [process.env.TEMP, process.env.TMP, '/tmp']
  .filter((value) => typeof value === 'string' && value.trim() !== '')
  .map((value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())

/** True for paths the OS keeps for scratch space (never worth a review). */
function isTempPath(displayPath) {
  const normalised = String(displayPath).replace(/\\/g, '/').toLowerCase()
  return TEMP_ROOTS.some((root) => normalised === root || normalised.startsWith(`${root}/`))
}

/**
 * The workspace scratch directory, `.dsh/tmp`, is an extension of the same idea.
 *
 * The OS temp directory is not the only place scratch work lands: this harness
 * tells the agent to keep every throwaway script and export under
 * `<workspace>/.dsh/tmp/`, and a workspace can sit on any drive, so the path
 * cannot be predicted from an environment variable. Those files are produced and
 * deleted inside one turn, so parking them only taught the user to click through
 * their own scratch space — the exact noise `skipTemp` exists to prevent. The
 * segment is matched anywhere in the path so nested folders are covered too.
 */
function isScratchPath(displayPath) {
  const normalised = `/${String(displayPath).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '')}`
  return normalised.includes('/.dsh/tmp/') || normalised.endsWith('/.dsh/tmp')
}

/**
 * Where a here-string ends: the index just past `'@` / `"@`, or the end of the
 * text when it is never closed.
 *
 * The opener must sit at the end of a line and the terminator at the start of
 * one, which is why a `'@` in the middle of a line of text does not close it.
 */
function hereStringEnd(text, start) {
  const terminator = `${text[start + 1]}@`
  let index = start + 2
  while (index < text.length) {
    const at = text.indexOf(terminator, index)
    if (at === -1) return text.length
    if (at === 0 || text[at - 1] === '\n' || text[at - 1] === '\r') return at + 2
    index = at + 2
  }
  return text.length
}

/**
 * Split a PowerShell command into simple statements, honouring quotes.
 *
 * Braces separate statements too, because a script block (`if (...) { ... }`,
 * `foreach (...) { ... }`, `& { ... }`) is a *sequence* of statements that the
 * shell runs. Leaving them glued on made the whole block one token run whose
 * first token was `if(Test-Path`, which matches no cmdlet — so a delete hidden
 * inside an `if` that merely tested for existence went through unreviewed.
 * `${name}` is the one brace that belongs to its statement, so it is kept whole.
 *
 * A here-string (`@'...'@`, `@"..."@`) is copied out whole: its body spans
 * newlines and routinely contains `|`, `&`, braces and quotes — a markdown table
 * is enough. Tearing it apart would not only lose the content but invent
 * commands out of prose.
 */
function splitStatements(command) {
  const out = []
  let current = ''
  let quote = ''
  let expansions = 0
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote !== '') {
      current += ch
      if (ch === '`' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '@' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      const end = hereStringEnd(command, i)
      current += command.slice(i, end)
      i = end - 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' && (current.endsWith('$') || current.endsWith('@'))) {
      expansions += 1
      current += ch
      continue
    }
    if (ch === '}' && expansions > 0) {
      expansions -= 1
      current += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || ch === '&' || ch === '{' || ch === '}') {
      if (current.trim() !== '') out.push(current)
      current = ''
      if (ch === '|' || ch === '&') {
        const follow = command[i + 1]
        if (follow === ch) i += 1
      }
      continue
    }
    current += ch
  }
  if (current.trim() !== '') out.push(current)
  return out
}

/** Split one statement into tokens, keeping quoted strings intact. */
function tokenize(statement) {
  const tokens = []
  let current = ''
  let quote = ''
  let started = false
  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i]
    if (quote !== '') {
      current += ch
      if (ch === '`' && quote === '"' && i + 1 < statement.length) {
        current += statement[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '@' && (statement[i + 1] === "'" || statement[i + 1] === '"')) {
      // One token, however many lines it covers: the cmdlet receives the body
      // as a single string argument.
      const end = hereStringEnd(statement, i)
      current += statement.slice(i, end)
      started = true
      i = end - 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * The body of a here-string token, or `null` when the token is not one.
 *
 * PowerShell drops the newline that follows the opener and the one that precedes
 * the terminator; everything between them is the value. The quotes are the same
 * two forms as everywhere else: `@'` never expands, `@"` expands.
 */
function hereStringBody(token) {
  if (typeof token !== 'string' || token.length < 4) return null
  if (token[0] !== '@' || (token[1] !== "'" && token[1] !== '"')) return null
  if (!token.endsWith(`${token[1]}@`)) return null
  let body = token.slice(2, -2)
  body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  return { body, interpolates: token[1] === '"' }
}

function stripQuotes(token) {
  let value = token
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === last && (first === "'" || first === '"')) value = value.slice(1, -1)
  }
  return value
}

/**
 * Split one `-Path`/positional argument into its target list.
 *
 * PowerShell also accepts a comma-separated list inside a single argument
 * (`Remove-Item 'a.txt','b.txt'`), and that comma sits *outside* the quotes, so
 * each element has to be unquoted on its own. Stripping the whole token first
 * left half a quote glued to every name, and the panel ended up showing
 * `a.txt'` and `'b.txt` as if those were the files about to be deleted.
 */
function splitTargetList(text) {
  const parts = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => stripQuotes(part.trim())).filter((part) => part !== '')
}

/**
 * The argument tokens of the first `::Name(...)` call in a statement.
 *
 * A .NET call takes positionals only — `[IO.File]::WriteAllText('a.txt', 'body')` —
 * so there are no `-Path` flags to read and the parenthesis is the argument list.
 * Quotes are kept intact per argument (unlike `splitTargetList`) because the caller
 * needs `literalOf` to see whether an argument was a literal string or an expression.
 * Splitting only happens on commas outside quotes, since a JSON body inside a string
 * would otherwise be cut in half.
 */
function callArgumentsOf(statement) {
  const open = statement.indexOf('(', statement.search(SHELL_MUTATING_MEMBER_RE))
  if (open === -1) return []
  const args = []
  let current = ''
  let quote = ''
  let depth = 0
  for (let i = open + 1; i < statement.length; i += 1) {
    const ch = statement[i]
    if (quote !== '') {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') {
      depth += 1
      current += ch
      continue
    }
    if (ch === ')') {
      if (depth === 0) {
        args.push(current.trim())
        break
      }
      depth -= 1
      current += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  return args.filter((arg) => arg !== '')
}

/**
 * Substitute `$env:NAME` with the value this process actually sees.
 *
 * A script naming its scratch file as `$env:TEMP\out.txt` is naming a real
 * location, and the harness already knows it: `process.env.TEMP` is the same
 * value the child shell resolves. Left unexpanded, the path never matched
 * `isTempPath`, so deleting a throwaway file in the OS temp directory still
 * asked the user to approve it — the exact noise `skipTemp` promises to skip.
 *
 * An undefined variable is left untouched, so the gate falls back to confirming
 * the command instead of pointing at a path that does not exist.
 */
function expandEnvVars(text) {
  if (!text.includes('$env:')) return text
  return text.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole, name) => {
    const value = process.env[name]
    return typeof value === 'string' && value !== '' ? value : whole
  })
}

/** A bare `$name` or `${name}` token: the only form we treat as a variable. */
const VARIABLE_TOKEN_RE = /^\$([A-Za-z_][A-Za-z0-9_:]*)$/
const VARIABLE_BRACED_RE = /^\$\{([A-Za-z_][A-Za-z0-9_:]*)\}$/

/** The variable a whole token names, or `null` when the token is anything else. */
function variableNameOf(token) {
  if (typeof token !== 'string') return null
  const braced = VARIABLE_BRACED_RE.exec(token)
  if (braced !== null) return braced[1].toLowerCase()
  const plain = VARIABLE_TOKEN_RE.exec(token)
  return plain === null ? null : plain[1].toLowerCase()
}

/** Backtick escapes PowerShell honours inside a double-quoted string. */
const SHELL_ESCAPES = {
  0: '\0',
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}

/** Resolve PowerShell backtick escapes: ``"a`nb"`` is the two-line string `a\nb`. */
function unescapeDouble(inner) {
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch !== '`' || i + 1 >= inner.length) {
      out += ch
      continue
    }
    const next = inner[i + 1]
    out += SHELL_ESCAPES[next] === undefined ? next : SHELL_ESCAPES[next]
    i += 1
  }
  return out
}

/**
 * The text a double-quoted body turns into, or `null` when the shell decides it.
 *
 * Escapes are resolved and every variable reference is substituted, so
 * `"$dir\out.txt"` and `"hello $name"` are exact whenever those variables were
 * assigned a literal earlier in the same command. One unknown reference makes
 * the whole string unknowable — half a path is worse than no path.
 */
function expandDouble(inner, vars) {
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '`' && i + 1 < inner.length) {
      const next = inner[i + 1]
      out += SHELL_ESCAPES[next] === undefined ? next : SHELL_ESCAPES[next]
      i += 1
      continue
    }
    if (ch !== '$') {
      out += ch
      continue
    }
    const rest = inner.slice(i)
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_:]*)\}|^\$([A-Za-z_][A-Za-z0-9_:]*)/.exec(rest)
    if (match === null) return null
    const name = String(match[1] === undefined ? match[2] : match[1]).toLowerCase()
    const known = vars === undefined ? undefined : vars.get(name)
    if (known === undefined) return null
    // A trailing `.`/`[` is property or index access, which we cannot replay.
    const after = rest[match[0].length]
    if (after === '.' || after === '[') return null
    out += known
    i += match[0].length - 1
  }
  return out
}

/**
 * The body of a token that is exactly one quoted string, else `null`.
 *
 * The closing quote has to be the token's last character. `'a'+'b'` begins and
 * ends with a quote yet is two literals the shell joins, and slicing off the
 * outer pair turned it into the garbage text `a'+'b` — content the reviewer was
 * shown as if it were about to be written. A doubled quote inside a
 * single-quoted string is an escaped quote, not a terminator.
 */
function wholeQuoted(token) {
  const quote = token[0]
  if (quote !== "'" && quote !== '"') return null
  let out = ''
  for (let i = 1; i < token.length; i += 1) {
    const ch = token[i]
    if (ch !== quote) {
      out += ch
      continue
    }
    if (quote === "'" && token[i + 1] === "'") {
      out += "'"
      i += 1
      continue
    }
    return i === token.length - 1 ? out : null
  }
  return null
}

/**
 * The text a token *literally* means, or `null` when the shell decides it.
 *
 * Three forms qualify: a quoted string whose variables are all known, a bare
 * word the shell would pass through unchanged, and a whole-token variable that
 * the same command assigned a literal earlier (`$t = 'a'` then `-Value $t`
 * writes exactly `a`). Everything else (`$(...)`, `Get-Date`, `$env:X`, a
 * variable built at run time) is state we cannot replay — guessing there would
 * show the reviewer content that is not what gets written.
 */
function literalOf(token, vars) {
  if (typeof token !== 'string' || token.length < 2) return null
  const name = variableNameOf(token)
  if (name !== null) {
    const known = vars === undefined ? undefined : vars.get(name)
    return known === undefined ? null : known
  }
  // A here-string is one argument whose body spans lines: `@'...'@` is literal,
  // `@"..."@` expands exactly like a double-quoted string does.
  const here = hereStringBody(token)
  if (here !== null) return here.interpolates ? expandDouble(here.body, vars) : here.body
  const quoted = wholeQuoted(token)
  if (quoted !== null) {
    // Single quotes never expand; double quotes only when every variable in them
    // is one we watched being assigned.
    return token[0] === '"' ? expandDouble(quoted, vars) : quoted
  }
  // A bare word reaches the cmdlet as written, unless the shell can expand it.
  // The rejected characters are the expansion and scoping syntaxes: `$` (a
  // variable), `(`/`)` (a sub-expression), `@` (a here-string or splat), `{`/`}`
  // (a script block) and `;`/`|`/`,` (statement and list separators).
  // A leftover quote means the token was a *mix* of quoted and unquoted text
  // (`'a'+'b'`), i.e. an expression the shell still has to evaluate; a bare word
  // could never contain one.
  if (/[$(){};|,@'"]/.test(token)) return null
  return token.includes('`') ? unescapeDouble(token) : token
}

/**
 * Substitute the variables we watched being assigned, inside a longer string.
 *
 * `$dir\probe.js` is the ordinary way a script names its output file. Replacing
 * only *known* variables keeps the result exact; anything left over means the
 * shell still has work to do, so the caller keeps the raw text and the gate
 * stays at command level instead of pointing at a name full of `$`.
 *
 * A reference followed by `.` or `[` is property or index access (`$a.Length`),
 * which is not plain substitution, so it is left alone and reported incomplete.
 */
function expandVars(text, vars) {
  if (!text.includes('$')) return { text, complete: true }
  if (vars === undefined || vars.size === 0) return { text, complete: false }
  const replaced = text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_:]*)\}|\$([A-Za-z_][A-Za-z0-9_:]*)/g,
    (whole, braced, plain, offset) => {
      const name = String(braced === undefined ? plain : braced).toLowerCase()
      const known = vars.get(name)
      if (known === undefined) return whole
      const after = text[offset + whole.length]
      if (after === '.' || after === '[') return whole
      return known
    },
  )
  return { text: replaced, complete: !replaced.includes('$') }
}

/**
 * Remember `$name = <literal>` so a later `-Value $name` stays knowable.
 *
 * Scripts almost never inline their payload: they build it in a variable first,
 * then hand the variable to the cmdlet. Without tracking those assignments every
 * such write fell back to "the result is not knowable", which is what the panel
 * used to say for perfectly ordinary `Set-Content -Value $content` calls. Only a
 * single literal right-hand side qualifies — `$a = 'x' + $b` needs the shell.
 */
function trackAssignment(statement, vars) {
  let tokens = tokenize(statement)
  // `$t='D:\x'` has no spaces, so tokenizing leaves the assignment as one token.
  // That compact form is at least as common as the spaced one, and missing it
  // meant the very next `Remove-Item $t` fell back to command level.
  if (tokens.length === 1) {
    const compact = /^(\$[A-Za-z_][A-Za-z0-9_:]*)=(.+)$/s.exec(tokens[0])
    if (compact !== null) tokens = [compact[1], '=', compact[2]]
  }
  if (tokens.length !== 3) return
  const name = variableNameOf(tokens[0])
  if (name === null || tokens[1] !== '=') return
  // `$n = Get-Date` has the shape of an assignment but the right-hand side is a
  // *command call*: the variable ends up holding the output, not the word. A
  // bare `verb-noun` is how every cmdlet is spelled, and a bare word that looks
  // like one is far more likely a call than a filename.
  if (/^[a-z][a-z0-9]*-[a-z][a-z0-9]*$/i.test(tokens[2])) return
  const value = literalOf(tokens[2], vars)
  if (value === null) return
  vars.set(name, value)
}

/** Destructive intents of one statement: `{ op, path, value, append }`. */
function shellOpsOf(statement, vars) {
  const tokens = tokenize(statement)
  if (tokens.length === 0) return []
  const ops = []

  // Redirection is destructive no matter which command produces the stream.
  // The left-hand token is only knowable when it is a literal: `$js > f` is
  // produced at run time, `'text' > f` is not.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '>' || token === '>|' || token === '>>' || token === '2>') {
      const next = tokens[i + 1]
      if (next !== undefined) {
        ops.push({
          op: 'write',
          path: stripQuotes(next),
          value: token === '2>' ? null : literalOf(tokens[i - 1], vars),
          append: token === '>>',
        })
      }
      continue
    }
    if (token.length > 1 && token.startsWith('>')) {
      ops.push({
        op: 'write',
        path: stripQuotes(token.replace(/^>+/, '')),
        value: literalOf(tokens[i - 1], vars),
        append: token.includes('>>'),
      })
    }
  }

  const lowered = tokens.map((token) => token.toLowerCase())
  // `-WhatIf` means nothing is touched; never gate a dry run.
  if (lowered.includes('-whatif') || lowered.includes('-wi')) return ops

  let verb = lowered[0]
  // `Microsoft.PowerShell.Management\Remove-Item` is the same cmdlet with its
  // module spelled out; whatever sits in front of the backslash is not a path.
  const moduleCut = verb.lastIndexOf('\\')
  if (moduleCut !== -1 && /^[a-z][a-z0-9.]*$/.test(verb.slice(0, moduleCut))) {
    verb = verb.slice(moduleCut + 1)
  }
  // `cmd.exe`, `node.EXE`, `x.ps1`: the extension never changes what the tool does.
  verb = verb.replace(/\.(?:exe|com|bat|cmd|ps1)$/, '')

  // A .NET member call writes through the framework: `[IO.File]::WriteAllText(…)`.
  // Nothing about it follows the cmdlet conventions, so the call shape is the only
  // signal, and the arguments are positional rather than flagged.
  if (SHELL_MUTATING_MEMBER_RE.test(statement)) {
    const args = callArgumentsOf(statement)
    const deleting = SHELL_MEMBER_DELETE_RE.test(statement)
    // The first argument is a positional path, so it goes through the same
    // literal test as a flagged one would. `WriteAllText($env:TEMP + '\x', 'y')`
    // passes an *expression*; stripping its quotes left the text `…\Temp + '\x'`
    // and the panel showed that as the file about to be written. An expression
    // means the name is unknowable, so it falls back to the command-level review.
    const target = args.length > 0 ? literalOf(args[0], vars) : null
    ops.push({
      op: deleting ? 'delete' : 'write',
      path: target === null ? verb : target,
      shape: true,
      wildcard: target === null,
      value: deleting || args.length < 2 ? null : literalOf(args[1], vars),
      append: SHELL_MEMBER_APPEND_RE.test(statement),
    })
    return ops
  }

  // `./tool`, `C:\tool.exe`: a program path, not a cmdlet name.
  if (verb.includes('/') || verb.includes('\\')) return ops

  const isDelete = SHELL_DELETE_CMDLETS.has(verb)
  const isTruncate = SHELL_TRUNCATE_CMDLETS.has(verb)
  const isWrite = SHELL_WRITE_CMDLETS.has(verb)
  const known = isDelete || isTruncate || isWrite
  const prefixed = !known
    && SHELL_MUTATING_PREFIXES.some((prefix) => verb.startsWith(prefix))
    && !SHELL_HARMLESS_VERBS.has(verb)
  const codeHost = SHELL_CODE_HOSTS.has(verb)
    && lowered.some((item) => SHELL_INLINE_CODE_FLAGS.has(item))
  const runsCode = SHELL_EXEC_ALWAYS.has(verb) || codeHost
  const gitMutating = verb === 'git'
    && lowered.slice(1).some((item) => SHELL_GIT_MUTATING.has(item))
  const unixMutator = SHELL_UNIX_MUTATORS.has(verb)
  if (!known && !prefixed && !runsCode && !gitMutating && !unixMutator) return ops

  if (!known) {
    // Nothing here has flag conventions to read: the payload is a string handed to
    // another program, or git's own arguments. Confirm the command itself rather
    // than inventing a file list.
    const removes = gitMutating || verb === 'unlink' || verb === 'shred' || verb === 'rm'
    ops.push({
      op: removes ? 'delete' : 'write',
      path: verb,
      shape: true,
      wildcard: true,
      value: null,
      append: false,
    })
    return ops
  }

  const op = isWrite ? 'write' : 'delete'
  const paths = []
  // The content only matters for writes, and only when it is a literal: `-Value
  // $x` and `-Value (Get-Date)` are produced later, so the panel falls back to
  // confirming the command.
  let value = null
  let positionalSeen = false
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    const lower = lowered[i]
    if (token.startsWith('-')) {
      if (SHELL_VALUE_FLAGS.has(lower)) {
        const next = tokens[i + 1]
        if (SHELL_PATH_FLAGS.has(lower) && next !== undefined && !next.startsWith('-')) {
          for (const part of splitTargetList(next)) paths.push(part)
        }
        if ((lower === '-value' || lower === '-inputobject') && isWrite && next !== undefined) {
          value = literalOf(next, vars)
        }
        i += 1
      }
      continue
    }
    // Write cmdlets take `-Path` then `-Value` positionally: only the first
    // positional can be a target. Delete cmdlets accept a list of paths.
    if (!isDelete && positionalSeen) {
      if (isWrite && value === null) value = literalOf(token, vars)
      continue
    }
    positionalSeen = true
    for (const part of splitTargetList(token)) paths.push(part)
  }

  // `Add-Content` and `Out-File -Append` extend the file; the rest replace it.
  const append = SHELL_APPEND_CMDLETS.has(verb) || lowered.includes('-append')
  if (paths.length === 0) {
    // A mutating cmdlet with no target of its own takes its input from a pipeline:
    // `Get-ChildItem | Remove-Item -Force` deletes whatever the left side produced,
    // and that list only exists while the command runs. Confirm the command itself.
    ops.push({ op, path: verb, shape: true, wildcard: true, value: null, append })
    return ops
  }
  for (const path of paths) ops.push({ op, path, value: isWrite ? value : null, append })
  return ops
}

/** All destructive intents of a command, in source order. */
function parseShellCommand(command) {
  const ops = []
  // Assignments are tracked in source order, so a script that builds its payload
  // in a variable and then writes it still yields the exact text being written.
  const vars = new Map()
  let statements = 0
  for (const statement of splitStatements(command)) {
    statements += 1
    // Past the cap we stop guessing and, with no ops collected, the gate lets the
    // command through untouched rather than reviewing a half-parsed command.
    if (statements > SHELL_MAX_STATEMENTS) return []
    trackAssignment(statement, vars)
    for (const item of shellOpsOf(statement, vars)) {
      if (item.path === undefined || item.path === '') continue
      // A path that is itself a variable we watched being assigned resolves the
      // same way the value does: `$p = 'D:\a.txt'; Remove-Item $p` is reviewable.
      const pathVar = variableNameOf(item.path)
      const assigned = pathVar !== null && vars.has(pathVar) ? vars.get(pathVar) : item.path
      // `"$dir\probe.js"` is how scripts name their output; substituting the
      // variables we saw assigned turns it into the real file.
      const path = expandEnvVars(expandVars(assigned, vars).text)
      if (path === '') continue
      // A wildcard or variable target cannot be resolved up front: keep it, but
      // flag it so the gate confirms the command itself instead of pretending to
      // know the files. Without the variable case this silently allowed every
      // delete whose path was built in a variable.
      //
      // `item.wildcard` carries the shape verdict: a shape op whose payload is not
      // a path at all (`git clean -fdx`, `iex $code`) arrives already flagged, and
      // the check below cannot rediscover that from a token like `git`.
      const unknown = item.wildcard === true
        || SHELL_WILDCARD_RE.test(path)
        || isShellExpanded(path)
      ops.push({
        op: item.op,
        path,
        wildcard: unknown,
        // A shape match carries the verb instead of a path: `iex` and `git` are not
        // files, so the record must be able to tell it apart from a wildcard like
        // `D:\x\*`, which is still a real location worth showing.
        shape: item.shape === true,
        // `value` is the literal text the command writes, when the shell does not
        // decide it. It stays attached to a wildcard target because the gate needs
        // to know a wildcard delete carries no content at all.
        value: item.value === undefined ? null : item.value,
        append: item.append === true,
      })
      if (ops.length >= SHELL_MAX_TARGETS) return ops
    }
  }
  return ops
}

/* ------------------------------------------------------------------- http -- */

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeFail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/* ------------------------------------------------------------------- main -- */

function apply(ctx, config) {
  /**
   * Settings live in `cordis.patch.yml` under `config:`; every key is optional
   * and falls back to `DEFAULT_SETTINGS`. The plugin stays dependency-free, so
   * the merge is plain and defensive instead of a schemastery schema.
   */
  const settings = { ...DEFAULT_SETTINGS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const value = config[key]
      if (value === undefined || value === null) continue
      if (typeof value === typeof DEFAULT_SETTINGS[key]) settings[key] = value
    }
  }

  /** @type {Map<string, object>} */
  const pending = new Map()
  let counter = 0
  let lastHeartbeat = 0

  /**
   * The turn each session is on, and the turn each session has been waved
   * through.
   *
   * "Allow everything for this request" has to end when the request ends, and a
   * turn is exactly that boundary — the host appends `turn/start` and `turn/end`
   * to the session log around every user message, so the pair identifies the
   * request unambiguously. A session-wide flag would keep the gate off for the
   * rest of the conversation, which is not what the button offers.
   *
   * These are reported to the panel as whole tables rather than as one answer:
   * the poller asks once for every open tab, so it cannot name a single session
   * in the request.
   */
  const turns = new Map()
  const allowedTurns = new Map()
  const wavedThrough = (sessionId) => {
    const turn = turns.get(sessionId)
    return typeof turn === 'number' && allowedTurns.get(sessionId) === turn
  }

  ctx.on('session/event', (session, event) => {
    const id = session === null || session === undefined ? undefined : session.id ?? session.header?.id
    if (typeof id !== 'string') return
    if (event === null || typeof event !== 'object') return
    const data = event.data
    if (data === null || typeof data !== 'object') return
    if (event.type === 'turn/start') {
      if (typeof data.turn === 'number') turns.set(id, data.turn)
      // Turns are rare (one per user message), so logging each one cannot bury
      // the gate events — and without it a missing button is indistinguishable
      // from a host that never reports turns at all.
      trace(settings, 'turn', { type: event.type, session: id, turn: data.turn ?? null })
      return
    }
    if (event.type === 'turn/end') {
      allowedTurns.delete(id)
      turns.delete(id)
      trace(settings, 'turn', { type: event.type, session: id, turn: data.turn ?? null })
    }
  })

  const nextId = () => {
    counter += 1
    return `c${Date.now().toString(36)}${counter.toString(36)}`
  }

  const armed = () => Date.now() - lastHeartbeat <= HEARTBEAT_TTL_MS

  /**
   * Record the poller without drowning the log.
   *
   * The browser polls every 1.2 s, so logging each tick would bury the gate
   * events. Log the first contact and every state change (no poller → poller,
   * and poller → gone), which is exactly the transition that arms or disarms
   * the gate.
   */
  let pollerLogged = false
  let pollerLastAt = 0
  const tracePoller = () => {
    const now = Date.now()
    const revived = pollerLastAt !== 0 && now - pollerLastAt > HEARTBEAT_TTL_MS
    if (!pollerLogged || revived) trace(settings, 'poller', { first: !pollerLogged, gapMs: pollerLastAt === 0 ? -1 : now - pollerLastAt })
    pollerLogged = true
    pollerLastAt = now
  }

  /**
   * Resolve the calling session and its directory.
   *
   * `SessionHeader.cwd` is optional on purpose — a session that never committed
   * a directory falls back to the deployment default — so reading the header
   * alone would silently disable the gate. The last resort below is the same
   * Service the host itself consults when it needs the effective directory.
   */
  const dirOf = (session) => {
    if (session === null || typeof session !== 'object') return undefined
    try {
      // Optional access: the Service is present in every shipped profile, but a
      // hard `inject` entry would make this plugin refuse to mount without it.
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined || workingDirectory === null) return undefined
      const value = workingDirectory.get(session)
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** Last resort: the deployment directory the host itself falls back to. */
  const defaultDir = () => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const value = workingDirectory?.defaultDirectory
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  const usableDir = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

  const sessionOf = (exec) => {
    const agent = exec?.agent
    const session = agent?.session
    const header = session?.header ?? session
    if (header === null || typeof header !== 'object') return undefined
    const cwdSource =
      usableDir(header.cwd) ??
      usableDir(session?.cwd) ??
      usableDir(agent?.cwd) ??
      dirOf(session) ??
      defaultDir()
    const idSource = header.id ?? session?.id
    return {
      id: typeof idSource === 'string' ? idSource : undefined,
      cwd: cwdSource,
    }
  }

  const summaryOf = (rec) => ({
    id: rec.id,
    sessionId: rec.sessionId,
    tool: rec.tool,
    path: rec.path,
    displayPath: rec.displayPath,
    fileless: rec.fileless === true,
    op: rec.op,
    added: rec.added,
    removed: rec.removed,
    oldLineCount: rec.oldLineCount,
    newLineCount: rec.newLineCount,
    createdAt: rec.createdAt,
    truncated: rec.truncated,
    reviewable: rec.reviewable,
    reason: rec.reason,
    command: rec.command,
    targets: rec.targets,
  })

  const listForSession = (sessionId) => {
    const out = []
    for (const rec of pending.values()) {
      if (sessionId === undefined || rec.sessionId === sessionId) out.push(summaryOf(rec))
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  /* ------------------------------------------------------------- gate ---- */

  /**
   * Park a record until the browser half answers it.
   *
   * Resolves with `'accept' | 'reject' | 'cancel' | 'timeout'`. `cancel` comes
   * from `exec.signal` (the user pressed Esc, the turn was interrupted);
   * `timeout` is the last-resort release so an unattended review never wedges
   * the agent.
   */
  const awaitDecision = async (rec, signal, timeoutMs) => {
    const decision = new Promise((resolve) => {
      rec.resolve = resolve
    })
    pending.set(rec.id, rec)
    trace(settings, 'park', {
      id: rec.id,
      tool: rec.tool,
      op: rec.op,
      path: rec.displayPath,
      added: rec.added,
      removed: rec.removed,
      pending: pending.size,
      timeoutMs,
    })
    try {
      return await new Promise((resolve) => {
        let settled = false
        let timer
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }
        const finish = (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        }
        const onAbort = () => finish('cancel')
        if (signal.aborted) {
          finish('cancel')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => finish('timeout'), Math.max(10_000, timeoutMs))
        if (typeof timer.unref === 'function') timer.unref()
        decision.then((value) => finish(value))
      })
    } finally {
      pending.delete(rec.id)
    }
  }

  /** Translate a parked record's verdict into a `tools/pre-execute` decision. */
  const settle = async (rec, exec, next) => {
    const outcome = await awaitDecision(rec, exec.signal, rec.timeoutMs ?? settings.timeoutMs)
    trace(settings, 'verdict', { id: rec.id, tool: rec.tool, op: rec.op, path: rec.displayPath, outcome })
    if (outcome === 'accept') return next()
    if (outcome === 'cancel') return { kind: 'cancel' }
    // Fail open: an unanswered review is not a refusal.
    if (outcome === 'timeout') return next()
    return {
      kind: 'deny',
      reason:
        rec.tool === 'pwsh'
          ? `The user rejected the shell command that touches ${rec.displayPath}.`
          : `The user rejected the change to ${rec.displayPath}.`,
      displayReason: {
        en: 'Rejected in the diff review panel.',
        zh: '已在对比审查面板中拒绝。',
      },
    }
  }

  /**
   * Reviewable record for a `pwsh` command that deletes or overwrites files.
   *
   * Shell work is confirmed at command level because the resulting bytes are not
   * knowable up front. Two cases are knowable and get a real diff instead:
   * deleting one text file (we can read what is about to be lost) and writing one
   * file from a quoted literal (the text is right there in the command). Anything
   * else reports `reason: 'shell-command'`, which the panel words as "the result
   * is not knowable up front" — a different statement from "too large to show".
   */
  const buildShellRecord = async (exec, session, args) => {
    const command = args.command
    if (typeof command !== 'string' || command.trim() === '') return undefined
    const ops = parseShellCommand(command)
    if (ops.length === 0) return undefined

    const targets = []
    for (const item of ops) {
      if (item.wildcard) {
        // The shell expands it and we cannot: review the command, not the files.
        targets.push({
          op: item.op,
          path: item.path,
          existed: false,
          target: undefined,
          shape: item.shape === true,
          value: item.value === undefined ? null : item.value,
          append: item.append === true,
        })
        continue
      }
      let resolved
      try {
        resolved = await ctx.fs.resolve(item.path, { cwd: session.cwd, signal: exec.signal })
      } catch {
        continue
      }
      if (settings.skipTemp && isTempPath(resolved.displayPath)) continue
      if (settings.skipScratch && isScratchPath(resolved.displayPath)) continue
      if (settings.skipSelf && isSelfPath(resolved.displayPath)) continue
      let info
      try {
        info = await ctx.fs.stat(resolved, exec.signal)
      } catch {
        continue
      }
      if (item.op === 'delete' && info === undefined) continue
      targets.push({
        op: item.op,
        path: resolved.displayPath,
        existed: info !== undefined,
        target: resolved,
        shape: false,
        value: item.value === undefined ? null : item.value,
        append: item.append === true,
      })
    }
    if (targets.length === 0) return undefined

    // A shape-level match has no file of its own: `iex $code` and `git clean -fdx`
    // touch whatever they touch at run time. Their `path` is the verb, a synthetic
    // marker that keeps the op in the queue — it must never be shown as a file name.
    // A wildcard target (`D:\x\*`) is different: the location is real even though
    // the file list is not, so it keeps its path.
    const fileless = targets.every((item) => item.shape === true)

    let before = ''
    let after = ''
    let rows = []
    let added = 0
    let removed = 0
    let oldLineCount = 0
    let newLineCount = 0
    let truncated = false
    let reviewable = false
    // Whether the new content was actually knowable. A huge but literal write is
    // knowable and merely too big to draw, which is a different sentence from a
    // command whose content only exists once the shell runs it.
    let computed = false
    let reason
    const single = targets.length === 1 ? targets[0] : undefined
    // `target === undefined` means the shell expands the path, so nothing about the
    // file is knowable: keep it at command level rather than inventing a diff.
    const oneWrite = single !== undefined && single.op === 'write' && single.value !== null && single.target !== undefined
    // Several ops on one file (`WriteAllText(…)` to seed it, then `Set-Content`)
    // resolve to the last write's text, so the outcome is knowable even though no
    // single op carries it. One file touched twice is ordinary in real scripts.
    const samePath = targets.length > 1 && targets.every((item) => item.path === targets[0].path)
    const replayable = samePath
      && targets.every((item) => item.target !== undefined)
      && targets.every((item) => item.op === 'delete' || item.value !== null)
    if (single !== undefined && single.op === 'delete' && single.existed) {
      try {
        let stored = await ctx.fs.readText(single.target, exec.signal)
        if (stored.length > MAX_STORED_CHARS) {
          stored = stored.slice(0, MAX_STORED_CHARS)
          truncated = true
        }
        const built = buildRows(stored, '')
        before = stored
        rows = toHunks(built.rows)
        added = built.added
        removed = built.removed
        oldLineCount = built.oldLineCount
        reviewable = built.added + built.removed <= 4000
        computed = true
      } catch {
        // Binary or unreadable: fall back to command-level confirmation.
      }
    } else if (oneWrite && single.existed) {
      // The command carries the text it writes, so the reviewer can see exactly
      // what the file becomes. `Add-Content`/`-Append` extend instead of replace.
      try {
        let stored = await ctx.fs.readText(single.target, exec.signal)
        if (stored.length > MAX_STORED_CHARS) {
          stored = stored.slice(0, MAX_STORED_CHARS)
          truncated = true
        }
        let next = single.append ? stored + single.value : single.value
        if (next.length > MAX_STORED_CHARS) {
          next = next.slice(0, MAX_STORED_CHARS)
          truncated = true
        }
        const built = buildRows(stored, next)
        before = stored
        after = next
        rows = toHunks(built.rows)
        added = built.added
        removed = built.removed
        oldLineCount = built.oldLineCount
        newLineCount = built.newLineCount
        reviewable = built.added + built.removed <= 4000
        computed = true
      } catch {
        // Unreadable target: fall back to command-level confirmation.
      }
    } else if (oneWrite && single.existed === false) {
      // Creating a new file: the whole content is new, so show it as an addition.
      let next = single.value
      if (next.length > MAX_STORED_CHARS) {
        next = next.slice(0, MAX_STORED_CHARS)
        truncated = true
      }
      const built = buildRows('', next)
      after = next
      rows = toHunks(built.rows)
      added = built.added
      removed = built.removed
      oldLineCount = 0
      newLineCount = built.newLineCount
      reviewable = built.added + built.removed <= 4000
      computed = true
    } else if (replayable && single === undefined) {
      // Replay the ops in the order the command runs them: a seed write followed
      // by the real one leaves exactly the second text, and a delete after a write
      // leaves nothing. Every step is a literal read out of the command, so the
      // final state is not a guess — it is what the shell will produce.
      let stored = ''
      if (targets[0].existed) {
        try {
          stored = await ctx.fs.readText(targets[0].target, exec.signal)
        } catch {
          stored = ''
        }
        if (stored.length > MAX_STORED_CHARS) {
          stored = stored.slice(0, MAX_STORED_CHARS)
          truncated = true
        }
      }
      let next = stored
      for (const item of targets) {
        if (item.op === 'delete') {
          next = ''
          continue
        }
        next = item.append ? next + item.value : item.value
      }
      if (next.length > MAX_STORED_CHARS) {
        next = next.slice(0, MAX_STORED_CHARS)
        truncated = true
      }
      const built = buildRows(stored, next)
      before = stored
      after = next
      rows = toHunks(built.rows)
      added = built.added
      removed = built.removed
      oldLineCount = built.oldLineCount
      newLineCount = built.newLineCount
      reviewable = built.added + built.removed <= 4000
      computed = true
    }

    // Only the case "we never saw the content" earns the shell-command wording;
    // a literal write that is simply too large keeps the oversized wording.
    if (!computed) reason = 'shell-command'

    // A change nobody can see is not worth interrupting for: asking the reviewer
    // to approve bytes that only exist once the shell runs is a prompt they cannot
    // answer. That covers `-Value $x`, `$js > file`, `"hello $env:USERNAME"` — one
    // known file, invisible text. Three shapes stay gated: a delete (it cannot be
    // undone, and the *file* is worth naming even when the content is not), a
    // command touching several files (naming them is the whole review), and a
    // fileless match — `iex $code`, `node -e "…"`, `powershell -EncodedCommand` —
    // where not even the target is knowable, so the effect could be anything.
    if (!computed && !fileless && !targets.some((item) => item.op === 'delete') && targets.length === 1) {
      return undefined
    }

    // A command that only touches files which do not exist yet creates them; the
    // badge has to say so, or a brand-new file reads as an edit of nothing.
    const anyDelete = targets.some((item) => item.op === 'delete')
    const anyExisted = targets.some((item) => item.existed === true)

    // One file touched twice in the same command used to appear twice in the
    // header (`D:\x.md, D:\x.md`), which reads like two files. Keep first-seen
    // order so the header still matches the order the command names them.
    const touched = []
    for (const item of targets) {
      if (!touched.includes(item.path)) touched.push(item.path)
    }
    const pathList = touched.join(', ')

    return {
      id: nextId(),
      sessionId: session.id,
      tool: 'pwsh',
      // A fileless match has no file to name, and printing the verb there would read
      // as a path the user is about to create. The panel shows the command instead.
      path: fileless ? '' : pathList,
      displayPath: fileless ? '' : pathList,
      fileless,
      // A shape match is neither a create nor an edit of anything nameable, so it
      // gets its own badge rather than claiming the file is new.
      op: fileless ? 'shell' : anyDelete ? 'delete' : anyExisted ? 'update' : 'create',
      command,
      targets: targets.map((item) => ({ op: item.op, path: item.path, existed: item.existed })),
      before,
      after,
      rows,
      added,
      removed,
      oldLineCount,
      newLineCount,
      createdAt: Date.now(),
      truncated,
      reviewable,
      reason,
      timeoutMs: settings.shellTimeoutMs,
      resolve: undefined,
    }
  }

  /**
   * Why the last gated call went through untouched.
   *
   * A gate that silently allows everything looks exactly like a gate that is
   * not installed, so every early return records itself here and `list` hands
   * the record to the panel. Without that the only symptom is "nothing
   * happens", which is unreadable on a live UI.
   */
  const diag = {
    gateCalls: 0,
    tools: [],
    lastTool: '',
    lastReason: '',
    lastAt: 0,
    lastKeys: [],
    lastSession: '',
    lastError: '',
    lastArmed: false,
    lastHeartbeatAge: -1,
    lastShape: null,
    recent: [],
  }
  const pass = (reason, next) => {
    diag.lastReason = reason
    diag.lastAt = Date.now()
    // A single "last reason" cannot show a sequence: an unanswered test needs
    // to see that the gate ran, which early return it took, and whether the
    // heartbeat moved between two calls. Keep a short ring buffer instead.
    diag.recent.push({ tool: diag.lastTool, reason, at: diag.lastAt, armed: Date.now() - lastHeartbeat <= HEARTBEAT_TTL_MS })
    if (diag.recent.length > 12) diag.recent.shift()
    trace(settings, 'pass', {
      tool: diag.lastTool,
      reason,
      armed: Date.now() - lastHeartbeat <= HEARTBEAT_TTL_MS,
      heartbeatAgeMs: lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat,
      keys: diag.lastKeys,
      session: diag.lastSession,
    })
    return next()
  }
  const diagSnapshot = () => ({
    calls: diag.gateCalls,
    tools: diag.tools.slice(0, 24),
    tool: diag.lastTool,
    reason: diag.lastReason,
    at: diag.lastAt,
    heartbeatAgeMs: diag.lastHeartbeatAge,
    armed: diag.lastArmed,
    pending: pending.size,
    keys: diag.lastKeys,
    session: diag.lastSession,
    shape: diag.lastShape,
    error: diag.lastError,
    recent: diag.recent.slice(),
    settings,
    selfRoot: SELF_ROOT ?? '',
    tempRoots: TEMP_ROOTS,
  })

  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        diag.gateCalls += 1
        diag.lastTool = exec.name
        diag.lastAt = Date.now()
        if (diag.tools.length < 24) diag.tools.push(exec.name)
        const rawArgs = exec.arguments
        diag.lastKeys = rawArgs !== null && typeof rawArgs === 'object' ? Object.keys(rawArgs).slice(0, 12) : []
        // The shape of the execution is the one thing the panel cannot infer:
        // if the gate reads "not-gated" for a name we expected, or "no-session"
        // for a live turn, these fields say why without another restart.
        diag.lastShape = {
          exec: exec !== null && typeof exec === 'object' ? Object.keys(exec).slice(0, 16) : null,
          hasAgent: exec.agent !== undefined && exec.agent !== null,
          agentKeys: exec.agent !== null && typeof exec.agent === 'object' ? Object.keys(exec.agent).slice(0, 10) : null,
          sessionKeys:
            exec.agent?.session !== null && typeof exec.agent?.session === 'object'
              ? Object.keys(exec.agent.session).slice(0, 12)
              : null,
        }
        if (!GATED_TOOLS.has(exec.name)) return pass('not-gated', next)
        if (!armed()) {
          diag.lastHeartbeatAge = lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat
          return pass('not-armed', next)
        }
        const session = sessionOf(exec)
        diag.lastSession = session === undefined ? 'none' : `${session.id ?? '?'}@${session.cwd ?? '?'}`
        if (session === undefined || session.cwd === undefined) return pass('no-session', next)

        // The reviewer pressed "allow everything for this request": every later
        // write in the same turn goes straight through, and the next turn re-arms
        // the gate because `turn/end` drops the pair. A delete is still asked
        // about — the button promises to stop interrupting for writes, and a
        // removal cannot be undone, so silence there would overrun the promise.
        const turn = turns.get(session.id)
        const turnAllowed = wavedThrough(session.id)

        const args = exec.arguments
        if (args === null || typeof args !== 'object') return pass('no-args', next)

        if (exec.name === 'pwsh') {
          if (!settings.shell) return pass('shell-disabled', next)
          if (turnAllowed === true) {
            const command = typeof args.command === 'string' ? args.command : ''
            if (!parseShellCommand(command).some((item) => item.op === 'delete')) return pass('turn-allowed', next)
          }
          let rec
          try {
            rec = await buildShellRecord(exec, session, args)
          } catch {
            return pass('shell-error', next)
          }
          if (rec === undefined) return pass('shell-not-destructive', next)
          return settle(rec, exec, next)
        }

        if (turnAllowed === true) return pass('turn-allowed', next)

        if (!settings.files) return pass('files-disabled', next)
        const filePath = args.file_path
        if (typeof filePath !== 'string' || filePath.trim() === '') return pass('no-file-path', next)

        let target
        try {
          target = await ctx.fs.resolve(filePath, { cwd: session.cwd, signal: exec.signal })
        } catch {
          return pass('resolve-failed', next)
        }
        if (settings.skipTemp && isTempPath(target.displayPath)) return pass('temp-skipped', next)
        if (settings.skipScratch && isScratchPath(target.displayPath)) return pass('scratch-skipped', next)
        if (settings.skipSelf && isSelfPath(target.displayPath)) return pass('self-skipped', next)

        let existed = false
        let beforeText = ''
        try {
          const info = await ctx.fs.stat(target, exec.signal)
          if (info !== undefined) {
            if (info.type !== 'file') return pass('not-a-file', next)
            existed = true
            beforeText = await ctx.fs.readText(target, exec.signal)
          }
        } catch {
          return pass('stat-failed', next)
        }

        let afterText
        if (exec.name === 'write') {
          if (typeof args.content !== 'string') return pass('no-content', next)
          afterText = args.content
          if (existed && beforeText === afterText) return pass('identical', next)
        } else {
          const oldString = args.old_string
          const newString = args.new_string
          if (typeof oldString !== 'string' || typeof newString !== 'string') return pass('no-edit-strings', next)
          if (oldString === newString) return pass('edit-identical', next)
          if (!existed) return pass('edit-missing-file', next)
          const replaceAll = args.replace_all === true
          const occurrences = oldString === '' ? 0 : beforeText.split(oldString).length - 1
          if (occurrences === 0) return pass('edit-no-match', next)
          if (!replaceAll && occurrences > 1) return pass('edit-ambiguous', next)
          afterText = replaceAll
            ? beforeText.split(oldString).join(newString)
            : beforeText.replace(oldString, () => newString)
          if (afterText === beforeText) return pass('edit-no-change', next)
        }

        let truncated = false
        let storedBefore = beforeText
        let storedAfter = afterText
        if (storedBefore.length > MAX_STORED_CHARS) {
          storedBefore = storedBefore.slice(0, MAX_STORED_CHARS)
          truncated = true
        }
        if (storedAfter.length > MAX_STORED_CHARS) {
          storedAfter = storedAfter.slice(0, MAX_STORED_CHARS)
          truncated = true
        }

        const built = buildRows(storedBefore, storedAfter)
        const rec = {
          id: nextId(),
          sessionId: session.id,
          tool: exec.name,
          path: target.displayPath,
          displayPath: target.displayPath,
          op: existed ? 'update' : 'create',
          before: storedBefore,
          after: storedAfter,
          rows: toHunks(built.rows),
          added: built.added,
          removed: built.removed,
          oldLineCount: built.oldLineCount,
          newLineCount: built.newLineCount,
          createdAt: Date.now(),
          truncated,
          reviewable: built.added + built.removed <= 4000,
          timeoutMs: settings.timeoutMs,
          resolve: undefined,
        }

        return settle(rec, exec, next)
      }),
    'dsh-diff-review: file change gate',
  )

  /* ------------------------------------------------------------- routes -- */

  const api = {
    async list(payload) {
      // Capture the heartbeat state BEFORE this call refreshes it: the panel
      // must be able to show whether the poller was actually alive a moment
      // ago, and reporting the just-refreshed value would always read healthy.
      diag.lastArmed = armed()
      diag.lastHeartbeatAge = lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat
      lastHeartbeat = Date.now()
      tracePoller()
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      const turn = sessionId === undefined ? undefined : turns.get(sessionId)
      return {
        changes: listForSession(sessionId),
        timeoutMs: settings.timeoutMs,
        armed: diag.lastArmed,
        // The panel polls once for every open tab and cannot name a single
        // session in that request, so ship the whole table and let each tab look
        // up its own id. Without this the button never appeared: `turn` was
        // always `null` because no `sessionId` was in the poll payload.
        turns: Object.fromEntries(turns),
        wavedThrough: Object.fromEntries(allowedTurns),
        turn: typeof turn === 'number' ? turn : null,
        turnAllowed: sessionId === undefined ? false : wavedThrough(sessionId),
        diag: diagSnapshot(),
      }
    },
    async detail(payload) {
      const id = typeof payload.id === 'string' ? payload.id : ''
      const rec = pending.get(id)
      if (rec === undefined) return { missing: true }
      return {
        change: summaryOf(rec),
        rows: rec.rows,
        before: rec.before,
        after: rec.after,
      }
    },
    async decide(payload) {
      lastHeartbeat = Date.now()
      const id = typeof payload.id === 'string' ? payload.id : ''
      const rec = pending.get(id)
      if (rec === undefined) return { missing: true }
      // `allowTurn` accepts this change and exempts the rest of the request: the
      // reviewer saw enough and does not want to be asked again until the next
      // user message. Kept as one action so the click is atomic — accepting the
      // record and arming the exemption must not be able to disagree.
      if (payload.action === 'allowTurn') {
        const turn = typeof rec.sessionId === 'string' ? turns.get(rec.sessionId) : undefined
        if (typeof turn === 'number') allowedTurns.set(rec.sessionId, turn)
        rec.resolve('accept')
        return { ok: true, turnAllowed: typeof turn === 'number' }
      }
      const action = payload.action === 'accept' ? 'accept' : 'reject'
      rec.resolve(action)
      return { ok: true }
    },
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (ctx.connection.requestRejection(req) !== undefined) {
            // The fence says no: the most common reason a browser half looks
            // dead is that its requests never arrive, so record the refusal.
            trace(settings, 'route-rejected', { url: req.url ?? '', origin: req.headers?.origin ?? '', host: req.headers?.host ?? '' })
            writeFail(res, 403, 'forbidden', 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            trace(settings, 'route-method', { method: req.method ?? '' })
            writeFail(res, 405, 'method-not-allowed', 'POST required')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${API_PREFIX}/`)
            ? pathname.slice(API_PREFIX.length + 1)
            : undefined
          const handler = method !== undefined && Object.hasOwn(api, method) ? api[method] : undefined
          if (typeof handler !== 'function') {
            trace(settings, 'route-unknown', { method: String(method) })
            writeFail(res, 404, 'not-found', `unknown method: ${String(method)}`)
            return
          }
          try {
            const payload = await readJsonBody(req)
            const value = await handler(payload)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            trace(settings, 'route-error', { method, message: error instanceof Error ? error.message : String(error) })
            writeFail(res, 400, 'bad-request', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    'dsh-diff-review: api routes',
  )
}

export { apply, inject, NS, API_PREFIX }
