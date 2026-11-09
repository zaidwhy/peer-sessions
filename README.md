# peer-sessions

When several Claude Code sessions run on one machine, none of them knows the others exist. Two of them edit the same file and the later write silently drops the earlier change; one runs `git commit -a` and sweeps another's half-done work into its commit; two push the same branch a minute apart. peer-sessions makes each session see the others and stops once before the edit or git command that would race a live peer.

## Thesis

- **Data:** one small JSON file per session in `~/.claude/peer-sessions/`: its id, folder, git checkout and branch, the task the user last typed (first line, 160 characters), and the files it edited in the last 30 minutes (200 at most). A session writes only its own file and reads the others, so the registry has no writer races of its own. A heartbeat rewrites the file every 60 seconds; a session whose file is older than about 3 minutes counts as gone, so a crashed session drops out by itself.
- **Failure mode 1, silent overwrite:** session B edits `invoice.py` minutes after session A did, from a stale read. The first such write is refused with A's id, folder and task, and an instruction to re-read the file. The write after the re-read goes through. Writes are caught from the Edit, Write, MultiEdit and NotebookEdit tools and from shell commands: `>` and `>>` redirects, `tee`, `sed -i`, and PowerShell's `Set-Content`, `Add-Content` and `Out-File`, resolved against a leading `cd`.
- **Failure mode 2, git race in a shared checkout:** `commit`, `push`, `pull`, `rebase`, `merge`, `reset`, `checkout`, `switch`, `stash`, `cherry-pick`, `revert` and `am` are refused once while another live session sits in the checkout the command acts on (the session's own, or the one `git -C <dir>` or a leading `cd <dir> &&` names). Read-only git (`status`, `log`, `diff`, `fetch`) is never touched. A peer in its own `git worktree` is a different checkout and blocks nothing; that is the fix the refusal points to.
- **Failure mode 3, two sessions take the same resource:** a session claims what it is about to work on (a file, a folder, or a named resource such as `port:3000`, `db:local`, `branch:main`) with the `claim` tool. A peer writing inside a claimed folder is refused once and told who holds it and why; a peer claiming something that overlaps is told at once. `branch:main` means main of this repository across all its worktrees: a peer's `commit`, `push`, `rebase` and the rest on that branch are refused once, while `checkout` stays free. Claims end with the session.
- **Sessions talk, not just block:** every refusal is also sent to the peer it was about ("I was about to write invoice.py, which you edited 2 min ago"), so both sides know. The `message` tool sends a note to one session or to all; it arrives with the receiver's next tool result, so it lands mid-task, not only when someone types. A refusal is skipped when this session read the file after the peer's edit: it has already seen the change.
- **Opinion: refuse once, never lock.** A lock that outlives a crashed session blocks real work, and a warning nobody has to act on gets skipped. One refusal per peer and target, carrying the peer's task, gives the model what it needs to re-read and coordinate, then gets out of the way. Every hook fails open: if the registry cannot be read or written, the tool call or prompt goes on as if the plugin were not installed.

## What a session sees

On the first prompt you type, if other sessions are live, the model gets a hidden note (you don't see it):

```
[peer-sessions] Other Claude sessions are live on this machine:
- bbbbbbbb in c:/work/app @ main [SAME CHECKOUT AS YOU]
  doing: refactor the invoice parser
  recent edits: c:/work/app/src/invoice.py (2 min ago)
  claims: c:/work/app/src/billing (invoice rewrite), port:3000 (dev server)
A peer in the same checkout or the same files can be overwritten by you, ...
```

After that, a note is added only when a new session appears. The status line shows `peers: 2 live, 1 in this checkout`, and `/peer-sessions` prints the full list.

The model gets two tools:

| Tool | What it does |
|---|---|
| `mcp__peer-sessions__claim` | `{ resources, note?, release? }`: claim files, folders or named resources; reports overlaps with claims peers already hold. `release: true` gives them back (all of them when `resources` is empty). At most 20 claims per session. |
| `mcp__peer-sessions__message` | `{ to, text }`: `to` is a peer's id from `peers` (8 characters or more) or `"all"`. Delivered once, with the receiver's next tool result or prompt; expires after 30 minutes, so a session that starts within that window still gets a recent broadcast. |
| `mcp__peer-sessions__peers` | Lists live peers with their checkout, branch, task, recent edits and claims, and what this session claims. |

The task is the prompt you typed, sent from your phone through Remote Control, passed to `claude -p`, handed over by a coordinating session, or fired by `/loop`. Task notifications, messages from other agents, slash commands and short replies such as "continue" leave the recorded task alone.

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

The plugin is a function-hooks module and needs a Claude Code build that loads those (it was built and tested on 2.1.319). No Python, Node or other runtime is needed; it runs inside Claude Code.

## Limits

- Shell writes are read from the command text, not traced: a script, a formatter, `cp`/`mv`, or a path held in a variable (`> $out`) is not recorded. A miss lets the write through unrecorded; it never blocks one.
- Claims are advisory between sessions that run peer-sessions: they refuse writes to claimed files and folders, but a named resource such as `port:3000` is only reported, not enforced (nothing stops a dev server binding the port).
- Subagents of one session share its id, so they never refuse each other. Give parallel subagents their own worktrees.
- A message waits for the receiver's next tool call or prompt; a session sitting idle at the prompt reads it when you next type there. Inboxes are checked at most every 10 seconds between prompts.
- Sessions on different machines, containers or remote sessions do not share `~/.claude` and cannot see each other.
- The task line is the first line of what you typed, kept in plain text in your home folder. It never leaves the machine.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/registry.ts` holds every rule as plain functions; `hooks/register.ts` wires them to the engine's events. `tests/peer-sessions.test.ts` runs the module against an in-memory disk and a seeded peer: 36 tests covering the briefing, every refusal and its one-time retry (edits, shell writes, claims, branch claims, git including `git -C`), the automatic handoff, message delivery and expiry (including from a sender that has since ended, and on a notification prompt), the read-after-edit skip, the claim, message and peers tools, which prompts count as the task, stale and ended peers, worktrees, non-repos and a broken disk.

## Changelog

- **0.3.0:** sessions message each other (`message` tool, delivered with the next tool result); every refusal is handed to the peer it was about; branch claims (`branch:main`) across worktrees; no refusal when the file was read after the peer's edit; prompts from `claude -p`, Remote Control, coordinators and `/loop` count as the task.
- **0.2.0:** claims (`claim` tool) for files, folders and named resources; a `peers` tool the model can call; shell writes guarded (`>`, `>>`, `tee`, `sed -i`, PowerShell content cmdlets); git checks follow `git -C` and a leading `cd`. Records stay readable by 0.1.0 sessions and the other way round.
- **0.1.0:** registry with heartbeat, peer briefing, edit and git refusals, `/peer-sessions`, status line.

## License

MIT
