import type { EngineInterface, Register } from 'claude-code'

import {
  EDIT_CONFLICT_MS,
  HEARTBEAT_MS,
  LIVE_MS,
  MAX_CLAIMS,
  MAX_PEERS_READ,
  MAX_RECORD_BYTES,
  addClaims,
  claimConflict,
  describePeer,
  editConflict,
  gitDir,
  intentFrom,
  newRecord,
  normPath,
  normResource,
  overlappingClaims,
  parseRecord,
  peersBlock,
  racingGitVerb,
  releaseClaims,
  sameCheckout,
  shellWriteTargets,
  statusText,
  touch,
  type SessionRecord,
} from './registry'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CLAIM_TOOL = 'mcp__peer-sessions__claim'
const PEERS_TOOL = 'mcp__peer-sessions__peers'

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

async function checkoutOf($: EngineInterface, dir: string): Promise<{ repo: string; branch: string | null } | null> {
  const ran = await $.process
    .run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { cwd: dir, timeoutMs: 3000 })
    .catch(() => null)
  if (!ran || ran.exitCode !== 0) return null
  const [top, branch] = ran.stdout.trim().split(/\r?\n/)
  return top ? { repo: normPath(top, dir), branch: branch || null } : null
}

async function refreshCheckout($: EngineInterface): Promise<void> {
  if (!own) return
  const found = await checkoutOf($, own.cwd)
  if (own) own = { ...own, repo: found?.repo ?? null, branch: found?.branch ?? null }
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

// One check for every way a file gets written (Edit, Write, a shell redirect):
// refuse once on a peer's recent edit or claim, otherwise record the write.
async function guardWrites($: EngineInterface, paths: readonly string[], shown: string): Promise<string | null> {
  if (!paths.length || !(await ensureOwn($)) || !own) return null
  const now = await $.clock.now()
  const peers = await livePeers($)
  for (const path of paths) {
    const edited = editConflict(peers, path, now)
    if (edited && !warned.has(`edit|${edited.peer.id}|${path}`)) {
      warned.add(`edit|${edited.peer.id}|${path}`)
      const minutes = Math.max(0, Math.round((now - edited.touchedAt) / 60_000))
      return [
        `[peer-sessions] Session ${edited.peer.id.slice(0, 8)} (${edited.peer.repo ?? edited.peer.cwd}) edited ${path} ${minutes} min ago and is still live.`,
        `It is doing: ${edited.peer.intent || 'no task typed yet'}.`,
        'Re-read the file before writing so you do not overwrite its change. If your change overlaps its task, message it (ListAgents, SendMessage) or ask the user first.',
        `This refusal fires once per file per peer within ${EDIT_CONFLICT_MS / 60_000} min: ${shown} made after re-reading goes through.`,
      ].join(' ')
    }
    const claimed = claimConflict(peers, path)
    if (claimed && !warned.has(`claim|${claimed.peer.id}|${path}`)) {
      warned.add(`claim|${claimed.peer.id}|${path}`)
      return [
        `[peer-sessions] ${path} is inside ${claimed.claim.resource}, which live session ${claimed.peer.id.slice(0, 8)} claimed${claimed.claim.note ? ` (${claimed.claim.note})` : ''}.`,
        `It is doing: ${claimed.peer.intent || 'no task typed yet'}.`,
        'Ask that session (ListAgents, SendMessage) or the user before changing what it owns. Running the same change again goes through.',
      ].join(' ')
    }
  }
  let record = own
  for (const path of paths) record = touch(record, path, now)
  own = record
  await save($)
  return null
}

async function checkEdit($: EngineInterface, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !(await ensureOwn($)) || !own) return null
  return guardWrites($, [normPath(raw, own.cwd)], 'the edit')
}

async function checkShellWrites($: EngineInterface, command: unknown): Promise<string | null> {
  if (typeof command !== 'string' || !(await ensureOwn($)) || !own) return null
  return guardWrites($, shellWriteTargets(command, own.cwd), 'the command')
}

async function checkGit($: EngineInterface, command: unknown): Promise<string | null> {
  const verb = typeof command === 'string' ? racingGitVerb(command) : null
  if (!verb || typeof command !== 'string' || !(await ensureOwn($)) || !own) return null
  const target = gitDir(command, own.cwd)
  // The session's own checkout is refreshed; a `git -C elsewhere` is looked up.
  if (target === own.cwd) await refreshCheckout($)
  const repo = target === own?.cwd ? (own?.repo ?? null) : ((await checkoutOf($, target))?.repo ?? null)
  if (!repo) return null
  const peer = sameCheckout(await livePeers($), repo).find(p => !warned.has(`git|${p.id}|${repo}|${verb}`))
  if (!peer) return null
  warned.add(`git|${peer.id}|${repo}|${verb}`)
  return [
    `[peer-sessions] Session ${peer.id.slice(0, 8)} is live in the checkout this git ${verb} acts on (${repo}${peer.branch ? ` @ ${peer.branch}` : ''}), doing: ${peer.intent || 'no task typed yet'}.`,
    `git ${verb} there can sweep its uncommitted changes into your commit, move the branch under it, or race its push.`,
    'Run git status and git fetch, check what is yours, and coordinate with that session (ListAgents, SendMessage) or ask the user. Running the same command again goes through.',
  ].join(' ')
}

