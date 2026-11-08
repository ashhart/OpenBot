/**
 * Risk classification for a shell command.
 *
 * The command is split into segments on `;`, `&&`, `||`, `|` and newlines while
 * respecting quotes (`parse.ts`), then each segment's head binary is looked up
 * here. This is a heuristic — it decides how loudly to ask, never whether
 * something is "safe enough to skip asking" for anything but plain reads.
 * Outright refusal is a separate concern and lives in `denylist.ts`.
 */

import { firstDenyReason } from './denylist'
import { headBinary, splitSegments, tokenize } from './parse'

export { splitSegments, unquote } from './parse'

export type RiskLevel = 'safe' | 'moderate' | 'high'

export interface CommandAnalysis {
  segments: string[]
  /** Head binary of each segment, in order, deduplicated. */
  binaries: string[]
  risk: RiskLevel
  reasons: string[]
  /** Set when the command matches a hard denylist rule and must never run. */
  blocked?: string
}

/** Read-only commands: prompting for these is pure friction. */
const SAFE_BINARIES = new Set([
  'ls', 'pwd', 'cat', 'bat', 'head', 'tail', 'wc', 'echo', 'printf', 'date', 'whoami', 'id',
  'uname', 'hostname', 'which', 'type', 'file', 'stat', 'du', 'df', 'tree', 'basename',
  'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'yq',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'diff', 'cmp', 'md5', 'shasum', 'sleep',
  'true', 'false', 'printenv', 'ps', 'top', 'uptime', 'man', 'help', 'history'
])

/*
 * `awk` used to sit in the list above, between `ag` and `diff`, on the strength
 * of reading files. It is a full interpreter: `awk 'BEGIN{system("rm -rf ~")}'`
 * was rated `safe`, and `safe` skips the approval gate under every policy except
 * `ask-every-time` — so the delete ran with no card at all under three of the
 * four we ship. Its `getline` also reads any absolute path, and because that
 * path sits inside the program token rather than in an argument,
 * `escapingPaths` never saw it and workspace containment did not apply either.
 *
 * The rule now is that an inline program is never classified by the name of the
 * interpreter in front of it.
 */

/** Interpreter flags whose value is a program, not data. */
const AWK_PROGRAM_FLAGS = new Set(['-e', '--source', '-f', '--file'])
const SHELL_PROGRAM_FLAGS = new Set(['-c', '-o'])

const PROGRAM_FLAGS: Record<string, ReadonlySet<string>> = {
  sh: SHELL_PROGRAM_FLAGS,
  bash: SHELL_PROGRAM_FLAGS,
  zsh: SHELL_PROGRAM_FLAGS,
  ksh: SHELL_PROGRAM_FLAGS,
  dash: SHELL_PROGRAM_FLAGS,
  fish: new Set(['-c']),
  // `env -S` packs a whole command into one argument. `headBinary` consumes the
  // flag and its value as wrapper noise and then returns nothing at all, so the
  // segment contributed no binary and stayed `safe`.
  env: new Set(['-S']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  node: new Set(['-e', '--eval', '-p', '--print']),
  bun: new Set(['-e']),
  deno: new Set(['-e', '--eval']),
  php: new Set(['-r']),
  osascript: new Set(['-e']),
  awk: AWK_PROGRAM_FLAGS,
  gawk: AWK_PROGRAM_FLAGS,
  mawk: AWK_PROGRAM_FLAGS,
  nawk: AWK_PROGRAM_FLAGS
}

/** Interpreters whose program is simply the first non-flag argument. */
const PROGRAM_FIRST_ARG = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/** Interpreters whose program is itself a shell command worth analysing again. */
const SHELL_PROGRAM = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'env'])

/*
 * Read-only commands that run a pager of their own when told to.
 *
 * `man -P` and `bat --pager` take a command line and run it — `man` through an
 * `eval` in its own script, `bat` by splitting the words — and `PAGER`,
 * `MANPAGER` and `GIT_PAGER` name the same command from the environment. All of
 * it sits behind binaries rated `safe` (`git -p log` forces the pager even on a
 * pipe), so `man -P "rm -rf /Users/me" ls` ran with no card under every policy
 * but `ask-every-time`. The denylist never saw the delete either: it is a quoted
 * argument of a command that is not an interpreter, so `scanForms` dropped the
 * argument, and `pathArguments` resolved the whole quoted string to a name
 * inside the workspace. A pager is a command, so it is analysed as one.
 */
const PAGER_FLAGS: Record<string, ReadonlySet<string>> = {
  man: new Set(['-P', '--pager']),
  bat: new Set(['--pager'])
}
const PAGER_VARIABLE = /^(?:PAGER|MANPAGER|GIT_PAGER)=(.*)$/

