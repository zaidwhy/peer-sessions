# 30-second demo

The hold-back only means something with two real sessions in one checkout, so the
demo is two terminal panes side by side, both opened in this folder. `invoice.py`
is the file they both reach for.

## Setup (once)

```
claude plugin install peer-sessions --marketplace zaidwhy/peer-sessions
```

Open two terminals, both `cd`'d into this `demo/` folder, and start `claude` in each.
Put them side by side; start the screen recorder.

## The script (about 30 seconds)

**Left pane, type:**

> You are refactoring invoice.py. Add a discount parameter to invoice_total, then claim the file so no one else touches it.

Left edits `invoice.py` and calls the `claim` tool. The status line and the band now
show one peer; let the recorder catch the band line.

**Right pane, type:**

> Change the tax rate in invoice.py to 0.20.

Right's first `Edit` is held back, once, before it writes:

```
[peer-sessions] invoice.py is inside demo/invoice.py, which live session 3f9a1c2e
claimed (invoice rewrite). It is doing: refactoring invoice.py. That session has
been told. Ask it (mcp__peer-sessions__message) or the user before changing what
it owns. Running the same change again goes through.
```

A toast says the same, and the left pane gets the automatic handoff in its next
message. End the recording there.

## The one line it proves

Without the plugin, both panes write `invoice.py` and the second silently wins.
With it, the second session is stopped once, told who holds the file and why, and
handed a way to coordinate before anything is lost.

## Trimming to a GIF

Any terminal recorder works ([asciinema](https://asciinema.org) to `agg`, or a
screen capture to `ffmpeg`). Keep the two panes in frame; the moment worth keeping
is the held-back message appearing in the right pane while the left pane's claim
sits in the band.
