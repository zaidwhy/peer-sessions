# peer-sessions bug pass - 2026-11-18

Branch: `bugfix/shellwrite-falsepos` (local, not pushed). Tests: 58 pass, 0 fail
(`claude plugin test .`), up from 56 (one fix test, one behavior-documenting test).

## 1. Tests run

`claude plugin test .` -> 58 pass / 0 fail. `claude plugin validate .` -> passes (pre-change).

## 2. FIXED: shellWriteTargets false-positive on version specifiers (defect 3b)

**Symptom (seen live):** stray "edits" with names like `=3.14.0"` showing up in the
recent-edits list and, worse, able to trigger spurious edit-conflict refusals.

**Root cause:** `shellWriteTargets` (hooks/registry.ts) reads redirect targets with a
regex that matches any `>`/`>>`. A `>` inside a quoted version spec is not a shell
redirect, but the regex still fires:
- `pip install "numpy>=3.14.0"` -> matches at `>=`, captures `=3.14.0"` as a "write target".
- `pip install "pkg>1.0"` -> captures `1.0"`.
- `uv add "fastapi>=0.110,<0.120"` -> captures `=0.110,`.

These artifacts were then normalised and recorded in the session's `touched` map, so they
appeared as edits and (because `editConflict`/`guardWrites` read `touched`) could cause a
false "a peer edited X" refusal.

**Fix (surgical, in `isRealTarget`):** reject targets that start with `=` (the `>=`/`<=`
comparison artifact) or contain a quote char (an unbalanced quote from inside a quoted
arg). Genuine redirect targets never look like either after unquoting.

**Repro / regression test:** `tests/peer-sessions.test.tsx` ->
"version specifiers and comparisons inside args are not read as redirect targets"
(fails before the fix, passes after). A genuine redirect beside a version spec
(`pip install "numpy>=3.14.0" > install.log`) is still captured.

Note on the other reported stray name `rce:`: not reproduced from a known command this
session. The `=...` / quote fix covers the version-spec class; if `rce:` recurs, capture
the exact shell command so the specific redirect shape can be added to the test.

## 3. PROPOSAL (behavior change - not applied): git refusal is once PER peer

**Found by** the new interleaving test. In a checkout shared by N live peers, a racing
git command (`git commit`/`push`/...) is refused once per peer: `checkGit` keys `warned`
on `git|<peerId>|<repo>|<verb>`, so with two sharing peers the command is refused for the
first, then again for the second, before it runs. But the refusal text says "Running the
same command again goes through" - which is only true with exactly one sharing peer. With
several, the model is refused repeatedly and may loop retrying.

Same shape applies to edits/claims when multiple peers collide on one path (one refusal
per peer), but that is rarer.

