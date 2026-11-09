// The registry's data and the decisions made on it, with no engine calls, so
// tests reach every rule directly.

export const SHAPE = 1
export const HEARTBEAT_MS = 60_000
// Three missed heartbeats: a session that crashed drops out within minutes.
export const LIVE_MS = 3 * HEARTBEAT_MS + 15_000
export const EDIT_CONFLICT_MS = 30 * 60_000
export const MAX_TOUCHED = 200
export const MAX_INTENT_CHARS = 160
// "continue", "yes", "okay do it" say nothing a peer can act on.
export const MIN_INTENT_CHARS = 20
export const MAX_RECORD_BYTES = 64 * 1024
export const MAX_PEERS_READ = 50
export const MAX_CLAIMS = 20
export const MAX_RESOURCE_CHARS = 300
export const MAX_NOTE_CHARS = 200
const MAX_SHELL_TARGETS = 10

// A claim is a session saying "this is mine for now": a file, a folder, or a
// named resource such as port:3000 or db:local. It lasts while the session is live.
export type Claim = { resource: string; note: string; at: number }

// A message lives in its sender's own file (no session writes another's) until
// it expires; each receiver remembers which ids it has already been shown.
export type Message = { id: string; to: string; text: string; at: number }
export const MESSAGE_TTL_MS = 30 * 60_000
export const MAX_OUTBOX = 20
export const MAX_SEEN = 200
export const MAX_MESSAGE_CHARS = 600

export type SessionRecord = {
  shape: number
  id: string
  cwd: string
  repo: string | null
  branch: string | null
  started: number
  intent: string
  touched: Record<string, number>
  // Optional so a 0.1.0 session's record still reads as a peer.
  claims?: Claim[]
  // The repository's shared git dir: one value for every worktree of a repo.
  common?: string | null
  outbox?: Message[]
  seen?: string[]
  // The person chose not to share the task line (userConfig shareTask: false).
  isTaskHidden?: boolean
  ended?: boolean
}

export const newRecord = (id: string, cwd: string, now: number): SessionRecord => ({
  shape: SHAPE,
  id,
  cwd: normPath(cwd, cwd),
  repo: null,
  branch: null,
  started: now,
  intent: '',
  touched: {},
})

const isWindowsPath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')

// One spelling per file: forward slashes, and on Windows one case, since
// C:\Repo\App.py and c:/repo/app.py are the same file there.
export const normPath = (path: string, cwd: string): string => {
  let full = path.replace(/\\/g, '/')
  const isAbsolute = full.startsWith('/') || /^[a-zA-Z]:\//.test(full)
  if (!isAbsolute) full = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${full}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && !(part === '' && parts.length > 0)) parts.push(part)
  }
  const joined = parts.join('/')
  return isWindowsPath(path) || isWindowsPath(cwd) ? joined.toLowerCase() : joined
}

export const parseRecord = (text: string): SessionRecord | null => {
  try {
    const value = JSON.parse(text)
    if (value?.shape !== SHAPE || typeof value.id !== 'string' || typeof value.touched !== 'object') return null
    return value as SessionRecord
  } catch {
    return null
  }
}

export const intentFrom = (prompt: string): string | null => {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
  const words = firstLine.replace(/\s+/g, ' ').trim()
  if (words.length < MIN_INTENT_CHARS || words.startsWith('/') || words.startsWith('<')) return null
  return words.length > MAX_INTENT_CHARS ? `${words.slice(0, MAX_INTENT_CHARS - 3)}...` : words
}

export const touch = (record: SessionRecord, path: string, now: number): SessionRecord => {
  const touched = { ...record.touched, [path]: now }
  const entries = Object.entries(touched)
  if (entries.length <= MAX_TOUCHED) return { ...record, touched }
  entries.sort((a, b) => b[1] - a[1])
  return { ...record, touched: Object.fromEntries(entries.slice(0, MAX_TOUCHED)) }
}

