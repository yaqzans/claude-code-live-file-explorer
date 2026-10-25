import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderElement } from 'claude-code'

import type { Change, ViewKey } from '../types'

const PANE = 'live-files'
const TITLE = 'Live files'
const SCAN_MS = 2500
const MAX_ENTRIES = 20000
const MAX_ROWS = 600
const MAX_PREVIEW_LINES = 3000
const MAX_PREVIEW_BYTES = 1024 * 1024

// Folders shown in the tree but never scanned inside: they are huge and
// change constantly, which would drown out the changes that matter.
const IGNORE = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.ipynb_checkpoints', '.next', '.gradle',
  '.tox', '.cache',
])
// Tools that can change files on disk; a scan runs right after each one.
const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell'])

const cwdA = atom({ plugin: 'live-files', key: 'cwd' } as const, '')
const rootA = atom({ plugin: 'live-files', key: 'root' } as const, '')
const browseA = atom({ plugin: 'live-files', key: 'browse' } as const, '')
const expandedA = atom({ plugin: 'live-files', key: 'expanded' } as const, [] as string[])
const changesA = atom({ plugin: 'live-files', key: 'changes' } as const, {} as Record<string, Change>)
const selectedA = atom({ plugin: 'live-files', key: 'selected' } as const, '')
const changedOnlyA = atom({ plugin: 'live-files', key: 'changedOnly' } as const, false)
const showFullA = atom({ plugin: 'live-files', key: 'showFull' } as const, false)
const versionA = atom({ plugin: 'live-files', key: 'version' } as const, 0)
const noticeA = atom({ plugin: 'live-files', key: 'notice' } as const, '')
const isClosedA = atom({ plugin: 'live-files', key: 'isClosed' } as const, false)
const isPickingA = atom({ plugin: 'live-files', key: 'isPicking' } as const, false)
// Files Claude wrote this chat, by lower-cased absolute path, kept even before a folder is picked.
const touchedA = atom({ plugin: 'live-files', key: 'touched' } as const, {} as Record<string, Change>)
const blinkA = atom({ plugin: 'live-files', key: 'blink' } as const, false)
// What the View menu shows; kept in $.store too, so every chat starts the same way.
const VIEW_DEFAULT: Record<ViewKey, boolean> = {
  size: false, age: true, tags: true, legend: true, ignored: true, dotfiles: true, guides: true,
  autoOpen: true, recentFirst: false,
}
// Bumped when a default changes, so an older saved view does not override it.
const VIEW_KEY = 'view-v2'
const VIEW_LABEL: Array<[ViewKey, string]> = [
  ['size', 'Size'], ['age', 'Age'], ['tags', 'File type tags'], ['legend', 'A / M / D key'],
  ['ignored', 'Ignored folders (.venv, node_modules)'], ['dotfiles', 'Dotfiles (.git, .gitignore)'],
  ['guides', 'Indent guides'], ['autoOpen', 'Auto-open changed folders'], ['recentFirst', 'Recent changes first'],
]
const viewA = atom({ plugin: 'live-files', key: 'view' } as const, VIEW_DEFAULT)
const isMenuOpenA = atom({ plugin: 'live-files', key: 'isMenuOpen' } as const, false)
// Folders the person closed although auto-open would open them.
const collapsedA = atom({ plugin: 'live-files', key: 'collapsed' } as const, [] as string[])
// Pause holds the tree still; this chat only, never saved.
const isPausedA = atom({ plugin: 'live-files', key: 'isPaused' } as const, false)
// What reading this chat's history found, shown dim so a miss is never silent.
const historyNoteA = atom({ plugin: 'live-files', key: 'historyNote' } as const, '')

// Windows' own Explorer-style Open dialog, set up to pick a folder: it prints
// the chosen folder, or nothing when cancelled. The start folder comes in by
// environment variable so no path is ever quoted into the script.
const EXPLORER_PICKER = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0',
  '$owner.Show(); $owner.Activate()',
  '$d = New-Object System.Windows.Forms.OpenFileDialog',
  "$d.Title = 'Go into the folder you want, then click Open'",
  '$d.InitialDirectory = $env:LIVE_FILES_START',
  '$d.ValidateNames = $false; $d.CheckFileExists = $false; $d.CheckPathExists = $true',
  "$d.FileName = 'Select this folder'",
  "$d.Filter = 'Folders|no.files'",
  "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write([IO.Path]::GetDirectoryName($d.FileName)) }",
  '$owner.Close()',
].join('; ')

// Module memory: rebuilt by the next scan after a reload.
let snapshot: Map<string, number> | undefined
let listings = new Map<string, FsEntry[]>()
let scannedDirs = new Set<string>()
let isCut = false
let isScanning = false
let timer: { cancel: () => void } | undefined
let blinkTimer: { cancel: () => void } | undefined
let blinkUntil = 0
// The text a file had before Claude first touched it this session (null: it did not exist).
const before = new Map<string, string | null>()

const norm = (p: string) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
const join = (root: string, rel: string) => (rel ? `${root}/${rel}` : root)
const isAbs = (p: string) => /^([A-Za-z]:)?[\\/]/.test(p)
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p
const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const parentDir = (abs: string) => {
  const cut = abs.lastIndexOf('/')
  return cut <= 0 ? abs : abs.slice(0, cut).replace(/^([A-Za-z]:)$/, '$1/')
}

function relOf(root: string, abs: string): string | undefined {
  const a = norm(abs)
  const r = norm(root).replace(/\/$/, '')
  if (a.toLowerCase() === r.toLowerCase()) return ''
  if (a.toLowerCase().startsWith(r.toLowerCase() + '/')) return a.slice(r.length + 1)
  return undefined
}