**Options (Zaid's call, since each changes behavior):**
- (a) Refuse once per `(repo, verb)` regardless of peer count, naming all sharing peers in
  the one message. Cleaner retry; slightly less per-peer granularity.
- (b) Keep per-peer keying but soften the message to "this may be refused once per live
  peer sharing the checkout" so the promise is accurate.

**Current behavior is codified** by the test
"interleaving: git refusal is once PER live peer in the shared checkout" so any future
change is a deliberate, visible edit.

## 4. INVESTIGATED, not reproduced: watch notice on an already-idle session (defect 3a)

**Report:** an idle notice fires immediately when a watch is armed on an already-idle
session.

**Finding:** the watch-resolution logic is correct and covered by existing tests
(`wait_for` keeps the watch while the holder stays fresh, fires only when the holder is
released or ends, and delivers mid-turn vs idle correctly). I could not reproduce an
immediate spurious fire in the unit harness (the clock is controlled there).

**Most likely live cause:** the WATCHED session's heartbeat lapsing. If the engine
throttles a fully-idle session's `$.clock.every` heartbeat, that session's registry
record ages past `LIVE_MS` (~195s) and a watcher then *correctly but prematurely* reports
it "ended"/"released", even though the session is alive-but-idle. This is the same
idle-session liveness limitation the README already notes for message delivery.

**Not fixed** because it is not a guard-logic bug and the remedies are tradeoffs (a
proposal, not a clear fix): e.g. lengthen `LIVE_MS`, or have the watcher require two
consecutive "gone" observations before declaring a session ended. To pin it down, capture
a live repro: which session armed the watch, on what target, what fired, and whether the
watched session's `~/.claude/peer-sessions/<id>.json` mtime had gone stale.

## Scope / safety

- Changed only `hooks/registry.ts` (`isRealTarget`) and `tests/peer-sessions.test.tsx`.
- No change to `.claude-plugin/` (marketplace/publishing untouched - 406023d1 owns that).
- Committed to a branch; not pushed to main; nothing published.

---

# Deeper pass - 2026-11-18 (same branch)

Coordinator correction accepted: the immediate idle-notice (first-pass item 4) is the
harness's SendMessage notify_when_idle, not this plugin - dropped. "rce" / "rce:" and the
stray erdos/oeis names never existed as files; same false-positive class as the version
spec bug. Tests: 60 pass, 0 fail.

## 5. Redirect-regex shapes - checked, one documented limitation

Test added: "operators and fd-dups inside commands are not read as redirect targets".
Safe already (return []): `2>&1`, `>&2` (digit/`&` before `>` excluded), `2>$null` (target
`$null` rejected), `=>` (`=` before `>` excluded), `->` inside `python -c "..."` (captured
target carries the closing quote, rejected by the first-pass quote guard).

PROPOSAL (not fixed): a `>` comparison inside a quoted awk/jq program with a bare numeric
or identifier operand (`awk '$1 > 5.5'` -> `5.5`; `jq '.a > .b'` -> `.b`) is read as a
target. Same root as the version-spec bug: the regex cannot separate a `>` inside quotes
from a redirect. Fix option: a quote-aware scan that skips `>` seen inside single/double
quotes, then captures the next token (quoted or bare) as the target. That rewrites redirect
parsing and carries new edge cases, so it is a proposal. Current behavior is pinned by the
test. Harm if left: one phantom target = at most one spurious edit-conflict refusal; writes
never block (the function fails open).

## 6. Windows path identity (item 2)

Test added: "Windows path identity: case and slash direction unify; junctions and 8.3 names
do not". Case, slash direction, and `.`/`..` normalize to one key, so claims and edit
conflicts match across those spellings.

PROPOSAL (not fixed): normPath is a pure string function with no filesystem access, so a
junction (this machine has Atlas\Projects -> projects) and an 8.3 short name (PROGRA~1) are
not resolved to their real path. The same file reached through the junction is a different
key, so a claim or edit on one side does not guard the other. Fix option: resolve the real
path once per unique input (async realpath, cached) in the hook layer, leaving normPath
pure. Behavior change -> proposal.

## 7. Lifecycle (item 3) and three-session interleaving (item 4) - already covered

- Stale registry entry: "a peer that stopped heartbeating no longer blocks anything"
  (drops after LIVE_MS). Covered.
- Stale claim: a claim lives on the owner's record; when the owner stops heartbeating its
  record leaves livePeers, so claimConflict stops enforcing it. Covered.
- Two sessions registering at the same instant: each writes only its own id-named file, so
  there is no shared-write race by construction (README "How it works"). No test needed.
- Claim released while a wait_for watch is pending: "wait_for returns once a peer gives the
  branch back" and "...hands a long wait to a watch that wakes the idle session". Covered.
- Three-session interleaving: "interleaving: git refusal is once PER live peer in the shared
  checkout" runs own + two peers across claim + edit + git-commit orderings; it surfaced the
  per-peer git-refusal proposal. Covered.

## Status

Branch bugfix/shellwrite-falsepos, local, not pushed. 60 tests pass, craft-guard clean. One
fix applied (version-spec false positive). Further items documented as proposals or
already-covered. No behavior-changing rewrite done without Zaid's sign-off.
