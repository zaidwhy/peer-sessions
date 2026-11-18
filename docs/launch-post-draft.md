# Launch post - DRAFT (Zaid rewrites and posts this himself)

Not posted. Plain words only; every claim traces to the field report
(docs/field-report-2026-11-18.md) or the test suite. No numbers that the plugin cannot
measure (for example it does not claim a count of collisions prevented - refusal volume
over time is not recoverable from the registry).

---

## Short version (X / Mastodon)

I run several Claude Code sessions on one machine and they kept stepping on each other:
one rewrites a file from a stale read, another's `git commit -a` sweeps in half-done work,
two push the same branch. So I built peer-sessions: every session on the machine sees the
others (who is live, which repo and branch, which files, which claims), they can message
and wait for each other, and the one edit or git command that would race a live peer is
held back once, with the reason, before it happens. No server, no config, fails open.

Last night it carried eight sessions sharing one machine for about five and a half hours.
MIT, install in one line.

`/plugin install peer-sessions --marketplace zaidwhy/peer-sessions`
github.com/zaidwhy/peer-sessions

## Longer version (LinkedIn / README intro)

**What it is.** A Claude Code plugin. Run more than one session on a machine and each one
gets a shared picture of the others: who is live, in which repo and branch, doing what,
touching which files, holding which resources. Sessions message and wait for each other,
leave a short per-repo trail for the next session, and the single edit or git command that
would race a live peer is held back once, with that peer's task, before it runs.

**The one problem it solves.** Parallel agents on one checkout clobber each other with no
warning: a stale-read rewrite that drops another session's change, a `git commit -a` that
sweeps in half-finished work, two sessions racing a push. peer-sessions makes those
sessions aware of each other so the collision is caught once, not discovered later.

**See it in 30 seconds.** `demo/` has a two-pane script: the left session claims and edits
`invoice.py`, the right session's edit of the same file is held back once, naming who holds
it and why. Record that and you have the whole idea.

**From last night (measured, see the field report).** Eight sessions shared one machine for
about five and a half hours. Across them the plugin recorded 545 file-writes and surfaced
one real bug of its own: 37 "phantom edits" where a `>` inside a quoted command argument
(a pip version spec like `"x>=1.0"`) was misread as a file write. That is now fixed with a
regression test. The suite is 60 tests.

**Honest limits.** It reads shell writes from the command text, so a script or a `$var`
path is not traced. Paths are matched by case and slash, not resolved through symlinks or
Windows junctions. Named claims like `port:3000` are reported, not enforced. It fails open:
if it cannot read its registry, every call proceeds as if it were not installed.

MIT. `/plugin install peer-sessions --marketplace zaidwhy/peer-sessions`