const byName = (a: FsEntry, b: FsEntry) =>
  (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) ||
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

async function scan($: EngineInterface): Promise<void> {
  if (isScanning || await read($, isPausedA)) return
  const scanStart = Date.now()
  trace('scan start')
  try { await scanInner($) } finally {
    trace(`scan end ${Date.now() - scanStart}ms, ${scannedDirs.size} dirs`)
    void flushTrace($)
  }
}

async function scanInner($: EngineInterface): Promise<void> {
  const root = await read($, rootA)
  if (!root) return
  isScanning = true
  try {
    const files = new Map<string, number>()
    const lists = new Map<string, FsEntry[]>()
    const dirs = new Set<string>()
    const queue = ['']
    let count = 0
    let cut = false
    while (queue.length > 0) {
      const batch = queue.splice(0, 16)
      const found = await Promise.all(
        batch.map(d => $.fs.list(join(root, d)).then(
          es => [d, es] as const,
          () => [d, undefined] as const,
        )),
      )
      for (const [d, es] of found) {
        if (!es) continue
        lists.set(d, es)
        dirs.add(d)
        for (const en of es) {
          const rel = d ? `${d}/${en.name}` : en.name
          count++
          if (en.kind === 'file') files.set(rel, en.mtimeMs)
          else if (en.kind === 'dir' && !IGNORE.has(en.name)) {
            if (count < MAX_ENTRIES) queue.push(rel)
            else cut = true
          }
        }
      }
    }
    if (!dirs.has('')) {
      await update($, noticeA, () => `Cannot read ${root} any more.`)
      return
    }
    if (root !== (await read($, rootA))) return // the folder changed mid-scan

    const old = snapshot
    const oldDirs = scannedDirs
    const sig = (m: Map<string, FsEntry[]>) =>
      [...m].map(([d, es]) => `${d}:${es.length}`).join('|')
    const isListingNew = sig(lists) !== sig(listings)
    snapshot = files
    listings = lists
    scannedDirs = dirs
    isCut = cut

    const found: Array<[string, Change['kind']]> = []
    if (old) {
      for (const [rel, mtime] of files) {
        if (!old.has(rel)) {
          if (oldDirs.has(parentOf(rel))) found.push([rel, 'added'])
        } else if (old.get(rel) !== mtime) found.push([rel, 'modified'])
      }
      for (const rel of old.keys()) {
        if (!files.has(rel) && dirs.has(parentOf(rel))) found.push([rel, 'deleted'])
      }
    }
    if (!old) {
      // Draw the tree now; the chat's history is read behind it and adds its marks after.
      await update($, versionA, v => v + 1)
      void seedFromHistory($, root, files)
    }
    if (found.length > 0) {
      const at = Date.now()
      await update($, changesA, prev => {
        const next = { ...prev }
        for (const [rel, kind] of found) {
          const was = prev[rel]?.kind
          if (kind === 'added') next[rel] = { kind: was === 'deleted' ? 'modified' : 'added', at }
          else if (kind === 'modified') next[rel] = { kind: was === 'added' ? 'added' : 'modified', at }
          else if (was === 'added') delete next[rel]
          else next[rel] = { kind: 'deleted', at }
        }
        return next
      })
    }
    if (found.length > 0 || isListingNew || !old) await update($, versionA, v => v + 1)
    if (found.length > 0) startBlink($)
  } finally {
    isScanning = false
  }
}

// One tool call in the transcript file, as it is spelled there.
const USE_RE = /"name":"(Write|Edit|NotebookEdit|Read)","input":\{"(?:file_path|notebook_path)":"([^"]*)"/g