export type EditConflict = { peer: SessionRecord; touchedAt: number }

export const editConflict = (peers: readonly SessionRecord[], path: string, now: number): EditConflict | null => {
  for (const peer of peers) {
    const touchedAt = peer.touched[path]
    if (touchedAt !== undefined && now - touchedAt <= EDIT_CONFLICT_MS) return { peer, touchedAt }
  }
  return null
}

// Commands that change what another session in the same checkout sees, or
// race it to the remote. Reads (status, log, diff, fetch) stay free.
const RACING_GIT = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(commit|push|pull|rebase|merge|reset|checkout|switch|stash|cherry-pick|revert|am)\b/

export const racingGitVerb = (command: string): string | null => RACING_GIT.exec(command)?.[1] ?? null

export const sameCheckout = (peers: readonly SessionRecord[], repo: string | null): SessionRecord[] =>
  repo === null ? [] : peers.filter(peer => peer.repo === repo)

const unquote = (token: string) => token.replace(/^(["'])(.*)\1$/, '$2')

const QUOTED_OR_BARE = String.raw`("[^"]+"|'[^']+'|[^\s;&|<>()]+)`

// The folder a shell command really works in: a leading `cd X &&` / `cd X;`
// (also `Set-Location X;`), else the session's own folder.
export const commandDir = (command: string, cwd: string): string => {
  const cd = new RegExp(String.raw`^\s*(?:cd|Set-Location|pushd)\s+${QUOTED_OR_BARE}\s*(?:&&|;)`, 'i').exec(command)
  return cd?.[1] ? normPath(unquote(cd[1]), cwd) : normPath(cwd, cwd)
}

// The folder git acts on: `git -C X ...` wins over the command's folder.
export const gitDir = (command: string, cwd: string): string => {
  const base = commandDir(command, cwd)
  const flag = new RegExp(String.raw`\bgit\s+-C\s+${QUOTED_OR_BARE}`).exec(command)
  return flag?.[1] ? normPath(unquote(flag[1]), base) : base
}

const isRealTarget = (target: string) =>
  target.length > 0 &&
  !/^(\/dev\/(null|stdout|stderr)|nul|\$null|&\d|\d)$/i.test(target) &&
  !/[$*?`]/.test(target)

// Files a shell command writes, read from the shapes that cover most real use:
// `>`/`>>` redirects, `tee`, `sed -i`, and PowerShell's Set-Content, Add-Content
// and Out-File. A miss lets the write through unrecorded, never blocks it.
export const shellWriteTargets = (command: string, cwd: string): string[] => {
  const base = commandDir(command, cwd)
  const found: string[] = []
  const add = (raw: string | undefined) => {
    const target = raw ? unquote(raw) : ''
    if (isRealTarget(target)) found.push(normPath(target, base))
  }
  for (const m of command.matchAll(new RegExp(String.raw`(?:^|[^<>&\d=])\d?>>?\s*${QUOTED_OR_BARE}`, 'g'))) add(m[1])
  for (const m of command.matchAll(new RegExp(String.raw`\btee\s+(?:-a\s+|--append\s+)?${QUOTED_OR_BARE}`, 'g'))) add(m[1])
  for (const m of command.matchAll(/\bsed\s+(?:-[a-zA-Z]*\s+)*-i\S*\s+(?:-e\s+)?("[^"]*"|'[^']*'|\S+)\s+([^;&|]+)/g)) {
    for (const file of (m[2] ?? '').trim().split(/\s+/)) add(file)
  }
  for (const m of command.matchAll(new RegExp(String.raw`\b(?:Set-Content|Add-Content|Out-File)\b(?:\s+-(?:Path|FilePath|LiteralPath))?\s+${QUOTED_OR_BARE}`, 'gi'))) add(m[1])
  return [...new Set(found)].slice(0, MAX_SHELL_TARGETS)
}

// A path-like claim is normalised like a file; anything else (port:3000) is a name.
export const normResource = (resource: string, cwd: string): string => {
  const trimmed = resource.trim().slice(0, MAX_RESOURCE_CHARS)
  const isPathLike = /[\\/]/.test(trimmed) || /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('.') || /\.\w{1,8}$/.test(trimmed)
  return isPathLike && !/^\w+:\d+$/.test(trimmed) ? normPath(trimmed, cwd) : trimmed.toLowerCase()
}

const covers = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer.replace(/\/$/, '')}/`)

export type ClaimConflict = { peer: SessionRecord; claim: Claim }

// A file inside a folder a live peer claimed.
export const claimConflict = (peers: readonly SessionRecord[], path: string): ClaimConflict | null => {
  for (const peer of peers) {
    const claim = (peer.claims ?? []).find(c => covers(c.resource, path))
    if (claim) return { peer, claim }
  }
  return null
}

// Peer claims that overlap what this session wants, in either direction:
// claiming src/ while a peer holds src/api.py is still a clash.
export const overlappingClaims = (peers: readonly SessionRecord[], resources: readonly string[]): ClaimConflict[] =>
  peers.flatMap(peer =>
    (peer.claims ?? [])
      .filter(c => resources.some(r => covers(c.resource, r) || covers(r, c.resource)))
      .map(claim => ({ peer, claim })),
  )

export const addClaims = (record: SessionRecord, resources: readonly string[], note: string, now: number): SessionRecord => {
  const kept = (record.claims ?? []).filter(c => !resources.includes(c.resource))
  const added = resources.map(resource => ({ resource, note: note.slice(0, MAX_NOTE_CHARS), at: now }))
  return { ...record, claims: [...added, ...kept].slice(0, MAX_CLAIMS) }
}

// branch:main means main of this repository, across all its worktrees, so it is
// stored against the shared git dir: branch:main@c:/work/app/.git.
export const branchClaim = (branch: string, common: string) => `branch:${branch.toLowerCase()}@${common}`

export const normClaim = (resource: string, cwd: string, common: string | null): string => {
  const branch = /^branch:([^@\s]+)$/i.exec(resource.trim())
  return branch?.[1] && common ? branchClaim(branch[1], common) : normResource(resource, cwd)
}

// The branch a racing git command lands on: an explicit `git push <remote> <src>[:dst]`
// names it, anything else acts on the checked-out branch.
export const gitBranch = (command: string, current: string | null): string | null => {
  const push = /\bgit\s+(?:-C\s+\S+\s+)?push\s+(?:-\S+\s+)*[^\s-]\S*\s+\+?([^\s:;&|]+)(?::([^\s;&|]+))?/.exec(command)
  return push ? (push[2] ?? push[1] ?? current) : current
}

export const branchConflict = (peers: readonly SessionRecord[], branch: string, common: string): ClaimConflict | null => {
  const wanted = branchClaim(branch, common)
  for (const peer of peers) {
    const claim = (peer.claims ?? []).find(c => c.resource === wanted)
    if (claim) return { peer, claim }
  }
  return null
}

export const addMessage = (record: SessionRecord, message: Message): SessionRecord => ({
  ...record,
  outbox: [message, ...(record.outbox ?? []).filter(m => message.at - m.at <= MESSAGE_TTL_MS)].slice(0, MAX_OUTBOX),
})

export type Delivery = { from: SessionRecord; message: Message }

// Messages for this session that it has not been shown: addressed to it by an
// id prefix of at least 8 characters, or to "all".
export const inboxFor = (peers: readonly SessionRecord[], own: SessionRecord, now: number): Delivery[] => {
  const seen = new Set(own.seen ?? [])
  return peers.flatMap(from =>
    (from.outbox ?? [])
      // A broadcast sent before this session started still matters ("deploying staging"): only expiry drops it.
      .filter(m => !seen.has(m.id) && now - m.at <= MESSAGE_TTL_MS)
      .filter(m => m.to === 'all' || (m.to.length >= 8 && own.id.startsWith(m.to)))
      .map(message => ({ from, message })),
  ).sort((a, b) => a.message.at - b.message.at)
}

export const markSeen = (record: SessionRecord, ids: readonly string[]): SessionRecord => ({
  ...record,
  seen: [...ids, ...(record.seen ?? [])].slice(0, MAX_SEEN),
})

export const inboxBlock = (deliveries: readonly Delivery[], now: number): string =>
  [
    '[peer-sessions] Messages from other Claude sessions on this machine:',
    ...deliveries.map(({ from, message }) => {
      const minutes = Math.max(0, Math.round((now - message.at) / 60_000))
      const where = `${from.repo ?? from.cwd}${from.ended ? ', session since ended' : ''}`
      return `- from ${from.id.slice(0, 8)} (${where}, doing: ${taskOf(from)}), ${minutes === 0 ? 'just now' : `${minutes} min ago`}${message.to === 'all' ? ', to all' : ''}: ${message.text}`
    }),
    'Reply with the mcp__peer-sessions__message tool (to: the sender id) if it needs an answer, and tell the user if it changes their task.',
  ].join('\n')

export const releaseClaims = (record: SessionRecord, resources: readonly string[]): SessionRecord => ({
  ...record,
  claims: resources.length ? (record.claims ?? []).filter(c => !resources.includes(c.resource)) : [],
})

export const taskOf = (record: SessionRecord): string =>
  record.intent || (record.isTaskHidden ? 'task not shared' : 'no task typed yet')

const ago = (then: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  return minutes === 0 ? 'just now' : `${minutes} min ago`
}

export const describePeer = (peer: SessionRecord, now: number, ownRepo: string | null): string => {
  const recent = Object.entries(peer.touched).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const files = recent.length ? recent.map(([path, at]) => `${path} (${ago(at, now)})`).join(', ') : 'none yet'
  const where = peer.repo ? `${peer.repo}${peer.branch ? ` @ ${peer.branch}` : ''}` : peer.cwd
  const shared = ownRepo !== null && peer.repo === ownRepo ? ' [SAME CHECKOUT AS YOU]' : ''
  const claims = (peer.claims ?? []).map(c => `${c.resource}${c.note ? ` (${c.note})` : ''}`)
  return [
    `- ${peer.id.slice(0, 8)} in ${where}${shared}`,
    `  doing: ${taskOf(peer)}`,
    `  recent edits: ${files}`,
    ...(claims.length ? [`  claims: ${claims.join(', ')}`] : []),
  ].join('\n')
}

export const PEER_GUIDANCE = [
  'A peer in the same checkout or the same files can be overwritten by you, or can commit or push your half-done work.',
  'Before touching what a peer touched or claimed: re-read the file, prefer your own branch or git worktree, and git fetch before any push.',
  'Claim the files, folders, branches (branch:main) or resources (port:3000, db:local) you are about to work on with the mcp__peer-sessions__claim tool, so peers are warned off them.',
  'If your task overlaps a peer\'s, tell it what you are about to change with the mcp__peer-sessions__message tool (to: its 8-character id) or ask the user which session owns the work.',
  'mcp__peer-sessions__peers or /peer-sessions shows the current list.',
].join(' ')

export const peersBlock = (heading: string, peers: readonly SessionRecord[], now: number, ownRepo: string | null): string =>
  [`[peer-sessions] ${heading}`, ...peers.map(peer => describePeer(peer, now, ownRepo)), PEER_GUIDANCE].join('\n')

export const statusText = (peers: readonly SessionRecord[], ownRepo: string | null): string | undefined => {
  if (peers.length === 0) return undefined
  const inCheckout = sameCheckout(peers, ownRepo).length
  return `peers: ${peers.length} live${inCheckout ? `, ${inCheckout} in this checkout` : ''}`
}
