import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describePeer, gitBranch, gitDir, intentFrom, normPath, normResource, racingGitVerb, shellWriteTargets, SHAPE } from '../hooks/registry'

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
  const toasts: string[] = []
  const repo = options.repo === undefined ? 'C:/work/app' : options.repo

  on('session.id', () => ({ value: OWN_ID }))
  on('session.cwd', () => ({ value: 'C:\\work\\app' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'peer-sessions' } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__peer-sessions__${e.name}` } }))
  // The session's folder is the repo `repo`; C:/work/other is a second repo a `git -C` can reach.
  on('process.run', (_, e) => {
    const dir = key(e.init?.cwd ?? '').toLowerCase()
    const top = dir.startsWith('c:/work/other') ? 'C:/work/other' : repo
    return {
      value: top
        ? { exitCode: 0, stdout: `${top}\nmain\n${top}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
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

  return { clock, files, statuses, ranTools, toasts, seedPeer, ownRecord }
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
  expect(JSON.stringify(refused)).toContain('checkout this git commit acts on')
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

const CWD = 'C:/work/app'

test('shell writes are read from redirects, tee, sed -i and PowerShell content cmdlets', () => {
  expect(shellWriteTargets('npm test >> logs/run.log 2>&1', CWD)).toEqual(['c:/work/app/logs/run.log'])
  expect(shellWriteTargets("cd ../lib && sed -i 's/a/b/' x.py y.py", CWD)).toEqual(['c:/work/lib/x.py', 'c:/work/lib/y.py'])
  expect(shellWriteTargets('make 2>&1 | tee -a "build out.txt"', CWD)).toEqual(['c:/work/app/build out.txt'])
  expect(shellWriteTargets('Add-Content -Path notes.md -Value done', CWD)).toEqual(['c:/work/app/notes.md'])
  expect(shellWriteTargets('echo hi > /dev/null; ls 2>/dev/null; echo $x > $target', CWD)).toEqual([])
  expect(shellWriteTargets('git log --oneline -5', CWD)).toEqual([])
})

test('git targets the folder -C or a leading cd names', () => {
  expect(gitDir('git -C ../other commit -m x', CWD)).toBe('c:/work/other')
  expect(gitDir('cd "C:/work/other" && git push', CWD)).toBe('c:/work/other')
  expect(gitDir('git push', CWD)).toBe('c:/work/app')
})

test('claims are paths when they look like paths, names otherwise', () => {
  expect(normResource('src\\api\\', CWD)).toBe('c:/work/app/src/api')
  expect(normResource('README.md', CWD)).toBe('c:/work/app/readme.md')
  expect(normResource('Port:3000', CWD)).toBe('port:3000')
  expect(normResource('localhost:3000', CWD)).toBe('localhost:3000')
})

test('a shell append to a file a live peer just edited is refused once', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  const refused = await $.tool.call({ tool: 'Bash', command: 'echo "# note" >> src/invoice.py' })
  expect(JSON.stringify(refused)).toContain('refactor the invoice parser')
  expect(w.ranTools).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'echo "# note" >> src/invoice.py' })
  expect(w.ranTools).toEqual(['Bash'])
  expect(Object.keys(w.ownRecord().touched)).toContain('c:/work/app/src/invoice.py')
})

