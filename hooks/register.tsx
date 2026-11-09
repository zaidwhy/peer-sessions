import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandView } from '../types'

import {
  EDIT_CONFLICT_MS,
  MESSAGE_TTL_MS,
  HEARTBEAT_MS,
  LIVE_MS,
  MAX_CLAIMS,
  MAX_MESSAGE_CHARS,
  MAX_PEERS_READ,
  MAX_RECORD_BYTES,
  addClaims,
  addMessage,
  branchConflict,
  claimConflict,
  describePeer,
  editConflict,
  gitBranch,
  gitDir,
  inboxBlock,
  inboxFor,
  intentFrom,
  markSeen,
  newRecord,
  normClaim,
  normPath,
  overlappingClaims,
  parseRecord,
  peersBlock,
  racingGitVerb,
  releaseClaims,
  sameCheckout,
  shellWriteTargets,
  statusText,
  taskOf,
  touch,
  type Message,
  type SessionRecord,
} from './registry'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
// Origins whose text is the session's task; notifications, peer deliveries and observers are not.
const TASK_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'coordinator', 'scheduled-trigger'])
const CLAIM_TOOL = 'mcp__peer-sessions__claim'
const PEERS_TOOL = 'mcp__peer-sessions__peers'
const MESSAGE_TOOL = 'mcp__peer-sessions__message'
const READ_TOOLS = new Set(['Read', 'NotebookRead'])
// Reading every peer file on every tool call would cost a disk scan per Grep.
const INBOX_EVERY_MS = 10_000
const MESSAGE_TTL_MINUTES = MESSAGE_TTL_MS / 60_000

// Module state starts over on a reload; the record itself is re-read from disk.
// userConfig: 'refuse' holds a colliding call back once, 'warn' lets it run and tells the model.
let mode: 'refuse' | 'warn' = 'refuse'
let isTaskShared = true
const BAND_EMPTY: BandView = { inCheckout: [], message: null, dismissedAt: null }
// Change the tag when BandView's fields change: it declines what an earlier version stored.
const band = atom({ plugin: 'peer-sessions', key: 'band' } as const, BAND_EMPTY, { shape: 'band-2' })
// A message stays on the band this long, unless dismissed.
const BAND_MESSAGE_MS = 10 * 60_000
let own: SessionRecord | null = null
let registryDir: string | null = null
let announced = new Set<string>()
let hasBriefed = false
// Each refusal fires once per peer and target; the retry after re-reading goes through.
const warned = new Set<string>()
let heartbeat: { cancel: () => void } | null = null
// When this session last read each file: a write after reading a peer's change is informed, not racing.
const readAt = new Map<string, number>()
let lastInboxCheck: number | null = null
let sentCount = 0

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
  readAt.clear()
  lastInboxCheck = null
  return own
}

async function save($: EngineInterface): Promise<void> {
  const dir = await dirOf($)
  if (own && dir) await $.fs.write(fileOf(dir, own.id), JSON.stringify(own))
}

type Checkout = { repo: string; branch: string | null; common: string | null }

async function checkoutOf($: EngineInterface, dir: string): Promise<Checkout | null> {
  const ran = await $.process
    .run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--git-common-dir'], { cwd: dir, timeoutMs: 3000 })
    .catch(() => null)
  if (!ran || ran.exitCode !== 0) return null
  const [top, branch, common] = ran.stdout.trim().split(/\r?\n/)
  if (!top) return null
  return {
    repo: normPath(top, dir),
    branch: branch && branch !== 'HEAD' ? branch : null,
    common: common ? normPath(common, dir) : null,
  }
}

async function refreshCheckout($: EngineInterface): Promise<void> {
  if (!own) return
  const found = await checkoutOf($, own.cwd)
  if (own) own = { ...own, repo: found?.repo ?? null, branch: found?.branch ?? null, common: found?.common ?? null }
}

