# peer-sessions

When several Claude Code sessions run on one machine, none of them knows the others exist. Two of them edit the same file and the later write silently drops the earlier change; one runs `git commit -a` and sweeps another's half-done work into its commit; two push the same branch a minute apart. peer-sessions makes each session see the others and stops once before the edit or git command that would race a live peer.

## Thesis

- **Data:** one small JSON file per session in `~/.claude/peer-sessions/`: its id, folder, git checkout and branch, the task the user last typed (first line, 160 characters), and the files it edited in the last 30 minutes (200 at most). A session writes only its own file and reads the others, so the registry has no writer races of its own. A heartbeat rewrites the file every 60 seconds; a session whose file is older than about 3 minutes counts as gone, so a crashed session drops out by itself.
- **Failure mode 1, silent overwrite:** session B edits `invoice.py` minutes after session A did, from a stale read. The first such Edit or Write is refused with A's id, folder and task, and an instruction to re-read the file. The edit after the re-read goes through.
- **Failure mode 2, git race in a shared checkout:** `commit`, `push`, `pull`, `rebase`, `merge`, `reset`, `checkout`, `switch`, `stash`, `cherry-pick`, `revert` and `am` are refused once while another live session sits in the same checkout. Read-only git (`status`, `log`, `diff`, `fetch`) is never touched. A peer in its own `git worktree` is a different checkout and blocks nothing; that is the fix the refusal points to.
- **Opinion: refuse once, never lock.** A lock that outlives a crashed session blocks real work, and a warning nobody has to act on gets skipped. One refusal per peer and target, carrying the peer's task, gives the model what it needs to re-read and coordinate, then gets out of the way. Every hook fails open: if the registry cannot be read or written, the tool call or prompt goes on as if the plugin were not installed.

## What a session sees

On the first prompt you type, if other sessions are live, the model gets a hidden note (you don't see it):

```
[peer-sessions] Other Claude sessions are live on this machine:
- bbbbbbbb in c:/work/app @ main [SAME CHECKOUT AS YOU]
  doing: refactor the invoice parser
  recent edits: c:/work/app/src/invoice.py (2 min ago)
A peer in the same checkout or the same files can be overwritten by you, ...
```

After that, a note is added only when a new session appears. The status line shows `peers: 2 live, 1 in this checkout`, and `/peer-sessions` prints the full list.

Only prompts typed at the composer count as the task. Task notifications, messages from other agents, slash commands and short replies such as "continue" leave the recorded task alone.

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

- Only the Edit, Write, MultiEdit and NotebookEdit tools are tracked as file edits. A file changed by a shell command (`sed -i`, a script, a formatter) is not recorded.
- The git check reads the session's own folder. A command that points git elsewhere (`git -C ../other commit`) is checked against the session's checkout, not the target.
- Subagents of one session share its id, so they never refuse each other. Give parallel subagents their own worktrees.
- Sessions on different machines, containers or remote sessions do not share `~/.claude` and cannot see each other.
- The task line is the first line of what you typed, kept in plain text in your home folder. It never leaves the machine.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/registry.ts` holds every rule as plain functions; `hooks/register.ts` wires them to the engine's events. `tests/peer-sessions.test.ts` runs the module against an in-memory disk and a seeded peer: 15 tests covering the briefing, both refusals and their one-time retry, stale and ended peers, worktrees, non-repos and a broken disk.

## License

MIT