test('editing inside a folder a live peer claimed is refused once, naming the claim', async ($, on) => {
  const w = world(on)
  w.seedPeer({ touched: {}, claims: [{ resource: 'c:/work/app/src/api', note: 'auth rewrite', at: 0 }] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: 'Write', file_path: 'C:/work/app/src/api/routes.py', content: 'x' })
  expect(JSON.stringify(refused)).toContain('auth rewrite')
  expect(w.ranTools).toEqual([])

  await $.tool.call({ tool: 'Write', file_path: 'C:/work/app/src/api/routes.py', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/work/app/src/apiary.py', content: 'x' })
  expect(w.ranTools).toEqual(['Write', 'Write'])
})

test('the claim tool records claims and reports overlaps with peers', async ($, on) => {
  const w = world(on)
  w.seedPeer({ claims: [{ resource: 'port:3000', note: 'dev server', at: 0 }] })
  await $.session.start(start)

  const ran = await $.tool.call({ tool: 'mcp__peer-sessions__claim', resources: ['src/', 'Port:3000'], note: 'billing work' })
  const text = JSON.stringify(ran)
  expect(text).toContain('port:3000 is held by bbbbbbbb (dev server)')
  expect(w.ownRecord().claims.map((c: { resource: string }) => c.resource)).toEqual(['c:/work/app/src', 'port:3000'])

  await $.tool.call({ tool: 'mcp__peer-sessions__claim', resources: ['port:3000'], release: true })
  expect(w.ownRecord().claims.map((c: { resource: string }) => c.resource)).toEqual(['c:/work/app/src'])

  await $.session.end({ reason: 'prompt_input_exit', sessionId: OWN_ID, resume: {} as never })
  expect(w.ownRecord().claims).toEqual([])
})

test('git -C into a checkout a live peer shares is refused even from outside any repo', async ($, on) => {
  const w = world(on, { repo: null })
  w.seedPeer({ repo: 'c:/work/other', cwd: 'c:/work/other' })
  await $.session.start(start)

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(w.ranTools).toEqual(['Bash'])

  const refused = await $.tool.call({ tool: 'Bash', command: 'git -C C:/work/other push' })
  expect(JSON.stringify(refused)).toContain('c:/work/other')
  expect(w.ranTools).toEqual(['Bash'])
})

test('the peers tool lists peers with their claims, and this session\'s own', async ($, on) => {
  const w = world(on)
  w.seedPeer({ claims: [{ resource: 'db:local', note: 'migrations', at: 0 }] })
  await $.session.start(start)
  await $.tool.call({ tool: 'mcp__peer-sessions__claim', resources: ['src/billing/'] })

  const text = JSON.stringify(await $.tool.call({ tool: 'mcp__peer-sessions__peers' }))
  expect(text).toContain('claims: db:local (migrations)')
  expect(text).toContain('This session claims: c:/work/app/src/billing')
})

type Out = { id: string; to: string; text: string; at: number }
const contextOf = (ran: unknown) => ((ran as { context?: string[] }).context ?? []).join('\n')

test('the branch a racing git command lands on', () => {
  expect(gitBranch('git push origin feature:main', 'feature')).toBe('main')
  expect(gitBranch('git push -u origin feat', 'main')).toBe('feat')
  expect(gitBranch('git push', 'dev')).toBe('dev')
  expect(gitBranch('git commit -m x', 'dev')).toBe('dev')
})

test('a refusal is handed to the peer it was about', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  const outbox: Out[] = w.ownRecord().outbox
  expect(outbox.length).toBe(1)
  expect(outbox[0]?.to).toBe(PEER_ID)
  expect(outbox[0]?.text).toContain('[automatic] I was about to write c:/work/app/src/invoice.py')
})

test('a message for this session arrives with the next tool result, once', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.seedPeer({ outbox: [{ id: 'm1', to: 'aaaaaaaa', text: 'hold off src/billing, mid-migration', at: w.clock.now() }] })

  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(contextOf(first)).toContain('from bbbbbbbb')
  expect(contextOf(first)).toContain('hold off src/billing, mid-migration')
  expect(w.ownRecord().seen).toEqual(['m1'])

  await w.clock.advance(11_000)
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(contextOf(second)).toBe('')
})

test('messages to all arrive, recent ones from before this session too; ones for others or expired do not', async ($, on) => {
  const w = world(on)
  await w.clock.set(40 * 60_000)
  await $.session.start(start)
  const now = w.clock.now()
  w.seedPeer({
    outbox: [
      { id: 'all1', to: 'all', text: 'deploying staging now', at: now },
      { id: 'other', to: 'cccccccc', text: 'not for you', at: now },
      { id: 'early', to: 'all', text: 'sent before you started', at: now - 60_000 },
      { id: 'old', to: 'all', text: 'long expired', at: now - 31 * 60_000 },
    ],
  })

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(contextOf(ran)).toContain('deploying staging now')
  expect(contextOf(ran)).not.toContain('not for you')
  expect(contextOf(ran)).toContain('sent before you started')
  expect(contextOf(ran)).not.toContain('long expired')
})