/** How deep nested substitutions are followed before we stop and just say high. */
const MAX_NESTING = 3

interface InlineProgram {
  binary: string
  source: string
  /** Whether `source` is shell syntax, and so worth re-analysing as a command. */
  shell: boolean
}

/**
 * Programs handed to an interpreter on the command line.
 *
 * These are scanned across the whole token list rather than from the head
 * binary, because a wrapper (`env`, `nice`, `xargs`) can sit in front and
 * `headBinary` deliberately steps over it.
 */
function inlinePrograms(tokens: string[]): InlineProgram[] {
  const found: InlineProgram[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    // Anywhere, not only ahead of the head binary: `env PAGER=… man` puts the
    // assignment behind a wrapper, and `headBinary` steps over both.
    const variable = PAGER_VARIABLE.exec(token)
    if (variable) {
      found.push({ binary: token.slice(0, token.indexOf('=')), source: variable[1] ?? '', shell: true })
      continue
    }
    const binary = token.includes('/') ? (token.split('/').pop() ?? token) : token
    const pager = Object.hasOwn(PAGER_FLAGS, binary) ? PAGER_FLAGS[binary] : undefined
    const flags = pager ?? PROGRAM_FLAGS[binary]
    if (!flags) continue
    const shell = pager !== undefined || SHELL_PROGRAM.has(binary)

    let taken = false
    for (let j = i + 1; j < tokens.length; j++) {
      const [flag, attached] = splitFlag(tokens[j] ?? '')
      if (!flags.has(flag)) continue
      const source = attached ?? tokens[j + 1]
      if (source === undefined) continue
      found.push({ binary, source, shell })
      taken = true
    }
    // `awk 'prog'` carries its program as the first bare argument instead.
    if (!taken && PROGRAM_FIRST_ARG.has(binary)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j] ?? ''
        if (arg.startsWith('-')) continue
        found.push({ binary, source: arg, shell: false })
        break
      }
    }
  }
  return found
}

/** `--flag=value` as its two halves; any other token is itself with no value. */
function splitFlag(token: string): [string, string | undefined] {
  const at = token.startsWith('--') ? token.indexOf('=') : -1
  return at === -1 ? [token, undefined] : [token.slice(0, at), token.slice(at + 1)]
}

/**
 * Command substitutions, as the shell will actually run them.
 *
 * `$(…)` and backticks run a command this classifier never saw, reported under
 * the head binary's name: `echo $(rm -rf ~)` came back as `echo`, rated
 * `moderate` on the bare presence of `$(`, and `moderate` skips the gate
 * entirely under `auto-run`. Single-quoted text is left alone because the shell
 * does not expand it there, and `$((…))` is arithmetic rather than a command.
 */
function substitutions(command: string): { found: string[]; unterminated: boolean } {
  const found: string[] = []
  let unterminated = false
  let quote: "'" | '"' | undefined

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (ch === '"') {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (!quote && ch === "'") {
      quote = "'"
      continue
    }

    if (ch === '`') {
      const end = command.indexOf('`', i + 1)
      if (end < 0) {
        unterminated = true
        break
      }
      found.push(command.slice(i + 1, end))
      i = end
      continue
    }

    if (ch === '$' && command[i + 1] === '(') {
      if (command[i + 2] === '(') continue // $((…)) is arithmetic, not a command
      let depth = 0
      let j = i + 1
      for (; j < command.length; j++) {
        if (command[j] === '(') depth++
        else if (command[j] === ')') {
          depth--
          if (depth === 0) break
        }
      }
      if (j >= command.length) {
        unterminated = true
        break
      }
      found.push(command.slice(i + 2, j))
      i = j
    }
  }
  return { found, unterminated }
}

/** Mutating but ordinary development commands. */
const MODERATE_BINARIES = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'sed', 'tee', 'chmod', 'chown', 'zip', 'unzip', 'tar',
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'vite', 'esbuild', 'python',
  'python3', 'pip', 'pip3', 'ruby', 'go', 'cargo', 'rustc', 'swift', 'make', 'cmake', 'xcodebuild',
  'open', 'osascript', 'defaults', 'plutil', 'codesign', 'pytest', 'jest', 'vitest', 'eslint', 'prettier'
])

