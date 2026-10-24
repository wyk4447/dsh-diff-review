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
const SHELL_DELETE_CMDLETS = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'])
const SHELL_TRUNCATE_CMDLETS = new Set(['clear-content', 'clc'])
const SHELL_WRITE_CMDLETS = new Set(['set-content', 'sc', 'out-file', 'add-content', 'ac'])
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

/** Defaults, overridable from `cordis.patch.yml` via `config:`. */
const DEFAULT_SETTINGS = {
  files: true,
  shell: true,
  skipTemp: true,
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

const TEMP_ROOTS = [process.env.TEMP, process.env.TMP, '/tmp']
  .filter((value) => typeof value === 'string' && value.trim() !== '')
  .map((value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())

/** True for paths the OS keeps for scratch space (never worth a review). */
function isTempPath(displayPath) {
  const normalised = String(displayPath).replace(/\\/g, '/').toLowerCase()
  return TEMP_ROOTS.some((root) => normalised === root || normalised.startsWith(`${root}/`))
}

/** Split a PowerShell command into simple statements, honouring quotes. */
function splitStatements(command) {
  const out = []
  let current = ''
  let quote = ''
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
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || ch === '&') {
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

function stripQuotes(token) {
  let value = token
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === last && (first === "'" || first === '"')) value = value.slice(1, -1)
  }
  return value
}

/** Destructive intents of one statement: `{ op: 'delete' | 'write', path }`. */
function shellOpsOf(statement) {
  const tokens = tokenize(statement)
  if (tokens.length === 0) return []
  const ops = []

  // Redirection is destructive no matter which command produces the stream.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '>' || token === '>|' || token === '>>' || token === '2>') {
      const next = tokens[i + 1]
      if (next !== undefined) ops.push({ op: 'write', path: stripQuotes(next) })
      continue
    }
    if (token.length > 1 && token.startsWith('>')) {
      ops.push({ op: 'write', path: stripQuotes(token.replace(/^>+/, '')) })
    }
  }

  const verb = tokens[0].toLowerCase()
  // `sc.exe`, `./tool`, `C:\tool.exe`: a program, not one of the cmdlets below.
  if (verb.includes('.') || verb.includes('/') || verb.includes('\\')) return ops

  const isDelete = SHELL_DELETE_CMDLETS.has(verb)
  const isTruncate = SHELL_TRUNCATE_CMDLETS.has(verb)
  const isWrite = SHELL_WRITE_CMDLETS.has(verb)
  if (!isDelete && !isTruncate && !isWrite) return ops

  const lowered = tokens.map((token) => token.toLowerCase())
  // `-WhatIf` means nothing is touched; never gate a dry run.
  if (lowered.includes('-whatif') || lowered.includes('-wi')) return ops

  const op = isWrite ? 'write' : 'delete'
  const paths = []
  let positionalSeen = false
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    const lower = lowered[i]
    if (token.startsWith('-')) {
      if (SHELL_VALUE_FLAGS.has(lower)) {
        const next = tokens[i + 1]
        if (SHELL_PATH_FLAGS.has(lower) && next !== undefined && !next.startsWith('-')) {
          for (const part of stripQuotes(next).split(',')) {
            if (part.trim() !== '') paths.push(part.trim())
          }
        }
        i += 1
      }
      continue
    }
    // Write cmdlets take `-Path` then `-Value` positionally: only the first
    // positional can be a target. Delete cmdlets accept a list of paths.
    if (!isDelete && positionalSeen) continue
    positionalSeen = true
    for (const part of stripQuotes(token).split(',')) {
      if (part.trim() !== '') paths.push(part.trim())
    }
  }

  for (const path of paths) ops.push({ op, path })
  return ops
}