async function claim($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  if (!(await ensureOwn($)) || !own) return 'peer-sessions: no home directory to keep the registry in.'
  const cwd = own.cwd
  const raw = Array.isArray(input.resources) ? input.resources.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []
  const resources = [...new Set(raw.map(r => normResource(r, cwd)))].slice(0, MAX_CLAIMS)
  const now = await $.clock.now()
  if (input.release === true) {
    own = releaseClaims(own, resources)
    await save($)
    return resources.length ? `Released: ${resources.join(', ')}.` : 'Released every claim.'
  }
  if (!resources.length) return 'Nothing claimed: pass resources, e.g. ["src/api/", "port:3000"].'
  own = addClaims(own, resources, typeof input.note === 'string' ? input.note : '', now)
  await save($)
  const clashes = overlappingClaims(await livePeers($), resources)
  const held = (own.claims ?? []).map(c => c.resource).join(', ')
  if (!clashes.length) return `Claimed: ${resources.join(', ')}. Peers editing inside these are refused once and told your task. You now hold: ${held}.`
  const lines = clashes.map(({ peer, claim: c }) => `- ${c.resource} is held by ${peer.id.slice(0, 8)}${c.note ? ` (${c.note})` : ''}, doing: ${peer.intent || 'no task typed yet'}`)
  return [`Claimed, but these overlap claims live peers already hold:`, ...lines, 'Agree with that session (SendMessage) or the user who owns it before working there.'].join('\n')
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
  const mine = (own?.claims ?? []).map(c => c.resource)
  const holding = mine.length ? `\nThis session claims: ${mine.join(', ')}` : ''
  if (!peers.length) return `No other live Claude sessions on this machine.${holding}`
  const now = await $.clock.now()
  const repo = own?.repo ?? null
  return [`${peers.length} other live session(s):`, ...peers.map(peer => describePeer(peer, now, repo))].join('\n') + holding
}

async function endOwn($: EngineInterface, sessionId: string): Promise<void> {
  heartbeat?.cancel()
  heartbeat = null
  if (own && own.id === sessionId) {
    own = { ...own, ended: true, claims: [] }
    await save($)
  }
  own = null
}

async function registerSurface($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'peer-sessions', description: 'List the other live Claude sessions on this machine' })
  await $.tool.register({
    name: 'claim',
    description:
      'Tell the other Claude sessions on this machine what you are about to work on, so they are refused once before editing it. ' +
      'resources: files, folders (claims everything inside) or named resources such as "port:3000", "db:local", "branch:main". ' +
      'note: a few words on why. release: true gives the listed resources back (all of them when resources is empty). Claims end with the session.',
    inputSchema: {
      type: 'object',
      properties: {
        resources: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: MAX_CLAIMS },
        note: { type: 'string', maxLength: 200 },
        release: { type: 'boolean' },
      },
      required: ['resources'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'peers',
    description: 'List the other live Claude sessions on this machine: folder, git checkout and branch, task, recent edits and claims.',
    inputSchema: { type: 'object', properties: {} },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await registerSurface($)
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

  on('tool.call', { tool: CLAIM_TOOL }, async ($, e) => ({
    result: await claim($, e as unknown as Record<string, unknown>).catch(error => `peer-sessions: claim failed (${String(error)}).`),
  })).catch(() => ({ result: 'peer-sessions: claim failed; nothing was recorded.' }))

  on('tool.call', { tool: PEERS_TOOL }, async $ => ({
    result: await peersReport($).catch(error => `peer-sessions: could not read the registry (${String(error)}).`),
  })).catch(() => ({ result: 'peer-sessions: could not read the registry.' }))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    let deny: string | null = null
    if (EDIT_TOOLS.has(e.tool)) deny = await checkEdit($, input.file_path ?? input.notebook_path).catch(() => null)
    else if (SHELL_TOOLS.has(e.tool)) {
      deny = await checkGit($, input.command).catch(() => null)
      deny ??= await checkShellWrites($, input.command).catch(() => null)
    }
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