// Other sessions' records written within `windowMs`, ended ones included.
async function peerRecords($: EngineInterface, windowMs: number): Promise<SessionRecord[]> {
  const dir = await dirOf($)
  if (!dir || !own) return []
  const ownId = own.id
  const now = await $.clock.now()
  const entries = await $.fs.list(dir).catch(() => [])
  const fresh = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
    .filter(entry => now - entry.mtimeMs <= windowMs && entry.size <= MAX_RECORD_BYTES)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PEERS_READ)
  const records = await Promise.all(
    fresh.map(entry => $.fs.read(`${dir}/${entry.name}`).then(text => parseRecord(String(text)), () => null)),
  )
  return records.filter((r): r is SessionRecord => r !== null && r.id !== ownId)
}

async function livePeers($: EngineInterface): Promise<SessionRecord[]> {
  return (await peerRecords($, LIVE_MS)).filter(r => !r.ended)
}

function showStatus($: EngineInterface, peers: readonly SessionRecord[]): void {
  const repo = own?.repo ?? null
  $.ui.status(statusText(peers, repo))
  const inCheckout = sameCheckout(peers, repo).map(p => ({ id: p.id.slice(0, 8), intent: taskOf(p), branch: p.branch }))
  update($, band, view => ({ ...view, inCheckout })).catch(() => undefined)
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
    const readTime = readAt.get(path)
    const hasSeenIt = edited !== null && readTime !== undefined && readTime >= edited.touchedAt
    if (edited && !hasSeenIt && !warned.has(`edit|${edited.peer.id}|${path}`)) {
      warned.add(`edit|${edited.peer.id}|${path}`)
      const minutes = Math.max(0, Math.round((now - edited.touchedAt) / 60_000))
      await handoff($, edited.peer, `I was about to write ${path}, which you edited ${minutes} min ago; I was told to re-read it first. My task: ${own ? taskOf(own) : 'no task typed yet'}.`)
      return [
        `[peer-sessions] Session ${edited.peer.id.slice(0, 8)} (${edited.peer.repo ?? edited.peer.cwd}) edited ${path} ${minutes} min ago and is still live.`,
        `It is doing: ${taskOf(edited.peer)}.`,
        'Re-read the file before writing so you do not overwrite its change (that session has been told). If your change overlaps its task, message it (mcp__peer-sessions__message) or ask the user first.',
        `This refusal fires once per file per peer within ${EDIT_CONFLICT_MS / 60_000} min: ${shown} made after re-reading goes through.`,
      ].join(' ')
    }
    const claimed = claimConflict(peers, path)
    if (claimed && !warned.has(`claim|${claimed.peer.id}|${path}`)) {
      warned.add(`claim|${claimed.peer.id}|${path}`)
      await handoff($, claimed.peer, `I was about to write ${path}, inside your claim ${claimed.claim.resource}. My task: ${own ? taskOf(own) : 'no task typed yet'}. Tell me if I should keep out.`)
      return [
        `[peer-sessions] ${path} is inside ${claimed.claim.resource}, which live session ${claimed.peer.id.slice(0, 8)} claimed${claimed.claim.note ? ` (${claimed.claim.note})` : ''}.`,
        `It is doing: ${taskOf(claimed.peer)}.`,
        'That session has been told. Ask it (mcp__peer-sessions__message) or the user before changing what it owns. Running the same change again goes through.',
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
  const checkout: Checkout | null =
    target === own?.cwd
      ? own?.repo
        ? { repo: own.repo, branch: own.branch, common: own.common ?? null }
        : null
      : await checkoutOf($, target)
  if (!checkout) return null
  const { repo } = checkout
  const peers = await livePeers($)
  const branch = gitBranch(command, checkout.branch)
  const isMovingAway = verb === 'checkout' || verb === 'switch'
  const held = branch && checkout.common && !isMovingAway ? branchConflict(peers, branch, checkout.common) : null
  if (held && !warned.has(`branch|${held.peer.id}|${held.claim.resource}|${verb}`)) {
    warned.add(`branch|${held.peer.id}|${held.claim.resource}|${verb}`)
    await handoff($, held.peer, `I was about to git ${verb} on ${branch}, which you claimed. My task: ${own ? taskOf(own) : 'no task typed yet'}.`)
    return [
      `[peer-sessions] Branch ${branch} of this repository is claimed by live session ${held.peer.id.slice(0, 8)}${held.claim.note ? ` (${held.claim.note})` : ''}, doing: ${taskOf(held.peer)}.`,
      `git ${verb} on it can race that session's work. That session has been told. Agree with it (mcp__peer-sessions__message) or the user first, or work on your own branch. Running the same command again goes through.`,
    ].join(' ')
  }
  const peer = sameCheckout(peers, repo).find(p => !warned.has(`git|${p.id}|${repo}|${verb}`))
  if (!peer) return null
  warned.add(`git|${peer.id}|${repo}|${verb}`)
  await handoff($, peer, `I was about to run git ${verb} in ${repo}, the checkout you are working in. My task: ${own ? taskOf(own) : 'no task typed yet'}.`)
  return [
    `[peer-sessions] Session ${peer.id.slice(0, 8)} is live in the checkout this git ${verb} acts on (${repo}${peer.branch ? ` @ ${peer.branch}` : ''}), doing: ${taskOf(peer)}.`,
    `git ${verb} there can sweep its uncommitted changes into your commit, move the branch under it, or race its push.`,
    'That session has been told. Run git status and git fetch, check what is yours, and coordinate with it (mcp__peer-sessions__message) or ask the user. Running the same command again goes through.',
  ].join(' ')
}

async function claim($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  if (!(await ensureOwn($)) || !own) return 'peer-sessions: no home directory to keep the registry in.'
  const cwd = own.cwd
  const raw = Array.isArray(input.resources) ? input.resources.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []
  const common = own.common ?? null
  const resources = [...new Set(raw.map(r => normClaim(r, cwd, common)))].slice(0, MAX_CLAIMS)
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
  const lines = clashes.map(({ peer, claim: c }) => `- ${c.resource} is held by ${peer.id.slice(0, 8)}${c.note ? ` (${c.note})` : ''}, doing: ${taskOf(peer)}`)
  return [`Claimed, but these overlap claims live peers already hold:`, ...lines, 'Agree with that session (SendMessage) or the user who owns it before working there.'].join('\n')
}

async function post($: EngineInterface, to: string, text: string): Promise<Message | null> {
  if (!(await ensureOwn($)) || !own) return null
  const now = await $.clock.now()
  sentCount += 1
  const message: Message = { id: `${own.id.slice(0, 8)}-${now}-${sentCount}`, to, text: text.slice(0, MAX_MESSAGE_CHARS), at: now }
  own = addMessage(own, message)
  await save($)
  return message
}

// Every refusal is also told to the peer it was about, so both sides know.
async function handoff($: EngineInterface, peer: SessionRecord, text: string): Promise<void> {
  await post($, peer.id, `[automatic] ${text}`).catch(() => null)
}

async function sendMessage($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const to = typeof input.to === 'string' ? input.to.trim().toLowerCase() : ''
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) return 'Nothing sent: text is empty.'
  if (!(await ensureOwn($)) || !own) return 'peer-sessions: no home directory to keep the registry in.'
  const peers = await livePeers($)
  if (to !== 'all') {
    if (to.length < 8) return 'Nothing sent: to must be a session id of at least 8 characters (from the peers tool), or "all".'
    const matches = peers.filter(p => p.id.startsWith(to))
    if (matches.length === 0) return `Nothing sent: no live session id starts with ${to}. Live: ${peers.map(p => p.id.slice(0, 8)).join(', ') || 'none'}.`
    if (matches.length > 1) return `Nothing sent: ${to} matches ${matches.length} sessions; use more of the id.`
  }
  const sent = await post($, to, text)
  if (!sent) return 'peer-sessions: the message could not be stored.'
  const reach = to === 'all' ? `all ${peers.length} live session(s)` : `session ${to.slice(0, 8)}`
  return `Sent to ${reach}. It reaches them with their next tool result or prompt, and expires in ${MESSAGE_TTL_MINUTES} min.`
}

// Messages for this session, at most every INBOX_EVERY_MS unless forced.
async function takeInbox($: EngineInterface, isForced: boolean): Promise<string | null> {
  const now = await $.clock.now()
  if (!isForced && lastInboxCheck !== null && now - lastInboxCheck < INBOX_EVERY_MS) return null
  lastInboxCheck = now
  if (!(await ensureOwn($)) || !own) return null
  // A sender that already finished still gets its last words delivered: "I pushed main" is
  // most often sent right before a session ends.
  const deliveries = inboxFor(await peerRecords($, MESSAGE_TTL_MS), own, now)
  if (!deliveries.length || !own) return null
  own = markSeen(own, deliveries.map(d => d.message.id))
  await save($)
  const latest = deliveries[deliveries.length - 1]
  if (latest) {
    const from = latest.from.id.slice(0, 8)
    $.ui.toast(`peer-sessions: ${deliveries.length > 1 ? `${deliveries.length} messages, latest ` : ''}from ${from}: ${latest.message.text.slice(0, 160)}`)
    await update($, band, view => ({ ...view, message: { from, text: latest.message.text, at: latest.message.at } }))
  }
  return inboxBlock(deliveries, now)
}

async function noteRead($: EngineInterface, raw: unknown): Promise<void> {
  if (typeof raw !== 'string' || !(await ensureOwn($)) || !own) return
  readAt.set(normPath(raw, own.cwd), await $.clock.now())
}

async function briefing($: EngineInterface, text: string): Promise<string | null> {
  if (!(await ensureOwn($)) || !own) return null
  const intent = intentFrom(text)
  if (intent) own = isTaskShared ? { ...own, intent, isTaskHidden: false } : { ...own, intent: '', isTaskHidden: true }
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
  const intro =
    isFirst && peers.length
      ? peersBlock('Other Claude sessions are live on this machine:', peers, now, repo)
      : arrived.length
        ? peersBlock('New Claude sessions started since your last prompt:', arrived, now, repo)
        : null
  const inbox = await takeInbox($, true)
  return [intro, inbox].filter(Boolean).join('\n\n') || null
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

const COMMAND_HELP = [
  '/peer-sessions                      list the other live sessions and what they claim',
  '/peer-sessions msg <id|all> <text>  send a message (it reaches them with their next tool result or prompt)',
  '/peer-sessions claim <what> [...]   claim files, folders, branch:<name>, port:<n> for this session',
  '/peer-sessions release [<what> ...] give claims back (all of them with no argument)',
  '/peer-sessions help                 this list',
].join('\n')

// The person's own way in: the same registry the model's tools use.
async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  switch (verb.toLowerCase()) {
    case '':
    case 'list':
      return peersReport($)
    case 'msg':
    case 'message': {
      const [to = '', ...words] = rest
      return sendMessage($, { to, text: words.join(' ') })
    }
    case 'claim':
      return claim($, { resources: rest, note: 'claimed by the user' })
    case 'release':
      return claim($, { resources: rest, release: true })
    case 'help':
      return COMMAND_HELP
    default:
      return `Unknown: ${verb}.\n${COMMAND_HELP}`
  }
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
    name: 'message',
    description:
      'Send a short message to another Claude session on this machine (to: its id from the peers tool, at least 8 characters) or to every live session (to: "all"). ' +
      'Use it to say what you are about to change, hand work over, or answer a peer. It reaches them with their next tool result or prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', maxLength: 80 },
        text: { type: 'string', maxLength: MAX_MESSAGE_CHARS },
      },
      required: ['to', 'text'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'peers',
    description: 'List the other live Claude sessions on this machine: folder, git checkout and branch, task, recent edits and claims.',
    inputSchema: { type: 'object', properties: {} },
  })
}

