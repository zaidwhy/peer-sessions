import type { EngineInterface, Register } from 'claude-code'

import {
  EDIT_CONFLICT_MS,
  HEARTBEAT_MS,
  LIVE_MS,
  MAX_PEERS_READ,
  MAX_RECORD_BYTES,
  describePeer,
  editConflict,
  intentFrom,
  newRecord,
  normPath,
  parseRecord,
  peersBlock,
  racingGitVerb,
  sameCheckout,
  statusText,
  touch,
  type SessionRecord,
} from './registry'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

// Module state starts over on a reload; the record itself is re-read from disk.
let own: SessionRecord | null = null
let registryDir: string | null = null
let announced = new Set<string>()
let hasBriefed = false
// Each refusal fires once per peer and target; the retry after re-reading goes through.
const warned = new Set<string>()
let heartbeat: { cancel: () => void } | null = null

// Every session writes only its own file and reads the others', so the
// registry never has two writers on one file.
async function dirOf($: EngineInterface): Promise<string | null> {
  if (registryDir) return registryDir
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) return null
  registryDir = `${home.replace(/\\/g, '/').replace(/\/$/, '')}/.claude/peer-sessions`
  return registryDir
}

function fileOf(dir: string, id: string): string {
  return `${dir}/${id.replace(/[^\w-]/g, '').slice(0, 80)}.json`
}

async function ensureOwn($: EngineInterface): Promise<SessionRecord | null> {
  const id = await $.session.id()
  if (own && own.id === id) return own
  // A /clear goes on under a new id: the old record was ended, start fresh.
  const dir = await dirOf($)
  if (!dir) return null
  const saved = await $.fs.read(fileOf(dir, id)).then(text => parseRecord(String(text)), () => null)
  own = saved && !saved.ended ? saved : newRecord(id, await $.session.cwd(), await $.clock.now())
  announced = new Set()
  hasBriefed = false
  warned.clear()
  return own
}

async function save($: EngineInterface): Promise<void> {
  const dir = await dirOf($)
  if (own && dir) await $.fs.write(fileOf(dir, own.id), JSON.stringify(own))
}

async function refreshCheckout($: EngineInterface): Promise<void> {
  if (!own) return
  const ran = await $.process
    .run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd: own.cwd, timeoutMs: 3000 })
    .catch(() => null)
  if (!own) return
  if (!ran || ran.exitCode !== 0) {
    own = { ...own, repo: null, branch: null }
    return
  }
  const [top, branch] = ran.stdout.trim().split(/\r?\n/)
  own = { ...own, repo: top ? normPath(top, own.cwd) : null, branch: branch || null }
}

async function livePeers($: EngineInterface): Promise<SessionRecord[]> {
  const dir = await dirOf($)
  if (!dir || !own) return []
  const ownId = own.id
  const now = await $.clock.now()
  const entries = await $.fs.list(dir).catch(() => [])
  const fresh = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
    .filter(entry => now - entry.mtimeMs <= LIVE_MS && entry.size <= MAX_RECORD_BYTES)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PEERS_READ)
  const records = await Promise.all(
    fresh.map(entry => $.fs.read(`${dir}/${entry.name}`).then(text => parseRecord(String(text)), () => null)),
  )
  return records.filter((r): r is SessionRecord => r !== null && !r.ended && r.id !== ownId)
}

function showStatus($: EngineInterface, peers: readonly SessionRecord[]): void {
  $.ui.status(statusText(peers, own?.repo ?? null))
}

async function beat($: EngineInterface): Promise<void> {
  if (!(await ensureOwn($))) return
  await save($)
  showStatus($, await livePeers($))
}

async function checkEdit($: EngineInterface, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !(await ensureOwn($)) || !own) return null
  const path = normPath(raw, own.cwd)
  const now = await $.clock.now()
  const conflict = editConflict(await livePeers($), path, now)
  const key = conflict ? `edit|${conflict.peer.id}|${path}` : ''
  if (conflict && !warned.has(key)) {
    warned.add(key)
    const minutes = Math.max(0, Math.round((now - conflict.touchedAt) / 60_000))
    return [
      `[peer-sessions] Session ${conflict.peer.id.slice(0, 8)} (${conflict.peer.repo ?? conflict.peer.cwd}) edited ${raw} ${minutes} min ago and is still live.`,
      `It is doing: ${conflict.peer.intent || 'no task typed yet'}.`,
      'Re-read the file before editing so you do not overwrite its change. If your edit overlaps its task, message it (ListAgents, SendMessage) or ask the user first.',
      `This refusal fires once per file per peer within ${EDIT_CONFLICT_MS / 60_000} min: the edit made after re-reading goes through.`,
    ].join(' ')
  }
  if (!own) return null
  own = touch(own, path, now)
  await save($)
  return null
}

