# How Agent Fleet works

The local server reads Superset sessions, builds a model of the fleet, and streams
changes to a browser. The browser draws that model as a restaurant. The foreground
server and frontend have no runtime package dependencies or build step.

## Read path

1. `server.js` starts the poll loop and serves static files and local API routes.
2. `lib/superset.js` asks for workspaces, terminals, terminal screens, and metadata.
3. `lib/transport.js` tries Superset's authenticated local host API where available,
   and otherwise runs the `superset` CLI.
4. `lib/world.js` combines observations with saved relationships and emits a snapshot
   and activity events.
5. `public/app.js` receives server-sent events and updates the scene and drawer.

The default `host` scope shows this machine's sessions. `fleet` is an explicit
option for hosts already visible to the user's Superset account. Remote terminal
reads use the CLI and can be slower or unavailable when a host is offline.

The local `/trpc/` API is private Superset implementation detail. The adapter probes
it, falls back to CLI calls when ordinary reads fail, and avoids selecting an
arbitrary organization when multiple manifests exist. `SUPERSET_TRANSPORT=cli`
forces the CLI. Optional lifecycle hook bindings have no CLI equivalent, so that
information is absent on fallback. A Superset update can also change CLI output;
the fallback is not a guarantee of compatibility with every release.

A fresh account does not need seeded projects, company credentials, or a deployment.
An account with no agent sessions produces an empty restaurant. Agent Fleet reads
what the selected Superset account can access; it does not register an account or
provision workspaces.

## Activity sources and limits

Terminal screens provide status and visible commands. Claude Code transcripts add
recorded tool calls, including MCP calls that never appear as full commands in a
terminal. The optional `bin/superset-send` helper records successful sends with
expanded recipient IDs and message text in a local JSONL log.

A session can become an orchestrator from observed coordination, shared-folder
relationships with supporting traffic, or a manual pin. Reads alone are not
sufficient evidence. The app remembers relationships and pins across restarts;
it reconstructs conversation history from the available sources.

This is an observation tool, not an authoritative audit log. Terminal buffers are
finite. Commands can repaint before a poll catches them, shell variables can hide
recipients, and unavailable transcripts leave gaps. Lifecycle signals can also
lag or miss interrupts. Counts and threads should be read with those limits in
mind. A manual pin is useful when you know who coordinates a session but its
commands are no longer visible.

The `superset-send` helper really sends a message through Superset. It is optional
and is not called by the viewer's ordinary read loop. See its source before adding
it to an orchestration workflow.

## Code map

| Location                                               | Responsibility                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `server.js`                                            | Local HTTP server, polling, API routes, event stream                 |
| `lib/superset.js`, `lib/transport.js`                  | Superset queries, CLI execution, direct host API adapter             |
| `lib/world.js`                                         | Fleet state, relationships, pins, snapshots and events               |
| `lib/parse.js`, `lib/activity.js`                      | Terminal parsing and activity summaries                              |
| `lib/transcripts.js`, `lib/fleetlog.js`                | Local transcript and send-log readers                                |
| `lib/weather.js`                                       | Optional forecast requests and cache                                 |
| `public/app.js`                                        | Event stream, filters, agent list and conversations                  |
| `public/scene.js`, `public/district.js`                | Seating, paths, movement and camera                                  |
| `public/draw.js`, `public/city.js`, `public/street.js` | Pixel art, buildings and street                                      |
| `public/daylight.js`, `public/weather.js`              | Daylight and weather rendering                                       |
| `test/`                                                | Bun tests and synthetic fixtures                                     |
| `bin/superset-send`, `plugins/agent-fleet/`            | Optional orchestration helper and skill                              |
| `service/`                                             | Optional local background-service installers                         |
| `api/`, `cloud/`, `lib/report.js`                      | Existing internal hosted view and reporting                          |
| `docs/internal/`                                       | Internal operations, separate from public setup                      |
| `docs/design/`                                         | Design proposals; read their status before assuming they are shipped |

The internal deployment shares the frontend but uses hosted API handlers and
stored machine reports. It is not needed for localhost use, and it is not the
promised public team app. Public onboarding stays in [local setup](local-setup.md).

## Working on the scene

Run `bun run demo` to use fictional activity without reading a real account.
Refresh the page after frontend edits. `bun run dev` restarts the live server when
server files change. For tests and review expectations, see
[CONTRIBUTING.md](../CONTRIBUTING.md).
