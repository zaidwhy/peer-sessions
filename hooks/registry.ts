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

export type SessionRecord = {
  shape: number
  id: string
  cwd: string
  repo: string | null
  branch: string | null
  started: number
  intent: string
  touched: Record<string, number>
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

const ago = (then: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  return minutes === 0 ? 'just now' : `${minutes} min ago`
}

export const describePeer = (peer: SessionRecord, now: number, ownRepo: string | null): string => {
  const recent = Object.entries(peer.touched).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const files = recent.length ? recent.map(([path, at]) => `${path} (${ago(at, now)})`).join(', ') : 'none yet'
  const where = peer.repo ? `${peer.repo}${peer.branch ? ` @ ${peer.branch}` : ''}` : peer.cwd
  const shared = ownRepo !== null && peer.repo === ownRepo ? ' [SAME CHECKOUT AS YOU]' : ''
  return [
    `- ${peer.id.slice(0, 8)} in ${where}${shared}`,
    `  doing: ${peer.intent || '(no task typed yet)'}`,
    `  recent edits: ${files}`,
  ].join('\n')
}

export const PEER_GUIDANCE = [
  'A peer in the same checkout or the same files can be overwritten by you, or can commit or push your half-done work.',
  'Before touching what a peer touched: re-read the file, prefer your own branch or git worktree, and git fetch before any push.',
  'If your task overlaps a peer\'s, tell it what you are about to change (ListAgents finds it, SendMessage reaches it) or ask the user which session owns the work.',
  'Run /peer-sessions for the current list.',
].join(' ')

export const peersBlock = (heading: string, peers: readonly SessionRecord[], now: number, ownRepo: string | null): string =>
  [`[peer-sessions] ${heading}`, ...peers.map(peer => describePeer(peer, now, ownRepo)), PEER_GUIDANCE].join('\n')

export const statusText = (peers: readonly SessionRecord[], ownRepo: string | null): string | undefined => {
  if (peers.length === 0) return undefined
  const inCheckout = sameCheckout(peers, ownRepo).length
  return `peers: ${peers.length} live${inCheckout ? `, ${inCheckout} in this checkout` : ''}`
}
