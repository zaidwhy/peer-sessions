import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { normPath, racingGitVerb, intentFrom, SHAPE } from '../hooks/registry'

const HOME = 'C:/Users/dev'
const DIR = `${HOME}/.claude/peer-sessions`
const OWN_ID = 'aaaaaaaa-own-session'
const PEER_ID = 'bbbbbbbb-peer-session'

type File = { text: string; mtimeMs: number }

// The engine beneath the mod: an in-memory disk, one repo at C:/work/app on main.
// The engine hands fs paths over in the platform's own spelling; key the disk on one.
const key = (path: string) => path.replace(/\\/g, '/')

function world(on: On, options: { repo?: string | null; isDiskBroken?: boolean } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  const files = new Map<string, File>()
  const statuses: (string | undefined)[] = []
  const ranTools: string[] = []
  const repo = options.repo === undefined ? 'C:/work/app' : options.repo

  on('session.id', () => ({ value: OWN_ID }))
  on('session.cwd', () => ({ value: 'C:\\work\\app' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'peer-sessions' } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ({
    value: repo
      ? { exitCode: 0, stdout: `${repo}\nmain\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.write', (_, e) => {
    if (options.isDiskBroken) return { deny: 'disk gone' }
    files.set(key(e.path), { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const file = files.get(key(e.path))
    return file ? { value: file.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', (_, e) => {
    if (options.isDiskBroken) return { deny: 'disk gone' }
    const dir = key(e.path)
    return { value: [...files.entries()]
      .filter(([path]) => path.startsWith(`${dir}/`))
      .map(([path, file]) => ({
        name: path.slice(dir.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })) }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', (_, e) => {
    ranTools.push(e.tool)
    return { result: {} }
  })

  const seedPeer = (fields: Record<string, unknown> = {}) =>
    files.set(`${DIR}/${PEER_ID}.json`, {
      mtimeMs: clock.now(),
      text: JSON.stringify({
        shape: SHAPE,
        id: PEER_ID,
        cwd: 'c:/work/app',
        repo: 'c:/work/app',
        branch: 'main',
        started: clock.now(),
        intent: 'refactor the invoice parser',
        touched: { 'c:/work/app/src/invoice.py': clock.now() },
        ...fields,
      }),
    })

  const ownRecord = () => JSON.parse(files.get(`${DIR}/${OWN_ID}.json`)?.text ?? 'null')

  return { clock, files, statuses, ranTools, seedPeer, ownRecord }
}

const typed = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })
const start = { cwd: 'C:\\work\\app', surface: 'terminal' as const, isInteractive: true }

test('paths are one spelling per file on Windows, untouched elsewhere', () => {
  expect(normPath('C:\\Work\\App\\src\\Invoice.py', 'C:/work')).toBe('c:/work/app/src/invoice.py')
  expect(normPath('src/../src/./a.py', 'C:\\work\\app')).toBe('c:/work/app/src/a.py')
  expect(normPath('/home/dev/App.py', '/home/dev')).toBe('/home/dev/App.py')
})

test('only state-changing git commands count as racing', () => {
  expect(racingGitVerb('git -C ../x commit -m "wip"')).toBe('commit')
  expect(racingGitVerb('git fetch origin && git push')).toBe('push')
  expect(racingGitVerb('git status -sb')).toBe(null)
  expect(racingGitVerb('git log --oneline -5')).toBe(null)
})

test('short replies and harness messages never replace the task', () => {
  expect(intentFrom('continue')).toBe(null)
  expect(intentFrom('<task-notification> <task-id>x</task-id> long enough to pass')).toBe(null)
  expect(intentFrom('/review the open pull request please')).toBe(null)
  expect(intentFrom('fix the retrieval cutoff in recall\nmore detail here')).toBe('fix the retrieval cutoff in recall')
})

test('a session registers itself and its checkout at start', async ($, on) => {
  const w = world(on)
  await $.session.start(start)

  const own = w.ownRecord()
  expect(own.id).toBe(OWN_ID)
  expect(own.repo).toBe('c:/work/app')
  expect(own.branch).toBe('main')
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('the first typed prompt is briefed on live peers, later ones only on new peers', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  const first = await $.prompt.submit(typed('add rate limiting to the upload endpoint'))
  const brief = first.context?.join('\n') ?? ''
  expect(brief).toContain('bbbbbbbb')
  expect(brief).toContain('refactor the invoice parser')
  expect(brief).toContain('[SAME CHECKOUT AS YOU]')
  expect(w.ownRecord().intent).toBe('add rate limiting to the upload endpoint')
  expect(w.statuses.at(-1)).toBe('peers: 1 live, 1 in this checkout')

  const second = await $.prompt.submit(typed('continue'))
  expect(second.context).toBe(undefined)
  expect(w.ownRecord().intent).toBe('add rate limiting to the upload endpoint')
})

test('a notification is not mistaken for the task and gets no briefing', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  const result = await $.prompt.submit({
    text: '<task-notification> background build finished with exit code 0',
    origin: { kind: 'task-notification' } as never,
    wait: false,
  })
  expect(result.context).toBe(undefined)
  expect(w.ownRecord().intent).toBe('')
})

test('editing a file a live peer just edited is refused once, then allowed', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  const refused = await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\app\\src\\Invoice.py', old_string: 'a', new_string: 'b' })
  expect(JSON.stringify(refused)).toContain('refactor the invoice parser')
  expect(w.ranTools).toEqual([])

  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  expect(w.ranTools).toEqual(['Edit'])
  expect(Object.keys(w.ownRecord().touched)).toEqual(['c:/work/app/src/invoice.py'])
})

test('a peer that stopped heartbeating no longer blocks anything', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)
  await w.clock.advance(10 * 60_000)

  await $.tool.call({ tool: 'Write', file_path: 'C:/work/app/src/invoice.py', content: 'x' })
  expect(w.ranTools).toEqual(['Write'])
})

test('an ended peer is ignored even while its file is fresh', async ($, on) => {
  const w = world(on)
  w.seedPeer({ ended: true })
  await $.session.start(start)

  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  expect(w.ranTools).toEqual(['Edit'])
})

test('git commit in a checkout a live peer shares is refused once; git status is never refused', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  await $.tool.call({ tool: 'Bash', command: 'git status -sb' })
  expect(w.ranTools).toEqual(['Bash'])

  const refused = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "wip"' })
  expect(JSON.stringify(refused)).toContain('same checkout')
  expect(w.ranTools).toEqual(['Bash'])

  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "wip"' })
  expect(w.ranTools).toEqual(['Bash', 'Bash'])
})

test('a peer in a different checkout (its own worktree) does not block git', async ($, on) => {
  const w = world(on)
  w.seedPeer({ repo: 'c:/work/app-feature', cwd: 'c:/work/app-feature' })
  await $.session.start(start)

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(w.ranTools).toEqual(['Bash'])
})

test('outside a git repo nothing about git is refused', async ($, on) => {
  const w = world(on, { repo: null })
  w.seedPeer()
  await $.session.start(start)

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(w.ranTools).toEqual(['Bash'])
})

test('the heartbeat keeps the record fresh and session end writes a tombstone', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  const before = w.files.get(`${DIR}/${OWN_ID}.json`)?.mtimeMs ?? 0

  await w.clock.advance(61_000)
  expect(w.files.get(`${DIR}/${OWN_ID}.json`)?.mtimeMs ?? 0).toBeGreaterThan(before)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: OWN_ID, resume: {} as never })
  expect(w.ownRecord().ended).toBe(true)
})

test('a broken registry never blocks a tool call or a prompt', async ($, on) => {
  const w = world(on, { isDiskBroken: true })
  await $.session.start(start)

  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/a.py', old_string: 'a', new_string: 'b' })
  expect(w.ranTools).toEqual(['Edit'])
  const prompt = await $.prompt.submit(typed('add rate limiting to the upload endpoint'))
  expect(prompt.text).toBe('add rate limiting to the upload endpoint')
})

test('/peer-sessions lists live peers', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  on('command.run', () => ({ text: 'engine' }))
  await $.session.start(start)

  const ran = await $.command.run({ command: 'peer-sessions', args: '', origin: { kind: 'composer' } } as never)
  expect(ran.text).toContain('1 other live session(s):')
  expect(ran.text).toContain('refactor the invoice parser')
})