/** Commands that reach outside the machine, escalate, or are hard to undo. */
const HIGH_RISK_BINARIES = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'doas', 'dd', 'mkfs', 'diskutil', 'fdisk', 'launchctl', 'systemsetup',
  'networksetup', 'scutil', 'pfctl', 'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'sftp', 'ftp', 'nc', 'ncat', 'telnet', 'security',
  'keychain', 'docker', 'kubectl', 'brew', 'softwareupdate', 'installer', 'pkgutil', 'spctl',
  'csrutil', 'nvram', 'tmutil', 'crontab', 'at'
])

/** Git subcommands that rewrite or publish history. */
const HIGH_RISK_GIT = new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch', 'gc', 'prune'])
const SAFE_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'blame', 'describe', 'rev-parse'])

export function analyzeCommand(command: string, userDenylist: string[] = []): CommandAnalysis {
  return analyze(command, userDenylist, 0)
}

function analyze(command: string, userDenylist: string[], depth: number): CommandAnalysis {
  const segments = splitSegments(command)
  const binaries: string[] = []
  const reasons: string[] = []
  let risk: RiskLevel = 'safe'

  const raise = (level: RiskLevel, reason: string): void => {
    if (level === 'high' || (level === 'moderate' && risk === 'safe')) risk = level
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  /* Programs and substitutions found while walking the segments, analysed once
     the head binaries are known so their own segments can be folded in. */
  const nested: string[] = []

  for (const segment of segments) {
    const tokens = tokenize(segment)

    for (const program of inlinePrograms(tokens)) {
      if (program.shell) {
        // `bash -c "…"` / `env -S "…"` really is a shell command: analyse it.
        nested.push(program.source)
        continue
      }
      /* An awk or perl program is not shell, so re-analysing it would report
         nonsense. It is arbitrary code execution either way, and the honest
         answer for something this classifier cannot model is to always ask. */
      raise('high', `${program.binary} runs an inline program`)
    }

    const head = headBinary(tokens)
    if (!head) continue
    if (!binaries.includes(head.binary)) binaries.push(head.binary)

    if (head.binary === 'git') {
      const sub = head.args[0] ?? ''
      if (HIGH_RISK_GIT.has(sub)) raise('high', `git ${sub} can rewrite or publish history`)
      else if (SAFE_GIT.has(sub)) raise('safe', '')
      else raise('moderate', `git ${sub} modifies the repository`)
      continue
    }
    if (head.viaSudo) raise('high', 'runs with sudo')
    if (HIGH_RISK_BINARIES.has(head.binary)) raise('high', `${head.binary} is powerful or irreversible`)
    else if (MODERATE_BINARIES.has(head.binary)) raise('moderate', `${head.binary} modifies files or state`)
    else if (!SAFE_BINARIES.has(head.binary)) raise('moderate', `${head.binary} is not a known read-only command`)
  }

  if (/(^|[\s;&|])>{1,2}\s*[^\s&|;]/.test(command)) raise('moderate', 'redirects output into a file')

  if (/\b(curl|wget)\b[^\n;&|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/.test(command)) {
    raise('high', 'pipes a downloaded script straight into a shell')
  }

  const substituted = substitutions(command)
  nested.push(...substituted.found)

  /* An unbalanced `$(` or a lone backtick parses to nothing, so it would
     otherwise slip past the scanner entirely. The shell will reject it, but the
     intent was still to run something. Text the scanner skipped on purpose —
     single quotes, `$((…))` arithmetic — is not flagged here. */
  if (substituted.unterminated) {
    raise('moderate', 'contains an unterminated command substitution')
  }

  let blocked = firstDenyReason(command, userDenylist)

  /*
   * A substituted command is a real command, so it is classified as one and its
   * segments and binaries are folded into this analysis. That matters beyond
   * the risk level: `allowlistCovers` requires *every* segment to match, and an
   * "always allow" rule as ordinary as `echo *` compiles to `^echo .*$` — which
   * matched `echo $(rm -rf ~)` whole and skipped the gate under every policy.
   * With the inner segment present, that rule no longer covers the command.
   */
  if (depth < MAX_NESTING) {
    for (const inner of nested) {
      if (!inner.trim()) continue
      const sub = analyze(inner, userDenylist, depth + 1)
      for (const segment of sub.segments) if (!segments.includes(segment)) segments.push(segment)
      for (const binary of sub.binaries) if (!binaries.includes(binary)) binaries.push(binary)
      raise(sub.risk, `runs ${sub.binaries.join(', ') || 'a command'} inside a substitution`)
      if (!blocked && sub.blocked) blocked = sub.blocked
    }
  } else if (nested.length > 0) {
    raise('high', 'nests commands more deeply than this can be checked')
  }

  return {
    segments,
    binaries,
    risk,
    reasons: reasons.filter(Boolean),
    ...(blocked ? { blocked } : {})
  }
}