export const register: Register = (on, options) => {
  mode = options.mode === 'warn' ? 'warn' : 'refuse'
  isTaskShared = options.shareTask !== false

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
    const isTask = TASK_ORIGINS.has(e.origin.kind) && !e.command && !e.isMeta
    // Any other prompt (a task notification waking an autonomous session) still
    // carries the inbox; only the task line is kept to real tasks.
    const isPlain = !e.command && !e.isMeta
    const block = isTask
      ? await briefing($, e.text).catch(() => null)
      : isPlain
        ? await takeInbox($, true).catch(() => null)
        : null
    return block ? next({ ...e, context: [...(e.context ?? []), block] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: CLAIM_TOOL }, async ($, e) => ({
    result: await claim($, e as unknown as Record<string, unknown>).catch(error => `peer-sessions: claim failed (${String(error)}).`),
  })).catch(() => ({ result: 'peer-sessions: claim failed; nothing was recorded.' }))

  on('tool.call', { tool: MESSAGE_TOOL }, async ($, e) => ({
    result: await sendMessage($, e as unknown as Record<string, unknown>).catch(error => `peer-sessions: message failed (${String(error)}).`),
  })).catch(() => ({ result: 'peer-sessions: message failed; nothing was sent.' }))

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
    if (deny) $.ui.toast(`peer-sessions: ${mode === 'warn' ? 'warned about' : 'held back'} ${e.tool}: ${deny.replace('[peer-sessions] ', '').slice(0, 180)}`)
    if (deny && mode === 'refuse') return { deny }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (deny) {
      const warning = `${deny.replace('[peer-sessions]', '[peer-sessions] (warn mode: the call ran anyway)')} Check what you just did against that session's work.`
      return { ...ran, context: [...(ran.context ?? []), warning] }
    }
    if (ran.isError) return ran
    if (READ_TOOLS.has(e.tool)) await noteRead($, input.file_path ?? input.notebook_path).catch(() => undefined)
    const inbox = await takeInbox($, false).catch(() => null)
    return inbox ? { ...ran, context: [...(ran.context ?? []), inbox] } : ran
  // next is replay-safe here: after the tool ran it hands back that result, never a second run.
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'peer-sessions' }, async ($, e) => ({
    text: await runCommand($, e.args).catch(error => `peer-sessions: the command failed (${String(error)}).`),
  })).catch(() => ({ text: 'peer-sessions: the command failed; the registry is untouched.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, band)
    const now = await $.clock.now()
    const message = view.message && (view.dismissedAt === null || view.message.at > view.dismissedAt) && now - view.message.at <= BAND_MESSAGE_MS ? view.message : null
    if (e.props.hasSurvey || (!message && view.inCheckout.length === 0)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const peerLine = view.inCheckout
      .slice(0, 3)
      .map(p => `${p.id}${p.branch ? ` on ${p.branch}` : ''}: ${p.intent}`)
      .join(' | ')
    return (
      <Box flexDirection="column">
        {view.inCheckout.length > 0 && (
          <Text color="yellow">
            {`peer-sessions: ${view.inCheckout.length} other session${view.inCheckout.length > 1 ? 's' : ''} in this checkout (${peerLine})`}
          </Text>
        )}
        {message && (
          <Box key="message">
            <Text>{`message from ${message.from}: ${message.text.slice(0, 200)} `}</Text>
            <Button key="dismiss" label="Dismiss" onPress={async () => {
                const at = await $.clock.now()
                await update($, band, v => ({ ...v, dismissedAt: at }))
              }} />
          </Box>
        )}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    // A missed tombstone is harmless: the record ages out after LIVE_MS.
    await endOwn($, e.sessionId).catch(() => undefined)
    return next(e)
  })
}
