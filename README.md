# Superset Agent Fleet

A Habbo-style pixel-art city block that shows your [Superset](https://superset.sh) agent fleet
at work.

**A restaurant is one orchestration and nothing else.** The orchestrator is the chef; the
sessions it is actually driving are the diners at the tables; its idle workers queue at the
door; and every message between them is carried by a waiter — a dish out to a table when the
chef sends one, a note back to the pass when a diner finishes a turn.

**There are two of them.** _The Orchestra_ belongs to the elected orchestrator. _The
Architects_, next door, belongs to a second session seen driving peers of its own — so a run
with two orchestrators in it is two restaurants, not one crowded room. When nobody is running a
second orchestration, The Architects is shut for the night.

**Every other session is outside on the street**, eating from the food carts on the pavement,
because nobody is supervising them. There is one cart per Superset project, so you can see at a
glance which projects have sessions running loose. When an orchestrator messages one of them
for the first time, that session puts its food down, crosses the road at that restaurant's
crossing and comes in through its door — the whole promotion, on foot.

**Both dining rooms are open to the street** — no roof, no front wall, the whole room in view,
and nothing else standing on the block. In this projection anything to the RIGHT of a room is in
front of it and rises over the floor, so a building there would hide half a dining room, and
none of them earned that. The two rooms sit five tiles apart, which is as close as the
right-hand one's wall can stand without climbing into its neighbour's floor.

It reads the fleet through the `superset` CLI and nothing else, so it can only ever show a state
an orchestrator could itself have observed.

## Requirements

- **macOS.** The always-on setup uses launchd. The server itself runs anywhere Bun does.
- **The Superset host running on this machine**, with you logged in (`superset status`). The
  view is of _this_ machine's workspaces.
- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`.
- **The `superset` CLI on `PATH`.** Superset installs it at `~/.superset/bin/superset`; check
  with `superset --version`.

No packages to install: the server has zero dependencies and there is no build step.

## Set up (once)

```bash
git clone git@github.com:skriptr-ai/superset-agent-fleet.git ~/Projects/superset-agent-fleet
cd ~/Projects/superset-agent-fleet
./service/install.sh
```

The installer registers the server as a **login service**: it starts when you log in to the
Mac, is restarted if it ever exits, and is simply always at **http://localhost:4400**. From then
on nobody starts it — you, or an orchestrator, just open the URL. Point a Superset browser pane
at it and leave it open while an orchestrator runs.

Verify:

```bash
curl -s localhost:4400/api/health     # {"ok":true,"tick":…,"agents":12,"watchers":1}
open http://localhost:4400
```

`agents` is how many agent sessions it can see; `watchers` how many pages are open.

To run it just once instead — no service — use `./start.sh`: it starts the server in the
background, prints the URL, and exits 0 if one is already up.

## Set up an orchestrator host

Only needed on a machine where **orchestrators run**, which may not be the machine showing the
view — a VM running workers, a colleague's Mac. Two pieces, and they are independent of the
server: install them and that host's orchestrators become visible in whoever's view is watching
that fleet. Skip it and nothing breaks; that host's traffic is just read off screens instead,
which is [best-effort and sometimes blind](#making-an-orchestrator-visible).

**If the repo is checked out there**, `./service/install.sh` has already done the first half —
it symlinks `bin/superset-send` into `~/.local/bin` and, when Superset's own directory exists,
into `~/.claude/skills/superset/bin` as well. The second is on PATH inside every workspace but
is Superset-managed, so an update may clear it; `~/.local/bin` is the one that persists. Add the
skill by hand:

```bash
ln -s "$PWD/plugins/agent-fleet/skills/orchestrate-fleet" ~/.agents/skills/orchestrate-fleet
```

**If it is not checked out there**, take just the two files:

```bash
mkdir -p ~/.local/bin ~/.agents/skills/orchestrate-fleet
base=https://raw.githubusercontent.com/skriptr-ai/superset-agent-fleet/agent-fleet@0.1.1
curl -fsSL $base/bin/superset-send -o ~/.local/bin/superset-send
chmod +x ~/.local/bin/superset-send
curl -fsSL $base/plugins/agent-fleet/skills/orchestrate-fleet/SKILL.md \
  -o ~/.agents/skills/orchestrate-fleet/SKILL.md
```

Check it took: `command -v superset-send`. If that comes back empty, `~/.local/bin` is not on
that host's `PATH`.

> **Why not `superset plugins install`?** That is what the plugin in `plugins/agent-fleet/` is
> for, and it is the right answer once it works. Today `superset plugins install` records the
> install but materialises no skills — `skills: 0`, `account sync failed`, and a
> `Bundled plugin missing at /$bunfs/templates/plugin` warning. A plugin scaffolded by
> Superset's own `plugins create --skills` behaves identically, so it is the CLI rather than
> this plugin. Reported to Superset; until it is fixed, the symlink and the `curl` above are the
> way. The wrapper half is unaffected either way.

The skill only ever suggests; an orchestrator that ignores it falls back to being read off its
screen. That is the floor, not the failure.

## What you are looking at

| On the block                                        | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The sign over a restaurant                          | Whose kitchen it is, how many sessions are in there and how many are working                                                                                                                                                                                                                                                                                                                                                                                   |
| The chef behind the counter                         | That house's orchestrator. Stirring the pot with steam rising = mid-turn; holding a dish out over the pass = a message just went out. Hover for its name                                                                                                                                                                                                                                                                                                       |
| The three waiters at the card table beside the chef | The delivery crew, playing poker until there is an order. One collects a dish from the chef, carries it out through the gate to the table, and comes back to the game; a report goes the other way — out to the table for the note, back to the chef with it. Orders queue while all three are out                                                                                                                                                             |
| A diner at a table                                  | One of the orchestrator's workers, mid-turn (food on the plate, fork going) or waiting on **you** (arm up, service bell, bouncing `!`)                                                                                                                                                                                                                                                                                                                         |
| The line at the door                                | The orchestrator's idle workers. The newest arrival stands at the front, by the maître d's podium; when one starts working it walks through the gap in the rope to its table, and when it stops it walks back to the head of the line                                                                                                                                                                                                                          |
| Who is inside at all                                | Only that house's orchestrator and the sessions it has been observed driving. **One chef per restaurant and one restaurant per chef** — the block is built from the orchestrators the server elected, so one orchestrator is one restaurant rather than one and an empty room beside it. A session two chefs have both driven belongs to the longer-standing one. A table is assigned once and kept for the whole run, most recently served nearest the middle |
| A food cart on the pavement                         | One Superset project. Its name is on the awning and its emblem on the panel; sessions with no project share the cart marked `Sessions`. A cart with the shutters down is scenery, parked to fill the kerb                                                                                                                                                                                                                                                      |
| Someone at a cart's hatch                           | A session running on its own, mid-turn — turned round with the food in its hand                                                                                                                                                                                                                                                                                                                                                                                |
| Someone in the queue behind a cart                  | A session running on its own, idle. Facing the van, waiting its turn                                                                                                                                                                                                                                                                                                                                                                                           |
| Somebody crossing the road                          | An orchestrator has just messaged a session for the first time, and it is walking in to take a table at that house. It only ever happens in that direction                                                                                                                                                                                                                                                                                                     |
| The traffic and the pigeons                         | Scenery. Nothing on the road is an agent, and none of it is derived from the fleet                                                                                                                                                                                                                                                                                                                                                                             |
| Label over a head                                   | Issue key and name (`PT-559 concurrent channel switch`), the harness (Claude's spark, Codex's ring), status, and `✉ n` messages exchanged. Zoomed out, people in the line show a name only on hover                                                                                                                                                                                                                                                            |
| The pills in the top bar                            | Filter to one Superset project, or to the ad-hoc sessions that have none. The block is rebuilt around the filtered party; the choice is remembered                                                                                                                                                                                                                                                                                                             |
| Speech bubbles                                      | A message, where it landed, headed by who sent it to whom (`PT-534 ← chef`). Several arriving together stack. The strip at the bottom of the room shows the same text in full                                                                                                                                                                                                                                                                                  |
| A worker's opening brief                            | The prompt an orchestrator started it with, drawn as the first message of its thread rather than as a `joined the fleet` notice. It is usually the longest and most consequential thing said in a run, and it counts toward `✉ n` like any other message                                                                                                                                                                                                       |

Which door somebody is inside says which orchestrator is driving them; whether they are at a
table or in the line — at the hatch or in the queue — says whether they are mid-turn. Those two are the whole status story; the one thing that gets an extra signal is
waiting on **you**. Everyone's outfit — shirt, trousers, hair, skin —
is derived from the workspace id, so a session looks the same every time it walks in. Plain
shells are not shown. Everyone who moves walks the tile grid one tile at a time along a real
path around the furniture, the way Habbo figures do.

**Hover** a diner for its status, message counts and the last thing it said. **Click** to zoom
onto it and open the drawer on its thread: the chef's messages on the left, the worker's
replies on the right, check-ins folded into one line, and the live terminal collapsed
underneath. Click the chef for everything it has sent. The drawer is closed by default and
slides over the room; the handle at the top left opens it on the agent list and doubles as the
status line — how many agents, how many working, whether anyone is waiting on you.

Zoom is continuous: scroll or pinch about the cursor, double-click to zoom in on a spot,
`+` / `-` on the keyboard. Keys: `Esc` closes the thread, then the drawer · `S` toggles the
drawer · `F` fits the whole block · `1`…`9` frame the n-th restaurant along the street, and any
digit past the last one frames the street · `R` hides check-ins.

## How it knows

Who exists comes from the `superset` CLI — `workspaces list`, `terminals list`, `terminals
read` — polled every 2.5 s while a page is open. Traffic is harder: the CLI has no message
history, only terminal buffers, so who said what to whom has to be **reconstructed**.

The rule the whole thing is built on:

> **Prefer what an agent recorded. Scrape a screen only when nothing recorded it.**

That is the axis that matters, and it is not the same as CLI versus MCP. An agent that writes
down the call as it makes it gives an exact sender, an exact recipient, the complete text and a
real timestamp, whichever tool it used. A screen gives whatever survived the last repaint. So
the sources below are ranked by that, best first, and the best one that knows about a message
is the one the world is drawn from:

**Recorded — exact.**

1. **A Claude session's own transcript**, where its `mcp__superset__*` calls are kept with
   their arguments intact. An orchestrator driving the fleet through the **Superset MCP
   server** never types a `superset` command at all — Claude Code renders the whole exchange as
   `Calling superset…` and then `Called superset 2 times` — so the screen sources below see
   literally nothing from it. This is the normal case for a Claude orchestrator today, and the
   fullest evidence there is: real ids, whole messages, real times, no repaint race.
2. **The fleet log**, when an orchestrator sends through `bin/superset-send` — a drop-in for
   `superset terminals send` that appends one line per message before handing your arguments to
   the real CLI. The same guarantees, one layer down, and the one that covers a shell loop or a
   Codex orchestrator. See [Making an orchestrator visible](#making-an-orchestrator-visible).

**Scraped — best-effort.** An event from these is a claim that the screens changed in a way
consistent with a message, never a claim that the CLI reported one.

3. **An orchestrator's own screen**, which logs every `superset` command it typed, including
   `terminals send --text '…'`. Long commands are elided as `… +11 lines`, so a message often
   arrives as its opening sentence with a trailing `…` — that is the screen's limit, not a bug.

   How much history that gives depends on the harness. **Codex** writes into the normal buffer,
   so a read returns a thousand lines of scrollback and a command is only missed once it has
   scrolled out of the terminal's own history — which is why this source still earns its place.
   **Claude Code** draws on the alternate screen, which has no scrollback at all: a read returns
   the ~50 visible lines, and a command is only readable while it is still on screen. That is
   why the poll is fast and why the evidence is cumulative — see the election below.

4. **A worker's queued-messages block**, which Codex prints verbatim while it finishes a tool
   call: the receiving half of the same message, usually with more of the text.
5. **Status flips** (idle→working, working→idle), so the room still moves when a command has
   scrolled off the orchestrator's screen.

Nothing is double-counted, because the sources are disjoint by construction rather than by
arbitration: an MCP call reaches the screen as `Called superset 2 times`, the wrapper's own
command line is `superset-send …`, and the screen parser matches neither.

None of this asks an orchestrator to use a particular tool. It shouldn't: a skill telling
agents to prefer the CLI has already lost to a pre-approved MCP tool that was better suited to
the job, and it deserved to. The agent picks the tool; this keeps up with it.

### Making an orchestrator visible

Orchestrators are **elected**, not configured, there can be several at once, and the evidence
accumulates across polls rather than being re-derived from each screen. A workspace becomes a
chef when either holds:

- It has been seen **commanding two or more distinct peers** (`terminals send`,
  `terminals create`, `agents create`), whether typed at a shell or called as an MCP tool.
  Reads do not count. Looking at a screen is what a curious human, a status sweep or this very
  tool does, and two check-ins should not hand anyone a kitchen.
- **Two or more distinct peers have been seen commanding it**, and nobody is commanding it in
  turn. This is the same fleet seen from the workers' end — their
  `terminals send --workspace <orchestrator>` reports — and it is what recovers an orchestrator
  whose own commands were never caught on screen, which is the normal case for Claude.

Before any traffic has been seen at all, one workspace named `orchestrat*` is used as a
cold-start guess — one, however many match, because it is a guess from a name rather than
evidence, and it is dropped as soon as a single real command is observed. Who commands whom is remembered in `~/.superset/agent-fleet.json`, so the evidence for a
chef survives a restart even after its commands have repainted away.

Every elected orchestrator gets a restaurant of its own, in the order it was elected — the
longest-standing chef keeps The Orchestra as others open next door. The browser keeps one
fallback for a server that elected only one: a second orchestrator found from the same link
tally the rest of the picture is drawn from — any other live session seen driving two or more
peers of its own that the first is not already driving. It counts any link as driving, reads
included, which is the looser rule the server has since dropped, so it is never allowed to open
a third.

### When the screen is not enough

Reading commands off a screen fails in two ways no parser can fix.

The first is the **MCP server**. A Claude orchestrator with Superset's MCP tools connected does
not run a shell command at all; it calls `mcp__superset__terminals_send`, and its terminal
shows only `Calling superset…`. There is no workspace id on the screen, no message, no send.
Nothing is configurable about this and nothing needs to be: the calls are read out of Claude
Code's own session transcript instead, found by the workspace's worktree path and checked
against the `cwd` each record carries. `AGENT_FLEET_TRANSCRIPTS` moves that directory, `''`
switches the source off.

The second is **the shell an orchestrator with several workers writes**:

```bash
while IFS=$'\t' read -r task ws term; do
  superset terminals send --workspace "$ws" --terminal "$term" --text "$(cat briefs/$task.md)"
done < workers.tsv
```

Every one of those sends reaches the screen as `--workspace "$ws"`. The id was resolved in a
shell nothing else can see, so the message has no recipient — not truncated, not scrolled away,
genuinely absent. A real orchestration of seven workers sent all seven briefs this way and
appeared as no orchestrator at all.

`bin/superset-send` closes that second hole from the other end. The shell expands `"$ws"` before the wrapper
runs, so the real id is always what gets recorded:

```bash
superset-send --workspace <workspace-id> --terminal <terminal-id> --text "<message>"
```

Same flags, same exit code, and nothing is written if the send fails. It records the sender
exactly, from `SUPERSET_WORKSPACE_ID`, which is the one thing a screen can never say for
certain. An agent sending from a shell will not reach for it unprompted, so the repo ships a
skill that says to — and that skill now says nothing at all to an agent using the MCP tools,
because there is nothing for it to do. Installing both is
[Set up an orchestrator host](#set-up-an-orchestrator-host) below.

The log lives at `~/.superset/agent-fleet.jsonl` (`AGENT_FLEET_LOG` to move it, `''` to ignore
it). It is only ever read forward: whatever is already in the file when the server starts is
skipped, because the transcripts and the screens already carry that history and replaying it would
double every count.

A waiter is only sent for a table a chef has actually been observed driving, and it collects
from that chef. A status flip in some unrelated workspace just moves that diner between the line
and its table; it never invents a sender.

Orchestrators are **elected**, not configured, there can be any number of them at once, and the
evidence accumulates across polls rather than being re-derived from each screen. A workspace
becomes a chef when either holds:

- It has been seen **commanding two or more distinct peers** (`terminals send`, `terminals
create`). Reads do not count. Looking at a screen is what a curious human, a status sweep or
  this very tool does, and two check-ins should not hand anyone a kitchen.
- **Two or more distinct peers have been seen commanding it**, and nobody is commanding it in
  turn. This is the same fleet seen from the workers' end — their `terminals send --workspace
<orchestrator>` reports — and it is what recovers an orchestrator whose own commands were
  never caught on screen, which is the normal case for Claude. The second half of the test is
  what stops it promoting a worker that its orchestrator and a neighbour both messaged.

Before any traffic has been seen at all, workspaces named `orchestrat*` are used as a cold-start
guess. Who commands whom is remembered in `~/.superset/agent-fleet.json`, so the evidence for a
chef survives a restart even after its commands have repainted away.

On start-up, whatever is already in each scrollback is counted in — seating, counts and threads
are all there on the first tick — but marked `earlier` and never animated. Who-drives-whom is
also remembered in `~/.superset/agent-fleet.json`, so a restart mid-run keeps the seating even
for a worker whose commands have scrolled away. Counts and threads are not saved: they are
rebuilt from the screens, which are the only source of truth.

## The service, in more detail

`service/install.sh` writes a LaunchAgent to
`~/Library/LaunchAgents/ai.skriptr.superset-agent-fleet.plist` with absolute paths to `bun` and
the `superset` CLI (launchd gives jobs no shell and a bare `PATH`), loads it, and waits for the
server to answer. It is safe to re-run; `service/uninstall.sh` stops and removes it.

```bash
launchctl print gui/$(id -u)/ai.skriptr.superset-agent-fleet      # state, pid, last exit
tail -f ~/Library/Logs/superset-agent-fleet.log                       # the server's output
launchctl kickstart -k gui/$(id -u)/ai.skriptr.superset-agent-fleet  # restart it
```

It is cheap to leave on. Each poll spawns one `superset` process per terminal, so with nobody
watching the server idles down to one poll every 20 s and wakes the moment a page connects.

Killing the process by hand does not stop it — `KeepAlive` brings it straight back within a
second. Use `uninstall.sh`.

## Updating

```bash
cd ~/Projects/superset-agent-fleet && git pull
launchctl kickstart -k gui/$(id -u)/ai.skriptr.superset-agent-fleet
```

The restart is only needed for changes to `server.js` or `lib/`; files under `public/` are
served fresh on every request.

## Configuration

All optional, as environment variables (put them in the plist's `EnvironmentVariables` for the
service):

| Variable                   | Default                         | Meaning                                                               |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `AGENT_FLEET_PORT`         | `4400`                          | Port. One fleet per machine, so one server per machine                |
| `AGENT_FLEET_POLL_MS`      | `2500`                          | Poll interval while a page is open                                    |
| `AGENT_FLEET_IDLE_POLL_MS` | `20000`                         | Poll interval with nobody watching                                    |
| `AGENT_FLEET_STATE`        | `~/.superset/agent-fleet.json`  | Where who-drives-whom is remembered; `''` to forget                   |
| `AGENT_FLEET_LOG`          | `~/.superset/agent-fleet.jsonl` | What `bin/superset-send` recorded; `''` to ignore                     |
| `AGENT_FLEET_TRANSCRIPTS`  | `~/.claude/projects`            | Claude Code's sessions, where MCP calls are read from; `''` to ignore |
| `SUPERSET_CLI`             | `superset`                      | The CLI binary, if it is not on `PATH`                                |

## Troubleshooting

- **Nothing on :4400** — `tail ~/Library/Logs/superset-agent-fleet.log`. The usual cause is
  `bun` or `superset` not being where they were when `install.sh` ran; re-run it.
- **`agents: 0`** — the CLI cannot see the host: run `superset status` and `superset ws list`
  in a terminal. Log in with `superset auth login` if asked.
- **An agent is missing** — only workspaces with an agent in a terminal get a seat; a workspace
  holding just a shell is not shown, and archived workspaces are dropped.
- **The room shows someone else's project** — the top-bar pills filter by project; the choice is
  remembered per browser.
- **Nobody is the chef** — no session has been seen commanding two others yet, none has had two
  others report to it, and none is named `orchestrat…`. Send a couple of `superset terminals
send` and the election happens.
- **A second orchestrator has no chef** — it is commanding one worker so far, or its commands
  have not been caught on screen yet. A Claude orchestrator that types at a shell has no
  scrollback, so its evidence is gathered one poll at a time while it works; leave the page open
  and it appears.
- **A Claude orchestrator using the MCP tools is missing** — its calls are read from
  `~/.claude/projects/<its worktree path, dashed>/`. Check that directory exists and that
  `CLAUDE_CONFIG_DIR` is not pointing Claude Code somewhere else; the status line under the
  drawer reports a transcript read error if there is one.

## Layout of the code

```
server.js                     Bun HTTP server: poll loop, SSE stream, static files
bin/superset-send             `terminals send` that also records what it sent
lib/superset.js               the CLI wrapper
lib/fleetlog.js               reads what bin/superset-send recorded
lib/transcripts.js            reads a Claude session's own record of the MCP calls it made
lib/parse.js                  terminal screen -> status, model, last utterance, CLI calls
lib/world.js                  the fleet as state, the per-tick diff that becomes events
public/draw.js                the room, the furniture and the people, as pixel art drawn from code
public/street.js              the restaurants' frontage, the road, the pavement and the carts
public/district.js            the one tile grid it all stands on: tables, kerbs, carts, what is walkable
public/scene.js               who is chef where, who is inside and who is out, orders, pathfinding, the camera
public/app.js                 SSE wiring, the project filter, the drawer with cards and threads
service/                      the launchd agent and its install/uninstall scripts
plugins/agent-fleet/          the skill that tells orchestrators to use the wrapper
```

## Limits worth knowing

Most of these describe the **scraped** sources. An orchestrator whose calls are recorded — a
Claude session using the MCP tools, or anyone sending through `bin/superset-send` — is subject
to none of the first four.

- A terminal buffer is finite. Once a command scrolls out of the terminal's own history the
  screen reader no longer knows about it; counts under-report over a long run, never
  over-report.
- A session scraped into a house goes indoors on the first message its orchestrator was **seen**
  to send it, so a worker whose orders all scrolled away before the page opened stays out on the
  street. It walks in on the next message. A recorded orchestration seats everyone on tick one
  instead, from the backfill.
- A **Claude** terminal has no scrollback to read: it draws on the alternate screen, so a read
  returns only what is visible, and the row holding a command is repainted by the next tool
  call. A shell command is caught while it is on screen and no other way, which makes such an
  orchestrator slower to be recognised than a Codex one and its message counts lower than the
  truth. Nothing here is fixed by polling harder — the history is not there to read. Use
  `bin/superset-send`, or the MCP tools, and none of it applies.
- An orchestrator that builds its commands from variables is invisible to the screen reader
  entirely, whatever its harness. Same answer: `bin/superset-send`, or the MCP tools.
- The transcript source is **Claude only**. Codex files its sessions by date rather than by
  working directory, so finding the one belonging to a workspace would mean opening all of
  them — and its commands are in its scrollback anyway, which the screen reader already
  recovers. It also depends on how Claude Code names its project directories; that guess is
  checked against the `cwd` in each record, so a change to the scheme costs the transcripts
  rather than mis-attributing them.
- Worker replies in a thread come from status flips, so they carry the worker's last narration
  line, not a full reply. The live terminal underneath has the rest.
- Agent chrome is parsed by pattern (`lib/parse.js`). A future Claude Code or Codex release that
  restyles its status line will need those patterns updated — the sample screens each pattern was
  written against are in the comments there.
- Only workspaces on this machine are shown.