// The Write/Edit/Read calls of this chat in order, from its transcript file on disk.
// The file keeps every call; the messages the engine hands back lose the ones a
// compaction summarised away. The file is often far over $.fs.read's 4 MiB, so a
// search tool streams it and hands back only the matches.
async function transcriptUses($: EngineInterface): Promise<Array<{ tool: string; path: string }>> {
  const id = await $.session.id()
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const base = norm((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`) + '/projects'
  const cwd = await read($, cwdA)
  let file = `${base}/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
  if (!(await $.fs.exists(file))) {
    file = ''
    for (const dir of await $.fs.list(base).catch(() => [] as FsEntry[])) {
      const guess = `${base}/${dir.name}/${id}.jsonl`
      if (dir.kind === 'dir' && await $.fs.exists(guess)) { file = guess; break }
    }
  }
  if (!file) throw new Error(`no transcript for chat ${id} under ${base}`)
  const isWindows = /^[A-Za-z]:/.test(file)
  const run = isWindows
    ? await $.process.run(
      ['powershell.exe', '-NoProfile', '-Command',
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
        "Select-String -LiteralPath $env:LIVE_FILES_TRANSCRIPT -AllMatches -Pattern " +
        "'\"name\":\"(Write|Edit|NotebookEdit|Read)\",\"input\":\\{\"(file_path|notebook_path)\":\"[^\"]*\"' " +
        "| ForEach-Object { $_.Matches | ForEach-Object { $_.Value } }"],
      { env: { LIVE_FILES_TRANSCRIPT: file.replace(/\//g, '\\') }, timeoutMs: 60_000 },
    )
    : await $.process.run(
      ['grep', '-oE', '"name":"(Write|Edit|NotebookEdit|Read)","input":\\{"(file_path|notebook_path)":"[^"]*"', file],
      { timeoutMs: 60_000 },
    )
  if (run.exitCode !== 0) throw new Error(`search failed (${run.exitCode}): ${run.stderr.trim().slice(0, 160)}`)
  const uses: Array<{ tool: string; path: string }> = []
  for (const m of run.stdout.matchAll(USE_RE)) {
    try {
      uses.push({ tool: m[1]!, path: JSON.parse(`"${m[2]!}"`) as string })
    } catch {
      // A path the JSON escape could not read: skip it.
    }
  }
  return uses
}

// The files Claude wrote or edited earlier in this chat, by lower-cased absolute
// path. A first Write with no Read before it made the file.
async function historyWrites($: EngineInterface): Promise<Record<string, Change>> {
  let uses: Array<{ tool: string; path: string }>
  let source = 'transcript'
  try {
    uses = await transcriptUses($)
  } catch (err) {
    // No transcript file to search: fall back to the messages the engine keeps.
    source = `messages only (${String(err instanceof Error ? err.message : err).slice(0, 160)})`
    uses = []
    try {
      for (const message of await $.session.messages()) {
        for (const use of message.toolUses) {
          const path = use.input.file_path ?? use.input.notebook_path
          if (typeof path === 'string') uses.push({ tool: use.tool, path })
        }
      }
    } catch (err) {
      await update($, historyNoteA, () => `Couldn't read this chat's history: ${String(err).slice(0, 160)}`)
      return {}
    }
  }
  const cwd = await read($, cwdA)
  const out: Record<string, Change> = {}
  const seen = new Set<string>()
  for (const use of uses) {
    const key = norm(isAbs(use.path) ? use.path : join(cwd, use.path)).toLowerCase()
    if (use.tool === 'Read') seen.add(key)
    else {
      if (!out[key]) out[key] = { kind: use.tool === 'Write' && !seen.has(key) ? 'added' : 'modified', at: 0 }
      seen.add(key)
    }
  }
  const root = (await read($, rootA)).toLowerCase()
  const here = Object.keys(out).filter(k => k === root || k.startsWith(root + '/')).length
  await update($, historyNoteA, () =>
    `Earlier work: this chat wrote ${Object.keys(out).length} file${Object.keys(out).length === 1 ? '' : 's'}, ` +
    `${here} in this folder (from ${source}).`)
  return out
}

// Marks what this chat wrote before the folder was watched. Never holds up the
// tree, and gives up after HISTORY_MS so a slow or stuck read cannot hang the pane.
const HISTORY_MS = 30_000
// Opt-in trace for debugging: when %TEMP%/live-files-trace.on exists, the last
// 300 things the pane did are written to %TEMP%/live-files-trace-<chat>.log.
const traceLines: string[] = []
let traceFile = ''
let traceOn: boolean | undefined
let traceFlushedAt = 0
function trace(line: string) {
  const t = new Date()
  traceLines.push(`${t.toLocaleTimeString('en-US')} ${line}`)
  if (traceLines.length > 300) traceLines.splice(0, traceLines.length - 300)
}
async function flushTrace($: EngineInterface) {
  if (Date.now() - traceFlushedAt < 1500) return
  traceFlushedAt = Date.now()
  try {
    if (traceOn === undefined) {
      const tmp = norm((await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp')
      traceOn = await $.fs.exists(`${tmp}/live-files-trace.on`)
      traceFile = `${tmp}/live-files-trace-${(await $.session.id()).slice(0, 8)}.log`
    }
    if (!traceOn) return
    await $.fs.write(traceFile, traceLines.join('\n') + '\n')
  } catch {
    // tracing must never break the pane
  }
}
const DRAW_MS = 3000
async function seedFromHistory($: EngineInterface, root: string, files: Map<string, number>) {
  await update($, historyNoteA, () => "Reading this chat's history...")
  const startedAt = Date.now()
  const slow = $.clock.after(HISTORY_MS, () => {
    void update($, historyNoteA, note =>
      note.startsWith('Reading') ? "Still reading this chat's history (a long chat); new changes are marked meanwhile." : note)
  })
  trace(`history start`)
  const found = await historyWrites($).catch(() => ({} as Record<string, Change>))
  slow.cancel()
  trace(`history end ${Date.now() - startedAt}ms, ${Object.keys(found).length} files`)
  if (root !== (await read($, rootA))) return // the folder changed meanwhile
  const touched = { ...found, ...(await read($, touchedA)) }
  const seeded: Record<string, Change> = {}
  for (const [rel, mtime] of files) {
    const mark = touched[join(root, rel).toLowerCase()]
    if (mark && mark.kind !== 'deleted') seeded[rel] = { kind: mark.kind, at: mtime }
  }
  if (Object.keys(seeded).length > 0) await update($, changesA, prev => ({ ...seeded, ...prev }))
  await update($, versionA, v => v + 1)
}

// Blinks the dots of fresh changes for PULSE_MS, then settles them.
function startBlink($: EngineInterface) {
  blinkUntil = Date.now() + PULSE_MS
  if (blinkTimer) return
  blinkTimer = $.clock.every(600, () => {
    if (Date.now() > blinkUntil) {
      blinkTimer?.cancel()
      blinkTimer = undefined
      void update($, blinkA, () => false)
      void update($, versionA, v => v + 1)
      return
    }
    void update($, blinkA, v => !v)
  })
}

function startTimer($: EngineInterface) {
  timer?.cancel()
  timer = $.clock.every(SCAN_MS, () => {
    void scan($)
  })
}

async function pickRoot($: EngineInterface, path: string) {
  const typed = path.trim().replace(/^"(.*)"$/, '$1')
  if (!typed) return
  const cwd = await read($, cwdA)
  const abs = isAbs(typed) ? norm(typed) : join(norm(cwd), norm(typed))
  const st = await $.fs.stat(abs, { resolve: true }).catch(() => undefined)
  if (!st || st.kind !== 'dir') {
    await update($, noticeA, () => `Not a folder: ${abs}`)
    return
  }
  const root = norm(st.realPath ?? abs)
  timer?.cancel()
  snapshot = undefined
  listings = new Map()
  scannedDirs = new Set()
  before.clear()
  await update($, changesA, () => ({}))
  await update($, expandedA, () => [])
  await update($, selectedA, () => '')
  await update($, changedOnlyA, () => false)
  await update($, noticeA, () => '')
  await update($, rootA, () => root)
  const recent = ((await $.store.get('recent')) as string[] | undefined) ?? []
  await $.store.set(
    'recent',
    [root, ...recent.filter(r => r.toLowerCase() !== root.toLowerCase())].slice(0, 6),
  )
  const id = await $.session.id().catch(() => '')
  if (id) {
    const byChat = ((await $.store.get('rootByChat')) as Record<string, string> | undefined) ?? {}
    delete byChat[id] // re-added last, so the oldest chats drop off first
    await $.store.set('rootByChat', Object.fromEntries([...Object.entries(byChat), [id, root]].slice(-300)))
  }
  await scan($)
  startTimer($)
}

async function openPane($: EngineInterface) {
  await update($, isClosedA, () => false)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function pickWithExplorer($: EngineInterface, start: string) {
  if (await read($, isPickingA)) return
  await update($, isPickingA, () => true)
  await update($, noticeA, () => '')
  try {
    const run = await $.process.run(
      ['powershell.exe', '-NoProfile', '-STA', '-Command', EXPLORER_PICKER],
      { env: { LIVE_FILES_START: start.replace(/\//g, '\\') }, timeoutMs: 600_000 },
    )
    const chosen = run.stdout.trim()
    if (chosen) await pickRoot($, chosen)
    else if (run.exitCode !== 0) {
      await update($, noticeA, () => `The folder picker failed: ${run.stderr.trim().slice(0, 300)}`)
    }
  } catch (err) {
    await update($, noticeA, () => `The folder picker failed: ${String(err).slice(0, 300)}`)
  } finally {
    await update($, isPickingA, () => false)
  }
}

async function leaveRoot($: EngineInterface) {
  const root = await read($, rootA)
  timer?.cancel()
  timer = undefined
  snapshot = undefined
  await update($, browseA, () => (root ? parentDir(root) : ''))
  await update($, rootA, () => '')
  await update($, selectedA, () => '')
}

// A unified diff of two texts, three lines of context; '' when they match or
// are too big for the quadratic table.
export function unifiedDiff(oldText: string, newText: string): string {
  const a = oldText === '' ? [] : oldText.split(/\r?\n/)
  const b = newText === '' ? [] : newText.split(/\r?\n/)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  if (A.length === 0 && B.length === 0) return ''
  if (A.length * B.length > 4_000_000) return ''

  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1))
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      const row = dp[i]!
      const below = dp[i + 1]!
      row[j] = A[i] === B[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!)
    }
  }
  const ops: Array<{ t: ' ' | '-' | '+'; s: string }> = a.slice(0, pre).map(s => ({ t: ' ', s }))
  let i = 0
  let j = 0
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      ops.push({ t: ' ', s: A[i]! }); i++; j++
    } else if (i < A.length && (j === B.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ t: '-', s: A[i]! }); i++
    } else {
      ops.push({ t: '+', s: B[j]! }); j++
    }
  }
  for (const s of a.slice(a.length - suf)) ops.push({ t: ' ', s })

  const oldBefore: number[] = []
  const newBefore: number[] = []
  let o = 0
  let n = 0
  for (const op of ops) {
    oldBefore.push(o); newBefore.push(n)
    if (op.t !== '+') o++
    if (op.t !== '-') n++
  }
  const groups: Array<[number, number]> = []
  ops.forEach((op, k) => {
    if (op.t === ' ') return
    const s = Math.max(0, k - 3)
    const e = Math.min(ops.length - 1, k + 3)
    const last = groups[groups.length - 1]
    if (last && s <= last[1] + 1) last[1] = e
    else groups.push([s, e])
  })
  const out: string[] = []
  for (const [s, e] of groups) {
    const part = ops.slice(s, e + 1)
    const oc = part.filter(op => op.t !== '+').length
    const nc = part.filter(op => op.t !== '-').length
    const os = oc === 0 ? oldBefore[s]! : oldBefore[s]! + 1
    const ns = nc === 0 ? newBefore[s]! : newBefore[s]! + 1
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`)
    for (const op of part) out.push(op.t + op.s)
  }
  return out.join('\n')
}

// JetBrains New UI dark file-status colors (CLion); type tags use its icon palette.
const TONE: Record<Change['kind'], { letter: string; color: string }> = {
  added: { letter: 'A', color: '#73bd79' },
  modified: { letter: 'M', color: '#70aeff' },
  deleted: { letter: 'D', color: '#868a91' },
}
const CHEVRON = '#8b8f96'
const TIP: Record<Change['kind'], string> = {
  added: 'Added: a new file',
  modified: 'Modified: this file changed',
  deleted: 'Deleted: this file was removed',
}
const PULSE_MS = 8000

const EXT_TONE: Array<[RegExp, string]> = [
  [/\.(py|pyi|ipynb)$/i, '#548af7'],
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '#d6ae58'],
  [/\.(md|mdx|txt|rst)$/i, '#8a96a3'],
  [/\.(json|ya?ml|toml|ini|cfg|env)$/i, '#e08855'],
  [/\.(pdf)$/i, '#db5c5c'],
  [/\.(docx?|pptx?|xlsx?|csv)$/i, '#548af7'],
  [/\.(png|jpe?g|gif|svg|webp|mp4|mov|mkv|mp3|wav)$/i, '#a571e6'],
  [/\.(c|cpp|h|hpp|java|kt|go|rs|cs)$/i, '#5fb865'],
  [/\.(html?|css|scss)$/i, '#e08855'],
]
const toneOf = (name: string) => EXT_TONE.find(([re]) => re.test(name))?.[1] ?? '#868a91'

// The right-hand column, JetBrains style: size and age for files, item count for folders.
const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ageOf = (mtime: number, now: number) => {
  const s = Math.max(0, (now - mtime) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`
  const d = new Date(mtime)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

const extTag = (name: string) => {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 4) : ''
  return ext.padEnd(5, ' ')
}

async function openInViewer($: EngineInterface, root: string, rel: string) {
  const path = join(root, rel).replace(/\//g, '\\')
  try {
    const ran = await $.tool.call({
      tool: 'mcp__ccd_view__show_pane',
      pane: 'file',
      path,
      consent: `The user clicked ${rel} in the Live files pane to open it.`,
    } as never) as { deny?: string; isError?: boolean }
    if (ran.deny || ran.isError) throw new Error('not opened')
  } catch {
    // The app could not show it (outside the chat's folder, say): preview here.
    await update($, showFullA, () => false)
    await update($, selectedA, () => rel)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, cwdA, () => norm(e.cwd))
    const savedView = (await $.store.get(VIEW_KEY)) as Partial<Record<ViewKey, boolean>> | undefined
    await update($, viewA, () => ({ ...VIEW_DEFAULT, ...savedView }))
    await $.command.register({
      name: 'files',
      description: 'Open the live file tree (optionally: /files <folder>)',
      argumentHint: '[folder]',
    })
    if (await read($, rootA)) {
      // Rebuild the marks on every load: state outlives a reload, and marks
      // from older code (or a wrong guess) would otherwise stick around.
      await update($, changesA, () => ({}))
      void scan($)
      startTimer($)
    } else {
      // Each chat keeps its own folder: reopen the one this chat watched last.
      // A chat that never picked one gets the picker, with Recent one click away.
      const id = await $.session.id().catch(() => '')
      const byChat = ((await $.store.get('rootByChat')) as Record<string, string> | undefined) ?? {}
      if (id && byChat[id]) void pickRoot($, byChat[id])
    }
    void openPane($)

    return next(e)
  })

  // Remember a close, so the button above the prompt can bring the pane back.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, isClosedA, () => true)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isClosedA))) return next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Button key="reopen" onPress={() => { void openPane($) }}>Open Live files</Button>
      </Box>
    )
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    await openPane($)
    if (e.args.trim()) {
      await pickRoot($, e.args)
      const notice = await read($, noticeA)
      if (notice) return { text: notice }
      return { text: `Watching ${await read($, rootA)}.` }
    }

    return { text: 'Live files pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const root = WRITERS.has(tool) ? await read($, rootA) : ''
    let key = ''
    let existed = true
    if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
      try {
        const input = e as unknown as { file_path?: string; notebook_path?: string }
        const path = input.file_path ?? input.notebook_path
        if (path) {
          const abs = norm(isAbs(path) ? path : join(await read($, cwdA), path))
          key = abs.toLowerCase()
          existed = await $.fs.exists(abs)
          const rel = root ? relOf(root, abs) : undefined
          if (rel && !before.has(rel)) {
            before.set(rel, existed ? await $.fs.read(abs).catch(() => null) : null)
          }
        }
      } catch {
        // Losing this only costs a mark or a diff, never the tool call.
      }
    }
    trace(`tool ${tool} start`)
    const result = await next(e)
    trace(`tool ${tool} end`)
    if (key) {
      await update($, touchedA, prev => ({
        ...prev,
        [key]: { kind: prev[key]?.kind === 'added' || !existed ? 'added' : 'modified', at: Date.now() } as Change,
      }))
    }
    if (root) void scan($)

    return result
  }).catch(($, e, next) => next(e)) // never block a tool over this pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Never leave the pane blank: a draw that throws shows its error, and one that
    // runs past DRAW_MS shows a holding line until the next redraw.
    const draw = async (): Promise<RenderElement> => {
      const ui = $.ui.resolve(e)
      const { Box, Text, Button, Code } = ui
      const Input = 'Input' in ui ? ui.Input : undefined
      const root = await read($, rootA)
      const notice = await read($, noticeA)

      // Picker: nothing is scanned until a folder is chosen.
      if (!root) {
        const cwd = await read($, cwdA)
        const browse = (await read($, browseA)) || cwd
        const subdirs = (await $.fs.list(browse).catch(() => [] as FsEntry[]))
          .filter(en => en.kind === 'dir' && !IGNORE.has(en.name))
          .sort(byName)
        const recent = ((await $.store.get('recent')) as string[] | undefined) ?? []
        const up = parentDir(browse)
        const isPicking = await read($, isPickingA)
        const isWindows = /^[A-Za-z]:/.test(cwd)

        return (
          <Box flexDirection="column" gap={1}>
            <Text bold>Which folder should I watch?</Text>
            <Text dimColor>Nothing is scanned until you pick one.</Text>
            {notice && <Text color="error">{notice}</Text>}
            {Input && (
              <Input
                key="path"
                label="Folder path"
                placeholder="Full path, or a folder name inside this chat's folder"
                submitLabel="Watch"
                onSubmit={value => {
                  void pickRoot($, value)
                }}
              />
            )}
            {isWindows && (
              <Box flexDirection="column">
                <Button
                  key="explorer"
                  variant="primary"
                  onPress={() => { void pickWithExplorer($, browse) }}
                >
                  {isPicking ? 'Picker is open...' : 'Browse with File Explorer...'}
                </Button>
                {isPicking && (
                  <Text dimColor>If you can't see it, it may be behind this window (check the taskbar).</Text>
                )}
              </Box>
            )}
            {recent.length > 0 && (
              <Box flexDirection="column">
                <Text bold>Recent</Text>
                {recent.map(r => (
                  <Button key={`recent:${r}`} plain onPress={() => { void pickRoot($, r) }}>
                    {baseName(r)} <Text dimColor>{r}</Text>
                  </Button>
                ))}
              </Box>
            )}
            <Box flexDirection="column">
              <Text bold>Browse</Text>
              <Text dimColor>{browse}</Text>
              <Box flexDirection="row" gap={1}>
                <Button key="use" onPress={() => { void pickRoot($, browse) }}>
                  Watch this folder
                </Button>
                {up !== browse && (
                  <Button key="up" onPress={() => { void update($, browseA, () => up) }}>
                    Up one level
                  </Button>
                )}
              </Box>
              {subdirs.slice(0, 300).map(en => (
                <Button
                  key={`browse:${en.name}`}
                  plain
                  onPress={() => { void update($, browseA, () => join(browse, en.name)) }}
                >
                  {'▸ '}{en.name}
                </Button>
              ))}
              {subdirs.length === 0 && <Text dimColor>No folders in here.</Text>}
            </Box>
          </Box>
        )
      }

      await read($, versionA) // redraw on every scan that found something
      const changes = await read($, changesA)
      const selected = await read($, selectedA)

      // Preview of one file.
      if (selected) {
        const change = changes[selected]
        const showFull = await read($, showFullA)
        const abs = join(root, selected)
        const st = await $.fs.stat(abs).catch(() => undefined)
        let current: string | undefined
        let problem = ''
        if (!st) problem = 'This file no longer exists.'
        else if (st.size > MAX_PREVIEW_BYTES) problem = `Too big to preview (${Math.round(st.size / 1024)} KB).`
        else {
          current = await $.fs.read(abs).catch(() => undefined)
          if (current === undefined) problem = 'Could not read this file.'
          else if (current.includes('\u0000')) { problem = 'Binary file, no preview.'; current = undefined }
        }
        const original = before.get(selected)
        const diff = before.has(selected) && current !== undefined && !showFull
          ? unifiedDiff(original ?? '', current)
          : ''
        const lines = current?.split(/\r?\n/) ?? []

        return (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1}>
              <Button key="back" onPress={() => { void update($, selectedA, () => '') }}>
                Back
              </Button>
              {before.has(selected) && current !== undefined && (
                <Button key="mode" onPress={() => { void update($, showFullA, v => !v) }}>
                  {showFull ? 'Show changes' : 'Show whole file'}
                </Button>
              )}
            </Box>
            <Text bold>
              {selected}
              {change && <Text color={TONE[change.kind].color}> {change.kind}</Text>}
            </Text>
            {problem && <Text dimColor>{problem}</Text>}
            {diff && <Text dimColor>What Claude changed in this chat:</Text>}
            {diff && <Code source={diff} format="diff" path={selected} />}
            {!diff && current !== undefined && (
              <Code
                source={lines.slice(0, MAX_PREVIEW_LINES).join('\n')}
                path={selected}
                startLine={1}
              />
            )}
            {!diff && lines.length > MAX_PREVIEW_LINES && (
              <Text dimColor>Showing the first {MAX_PREVIEW_LINES} of {lines.length} lines.</Text>
            )}
          </Box>
        )
      }

      const changedOnly = await read($, changedOnlyA)
      const expanded = new Set(await read($, expandedA))
      const blink = await read($, blinkA)
      const view = await read($, viewA)
      const isMenuOpen = await read($, isMenuOpenA)
      const collapsed = new Set(await read($, collapsedA))
      const isPaused = await read($, isPausedA)
      const historyNote = await read($, historyNoteA)
      const now = Date.now()
      const keys = Object.keys(changes).sort()
      const tally = { added: 0, modified: 0, deleted: 0 }
      const perDir = new Map<string, { n: number; at: number }>()
      for (const rel of keys) {
        const change = changes[rel]!
        tally[change.kind]++
        for (let d = parentOf(rel); ; d = parentOf(d)) {
          const was = perDir.get(d)
          perDir.set(d, { n: (was?.n ?? 0) + 1, at: Math.max(was?.at ?? 0, change.at) })
          if (d === '') break
        }
      }
      const isFresh = (at: number) => now - at < PULSE_MS
      const isOpenDir = (rel: string) =>
        expanded.has(rel) || (view.autoOpen && perDir.has(rel) && !collapsed.has(rel))
      const toggle = (rel: string) => {
        if (isOpenDir(rel)) {
          void update($, expandedA, list => list.filter(x => x !== rel))
          void update($, collapsedA, list => (list.includes(rel) ? list : [...list, rel]))
        } else {
          void update($, collapsedA, list => list.filter(x => x !== rel))
          void update($, expandedA, list => [...list, rel])
        }
      }
      // Folders first; with "Recent changes first", the most recently touched lead
      // within each kind, else names in order.
      const lastTouched = (dir: string, en: FsEntry) => {
        const rel = dir ? `${dir}/${en.name}` : en.name
        return en.kind === 'dir'
          ? perDir.get(rel)?.at ?? 0
          : Math.max(en.mtimeMs, changes[rel]?.at ?? 0)
      }
      const sorted = (dir: string, entries: FsEntry[]) => {
        const list = entries.filter(en => view.dotfiles || !en.name.startsWith('.'))
        if (!view.recentFirst) return list.sort(byName)
        return list.sort((a, b) =>
          (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) ||
          lastTouched(dir, b) - lastTouched(dir, a) || byName(a, b))
      }

      const rows: RenderElement[] = []
      let target = rows // where push puts a row: the top list, or an open folder's
      let drawn = 0
      let hidden = 0
      const push = (one: RenderElement) => {
        if (drawn < MAX_ROWS) { target.push(one); drawn++ }
        else hidden++
      }
      const isDesktop = e.surface === 'desktop'
      // A row: chevron, type tag, the name, then the change mark; nesting indents it.
      const row = (opts: {
        key: string; depth: number; kind: 'dir' | 'file'; name: string; label: string
        isOpen?: boolean; isMuted?: boolean; color?: string; isStruck?: boolean
        letter?: string; dot?: { color: string; isPulsing: boolean }; count?: number
        onPress?: () => void; tip?: string; meta?: string
      }) => {
        const name = (
          <Text color={opts.color} dimColor={opts.isMuted} strikethrough={opts.isStruck} wrap="truncate-end">
            {opts.label}
          </Text>
        )
        push(
          <Box key={`row:${opts.key}`} flexDirection="row" alignItems="center">
            <Box flexShrink={0} flexDirection="row">
              <Text mono color={CHEVRON}>{opts.kind === 'dir' ? (opts.isOpen ? '▾ ' : '▸ ') : '  '}</Text>
              <Text mono size="caption" color={toneOf(opts.name)} dimColor={opts.isMuted}>
                {opts.kind === 'file' && view.tags ? extTag(opts.name) : ''}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {opts.onPress
                ? <Button key={opts.key} plain onPress={opts.onPress}>{name}</Button>
                : name}
            </Box>
            {opts.meta && (
              <Box flexShrink={0}><Text dimColor size="caption" mono>{opts.meta}  </Text></Box>
            )}
            {opts.tip && (
              // The keyed Box is the hover scope; the card inside it shows while
              // the pointer is on the mark (the docs' own reveal pattern).
              <Box key={`mark:${opts.key}`} flexShrink={0} flexDirection="row">
                {opts.count !== undefined && <Text dimColor size="caption">{opts.count} </Text>}
                {opts.letter && <Text color={opts.color} size="caption" mono>{opts.letter}</Text>}
                {opts.dot && (
                  <Text color={opts.dot.color} dimColor={opts.dot.isPulsing && blink}> ●</Text>
                )}
                <Box
                  position="absolute"
                  top={-1}
                  right={2}
                  width={opts.tip.length + 2}
                  display="none"
                  hover={{ display: 'flex' }}
                  backgroundColor="inverseText"
                  paddingX={1}
                >
                  <Text size="caption" wrap="truncate-end">{opts.tip}</Text>
                </Box>
              </Box>
            )}
          </Box>,
        )
      }
      const fileRow = (rel: string, label: string, depth: number, entry?: FsEntry) => {
        const change = changes[rel]
        const tone = change ? TONE[change.kind] : undefined
        row({
          meta: entry && (view.size || view.age)
            ? [view.size ? sizeOf(entry.size).padStart(7) : '', view.age ? ageOf(entry.mtimeMs, now).padStart(6) : '']
              .filter(Boolean).join('  ')
            : undefined,
          key: `file:${rel}`, depth, kind: 'file', name: baseName(rel), label,
          color: tone?.color, isStruck: change?.kind === 'deleted', letter: tone?.letter,
          dot: change && tone && isFresh(change.at) ? { color: tone.color, isPulsing: true } : undefined,
          tip: change
            ? `${TIP[change.kind]}${isFresh(change.at) ? ', just now' : ''}`
            : undefined,
          onPress: change?.kind === 'deleted' ? undefined : () => { void openInViewer($, root, rel) },
        })
      }
      const walk = (dir: string, depth: number) => {
        const entries = listings.get(dir)
        if (!entries) {
          push(
            <Text key={`n:${dir}`} dimColor size="caption">
              {dir === '' ? 'Reading the folder...' : 'Not scanned: too many files'}
            </Text>,
          )
          return
        }
        for (const en of sorted(dir, [...entries])) {
          const rel = dir ? `${dir}/${en.name}` : en.name
          if (en.kind === 'dir') {
            if (IGNORE.has(en.name)) {
              if (!view.ignored) continue
              row({ key: `skip:${rel}`, depth, kind: 'dir', name: en.name, label: en.name, isMuted: true })
              continue
            }
            const isOpen = isOpenDir(rel)
            const inside = perDir.get(rel)
            row({
              key: `dir:${rel}`, depth, kind: 'dir', name: en.name, label: en.name, isOpen,
              meta: view.size && listings.has(rel)
                ? `${listings.get(rel)!.length} items`.padStart(view.age ? 15 : 7)
                : undefined,
              color: inside ? TONE.modified.color : undefined, // JetBrains tints a changed folder's name
              count: inside && !isOpen ? inside.n : undefined,
              dot: inside ? { color: TONE.modified.color, isPulsing: isFresh(inside.at) } : undefined,
              tip: inside
                ? `${inside.n} changed file${inside.n === 1 ? '' : 's'} inside${isFresh(inside.at) ? ', work happening now' : ''}`
                : undefined,
              onPress: () => toggle(rel),
            })
            if (isOpen) {
              // The folder's contents beside one guide line: a zero-width box's
              // border, so the line runs unbroken down every row inside.
              const kids: RenderElement[] = []
              const outer = target
              target = kids
              walk(rel, depth + 1)
              target = outer
              target.push(
                <Box key={`kids:${rel}`} flexDirection="row">
                  {isDesktop && view.guides
                    ? (
                      // A hairline bar (0.15 of a cell, about 1px) as tall as the folder: a border
                      // on a zero-width box drew as a rounded pill instead.
                      <Box width={0.15} flexShrink={0} marginLeft={1} marginRight={1} backgroundColor="#4e5157" />
                    )
                    : <Text mono>{'  '}</Text>}
                  <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{kids}</Box>
                </Box>,
              )
            }
          } else {
            fileRow(rel, en.name, depth, en)
          }
        }
        for (const rel of keys) {
          if (changes[rel]?.kind === 'deleted' && parentOf(rel) === dir) {
            fileRow(rel, baseName(rel), depth)
          }
        }
      }
      if (changedOnly) {
        for (const rel of keys) fileRow(rel, rel, 0)
        if (keys.length === 0) push(<Text key="none" dimColor>No changes yet. They show up here as they happen.</Text>)
      } else {
        walk('', 0)
      }

      const isNarrow = (e.props.bodyColumns ?? 80) < 48
      const link = (key: string, label: string, onPress: () => void) => (
        <Button key={key} plain onPress={onPress}><Text dimColor size="footnote">{label}</Text></Button>
      )

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="center">
              <Box flexGrow={1}><Text weight="semibold">{baseName(root)}</Text></Box>
              <Text size="footnote" mono>
                <Text color={TONE.added.color}>+{tally.added} </Text>
                <Text color={TONE.modified.color}>~{tally.modified} </Text>
                <Text color={TONE.deleted.color}>-{tally.deleted}</Text>
              </Text>
            </Box>
            <Text dimColor size="caption" wrap="truncate-start">{root}</Text>
          </Box>
          {/* Wraps onto more lines as the pane narrows; very narrow, the labels shorten too. */}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {link('pick', isNarrow ? 'Folder' : 'Change folder', () => { void leaveRoot($) })}
            {link('only', changedOnly ? (isNarrow ? 'All' : 'All files') : (isNarrow ? 'Changed' : 'Changes only'), () => { void update($, changedOnlyA, v => !v) })}
            {link('collapse', 'Collapse', () => {
              void update($, expandedA, () => [])
              void update($, collapsedA, () => [...perDir.keys()])
            })}
            {link('pause', isPaused ? 'Resume' : 'Pause', () => {
              void update($, isPausedA, v => !v).then(() => scan($))
            })}
            {link('view', isMenuOpen ? 'View ▴' : 'View ▾', () => { void update($, isMenuOpenA, v => !v) })}
            {keys.length > 0 && link('clear', 'Clear', () => { void update($, changesA, () => ({})) })}
          </Box>
          {notice && <Text color={TONE.deleted.color} size="footnote">{notice}</Text>}
          {isMenuOpen && (
            <Box flexDirection="column">
              {VIEW_LABEL.map(([key, label]) => (
                <Button
                  key={`view:${key}`}
                  plain
                  onPress={() => {
                    void update($, viewA, v => {
                      const next = { ...v, [key]: !v[key] }
                      void $.store.set(VIEW_KEY, next)
                      return next
                    })
                  }}
                >
                  <Text color={view[key] ? TONE.modified.color : undefined} dimColor={!view[key]}>
                    {view[key] ? '● ' : '○ '}
                  </Text>
                  <Text dimColor={!view[key]} size="footnote">{label}</Text>
                </Button>
              ))}
            </Box>
          )}
          {historyNote && <Text dimColor size="caption">{historyNote}</Text>}
          {isPaused && (
            <Text size="caption" color={TONE.modified.color}>Paused: the tree is frozen. Resume catches up on everything.</Text>
          )}
          {view.legend && (
            <Text size="caption">
              <Text color={TONE.added.color}>A</Text><Text dimColor> new   </Text>
              <Text color={TONE.modified.color}>M</Text><Text dimColor> changed   </Text>
              <Text color={TONE.deleted.color}>D</Text><Text dimColor> deleted   </Text>
              <Text color={TONE.modified.color}>●</Text><Text dimColor> changes inside, blinks while live</Text>
            </Text>
          )}
          {isCut && <Text dimColor size="caption">Big folder: only the first {MAX_ENTRIES} entries are watched.</Text>}
          <Box flexDirection="column">{rows}</Box>
          {hidden > 0 && <Text dimColor size="caption">{hidden} more rows. Collapse some folders.</Text>}
        </Box>
      )
    }
    const { Box, Text } = $.ui.resolve(e)
    const drawStart = Date.now()
    trace('draw start')
    try {
      let timer: { cancel: () => void } | undefined
      const slow = new Promise<'slow'>(resolve => { timer = $.clock.after(DRAW_MS, () => resolve('slow')) })
      const drawn = await Promise.race([draw(), slow])
      timer?.cancel()
      trace(`draw end ${Date.now() - drawStart}ms${drawn === 'slow' ? ' (slow)' : ''}`)
      void flushTrace($)
      if (drawn === 'slow') return <Text dimColor>Still loading the folder...</Text>
      return drawn
    } catch (err) {
      trace(`draw error ${String(err).slice(0, 200)}`)
      void flushTrace($)
      return (
        <Box flexDirection="column">
          <Text color={TONE.deleted.color}>Live files hit an error while drawing:</Text>
          <Text dimColor size="caption">{String(err instanceof Error ? `${err.name}: ${err.message}` : err).slice(0, 400)}</Text>
        </Box>
      )
    }
  })
}
