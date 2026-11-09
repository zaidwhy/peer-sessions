# peer-sessions

Run three Claude Code sessions on one machine and none of them knows the others exist. One rewrites `invoice.py` from a stale read and silently drops another's change. One runs `git commit -a` and sweeps in another's half-done work. Two push `main` a minute apart. Two start a dev server on port 3000.

peer-sessions gives every session on the machine a shared picture: who else is live, in which repo and branch, doing what, touching which files, holding which resources. Sessions message each other, and the one edit or git command that would race a live peer is held back once, with the reason, before it happens.

```
/plugin install peer-sessions --marketplace zaidwhy/peer-sessions
```

Nothing to configure. It is silent while you run one session and starts talking the moment a second one opens.

## What you see

**Above the prompt**, whenever another session shares your checkout or a message arrives:

```
peer-sessions: 1 other session in this checkout (3f9a1c2e on main: refactor the invoice parser)
message from 3f9a1c2e: pushing main in 5 min, pull before you commit   [Dismiss]
```

**In the status line:** `peers: 2 live, 1 in this checkout`.

**A toast** when a message arrives or a call is held back: `peer-sessions: held back Edit: Session 3f9a1c2e (c:/work/app) edited c:/work/app/src/invoice.py 2 min ago and is still live.`

**What the model reads** (hidden from you) on the first prompt and whenever a new session opens:

```
[peer-sessions] Other Claude sessions are live on this machine:
- 3f9a1c2e in c:/work/app @ main [SAME CHECKOUT AS YOU]
  doing: refactor the invoice parser
  recent edits: c:/work/app/src/invoice.py (2 min ago)
  claims: c:/work/app/src/billing (invoice rewrite), port:3000 (dev server)
```

## What it stops

| Collision | What happens |
|---|---|
| Writing a file a live peer edited in the last 30 min | Held back once with the peer's task; the write after re-reading goes through. Skipped when this session already read the file after the peer's edit. Caught from Edit, Write, MultiEdit, NotebookEdit and shell writes (`>`, `>>`, `tee`, `sed -i`, `Set-Content`, `Add-Content`, `Out-File`). |
| Writing inside a folder a peer claimed | Held back once, naming the claim and its note. |
| `commit`, `push`, `pull`, `rebase`, `merge`, `reset`, `checkout`, `switch`, `stash`, `cherry-pick`, `revert`, `am` in a checkout a live peer is in | Held back once. Follows `git -C <dir>` and a leading `cd <dir> &&`. Read-only git (`status`, `log`, `diff`, `fetch`) is never touched. A peer in its own `git worktree` is a different checkout and blocks nothing. |
| Racing git on a branch a peer claimed (`branch:main`) | Held back once, from any worktree of the same repository. `checkout` stays free. |
| Claiming something a peer already holds (`port:3000`, `db:local`) | Reported at once, with who holds it and why. |

Every hold-back is also sent to the peer it was about ("I was about to write invoice.py, which you edited 2 min ago"), so both sides know.

## Commands and tools

For you, at the prompt:

```
/peer-sessions                      list the other live sessions and what they claim
/peer-sessions msg <id|all> <text>  send a message
/peer-sessions claim <what> [...]   claim files, folders, branch:<name>, port:<n> for this session
/peer-sessions release [<what> ...] give claims back (all of them with no argument)
/peer-sessions help
```

For the model:

| Tool | What it does |
|---|---|
| `mcp__peer-sessions__claim` | `{ resources, note?, release? }`: claim files, folders, `branch:<name>` or named resources; reports overlaps with what peers hold. At most 20 claims per session; they end with the session. |
| `mcp__peer-sessions__message` | `{ to, text }`: `to` is a peer's id (8 characters or more) or `"all"`. Delivered once, with the receiver's next tool result or prompt, so it lands mid-task. Kept 30 minutes, so a session that opens within that window still gets a recent broadcast, and a message from a session that has since ended still arrives. |
| `mcp__peer-sessions__peers` | Live peers with their checkout, branch, task, recent edits and claims, and what this session claims. |