test('the typed prompt carries unread messages', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.seedPeer({ outbox: [{ id: 'm2', to: 'aaaaaaaa', text: 'I pushed main, pull before you commit', at: w.clock.now() }] })

  const prompt = await $.prompt.submit(typed('add rate limiting to the upload endpoint'))
  expect(prompt.context?.join('\n')).toContain('I pushed main, pull before you commit')
})

test('the message tool sends to one live peer or all, and refuses unknown ids', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__peer-sessions__message', to: 'bbbbbbbb', text: 'taking src/api' }))).toContain('Sent to session bbbbbbbb')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__peer-sessions__message', to: 'zzzzzzzz', text: 'hi' }))).toContain('no live session id starts with zzzzzzzz')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__peer-sessions__message', to: 'bb', text: 'hi' }))).toContain('at least 8 characters')
  await $.tool.call({ tool: 'mcp__peer-sessions__message', to: 'all', text: 'running migrations' })

  const outbox: Out[] = w.ownRecord().outbox
  expect(outbox.map(m => [m.to, m.text])).toEqual([['all', 'running migrations'], ['bbbbbbbb', 'taking src/api']])
})

test('reading the file after the peer edited it means no refusal', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)
  await w.clock.advance(1_000)

  await $.tool.call({ tool: 'Read', file_path: 'C:/work/app/src/invoice.py' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  expect(w.ranTools).toEqual(['Read', 'Edit'])
})

test('a read from before the peer edit still gets the refusal', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/app/src/invoice.py' })
  await w.clock.advance(1_000)
  w.seedPeer()

  const refused = await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  expect(JSON.stringify(refused)).toContain('refactor the invoice parser')
  expect(w.ranTools).toEqual(['Read'])
})

test('a branch a peer claimed from another worktree refuses a push to it, not a checkout', async ($, on) => {
  const w = world(on)
  w.seedPeer({ repo: 'c:/work/app-wt', cwd: 'c:/work/app-wt', claims: [{ resource: 'branch:main@c:/work/app/.git', note: 'release cut', at: 0 }] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(JSON.stringify(refused)).toContain('Branch main of this repository is claimed')
  expect(JSON.stringify(refused)).toContain('release cut')

  await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(w.ranTools).toEqual(['Bash', 'Bash'])
})

test('claiming branch:main ties it to this repository', async ($, on) => {
  const w = world(on)
  await $.session.start(start)

  await $.tool.call({ tool: 'mcp__peer-sessions__claim', resources: ['branch:main'], note: 'release' })
  expect(w.ownRecord().claims.map((c: { resource: string }) => c.resource)).toEqual(['branch:main@c:/work/app/.git'])
})

test('a headless (-p) or phone prompt is the task; a peer delivery is not', async ($, on) => {
  const w = world(on)
  await $.session.start(start)

  await $.prompt.submit({ text: 'summarise the failing CI jobs on main', origin: { kind: 'sdk' } as never, wait: false })
  expect(w.ownRecord().intent).toBe('summarise the failing CI jobs on main')

  await $.prompt.submit({ text: 'Another Claude session sent a message: please stop editing', origin: { kind: 'peer' } as never, wait: false })
  expect(w.ownRecord().intent).toBe('summarise the failing CI jobs on main')
})

test('a notification prompt carries the inbox without becoming the task', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await $.prompt.submit(typed('add rate limiting to the upload endpoint'))
  w.seedPeer({ outbox: [{ id: 'm3', to: 'aaaaaaaa', text: 'PONG from B', at: w.clock.now() }] })

  const woke = await $.prompt.submit({ text: '<task-notification> background job finished', origin: { kind: 'task-notification' } as never, wait: false })
  expect(woke.context?.join('\n')).toContain('PONG from B')
  expect(w.ownRecord().intent).toBe('add rate limiting to the upload endpoint')
})

test('a message from a session that has since ended still arrives, marked as ended', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.seedPeer({ ended: true, outbox: [{ id: 'm4', to: 'aaaaaaaa', text: 'I pushed main, pull before you commit', at: w.clock.now() }] })
  await w.clock.advance(5 * 60_000)
  w.files.set(`${DIR}/${PEER_ID}.json`, { ...w.files.get(`${DIR}/${PEER_ID}.json`)!, mtimeMs: w.clock.now() - 4 * 60_000 })

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(contextOf(ran)).toContain('I pushed main, pull before you commit')
  expect(contextOf(ran)).toContain('session since ended')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__peer-sessions__peers' }))).toContain('No other live Claude sessions')
})