/** All destructive intents of a command, in source order. */
function parseShellCommand(command) {
  const ops = []
  let statements = 0
  for (const statement of splitStatements(command)) {
    statements += 1
    // Past the cap we stop guessing and, with no ops collected, the gate lets the
    // command through untouched rather than reviewing a half-parsed command.
    if (statements > SHELL_MAX_STATEMENTS) return []
    for (const item of shellOpsOf(statement)) {
      if (item.path === undefined || item.path === '') continue
      // A wildcard target cannot be resolved up front: keep it, but flag it so the
      // gate confirms the command itself instead of pretending to know the files.
      ops.push({ op: item.op, path: item.path, wildcard: SHELL_WILDCARD_RE.test(item.path) })
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
    op: rec.op,
    added: rec.added,
    removed: rec.removed,
    oldLineCount: rec.oldLineCount,
    newLineCount: rec.newLineCount,
    createdAt: rec.createdAt,
    truncated: rec.truncated,
    reviewable: rec.reviewable,
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
   * knowable up front. The one exception is deleting a single text file: we can
   * read what is about to be lost, so the panel shows it as a deletion.
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
        targets.push({ op: item.op, path: item.path, existed: false, target: undefined })
        continue
      }
      let resolved
      try {
        resolved = await ctx.fs.resolve(item.path, { cwd: session.cwd, signal: exec.signal })
      } catch {
        continue
      }
      if (settings.skipTemp && isTempPath(resolved.displayPath)) continue
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
      })
    }
    if (targets.length === 0) return undefined

    let before = ''
    let rows = []
    let added = 0
    let removed = 0
    let oldLineCount = 0
    let truncated = false
    let reviewable = false
    const single = targets.length === 1 ? targets[0] : undefined
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
      } catch {
        // Binary or unreadable: fall back to command-level confirmation.
      }
    }

    return {
      id: nextId(),
      sessionId: session.id,
      tool: 'pwsh',
      path: targets.map((item) => item.path).join(', '),
      displayPath: targets.map((item) => item.path).join(', '),
      op: targets.some((item) => item.op === 'delete') ? 'delete' : 'update',
      command,
      targets: targets.map((item) => ({ op: item.op, path: item.path, existed: item.existed })),
      before,
      after: '',
      rows,
      added,
      removed,
      oldLineCount,
      newLineCount: 0,
      createdAt: Date.now(),
      truncated,
      reviewable,
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

        const args = exec.arguments
        if (args === null || typeof args !== 'object') return pass('no-args', next)

        if (exec.name === 'pwsh') {
          if (!settings.shell) return pass('shell-disabled', next)
          let rec
          try {
            rec = await buildShellRecord(exec, session, args)
          } catch {
            return pass('shell-error', next)
          }
          if (rec === undefined) return pass('shell-not-destructive', next)
          return settle(rec, exec, next)
        }

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
    async heartbeat() {
      lastHeartbeat = Date.now()
      tracePoller()
      return { armed: true, timeoutMs: settings.timeoutMs, pending: pending.size }
    },
    async list(payload) {
      // Capture the heartbeat state BEFORE this call refreshes it: the panel
      // must be able to show whether the poller was actually alive a moment
      // ago, and reporting the just-refreshed value would always read healthy.
      diag.lastArmed = armed()
      diag.lastHeartbeatAge = lastHeartbeat === 0 ? -1 : Date.now() - lastHeartbeat
      lastHeartbeat = Date.now()
      tracePoller()
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      return {
        changes: listForSession(sessionId),
        timeoutMs: settings.timeoutMs,
        armed: diag.lastArmed,
        diag: diagSnapshot(),
      }
    },
    async decideAll(payload) {
      lastHeartbeat = Date.now()
      const action = payload.action === 'accept' ? 'accept' : 'reject'
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      let decided = 0
      for (const rec of pending.values()) {
        if (sessionId !== undefined && rec.sessionId !== sessionId) continue
        rec.resolve(action)
        decided += 1
      }
      return { decided }
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
      const action = payload.action === 'accept' ? 'accept' : 'reject'
      const rec = pending.get(id)
      if (rec === undefined) return { missing: true }
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
