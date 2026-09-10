# Superset Agent Fleet

A Habbo-style pixel-art city block that shows your [Superset](https://superset.sh) agent fleet
at work.

**One restaurant, and it is your fleet.** The room has two halves and every session is in one
of them.

**The bar is the orchestration.** It is an L: the long leg runs the length of the left wall with
back-bar shelves behind it, and the short arm turns at the corner and runs along the back wall
until it meets the kitchen — so the lane behind the bar opens straight into the kitchen's back
row and the two halves of the room are one place. The chef could walk out of the kitchen and all
the way down the bar without crossing the floor. It never does, but the room is built as though
it could. An orchestrator is the bartender; the sessions it has been observed driving are the ones on
the stools beside it, turned into the bar, and every message between them goes straight over it —
a drink poured out when the bartender sends one, an empty glass slid back when a worker finishes
a turn. Several orchestrators run at once, so the bar is divided into patches, one per bartender,
laid back to front in the order they were elected. A bar with nobody behind it is still a bar; it
just stands there empty.

**The dining room is yours.** The kitchen is a corner at the back right — small, because the bar
took the rest — and the chef in it is the developer, you. Every session nobody is orchestrating is
a customer at a table, waiting on you rather than on an agent. When you send one of them
something, a waiter collects it at the pass and carries it out to that table; when one finishes a
turn, a waiter brings the note back to the kitchen.

**And a session that is resting is in neither half.** It is in the line at the door, behind the
rope, waiting to be shown in — so the bar and the floor only ever show work actually happening,
and the line is the backlog waiting on somebody to start it. When a turn begins, that session
walks from the line to its own seat: the stool its bartender keeps for it, or its own table.

So where somebody is standing answers the two questions worth asking at a glance: is this
session working at all, and if it is, is an agent driving it or am I?

The room is cut to whichever of its two halves is hungrier. The bar runs down the depth, so a
busy bar makes the room deeper — and the dining room gets narrower to match, the same tables in
more rows of fewer columns, rather than the whole place growing both ways at once.

**The room is open to the street** — no roof, no front wall, the whole floor in view, and nothing
else standing on the block. Outside is scenery — a bus shelter, a newspaper kiosk, a phone box,
trees and cars at the kerb — because a restaurant with nothing in front of it is not a street.

**And the street is in a city.** Two blocks of lit buildings to either side of the restaurant
and two behind it, streets between them, and in front, past the main road, the river. The view
opens framed on the restaurant with the city filling the window round it, and that opening view
is as far out as the camera goes: you can zoom in and look around inside it, but never pull back
past it or pan off its edge. None of it is walkable and none of it is an agent.

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

| In the room                         | What it means                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The sign over the restaurant        | How many sessions are at the bar being orchestrated, how many are at the tables, and whether any of them is waiting on you                                                                                                                                                            |
| The chef in the kitchen             | **You.** Not a session, so it has no name and no status of its own — stirring the pot means there is a message of yours on its way out to the floor, holding a dish out over the pass means a waiter is collecting one right now                                                      |
| A bartender behind the bar          | One orchestrator. Polishing a glass = mid-turn; sliding one down the bar = a message just went out. It stands behind its own patch, and only that patch                                                                                                                               |
| Somebody on a stool                 | A session that bartender is driving, mid-turn. Turned into the bar with a drink in hand; arm up and a bouncing `!` when it is waiting on **you**                                                                                                                                      |
| A glass travelling along the bar    | One message between a bartender and one of its own workers. Amber going out, an empty glass with a note under it coming back                                                                                                                                                          |
| A diner at a table                  | A session nobody is orchestrating — one of yours, mid-turn. Food on the plate and the fork going; service bell and a bouncing `!` when it is waiting on you                                                                                                                           |
| The three waiters at the card table | Your delivery crew, playing poker until there is an order. One collects a dish at the pass, carries it out through the gate to a table, and comes back to the game; a report goes the other way — out for the note, back to the kitchen with it. Orders queue while all three are out |
| The line at the door                | Every session that is resting, whichever half of the room its seat is in, newest at the back. Its seat is held for it, so it walks straight to the same stool or the same table the moment a turn starts                                                                              |
| The empty tables and stools         | The room's real capacity, laid whether or not anybody is in it: ten stools at minimum and six tables, so a quiet fleet reads as a quiet night rather than as a broken picture                                                                                                         |
| Somebody crossing the floor         | A session starting or finishing a turn and walking between the line and its seat, or one changing hands — picked up by an orchestrator and moving from its table to a stool, or dropped and walking back. One grid, walked a tile at a time                                           |
| The street                          | Scenery, all of it. A bus shelter, a newspaper kiosk, a phone box, trees, cars parked at the kerb and two more passing. Nothing outside is an agent and none of it is derived from the fleet                                                                                          |
| Label over a head                   | Issue key and name (`PT-559 concurrent channel switch`), the harness (Claude's spark, Codex's ring), status, and `✉ n` messages exchanged. Zoomed out, people at the bar show a name only on hover                                                                                    |
| The pills in the top bar            | Filter to one Superset project, or to the ad-hoc sessions that have none. The room is rebuilt around the filtered party; the choice is remembered                                                                                                                                     |
| Speech bubbles                      | A message, where it landed, headed by who sent it to whom (`PT-534 ← You`). Several arriving together stack. The strip at the bottom shows the same text in full                                                                                                                      |
| A worker's opening brief            | The prompt an orchestrator started it with, drawn as the first message of its thread rather than as a `joined the fleet` notice. It is usually the longest and most consequential thing said in a run, and it counts toward `✉ n` like any other message                              |

Whether somebody is seated at all says whether they are mid-turn; which half of the room they are
seated in says who is driving them. Those two are the whole status story; the one thing that gets
an extra signal is waiting on **you**. Everyone's outfit — shirt,
trousers, hair, skin — is derived from the workspace id, so a session looks the same every time
it walks in. Plain shells are not shown. Everyone who moves walks the tile grid one tile at a
time along a real path around the furniture, the way Habbo figures do.

**Hover** anyone for their status, message counts and the last thing they said. **Click** to zoom
onto them and open the drawer on their thread: what was sent to them on the left, their replies
on the right, check-ins folded into one line, and the live terminal collapsed underneath. Click a
bartender for everything it has sent. The drawer is closed by default and slides over the room;
the handle at the top left opens it on the agent list and doubles as the status line — how many
agents, how many working, whether anyone is waiting on you.

Zoom is continuous: scroll or pinch about the cursor, double-click to zoom in on a spot,
`+` / `-` on the keyboard. Keys: `Esc` closes the thread, then the drawer · `S` toggles the
drawer · `F` fits the whole block · `1` frames the room, `2` the bar, `3` the tables and `4` the
street · `R` hides check-ins.

## How it knows

Who exists comes from four questions — `hosts list`, then `workspaces list`, `terminals list`
and `terminals read` per host — polled every 2.5 s while a page is open. Traffic is harder:
there is no message history anywhere, only terminal buffers, so who said what to whom has to be
**reconstructed**.

### Two transports, one set of answers

`superset` is not a script. It is a 75 MB compiled Bun binary, so each invocation loads that
image and boots a JavaScript runtime — ~480 ms and ~130 MB resident — to do work that takes one
millisecond. A poll reading twenty-five terminals paid that toll forty-six times.

Underneath, the CLI is a thin client for a tRPC server the host service already runs on
loopback, addressed and tokened in `~/.superset/host/<org>/manifest.json`. Asking it directly:

|                            | time   | processes | memory  |
| -------------------------- | ------ | --------- | ------- |
| `superset workspaces list` | 483 ms | 1         | ~130 MB |
| `workspace.list` over tRPC | 1 ms   | 0         | none    |

So `lib/transport.js` uses the fast path where it reaches and the CLI everywhere else. This is
**not** a second source of truth: it is the same server the CLI asks, answering the same
procedures with the same rows — parity was checked field by field and differs only in `tags`,
which arrives as an array rather than a string and is unused. What it costs is a stable
contract: `/trpc/*` is private and may change in any Superset release, which is exactly why the
CLI path stays and is probed rather than assumed.

The host service knows only its **own** machine — no host, relay or remote procedures exist on
it — so every remote host still goes through the CLI, and that is now essentially the whole
cost of a poll. `superset status` reports the transport in use, as does `/api/health`.

### One instance per host, merged in the browser

A single instance can read the whole fleet (`AGENT_FLEET_SCOPE=fleet`, the default) and pays
for it: everything beyond this machine is a `superset` process and a cloud round trip, and the
agents' own records — the transcripts an MCP-driven orchestrator writes, which are the only
exact evidence of what it sent — are local files it cannot open at all.

So each host can instead run its own instance against itself:

```sh
# on the VM — bind to its tailnet address, never 0.0.0.0
AGENT_FLEET_BIND=100.112.30.44 AGENT_FLEET_TOKEN=$SECRET AGENT_FLEET_SCOPE=host bun server.js

# on the laptop — reads itself, and tells the browser where the others are
AGENT_FLEET_SCOPE=host AGENT_FLEET_PEERS="http://preben-dev-vm:4400?token=$SECRET" bun server.js
```

Nothing merges server-side. A server that read its peers would be describing a machine it
cannot see, which is the thing this arrangement exists to escape; the browser opens one stream
per host and folds them together, because it is the only party that talks to all of them.

Rooms partition cleanly — each instance reports its own host and no other — so the merge is a
union rather than a reconciliation. Event ids are per-server and get namespaced by source
before they meet. A host that goes away has its rooms **dropped**, not left standing: the view
stops claiming to know, names the host it lost, and turns the live dot red.

Every `/api` route reads every terminal screen on its host, so a bind beyond loopback requires
a token and `0.0.0.0` is refused outright — on a machine whose firewall is inactive that would
also serve the fleet on its public IP.

### Every machine, not just this one

Each of those workspace commands defaults to **the machine it runs on**. `workspaces list`
with no `--host` means `--local`, and `terminals list` / `terminals read` answer `Workspace not
found on host <local>` for anything else. Taking those defaults does not show a fleet slightly
short — it shows only the box the server happens to be on, and a workspace running on a VM is
absent rather than empty.

So the sweep starts at `hosts list` and runs once per host that is not explicitly offline,
carrying `--host` through every call that follows. Workspaces are identified by their uuid, so
a fleet is one world however many machines it is spread over, and an agent that is not on this
machine wears its host's name as a badge — two hosts routinely hold a `main` of the same
project, and the name alone stops identifying anything the moment a second machine joins.

A host that is switched off is skipped and is **not** an error: half a fleet asleep is the
normal state of a laptop, and flagging it would leave the live dot red for as long as it stayed
shut. A host that reports itself online and then fails to answer _is_ flagged — that is the one
that silently costs you rooms — and the rest of the fleet is still drawn. Only when no host at
all answers does the world go dark.

One consequence, spelt out under **Limits** below: the transcript source reads files on this
machine, so it is offered only this machine's workspaces.

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

**Whether a session is working at all** is read two ways, and they cover for each other.

- **What the agent's own hooks told the host service.** Every Claude Code and Codex session
  Superset launches has lifecycle hooks wired in — a prompt submitted, a turn finished, a
  permission prompt, a sub-agent started or stopped — and each one is posted to the host
  service, which keeps the last event per terminal. This is the same state that drives the
  working and permission indicators in the desktop app, and it is exact: the agent said so, at
  the moment it happened. It is read straight off the host service, because no `superset`
  command prints it and no MCP tool returns it, which also means it only covers **this
  machine**; a remote host's sessions have only their screens.
- **What the screen shows.** Claude's spinner line, its `done` line, an interrupt, a permission
  prompt; Codex's spinner and its prompt line. Exactly right when one of those is on screen and
  silent when none is — the spinner between frames, a screen just cleared.

What the screen _shows_ beats what the hooks _remember_, and the hooks answer only where the
screen is silent. A spinner on screen is working whatever the hooks say (a wakeup that submitted
no prompt leaves them at `Stop`); a done line or an interrupt on screen is idle whatever the hooks
say (escape fires no hook, so they stay at `Start`). With no marker at all, the hooks decide.
Each room's card says which one answered.

Nothing is double-counted, because the sources are disjoint by construction rather than by
arbitration: an MCP call reaches the screen as `Called superset 2 times`, the wrapper's own
command line is `superset-send …`, and the screen parser matches neither.

None of this asks an orchestrator to use a particular tool. It shouldn't: a skill telling
agents to prefer the CLI has already lost to a pre-approved MCP tool that was better suited to
the job, and it deserved to. The agent picks the tool; this keeps up with it.

### What each session is on

Hovering a figure in the room, and every card in the panel, leads with two lines that are not
the last thing the agent said: **the task** it is on, and **what it is doing about it** right
now — researching, implementing, testing, verifying in the browser, building, running the app,
committing, delegating to sub-agents, driving the fleet, or asking you something. While it
works, the phase is followed by the thing it is on (`testing · bun test lib/parse`) and the
story of the turn so far (`researched → implemented → testing`); once it stops, the last thing
it said takes over, with the turn's story under it as the hint of how it got there.

Both come from the same places the rest of the picture does, best source first:

- **The task.** Claude Code writes its own title for a session into the transcript (an
  `ai-title` record), generated from the actual exchange — so a workspace called `pt-666`
  reads as what PT-666 turned out to be about. Where there is none, the Superset task the
  workspace was opened for is asked for by id (`superset tasks get`, once, and remembered),
  which is the only source for a Codex agent or a session on another machine. Failing both,
  the opening of the prompt the agent is acting on. A title that would only repeat the
  workspace name is left out. The card's hover says which source it was.
- **The phase.** Read off the tool calls of the current turn: the transcript's `tool_use`
  records when this machine has them, which is exact, and the tool rows on the screen when it
  does not, which is the same best-effort guess as everything else read off a screen. A turn
  starts at each prompt. The rules — which tool or shell command means which phase — are in
  `lib/activity.js`, one place, with the cases that motivated them in `test/activity.test.js`.
  One read tucked in behind an edit does not flip "implementing" back to "researching"; a run
  of them does.

## Making an orchestrator visible

Orchestrators are **elected**, not configured, there can be several at once, and the evidence
accumulates across polls rather than being re-derived from each screen. A workspace becomes a
bartender when either holds:

- It has been seen **commanding two or more distinct peers** (`terminals send`,
  `terminals create`, `agents create`), whether typed at a shell or called as an MCP tool.
  Reads do not count. Looking at a screen is what a curious human, a status sweep or this very
  tool does, and two check-ins should not put anyone behind the bar.
- **Two or more distinct peers have been seen commanding it**, and nobody is commanding it in
  turn. This is the same fleet seen from the workers' end — their
  `terminals send --workspace <orchestrator>` reports — and it is what recovers an orchestrator
  whose own commands were never caught on screen, which is the normal case for Claude.

Before any traffic has been seen at all, one workspace named `orchestrat*` is used as a
cold-start guess — one, however many match, because it is a guess from a name rather than
evidence, and it is dropped as soon as a single real command is observed. Who commands whom is remembered in `~/.superset/agent-fleet.json`, so the evidence for a
bartender survives a restart even after its commands have repainted away.

Every elected orchestrator gets a patch of the bar, in the order it was elected — the
longest-standing bartender keeps its end of the run as others start pouring beside it. A session
two of them have both driven takes a stool at the longer-standing one's patch, and only what is
left over fills the patch next to it. The browser keeps one fallback for a server that elected
only one: a second orchestrator found from the same link tally the rest of the picture is drawn
from — any other live session seen driving two or more peers of its own that the first is not
already driving. It counts any link as driving, reads included, which is the looser rule the
server has since dropped, so it is never allowed to open a third.

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

A glass only crosses the bar between a bartender and a session it has actually been observed
driving. A waiter is only sent for a table nobody is orchestrating, and it collects at the pass,
because the only person who can be sending that session anything is you. A status flip in some
unrelated workspace never invents a sender.

Orchestrators are **elected**, not configured, there can be any number of them at once, and the
evidence accumulates across polls rather than being re-derived from each screen. A workspace
becomes a bartender when either holds:

- It has been seen **commanding two or more distinct peers** (`terminals send`, `terminals
create`). Reads do not count. Looking at a screen is what a curious human, a status sweep or
  this very tool does, and two check-ins should not put anyone behind the bar.
- **Two or more distinct peers have been seen commanding it**, and nobody is commanding it in
  turn. This is the same fleet seen from the workers' end — their `terminals send --workspace
<orchestrator>` reports — and it is what recovers an orchestrator whose own commands were
  never caught on screen, which is the normal case for Claude. The second half of the test is
  what stops it promoting a worker that its orchestrator and a neighbour both messaged.

Before any traffic has been seen at all, workspaces named `orchestrat*` are used as a cold-start
guess. Who commands whom is remembered in `~/.superset/agent-fleet.json`, so the evidence for a
bartender survives a restart even after its commands have repainted away.

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

| Variable                           | Default                         | Meaning                                                                 |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `AGENT_FLEET_PORT`                 | `4400`                          | Port. One fleet per machine, so one server per machine                  |
| `AGENT_FLEET_BIND`                 | `127.0.0.1`                     | Interface to serve on. Name an address; `0.0.0.0` is refused            |
| `AGENT_FLEET_TOKEN`                | _unset_                         | Required on `/api` once set. Mandatory to bind beyond loopback          |
| `AGENT_FLEET_SCOPE`                | `fleet`                         | `host` reads only this machine, leaving the rest to their own instances |
| `AGENT_FLEET_PEERS`                | _unset_                         | Other hosts' instances, comma-separated, merged in the browser          |
| `AGENT_FLEET_POLL_MS`              | `2500`                          | Poll interval while a page is open                                      |
| `AGENT_FLEET_IDLE_POLL_MS`         | `20000`                         | Poll interval with nobody watching                                      |
| `AGENT_FLEET_STATE`                | `~/.superset/agent-fleet.json`  | Where who-drives-whom is remembered; `''` to forget                     |
| `AGENT_FLEET_LOG`                  | `~/.superset/agent-fleet.jsonl` | What `bin/superset-send` recorded; `''` to ignore                       |
| `AGENT_FLEET_TRANSCRIPTS`          | `~/.claude/projects`            | Claude Code's sessions, where MCP calls are read from; `''` to ignore   |
| `AGENT_FLEET_READ_CONCURRENCY`     | `32`                            | Workspaces read at once; free now that local reads spawn nothing        |
| `AGENT_FLEET_CLI_INFLIGHT`         | `12`                            | `superset` processes alive at once; each is ~130 MB                     |
| `AGENT_FLEET_REMOTE_IDLE_PER_TICK` | `4`                             | Idle remote workspaces re-read per tick; local ones are always read     |
| `SUPERSET_CLI`                     | `superset`                      | The CLI binary, if it is not on `PATH`                                  |

## Troubleshooting

- **Nothing on :4400** — `tail ~/Library/Logs/superset-agent-fleet.log`. The usual cause is
  `bun` or `superset` not being where they were when `install.sh` ran; re-run it.
- **`agents: 0`** — the CLI cannot see the host: run `superset status` and `superset ws list`
  in a terminal. Log in with `superset auth login` if asked.
- **An agent is missing** — only workspaces with an agent in a terminal get a seat; a workspace
  holding just a shell is not shown, and archived workspaces are dropped.
- **The room shows someone else's project** — the top-bar pills filter by project; the choice is
  remembered per browser.
- **Nobody is behind the bar** — no session has been seen commanding two others yet, none has
  had two others report to it, and none is named `orchestrat…`. Send a couple of `superset
terminals send` and the election happens. Until then the whole fleet is out at the tables, which
  is the truthful picture: nothing is being orchestrated.
- **A second orchestrator has no patch** — it is commanding one worker so far, or its commands
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
lib/transport.js              how a question travels: the host service's tRPC, or the CLI
lib/superset.js               the questions themselves, and the per-host sweep that finds the fleet
lib/fleetlog.js               reads what bin/superset-send recorded
lib/transcripts.js            reads a Claude session's own record of the MCP calls it made
lib/parse.js                  terminal screen -> status, model, last utterance, CLI calls
lib/world.js                  the fleet as state, the per-tick diff that becomes events
public/draw.js                the room, the furniture and the people, as pixel art drawn from code
public/street.js              the restaurant's frontage, the road, the pavement and the vans
public/district.js            the one tile grid it all stands on: the bar, the tables, the kerb, what is walkable
public/scene.js               who is behind the bar, who is seated, who is still in line; orders, pathfinding, the camera
public/app.js                 SSE wiring, the project filter, the drawer with cards and threads
docs/design/                  proposals not yet built; cross-host-visibility.md is the open one
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
- A session is given a stool on the first message its orchestrator was **seen** to send it, so a
  worker whose orders all scrolled away before the page opened is one of yours, at a table. It
  crosses to the bar on the next message. A recorded orchestration seats everyone on tick one
  instead, from the backfill.
- A **Claude** terminal has no scrollback to read: it draws on the alternate screen, so a read
  returns only what is visible, and the row holding a command is repainted by the next tool
  call. A shell command is caught while it is on screen and no other way, which makes such an
  orchestrator slower to be recognised than a Codex one and its message counts lower than the
  truth. Nothing here is fixed by polling harder — the history is not there to read. Use
  `bin/superset-send`, or the MCP tools, and none of it applies.
- An orchestrator that builds its commands from variables is invisible to the screen reader
  entirely, whatever its harness. Same answer: `bin/superset-send`, or the MCP tools.
- **Idle agents on other machines are refreshed in rotation, not every tick.** Local rooms are
  read every tick because reading them is free; a remote one costs a process and a cloud
  round-trip, so idle remote rooms take turns, oldest first, four per tick. An idle remote
  agent that starts working is therefore seen within a cycle — about eleven seconds on a
  seventeen-room fleet — rather than immediately. It is a delay and never a miss, which is the
  deliberate difference from gating on `lastActivityAt` below.
- **Remote hosts are the whole cost of a poll.** Local reads are a loopback `fetch` at ~1 ms;
  a remote one is a `superset` process and a cloud round trip at ~1.2 s, because the host
  service exposes nothing for other machines. On a 21-agent fleet whose remote half is 17 of
  them, the median tick runs 5.8 s against the 2.5 s the interval asks for, so the world
  updates as fast as it can rather than as often as configured. Nothing breaks — the loop times
  from the start of a poll and never piles ticks up — it just moves less smoothly.
  `AGENT_FLEET_CLI_INFLIGHT` trades memory for latency at ~130 MB a process (7.9 s at eight,
  5.8 s at twelve, 5.2 s at sixteen; the curve flattens well before the memory does).
- **A terminal read from another host arrives with no title.** Shells are told from agents by
  their title — `user@host:path` — and that only holds on this machine, so every remote shell
  came back untitled, fell through to `unknown`, and `unknown` is kept as an agent: thirteen
  `pip install` scrollbacks drawn as thirteen rooms full of nobody. A remote shell is now
  recognised by having no title, no agent chrome and nothing but a prompt on its bottom line —
  three signals together, and consulted only after the agent tests have declined, so a
  recognised agent can never be demoted by it. A terminal that is mid-startup, or an agent
  whose chrome has scrolled off, still reads as `unknown` and is still kept.
- **`lastActivityAt` cannot be used to skip a read.** It looks like the obvious way to avoid
  re-reading an idle terminal, and it is wrong: measured against screen hashes over a 15 s
  window it agreed 29 times out of 31 and missed two real changes, including an actively
  working session. Missing a change is the one failure this view must not have, so reads are
  not gated on it.
- **`terminal.transcript` is not a traffic log.** The host service will hand back 16–36 KB of
  an agent's scrollback where a screen read gives 2–4 KB, and for Claude sessions too — which
  contradicts the note below about there being no history to read. But what comes back is the
  _conversation_: `User:` and `Assistant:` turns, with no tool calls in it at all. It is better
  evidence of what an agent is **saying** and no evidence of what it **did**, so it cannot
  replace the sources above for reconstructing who messaged whom.
- The transcript source reads **local files**, so it only ever sees orchestrators running on
  the machine the server is on. A Claude orchestrator driving the fleet from a VM through the
  MCP tools keeps its transcript on that VM, out of reach; it is scraped from its screen like
  any Codex agent, with the accuracy that implies. Remote workspaces are deliberately withheld
  from this source rather than merely failing to open: two machines can hold the same worktree
  path, which would slug to the same directory and file one agent's calls against another's
  room.
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
