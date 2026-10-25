import { expect, mock, test } from 'claude-code/testing'

import { unifiedDiff } from '../hooks/register'

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }
const file = (name: string, mtimeMs = 1): Entry => ({ name, kind: 'file', size: 10, mtimeMs, isLink: false })
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const PANE = {
  plugin: 'live-files',
  component: 'Pane',
  requestId: 'live-files',
  props: {
    title: 'Live files',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('picks a folder, then marks added, changed and deleted files', async ($, on) => {
  // A tiny disk: C:/work holds two projects; only "proj" gets watched.
  const disk: Record<string, Entry[]> = {
    'C:/work': [dir('proj'), dir('other')],
    'C:/work/proj': [dir('src'), dir('.venv'), file('README.md')],
    'C:/work/proj/src': [file('a.py'), file('b.py')],
    'C:/work/other': [file('big.bin')],
  }
  const listed: string[] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    listed.push(path)
    const entries = disk[path]
    if (!entries) throw new Error('ENOENT ' + e.path)
    return { value: entries }
  })
  on('fs.stat', (_, e) => ({
    value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path },
  }))
  on('fs.read', () => ({ value: 'print(1)\n' }))
  const opened: string[] = []
  on('tool.call', (_, e) => {
    const input = e as unknown as { tool: string; path?: string }
    if (input.tool === 'mcp__ccd_view__show_pane') opened.push(input.path ?? '')
    return { result: {} }
  })

  await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
  expect(listed.length).toBe(0) // nothing scanned before a pick

  const picker = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await picker.find({ type: 'Text', text: /Which folder/ })).toBeDefined()
  await picker.unmount()

  await $.command.run({ command: 'files', args: 'proj' })
  expect(listed.includes('C:/work/other')).toBe(false) // only the chosen folder
  expect(listed.includes('C:/work/proj/.venv')).toBe(false) // ignored folder not entered

  // Change the disk: b.py edited, a.py deleted, c.py added.
  disk['C:/work/proj/src'] = [file('b.py', 2), file('c.py')]
  await clock.advance(2600)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /-1/ })).toBeDefined()
    // src holds changes, so auto-open has it open; a press on it closes it.
    expect(await ui.find({ key: 'file:src/c.py' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a\.py/ })).toBeDefined() // the deleted ghost row
    await ui.press({ key: 'file:src/c.py' }) // opens in the app's own Files viewer
    expect(opened.at(-1)).toBe('C:\\work\\proj\\src\\c.py')
    await ui.press({ key: 'dir:src' }) // close it: the person's close beats auto-open
    expect(await ui.find({ key: 'file:src/c.py' })).toBeUndefined()
    await ui.press({ key: 'dir:src' }) // and open it again for the next surface
    await ui.unmount()
  }
})

test('the diff has correct hunk headers', async () => {
  expect(unifiedDiff('a\nb\nc', 'a\nB\nc')).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
  expect(unifiedDiff('', 'x')).toBe('@@ -0,0 +1,1 @@\n+x')
  expect(unifiedDiff('same', 'same')).toBe('')
})

test('no reopen button while the pane is open', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => undefined)
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  // Stands for the engine's own band when the plugin passes.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const band = { plugin: 'live-files', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  expect(await ui.find({ key: 'reopen' })).toBeUndefined() // open: no button
  await ui.unmount()
})

test('Browse with File Explorer picks the folder the dialog returns', async ($, on) => {
  const argvs: string[][] = []
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'C:/work/my-app\r\n', stderr: '' } }
  })

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'explorer' })
  expect(argvs[0]?.[0]).toBe('powershell.exe')
  expect(await ui.find({ type: 'Text', text: /C:\/work\/my-app/ })).toBeDefined()
  await ui.unmount()
})

test('work done before the folder was picked still shows as changed', async ($, on) => {
  const disk: Record<string, Entry[]> = {
    'C:/work/proj': [file('old.py'), file('new.md')],
  }
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => ({ value: disk[e.path.replace(/\\/g, '/')] ?? [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.exists', (_, e) => ({ value: !e.path.endsWith('new.md') }))
  on('fs.read', () => ({ value: '' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  // Claude edits one file and creates another, before any folder is picked.
  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/proj/old.py', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/work/proj/new.md', content: '# hi' })
  await $.command.run({ command: 'files', args: 'proj' })
  await clock.advance(0) // the history is read in the background

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^A$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^M$/ })).toBeDefined()
  await ui.unmount()
})

test('only files this chat wrote are marked, read from its history', async ($, on) => {
  // Both files are brand new on disk; only one was written by this chat.
  const disk: Record<string, Entry[]> = {
    'C:/work/proj': [file('mine.py', Date.now()), file('someone_else.pdf', Date.now())],
  }
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: [{
      role: 'assistant', text: '',
      toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'C:/work/proj/mine.py' } }],
    }],
  }))
  on('fs.list', (_, e) => ({ value: disk[e.path.replace(/\\/g, '/')] ?? [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'files', args: 'proj' })
  await clock.advance(0) // the history is read in the background

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /~1/ })).toBeDefined() // mine.py only
  expect(await ui.find({ type: 'Text', text: /Modified: this file changed/ })).toBeDefined() // hover card
  await ui.unmount()
})

test('each chat reopens on its own folder, not the most recent one', async ($, on) => {
  mock.clock(on)
  // Chat A last watched proj; another chat watched other since, so other is most recent.
  mock.store(on, { recent: ['C:/work/other', 'C:/work/proj'], rootByChat: { 'chat-a': 'C:/work/proj' } })
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'chat-a' }))
  on('fs.list', (_, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('proj') ? [file('a.py')] : [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Which folder/ })).toBeUndefined() // no picker
  expect(await ui.find({ key: 'file:a.py' })).toBeDefined() // chat A's own folder, not the most recent
  await ui.unmount()
})

