# Field report - 2026-11-18

peer-sessions running under a real multi-session night: several Claude Code sessions
sharing one machine (C:/Users/Asus) for about five hours. Every number below comes from
the plugin's own registry (`~/.claude/peer-sessions/*.json`), read only. Where a number
cannot be measured from what the plugin stores, it says so instead of guessing.

## Method

A read-only script parsed every record in `~/.claude/peer-sessions/`. "Tonight" is the
set of records with activity (session start or a recorded write) in the last six hours.
No record was modified.

## What was measured

| Measure | Value | Source |
|---|---|---|
| Records on disk (7-day trail) | 235 | registry file count |
| Sessions active tonight (6h window) | 8 (6 live, 2 ended) | records with start/write in window |
| Window | first start 23:59, last activity 05:27 (~5.5 h) | min/max timestamps in those records |
| File-write entries recorded | 545 | sum of `touched` entries (capped 200/session, so a lower bound) |
| Phantom edits (the shellWriteTargets bug) | 37 | `touched` keys starting with `=` or containing a quote |
| Claims currently held | 7 | `claims` on live records |

## The phantom-edit bug, measured in the wild

The 37 phantom entries are exactly the false-positive class fixed on
`bugfix/shellwrite-falsepos`: a `>` inside a quoted argument read as a shell redirect.
Real examples pulled from tonight's records (verbatim keys):

- `c:/users/asus/projects/replication-study/=1.11"`, `=2.18"`, `=3.8"` (pip/uv version specs)
- `c:/users/asus/projects/ai-house/plan:"`, `scene:"` (colon-suffixed tokens, the "rce:" class)
- `c:/users/asus/projects/earthsong/"`, `benchmark-autopsy/14}"`

Each of these was recorded as a file the session "wrote", so it showed up in recent-edits
and could have driven a spurious edit-conflict refusal. The fix removes this class;
`isRealTarget` now rejects `=`-prefixed and quote-bearing targets, with a regression test.

## What could NOT be measured (stated, not estimated)

- **Total refusals and messages over the night.** The message outbox has a 30-minute TTL
  and a 20-message cap per session, so only the last ~30 minutes is still on disk. At read
  time that was 6 messages total (1 automatic handoff / refusal of kind edit-conflict, 5
  human or tool messages). The count of refusals issued across the full five hours is not
  recoverable from the registry.
- **Total claims made.** A session clears its claims when it ends, so only the 7 claims
  held by still-live sessions are countable; claims made and released earlier are gone.
- **Exact per-session write counts above 200.** `touched` is capped at 200 entries per
  session, so 545 is a lower bound if any session wrote more than 200 files.

## Takeaway

The plugin carried a real eight-session, ~5.5-hour night on one machine. The one concrete
defect it surfaced - phantom edits from quoted `>` - happened 37 times and is now fixed
with a test. Refusal and message volume over the whole night is not measurable because
those records are short-lived by design; only point-in-time state survives.