test('warn mode lets the colliding edit run and tells the model afterwards', { options: { mode: 'warn' } }, async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  const ran = await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  expect(w.ranTools).toEqual(['Edit'])
  expect(contextOf(ran)).toContain('(warn mode: the call ran anyway)')
  expect(w.toasts.join('\n')).toContain('warned about Edit')
})

test('refuse mode shows a toast for the person as well', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  await $.session.start(start)

  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/src/invoice.py', old_string: 'a', new_string: 'b' })
  expect(w.toasts.join('\n')).toContain('held back Edit')
})

test('with shareTask off the task line never reaches the registry', { options: { shareTask: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)

  await $.prompt.submit(typed('rotate the production database credentials'))
  expect(w.ownRecord().intent).toBe('')
  expect(w.ownRecord().isTaskHidden).toBe(true)
  expect(JSON.stringify(w.files.get(`${DIR}/${OWN_ID}.json`))).not.toContain('credentials')
  expect(describePeer(w.ownRecord(), w.clock.now(), null)).toContain('doing: task not shared')
})

test('the person can message, claim and release from /peer-sessions', async ($, on) => {
  const w = world(on)
  w.seedPeer()
  on('command.run', () => ({ text: 'engine' }))
  await $.session.start(start)
  const run = (args: string) => $.command.run({ command: 'peer-sessions', args, origin: { kind: 'composer' } } as never)

  expect((await run('msg bbbbbbbb please leave src/api to me')).text).toContain('Sent to session bbbbbbbb')
  expect(w.ownRecord().outbox[0].text).toBe('please leave src/api to me')
  expect((await run('claim src/api port:3000')).text).toContain('Claimed: c:/work/app/src/api, port:3000')
  expect((await run('release port:3000')).text).toContain('Released: port:3000')
  expect(w.ownRecord().claims.map((c: { resource: string }) => c.resource)).toEqual(['c:/work/app/src/api'])
  expect((await run('help')).text).toContain('/peer-sessions msg <id|all> <text>')
  expect((await run('frobnicate')).text).toContain('Unknown: frobnicate.')
})

test('an arriving message raises a toast', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  w.seedPeer({ outbox: [{ id: 'm5', to: 'all', text: 'staging is down, do not deploy', at: w.clock.now() }] })

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.toasts.join('\n')).toContain('from bbbbbbbb: staging is down, do not deploy')
})

const BAND = {
  plugin: 'peer-sessions',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } },
} as const

test('the band names peers in this checkout and the latest message, on every surface', async ($, on) => {
  const w = world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  w.seedPeer({ outbox: [{ id: 'm6', to: 'aaaaaaaa', text: 'pushing main in 5 min', at: w.clock.now() }] })
  await $.session.start(start)
  await $.prompt.submit(typed('add rate limiting to the upload endpoint'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect((await ui.find({ type: 'Text', text: /in this checkout/ }))?.text).toContain('1 other session in this checkout (bbbbbbbb on main: refactor the invoice parser)')
    expect((await ui.find({ type: 'Text', text: /pushing main in 5 min/ }))).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /pushing main/ })).toBeUndefined()
  await ui.unmount()
})

test('the band stays out of the way when nothing is shared', async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(start)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