test('a brand-new chat starts on the picker with Recent listed', async ($, on) => {
  mock.clock(on)
  mock.store(on, { recent: ['C:/work/proj'], rootByChat: { 'some-other-chat': 'C:/work/proj' } })
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'brand-new' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Which folder/ })).toBeDefined()
  expect(await ui.find({ key: 'recent:C:/work/proj' })).toBeDefined()
  await ui.unmount()
})

test('writes from before a compaction come back from the transcript file', async ($, on) => {
  const disk: Record<string, Entry[]> = {
    'C:/work/proj': [dir('work'), file('untouched.pdf', Date.now())],
    'C:/work/proj/work': [file('engine.py'), file('notes.md')],
  }
  const transcript = 'C:/Users/you/.claude/projects/C--work/s1.jsonl'
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/you' })
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  // The engine's messages lost these writes to a compaction.
  on('session.messages', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: e.path.replace(/\\/g, '/') === transcript }))
  on('fs.list', (_, e) => ({ value: disk[e.path.replace(/\\/g, '/')] ?? [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: [
        '"name":"Write","input":{"file_path":"C:\\\\work\\\\proj\\\\work\\\\engine.py"',
        '"name":"Read","input":{"file_path":"C:\\\\work\\\\proj\\\\work\\\\notes.md"',
        '"name":"Edit","input":{"file_path":"C:\\\\work\\\\proj\\\\work\\\\notes.md"',
      ].join('\r\n'),
    },
  }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'files', args: 'proj' })
  await clock.advance(0) // the history is read in the background

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined() // engine.py, written new
  expect(await ui.find({ type: 'Text', text: /~1/ })).toBeDefined() // notes.md, read then edited
  expect(await ui.find({ type: 'Text', text: /wrote 2 files, 2 in this folder \(from transcript\)/ })).toBeDefined()
  await ui.unmount()
})

test('the View menu hides parts of the tree', async ($, on) => {
  mock.clock(on)
  mock.store(on, { recent: ['C:/work/proj'], rootByChat: { 'this-chat': 'C:/work/proj' } })
  on('session.id', () => ({ value: 'this-chat' }))
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [dir('.venv'), file('a.py')] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^\.venv$/ })).toBeDefined()
  await ui.press({ key: 'view' })
  expect(await ui.find({ type: 'Text', text: /\bB\b|KB|MB/ })).toBeUndefined() // size is off by default
  await ui.press({ key: 'view:ignored' })
  expect(await ui.find({ type: 'Text', text: /^\.venv$/ })).toBeUndefined()
  await ui.press({ key: 'view:legend' })
  expect(await ui.find({ type: 'Text', text: /changes inside/ })).toBeUndefined()
  await ui.unmount()
})

test('dotfiles hide, recent changes sort first, pause freezes and resume catches up', async ($, on) => {
  const disk: Record<string, Entry[]> = {
    'C:/work/proj': [file('.gitignore'), file('a_old.py', 1), file('z_new.py', 5)],
  }
  const clock = mock.clock(on)
  mock.store(on, { recent: ['C:/work/proj'], rootByChat: { 'this-chat': 'C:/work/proj' } })
  on('session.id', () => ({ value: 'this-chat' }))
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => ({ value: disk[e.path.replace(/\\/g, '/')] ?? [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'file:.gitignore' })).toBeDefined()
  await ui.press({ key: 'view' })
  await ui.press({ key: 'view:dotfiles' })
  expect(await ui.find({ key: 'file:.gitignore' })).toBeUndefined()

  // Recent first: z_new.py (newer) is listed before a_old.py.
  await ui.press({ key: 'view:recentFirst' })
  const order = async () => {
    const first = await ui.find({ key: 'file:z_new.py' })
    const second = await ui.find({ key: 'file:a_old.py' })
    return [first, second].every(Boolean)
  }
  expect(await order()).toBe(true)
  await ui.unmount()

  // Pause: a new file stays hidden; resume brings it in, marked added.
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pause' })
  disk['C:/work/proj'] = [...disk['C:/work/proj']!, file('later.py', 9)]
  await clock.advance(2600)
  expect(await ui.find({ key: 'file:later.py' })).toBeUndefined()
  await ui.press({ key: 'pause' })
  expect(await ui.find({ key: 'file:later.py' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow pane keeps every toolbar link, with short labels', async ($, on) => {
  mock.clock(on)
  mock.store(on, { rootByChat: { narrow: 'C:/work/proj' } })
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'narrow' }))
  on('fs.list', () => ({ value: [file('a.py')] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'desktop' })
  for (const key of ['pick', 'only', 'collapse', 'pause', 'view']) {
    expect(await ui.find({ key })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /^Folder$/ })).toBeDefined()
  await ui.unmount()
})

test('a slow history read never holds up the tree', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/you' })
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('proj') ? [file('a.py')] : [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', async () => {
    await gate // the transcript search is still running
    return { value: { exitCode: 0, stderr: '', stdout: '"name":"Write","input":{"file_path":"C:\\\\work\\\\proj\\\\a.py"' } }
  })

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  void $.command.run({ command: 'files', args: 'proj' })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'file:a.py' })).toBeDefined() // the tree is already there
  expect(await ui.find({ type: 'Text', text: /Reading this chat's history/ })).toBeDefined()

  release()
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined() // the mark arrives after
  await ui.unmount()
})

test('an error while drawing shows on the pane instead of a blank pane', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => { throw new Error('store is broken') })

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /hit an error while drawing/ })).toBeDefined()
  await ui.unmount()
})
