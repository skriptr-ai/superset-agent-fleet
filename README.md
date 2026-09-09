# Superset Agent Fleet

A Habbo-style pixel-art restaurant for the Superset fleet. The orchestrator is the chef in
the kitchen; the agents it drives are the diners at the tables; waiters carry every message
across the floor — a dish out to a table when the chef sends one, a note back to the pass
when a diner finishes a turn.

```bash
git clone git@github.com:skriptr-ai/superset-agent-fleet.git ~/Projects/superset-agent-fleet
cd ~/Projects/superset-agent-fleet
./start.sh          # background, prints the URL, safe to run twice
open http://localhost:4400
```

Needs `bun` and the `superset` CLI on `PATH`. No dependencies to install.

Then point a Superset browser pane at `http://localhost:4400` and leave it open while the
orchestrator runs.

## What you are looking at

| In the restaurant                                   | What it means                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The chef behind the counter                         | The orchestrator. Stirring the pot with steam rising = mid-turn; holding a dish out over the pass = a message just went out                                                                                                                                                                        |
| The three waiters at the card table beside the chef | The delivery crew, playing poker until there is an order. One collects a dish from the chef, carries it out through the gate to the table, and comes back to the game; a report goes the other way — out to the table for the note, back to the chef with it. Orders queue while all three are out |
| A diner at a table                                  | An agent mid-turn (green gem, food on the plate, fork going) or waiting on **you** (amber gem, arm up, service bell, bouncing `!`)                                                                                                                                                                 |
| The line at the door                                | Idle agents. The newest arrival stands at the front, by the maître d's podium; when one starts working it walks through the gap in the rope to its table, and when it stops it walks back to the head of the line                                                                                  |
| Tables nearest the kitchen                          | The orchestrator's workers, most recently served nearest the middle. A table is assigned once and kept for the whole run                                                                                                                                                                           |
| Tables further back                                 | Every other agent session on this host                                                                                                                                                                                                                                                             |
| The mark beside a head, and in the labels and cards | The harness: Claude's spark on orange, Codex's ring on black                                                                                                                                                                                                                                       |
| Label over a head                                   | Workspace name, status dot, and `✉ n` messages exchanged; hover for the full card. Zoomed out, the line at the door shows names only on hover                                                                                                                                                      |
| The pills in the top bar                            | Filter to one Superset project (or the ad-hoc sessions that have none). The room re-seats to the filtered party and refits; the choice is remembered                                                                                                                                               |

Everyone's outfit — shirt, trousers, hair colour and style, skin — is derived from the
workspace id, so a session looks the same every time it walks in. Plain shells are not shown.
Everyone who moves walks the tile grid one tile at a time along a real path around the
furniture, the way Habbo figures do; guests may not enter the kitchen, staff may.

The room is drawn straight onto the retina canvas at the current zoom, so it is crisp at any
scale and never resampled. Zoom is continuous: scroll or pinch about the cursor, double-click
to zoom in on a spot, `+`/`-` on the keyboard; every move eases in, with the point under the
cursor held still.

**Hover** a diner for its status, message counts and the last thing it said. **Click** to zoom
onto it and open the drawer on its thread: the chef's messages on the left, the worker's
replies on the right, check-ins folded into one line, and the live terminal collapsed
underneath. Click the chef for everything it has sent. The drawer is closed by default and
slides over the room; the handle at the top left opens it on the agent list and doubles as the
status line (how many agents, how many working, whether anyone is waiting on you). The only
control in the top bar is the project filter.

Keys: `Esc` closes the thread, then the drawer · `S` toggles the drawer · `F` refits · `R`
hides check-ins · `+` / `-` zoom. Clicking the floor changes nothing.

Whether someone is at a table or in the line is the whole status story — there are no gems
or `zzz` over heads. The one exception is waiting on **you**: arm up, bell, `!`.

## How it knows

Everything comes from the `superset` CLI — `workspaces list`, `terminals list`, `terminals
read` — polled every 2.5s. Reading the fleet the same way the orchestrator drives it means the
view can only ever show a state the orchestrator could itself have observed.

There is no message history in the CLI, only terminal buffers, so traffic is **reconstructed**:

1. **The orchestrator's own scrollback** logs every `superset` command it ran, including
   `terminals send --text '…'`. This is the exact source, and where the message text comes
   from. Long commands are elided on screen as `… +11 lines`, so a message often arrives as its
   opening sentence with a trailing `…` — that is the screen's limit, not a bug. The whole
   buffer is read on every tick, so a command is only missed once it has scrolled out of the
   terminal's own history.
2. **A worker's queued-messages block**, which Codex prints verbatim while it finishes a tool
   call. This is the receiving half of the same message, usually with more of the text.
3. **Status flips** (idle→working, working→idle) as a fallback, so the world still moves when a
   command has scrolled off the orchestrator's screen.

A beam is only drawn for a room the orchestrator has actually been observed driving. A status
flip in some unrelated workspace shows as "started working" with no arrow, rather than
inventing a sender.

The orchestrator is **elected**, not configured: whichever workspace is observed driving the
most distinct peers wins. Before any traffic has been seen, a workspace named `orchestrat*` is
used as a cold-start guess.

On start-up, whatever is already in each scrollback is counted in — rings, beams and threads
are all there on the first tick — but marked `earlier` and never animated. Who-drives-whom is
also remembered in `~/.superset/agent-fleet.json` (override with `AGENT_FLEET_STATE`, set it to
`''` to forget), so a restart mid-run keeps the ring intact even for a worker whose commands
have scrolled away. Counts and threads are not saved: they are rebuilt from the screens, which
are the only source of truth.

## Ports and instances

Fixed on **4400**. There is one fleet per machine, so there is one server per machine; a second
would draw the same world twice. Starting one while another is up prints the running URL and exits 0.

Override with `AGENT_FLEET_PORT`; poll interval with `AGENT_FLEET_POLL_MS`.

## Shape

```
server.js          Bun HTTP server: poll loop, SSE stream, static files
lib/superset.js    the CLI wrapper
lib/parse.js       terminal screen -> status, model, last utterance, CLI calls
lib/world.js       the fleet as state, the per-tick diff that becomes events, the link tally
public/draw.js     the room, the furniture and the people, as 1× pixel art drawn from code
public/scene.js    seating, waiter pathfinding, the chef, the pixel-buffer camera
public/app.js      SSE wiring, the agent cards and the per-worker thread
```

No dependencies and no build step — `bun server.js` from any worktree is the whole thing.

## Limits worth knowing

- A terminal buffer is finite. Once a command scrolls out of the terminal's own history the
  view no longer knows about it; counts under-report over a long run, never over-report.
- Worker replies in a thread come from status flips, so they carry the worker's last narration
  line, not a full reply. The live terminal underneath has the rest.
- Agent chrome is parsed by pattern (`lib/parse.js`). A future Claude Code or Codex release that
  restyles its status line will need those patterns updated — the sample screens each one was
  written against are in the comments there.
- Only workspaces on this host are shown, and archived ones are dropped.
