# peer-sessions

Run three Claude Code sessions on one machine and none of them knows the others exist. One rewrites `invoice.py` from a stale read and silently drops another's change. One runs `git commit -a` and sweeps in another's half-done work. Two push `main` a minute apart. Two start a dev server on port 3000.

peer-sessions gives every session on the machine a shared picture: who else is live, in which repo and branch, doing what, touching which files, holding which resources. Sessions message each other, wait for each other, and remember what earlier sessions did in a repository. The one edit or git command that would race a live peer is held back once, with the reason, before it happens.

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

## What it remembers

Every session leaves its record behind when it ends, so a repository builds up a short memory with no handoff file to write:

- **The trail.** The first prompt in a repository hears what the last sessions there did (kept 7 days):
  ```
  [peer-sessions] Earlier Claude sessions in this repository (most recent first):
  - 2 h ago, 7c41e0b9: migrate the users table to uuid keys
    wrote: c:/work/app/db/migrate.py, c:/work/app/models/user.py and 3 more
  ```
- **Blame for Claude sessions.** The first write to a file says who wrote it last, if another session did within a day: `c:/work/app/db/migrate.py was last written 3 h ago by session 7c41e0b9 (session since ended), doing: migrate the users table to uuid keys.` The `history` tool answers "who touched this file?" for the last 7 days.
- **Pinned notes.** `pin` leaves a note for every session working in the repository, for up to 7 days, outliving the session that wrote it: "staging DB credentials were rotated, use the new .env.staging". Sessions that open there see it; live ones get it with their next prompt.

## Waiting instead of racing

`wait_for` takes a session id or a claimed resource (`branch:main`, `port:3000`, `src/api/`). It checks for a few seconds; if the target is still held, it watches it and messages the session the moment it clears, waking it if it is idle. The model can do other work meanwhile instead of racing the peer or polling by hand.

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
/peer-sessions history [<file>]     earlier sessions in this repository, or who wrote a file
/peer-sessions pin <text>           pin a note for this repository for 24 h
/peer-sessions unpin <id|all>       remove a note this session pinned
/peer-sessions help
```

For the model:

| Tool | What it does |
|---|---|
| `mcp__peer-sessions__claim` | `{ resources, note?, release? }`: claim files, folders, `branch:<name>` or named resources; reports overlaps with what peers hold. At most 20 claims per session; they end with the session. |
| `mcp__peer-sessions__message` | `{ to, text }`: `to` is a peer's id (8 characters or more) or `"all"`. Delivered once, with the receiver's next tool result or prompt, so it lands mid-task. Kept 30 minutes, so a session that opens within that window still gets a recent broadcast, and a message from a session that has since ended still arrives. |
| `mcp__peer-sessions__peers` | Live peers with their checkout, branch, task, recent edits and claims, and what this session claims. |
| `mcp__peer-sessions__history` | `{ path? }`: earlier sessions in this repository over 7 days, with their tasks, files and pinned notes; with `path`, every session that wrote that file. |
| `mcp__peer-sessions__pin` | `{ text, hours?, unpin? }`: pin a note for everyone working in this repository, 1 to 168 hours (default 24). `unpin` takes a note id or `"all"`. |
| `mcp__peer-sessions__wait_for` | `{ target, timeoutSeconds? }`: wait for a session to end or a claim to clear; hands a long wait to a watch that messages the session when it clears (5 to 3600 s, default 600). |

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
- **Runs inside Claude Code:** a function-hooks module, no Python, Node or server. Needs Claude Code **2.1.289 or newer**: earlier builds do not load function-hooks modules (checked with `claude plugin validate` on every release from 2.1.288 to 2.1.319). Tested end to end on 2.1.319. Check yours with `claude --version`.

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
- Ended sessions' files stay in `~/.claude/peer-sessions/` (a few KB each): they are the 7-day trail. Files older than that are never read again; the plugin cannot delete files, so clear the folder by hand if it ever grows large.
- A watch lives in the session that asked for it: if that session ends, the watch goes with it.
- The task line stays in plain text in your home folder and never leaves the machine; turn `shareTask` off to keep it out entirely.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/registry.ts` holds every rule as plain functions; `hooks/register.tsx` wires them to the engine's events and draws the band. `tests/peer-sessions.test.tsx` runs the module against an in-memory disk and seeded peers: 56 tests covering the briefing, every hold-back and its one-time retry, both modes, the automatic handoff, message delivery and expiry, the read-after-edit skip, the trail, blame and pinned notes (including expiry and other repositories), `wait_for` with its watch waking an idle session or arriving mid-turn, the tools and the `/peer-sessions` subcommands, task privacy, the band on terminal and desktop, worktrees, non-repos and a broken disk.

## Changelog

- **0.5.0:** a repository memory: the trail of earlier sessions on the first prompt, blame on the first write to a file, the `history` tool, and pinned notes (`pin`) that outlive their session; `wait_for` with watches that message or wake the session when a peer ends or a claim clears.
- **0.4.0:** a band above the prompt and toasts, so you see peers and messages, not only the model; `/peer-sessions msg|claim|release|help`; settings: `mode` (refuse or warn) and `shareTask`.
- **0.3.0:** sessions message each other (`message` tool, delivered with the next tool result); every refusal is handed to the peer it was about; branch claims across worktrees; no refusal when the file was read after the peer's edit; prompts from `claude -p`, Remote Control, coordinators and `/loop` count as the task.
- **0.2.0:** claims for files, folders and named resources; a `peers` tool; shell writes guarded; git checks follow `git -C` and a leading `cd`.
- **0.1.0:** registry with heartbeat, peer briefing, edit and git refusals, `/peer-sessions`, status line.

## Issues, ideas and pull requests

Something wrong, noisy or missing? [Open an issue](https://github.com/zaidwhy/peer-sessions/issues): a hold-back that should not have happened, a collision it missed, a message that never arrived, or an idea for how sessions should work together. The most useful reports say your Claude Code version (`claude --version`), your OS, and what each session was doing.

Pull requests are welcome and I am happy to merge them. Before opening one, run `claude plugin validate .` and `claude plugin test .`, and add a test in `tests/peer-sessions.test.tsx` that fails without your change. Rules live in `hooks/registry.ts` as plain functions, so most fixes start and end there.

## License

MIT