async function checkGit($: EngineInterface, command: unknown): Promise<string | null> {
  const verb = typeof command === 'string' ? racingGitVerb(command) : null
  if (!verb || !(await ensureOwn($))) return null
  await refreshCheckout($)
  const repo = own?.repo ?? null
  if (!repo) return null
  const peer = sameCheckout(await livePeers($), repo).find(p => !warned.has(`git|${p.id}|${verb}`))
  if (!peer) return null
  warned.add(`git|${peer.id}|${verb}`)
  return [
    `[peer-sessions] Session ${peer.id.slice(0, 8)} is live in this same checkout (${repo}${peer.branch ? ` @ ${peer.branch}` : ''}), doing: ${peer.intent || 'no task typed yet'}.`,
    `git ${verb} here can sweep its uncommitted changes into your commit, move the branch under it, or race its push.`,
    'Run git status and git fetch, check what is yours, and coordinate with that session (ListAgents, SendMessage) or ask the user. Running the same command again goes through.',
  ].join(' ')
}

async function briefing($: EngineInterface, text: string): Promise<string | null> {
  if (!(await ensureOwn($)) || !own) return null
  const intent = intentFrom(text)
  if (intent) own = { ...own, intent }
  await refreshCheckout($)
  await save($)
  const peers = await livePeers($)
  showStatus($, peers)
  const arrived = peers.filter(peer => !announced.has(peer.id))
  announced = new Set(peers.map(peer => peer.id))
  const isFirst = !hasBriefed
  hasBriefed = true
  const now = await $.clock.now()
  const repo = own?.repo ?? null
  if (isFirst && peers.length) return peersBlock('Other Claude sessions are live on this machine:', peers, now, repo)
  if (arrived.length) return peersBlock('New Claude sessions started since your last prompt:', arrived, now, repo)
  return null
}

async function peersReport($: EngineInterface): Promise<string> {
  if (!(await ensureOwn($))) return 'peer-sessions: no home directory to keep the registry in.'
  await refreshCheckout($)
  await save($)
  const peers = await livePeers($)
  showStatus($, peers)
  if (!peers.length) return 'No other live Claude sessions on this machine.'
  const now = await $.clock.now()
  const repo = own?.repo ?? null
  return [`${peers.length} other live session(s):`, ...peers.map(peer => describePeer(peer, now, repo))].join('\n')
}

async function endOwn($: EngineInterface, sessionId: string): Promise<void> {
  heartbeat?.cancel()
  heartbeat = null
  if (own && own.id === sessionId) {
    own = { ...own, ended: true }
    await save($)
  }
  own = null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'peer-sessions', description: 'List the other live Claude sessions on this machine' })
      await ensureOwn($)
      await refreshCheckout($)
      await beat($)
      heartbeat?.cancel()
      heartbeat = $.clock.every(HEARTBEAT_MS, () => {
        beat($).catch(() => undefined)
      })
    } catch {
      // Coordination is advisory: a failure here must never stop a session.
    }
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer' && !e.command && !e.isMeta
    const block = isTyped ? await briefing($, e.text).catch(() => null) : null
    return block ? next({ ...e, context: [...(e.context ?? []), block] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const deny = EDIT_TOOLS.has(e.tool)
      ? await checkEdit($, input.file_path ?? input.notebook_path).catch(() => null)
      : SHELL_TOOLS.has(e.tool)
        ? await checkGit($, input.command).catch(() => null)
        : null
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'peer-sessions' }, async $ => ({
    text: await peersReport($).catch(error => `peer-sessions: could not read the registry (${String(error)}).`),
  })).catch(() => ({ text: 'peer-sessions: the command failed; the registry is untouched.' }))

  on('session.end', async ($, e, next) => {
    // A missed tombstone is harmless: the record ages out after LIVE_MS.
    await endOwn($, e.sessionId).catch(() => undefined)
    return next(e)
  })
}