## Settings

In `/config`, under peer-sessions:

| Setting | Default | |
|---|---|---|
| On a collision (`mode`) | `refuse` | `refuse` holds the call back once. `warn` lets it run and tells the model straight after, for people who never want a tool call stopped. |
| Share my task line (`shareTask`) | on | Off: other sessions see that this one is live, its folder, files and claims, but not what you asked it to do. |

## How it works

- **Data:** one small JSON file per session in `~/.claude/peer-sessions/`: id, folder, git checkout, branch and shared git dir, the task line (first line of the prompt, 160 characters; from your typing, Remote Control, `claude -p`, a coordinator or `/loop`, never from notifications or short replies like "continue"), files written in the last 30 minutes (200 at most), claims, and outgoing messages. A session writes only its own file and reads the others', so the registry has no writer races of its own.
- **Liveness:** a heartbeat rewrites the file every 60 seconds; a file older than about 3 minutes counts as gone, so a crashed session drops out by itself. A session that ends writes a tombstone.
- **Opinion: hold back once, never lock.** A lock that outlives a crashed session blocks real work, and a warning nobody has to act on gets skipped. One hold-back per peer and target, carrying the peer's task, gives the model what it needs to re-read and coordinate, then gets out of the way.
- **Fails open:** if the registry cannot be read or written, every tool call and prompt goes on as if the plugin were not installed.
- **Runs inside Claude Code:** a function-hooks module, no Python, Node or server. Built and tested on Claude Code 2.1.319.

## Install

At the prompt of a terminal session:

```
/plugin install peer-sessions --marketplace zaidwhy/peer-sessions
```

Answer `y` to add the marketplace, then pick a scope (user scope covers every session). From a shell:

```
claude plugin install peer-sessions --marketplace zaidwhy/peer-sessions
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `zaidwhy/peer-sessions`, then Add plugin.

To update later:

```
claude plugin marketplace update peer-sessions
claude plugin update peer-sessions@peer-sessions
```

## Limits

- Shell writes are read from the command text, not traced: a script, a formatter, `cp`/`mv`, or a path held in a variable (`> $out`) is not recorded. A miss lets the write through; it never blocks one.
- Named claims such as `port:3000` are reported, not enforced: nothing stops a dev server binding the port.
- Subagents of one session share its id, so they never hold each other back. Give parallel subagents their own worktrees.
- A session idle at the prompt reads its messages when you next type there. Between prompts, inboxes are checked at most every 10 seconds.
- Sessions on different machines, containers or cloud sessions do not share `~/.claude` and cannot see each other.
- The task line stays in plain text in your home folder and never leaves the machine; turn `shareTask` off to keep it out entirely.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/registry.ts` holds every rule as plain functions; `hooks/register.tsx` wires them to the engine's events and draws the band. `tests/peer-sessions.test.tsx` runs the module against an in-memory disk and seeded peers: 43 tests covering the briefing, every hold-back and its one-time retry, both modes, the automatic handoff, message delivery and expiry, the read-after-edit skip, the tools and the `/peer-sessions` subcommands, task privacy, the band on terminal and desktop, worktrees, non-repos and a broken disk.

## Changelog

- **0.4.0:** a band above the prompt and toasts, so you see peers and messages, not only the model; `/peer-sessions msg|claim|release|help`; settings: `mode` (refuse or warn) and `shareTask`.
- **0.3.0:** sessions message each other (`message` tool, delivered with the next tool result); every refusal is handed to the peer it was about; branch claims across worktrees; no refusal when the file was read after the peer's edit; prompts from `claude -p`, Remote Control, coordinators and `/loop` count as the task.
- **0.2.0:** claims for files, folders and named resources; a `peers` tool; shell writes guarded; git checks follow `git -C` and a leading `cd`.
- **0.1.0:** registry with heartbeat, peer briefing, edit and git refusals, `/peer-sessions`, status line.

## License

MIT
