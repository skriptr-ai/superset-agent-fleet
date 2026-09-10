# Seeing a fleet that is spread over more than one machine

Status: **proposal**. Nothing here is built.

## The problem

The fleet view now finds workspaces on every host (#7). It cannot see what an orchestrator
running on another host is _doing_.

Put an orchestrator on the VM and it appears as a room, because its screen is read like any
other. It does not appear as an orchestrator: no beams to its workers, no speech bubbles, no
place in the kitchen. It sits out on the street looking like a worker while it drives nine of
them.

That is not a rendering bug. The evidence simply is not on this machine.

## Why it cannot be fixed where it hurts

Fleet traffic — "at 14:03, workspace A sent workspace B this text" — exists in exactly three
places, and the ranking in `lib/world.js` is built on them:

| Source                      | What it holds                                   | Where it lives              |
| --------------------------- | ----------------------------------------------- | --------------------------- |
| Claude's `projects/*.jsonl` | every `mcp__superset__*` call, arguments intact | a file on the agent's host  |
| `bin/superset-send` log     | one line per message, as it was sent            | a file on the sender's host |
| The terminal screen         | whatever survived the last repaint              | readable from anywhere      |

The first two are exact and both are **local files**. The third reaches across hosts and is the
one that degrades: a Claude orchestrator driving through MCP types no `superset` command at
all, so its screen says `Called superset 2 times` and nothing else — no workspace id, no
message text, no indication a message happened.

So the exact sources cannot be reached, and the reachable source is blind to precisely the
orchestrator we are trying to see.

### Things that look like a way out and are not

Each of these was checked against the running system, not reasoned about:

- **`terminal.transcript`.** The host service will hand back 16–36 KB of an agent's scrollback
  where a screen read gives 2–4 KB, Claude sessions included. It is not a traffic log: what
  comes back is the _conversation_, `User:` and `Assistant:` turns, with **no tool calls in it
  at all**. Better evidence of what an agent said; no evidence of what it did.
- **Reaching another host's transcript.** There is no `superset terminals transcript` command.
  The procedure exists only on the local host service, and that service has no remote
  procedures of any kind — its whole router is `workspace`, `terminal`, `project`, `browser`.
- **Reading the remote file directly.** `--attachment` uploads a file _to_ a host. Nothing in
  the CLI brings one back.

## What is actually available

Verified this session, against Superset 1.27.0:

- **The local host service is a tRPC server on loopback**, addressed and tokened in
  `~/.superset/host/<org>/manifest.json`. It answers about its own machine in ~1 ms.
- **Remote hosts are reached only through the cloud**, at ~1.2 s and one ~130 MB process per
  call. This is why a poll is ~4 s rather than the 2.5 s the interval asks for.
- **Arbitrary commands can be started on a remote host**: `terminals create --host X
--command …`. Their output comes back only as a screen.
- **`superset pages`** is an organization-scoped, cloud-backed, versioned store —
  `publish` / `pull` / `versions`, with `just_me` or `org` visibility. It is meant for HTML
  documents. There is no `delete`.
- **`superset tasks`** is similar in reach and even less appropriate as a data channel.

The shape of the answer follows from the first two lines. Every host can read itself perfectly
and cheaply. No host can read another well. So the reading should happen **where the records
are**, and only the result should travel.

## Options

### A. Each host runs a reader that ships events to one aggregator

A small process per host reads its own tRPC endpoint and its own local files, and pushes a
stream of already-interpreted events to whichever machine is drawing the world.

Correct, and the most work. It needs a transport (below), a protocol, and something to install
and keep alive on every host.

### B. Each host runs the whole fleet view; the browser merges

No new protocol at all. Every host runs this same server against itself — 1 ms reads, complete
local evidence, orchestrators visible because their transcripts are right there. The page opens
an SSE connection per host and merges the snapshots client-side.

Workspace ids are uuids and already globally unique, so a link from an orchestrator here to a
worker there stitches on identity alone. Each server stays exactly as simple as it is today,
and keeps the property `lib/superset.js` opens with: it only ever shows a state the
orchestrator on _that_ machine could itself have observed.

The catch is that the browser must reach every host, which is the same reachability question as
(A) without the protocol design.

### C. Ship events through `pages`

Each reader publishes its event log as a page version; the aggregator pulls. No open ports, no
NAT problem, no new infrastructure — the cloud is already trusted by both ends.

It is also plainly off-label. A version per poll is absurd for a documents feature, so it would
have to batch on a much slower clock, and there is no `delete` to clean up after it. Worth
holding as the fallback if direct reachability turns out to be the blocker.

### D. Move the aggregator to the VM

The VM is always on, reachable, and already holds most of the fleet. Running the view there
makes the majority case cheap and correct.

It does not solve the problem; it relocates it. The laptop's orchestrators then become the
invisible ones — and the laptop is where orchestrators mostly run.

## Recommendation

**Start with B.** It is the smallest change that fixes both open problems at once, it needs no
protocol, and it degrades honestly: a host you cannot reach is a host whose rooms are missing,
which the view can say plainly.

It also collapses the poll cost that (#7) left behind. Nothing crosses the network per terminal
any more — each server reads its own host at ~1 ms — so the ~4 s poll becomes a local one, and
`AGENT_FLEET_CLI_INFLIGHT`, the remote-idle rotation and the whole apparatus for rationing
subprocesses become unnecessary rather than merely tuned.

Fall back to **C** for any host the browser cannot reach directly, and treat **A** as what B
becomes if merging in the browser turns out to be the wrong place for it.

## What has to be decided

1. **Reachability.** Can a browser on the laptop open an SSE connection to the VM? The VM is on
   Azure and the laptop is behind NAT, so the direction matters: laptop-as-client is the
   workable one, and it still needs a port and a way through the firewall. _This is the
   question the whole recommendation rests on, and it is not a question about this repo._
2. **Authentication.** A fleet view reachable from outside loopback is a terminal-screen reader
   exposed to the network. It needs a token at minimum, and probably should not be reachable
   from anything but a known address.
3. **How a host-side instance gets there.** Checked out and run as a Superset workspace, or
   installed as a login service the way this one is on the laptop.
4. **Who draws the kitchen.** Orchestrator election, the link tally, and the event history are
   currently per-server state. Merging N snapshots in the browser means deciding whether each
   server elects within its own host and the browser unions the result, or the browser elects
   across the merged whole. The second is more correct and moves real logic client-side.
5. **What an unreachable host looks like.** Missing rooms, greyed rooms, or a stated gap. The
   current single-server answer — a partial error that still draws everything it did reach — is
   probably the right precedent.

## What has not been verified

- That an SSE stream from the VM to a browser on the laptop is possible at all. Everything else
  here was tested; this was not, and (1) above is the reason it matters most.
- That two servers' event streams merge without double-counting. The sources are disjoint by
  construction _within_ one host; across hosts, a message sent from the laptop to a VM worker
  is recorded by the laptop's transcript reader and may also be inferred from the worker's
  idle→working flip by the VM's server. `#hubDriving` already refuses to attribute a flip to a
  hub that has not been seen driving that agent, which probably makes this safe — but "probably"
  is doing work in that sentence and it should be tested before it is trusted.
