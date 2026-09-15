# Local setup

Agent Fleet runs on your machine with your own Superset login. Start with
[the quickstart](../README.md#quickstart). This guide covers the knobs you might
need afterward.

## Requirements and platforms

- Bun 1.3.14 or newer and Git.
- The Superset app and CLI, signed in, with its local host running.
- A browser with JavaScript enabled.

The foreground server uses Bun and has no runtime dependencies. macOS has an
optional launchd installer. A Linux systemd installer is also included. Windows
service installation is not provided, and Windows live integration has not been
verified. The Bash helper scripts require a compatible shell.

Live viewing was checked on macOS with Bun 1.3.14 and Superset CLI 1.28.0 on
September 15, 2026, using the CLI fallback. Other Superset versions can change the
private host API or command output; see the troubleshooting section below.

Check the tools from the same terminal where you will start the server:

```sh
bun --version
superset --version
superset status
bun run doctor
```

If the CLI is installed outside `PATH`, set `SUPERSET_CLI` to its absolute path.
Use Superset's own login flow if its status says you are signed out. Agent Fleet
does not need access to Skriptr's organization.

## Run and stop

```sh
bun start
```

Open http://localhost:4400 and leave the process running. `Ctrl+C` stops it.
For a UI preview with fictional data, run `bun run demo` and use the URL it prints.
The demo defaults to port 4401 and needs no Superset account. Set
`AGENT_FLEET_DEMO_PORT` if that port is already in use.

An empty Superset organization is a valid starting point. Open a workspace and
start a coding agent in Superset. Plain shell terminals and archived workspaces
are not displayed as agents.

## Configuration

All configuration is optional. Pass environment variables before the command,
or copy `.env.example` to `.env` and edit it. Bun loads `.env` from the repository
when starting the server. Keep it local; it is ignored by Git.

```sh
AGENT_FLEET_OWNER="Alex" AGENT_FLEET_WEATHER=off bun start
```

| Variable                   | Default                         | Purpose                                                                                   |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `AGENT_FLEET_PORT`         | `4400`                          | Local HTTP port                                                                           |
| `AGENT_FLEET_OWNER`        | Unset                           | Name over your restaurant                                                                 |
| `AGENT_FLEET_SCOPE`        | `host`                          | Read this machine's workspaces; `fleet` also reads hosts visible to your Superset account |
| `AGENT_FLEET_WEATHER`      | `on`                            | Set `off` to disable the external forecast                                                |
| `AGENT_FLEET_PLACE`        | `Oslo`                          | Town name in the clock                                                                    |
| `AGENT_FLEET_TZ`           | `Europe/Oslo`                   | Clock's IANA time zone                                                                    |
| `AGENT_FLEET_LAT`          | `59.9139`                       | Latitude for daylight and weather                                                         |
| `AGENT_FLEET_LON`          | `10.7522`                       | Longitude for daylight and weather                                                        |
| `AGENT_FLEET_POLL_MS`      | `2500`                          | Requested polling interval while someone watches                                          |
| `AGENT_FLEET_IDLE_POLL_MS` | `20000`                         | Requested polling interval with no open page                                              |
| `SUPERSET_CLI`             | `superset`                      | CLI executable name or absolute path                                                      |
| `SUPERSET_TRANSPORT`       | Automatic                       | Set `cli` to bypass the private local host API                                            |
| `AGENT_FLEET_STATE`        | `~/.superset/agent-fleet.json`  | Saved relationship and pin state; empty disables persistence                              |
| `AGENT_FLEET_LOG`          | `~/.superset/agent-fleet.jsonl` | Optional send log to read; empty disables reading it                                      |
| `AGENT_FLEET_TRANSCRIPTS`  | `~/.claude/projects`            | Claude transcript directory; empty disables this source                                   |

`CLAUDE_CONFIG_DIR` changes the default transcript directory to its `projects`
subdirectory. `SUPERSET_HOME_DIR` selects Superset's configuration directory.
An in-flight poll finishes before the next one starts, so a slow read can make
updates less frequent than the configured interval.

Keep the server on its default `127.0.0.1` address. Public tunnels and team hosting
are outside this setup. The advanced `fleet` scope still serves the page locally;
it uses your existing Superset access to read other hosts and is not team onboarding.
Even in `host` scope, discovery lists account-visible host and workspace metadata to resolve
relationships. Only this machine's terminal screens and local transcripts are read. A slow
remote workspace listing can delay discovery.

## Privacy and local storage

The live server reads Superset workspace and terminal metadata, terminal screens,
relevant Claude Code transcripts, and an optional local send log. Conversation
history reconstructed from these sources appears in the browser. Agent Fleet does
not send prompts to an AI provider or control agents from its normal viewer UI.
Pinning an orchestrator changes the viewer's own saved state.

Relationship and pin state is saved in `AGENT_FLEET_STATE`. The optional
`bin/superset-send` wrapper writes message text to `AGENT_FLEET_LOG`. Setting an
empty log path on the server disables reading that log; it does not disable writes
by a separately running wrapper. The source transcripts remain in Claude Code's
own directory. Disabling a source does not erase files already on disk.

The default configuration does not upload fleet reports. Internal reporting code
exists and activates if both `AGENT_FLEET_PUSH_URL` and `AGENT_FLEET_PUSH_KEY` are
explicitly set. Those reports can include terminal and conversation content.
Leave those variables unset for the local setup.

Superset's CLI may contact Superset services, including for host and task metadata.
The optional weather request sends configured coordinates to `api.met.no`, which
also sees the request's source IP. It does not send terminal content. Set
`AGENT_FLEET_WEATHER=off` to disable it. Coordinates default to Oslo; the app does
not request browser geolocation.

Use `bun run demo` when recording or sharing the app. Review diagnostics before
posting them; local paths and project names can also be sensitive.

## Optional background service

Get `bun start` working first, then stop the foreground process before installing.
Run these commands from the repository root.

The installers use this checkout's `.env` and your existing Superset login. They
do not require Doppler for local use. Installation with a live launchd or systemd
service manager has not yet been verified. Use the foreground server first.

On macOS:

```sh
./service/install.sh
```

The installer creates a login service that restarts automatically. Inspect or
restart the service with:

```sh
launchctl print gui/$(id -u)/ai.skriptr.superset-agent-fleet
launchctl kickstart -k gui/$(id -u)/ai.skriptr.superset-agent-fleet
```

Server output goes to `~/Library/Logs/superset-agent-fleet.log`. To stop and
unregister the service, run `./service/uninstall.sh`.

On Linux:

```sh
./service/install-linux.sh
systemctl --user status superset-agent-fleet
```

See the installer's output for the unit and logs. Keep the checkout at the path
where you installed the service; it runs directly from that directory.
To stop and unregister the Linux service, run `./service/uninstall-linux.sh`.
Uninstalling either service keeps your checkout and saved fleet state.

The optional `bin/superset-send` helper is separate from the service. You can call
it by its path from an orchestration script; installing the viewer does not add
commands to your shell or change your agent skills. See
[activity sources](architecture.md#activity-sources-and-limits) before using it.

### Updating an existing service

Stop an older service before starting the updated server:

```sh
# macOS
launchctl bootout gui/$(id -u)/ai.skriptr.superset-agent-fleet

# Linux
systemctl --user stop superset-agent-fleet
```

Then run the matching installer again from your updated checkout. An older
Agent Fleet process may answer `/api/health` without the service identity field
used by the new startup checks. If the port is occupied, startup asks you to stop
the existing process instead of assuming it is this application. This also
protects unrelated applications using the same port.

## Troubleshooting

### Nothing loads on localhost

Read the server's terminal output and run `bun run doctor`. If port 4400 belongs
to another process, stop that process yourself or try:

```sh
AGENT_FLEET_PORT=4401 bun start
```

Then open http://localhost:4401. A service can keep restarting after its process
is killed, so use the service's stop or uninstall command.

### The room is empty or an agent is missing

Check `superset status` and `superset workspaces list` with the same user account.
A new account may simply have no running agent sessions yet. Clear the project
filter in the top bar. Shell-only and archived workspaces do not get seats.

The default scope is this machine. For a workspace on another host you own,
use `AGENT_FLEET_SCOPE=fleet`. Offline or inaccessible hosts cannot be read.

### The wrong organization appears

Check which organization the Superset CLI is using. Agent Fleet does not ask you
to sign into a second account. When several local organization manifests are
available, automatic transport selection uses the CLI instead of guessing one.
Restart Agent Fleet after changing Superset accounts or organizations.

### Superset works but Agent Fleet does not

Try `SUPERSET_TRANSPORT=cli bun start`. The direct local host API is private and
can change between Superset versions. CLI fallback covers workspace and terminal
reads; optional lifecycle hook details have no equivalent CLI command.
Include both tool versions and a redacted reproduction when reporting a problem.

### An orchestrator sits at a table

The app needs evidence of coordination before it assigns a bartender. A command
that scrolled away, an unresolved shell variable, or an unavailable transcript can
hide that evidence. Click the session and choose **Make this the orchestrator**.
See [activity sources and limits](architecture.md#activity-sources-and-limits)
for what the automatic detection can observe.
