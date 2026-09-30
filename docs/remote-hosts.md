# Remote hosts and virtual machines

Agent Fleet shows the agents your Superset account can see. An agent on a VM, a
second computer or a sandbox appears only when that machine runs a Superset host
that is signed in to the same organization and online. Agent Fleet itself does
not connect to the VM, open ports or install anything there.

Get the local [quickstart](../README.md#quickstart) working on your laptop first.

## Choose where the viewer runs

|                           | A: viewer on your laptop                | B: viewer on the VM                  |
| ------------------------- | --------------------------------------- | ------------------------------------ |
| This repository on the VM | Not needed                              | Needed                               |
| What the page shows       | Your laptop and every online host       | That VM only                         |
| Remote session detail     | Terminal screens only                   | Full: screens, transcripts and hooks |
| Remote read speed         | Each read goes through Superset's cloud | Local reads on the VM                |
| How you open it           | http://localhost:4400                   | An SSH tunnel to the VM              |

Most people want **A**. Choose **B** when the VM runs orchestrators and you want
them detected as reliably as local ones, or when you only care about that VM.

Both paths need step 1.

## 1. Run a Superset host on the VM

These steps are Superset's own; see its [Remote Access](https://docs.superset.sh/remote-access)
and [Host Server](https://docs.superset.sh/cli/host-server) docs for details.

1. Install the CLI. The standalone installer puts it in `~/superset/bin`:

   ```sh
   curl -fsSL https://superset.sh/cli/install.sh | sh
   ```

   The host needs `git` and `gh` on `PATH`, plus the agent CLIs you want to run
   there, such as Claude Code.

2. Sign in to the **same organization** your laptop uses. `superset auth login`
   opens a browser. On a headless VM, create an API key in the desktop app under
   **Settings → API Keys** and use it instead:

   ```sh
   superset auth login --api-key sk_live_…
   ```

3. Start the host service. Pass `--org` if your account belongs to more than one
   organization, or the VM can register under the wrong one:

   ```sh
   superset start --daemon --org <your-org>
   superset status
   ```

4. Keep it running. `--daemon` does not survive a reboot, and a stopped host shows
   as offline. For an always-on VM, run it under systemd as described in Superset's
   [Host Server](https://docs.superset.sh/cli/host-server#run-it-under-systemd)
   docs. Read their note about CLI versions first. A systemd **user** service also
   needs `sudo loginctl enable-linger $USER` so it keeps running after you log out.

A second computer that runs the Superset desktop app does not need the CLI steps.
Turn on **Settings → Remote Access** in the app on that computer instead. Doing so
restarts its host service and interrupts running terminals.

Only the person who started a host can see it at first. If the VM was started
under another account, add yourself in the desktop app under **Settings → Hosts**.

### Check it from your laptop

```sh
superset hosts list
```

The VM must be listed as online. If it is missing, it is signed in to
another organization or account, or it never started. If it is listed as offline,
its host service is not running.

Then start a coding agent in a workspace on the VM, from the Superset app or
CLI. Plain shell terminals and archived workspaces never get a seat, so a VM
with only shells looks empty.

## 2A. Watch every host from your laptop

Set the scope to `fleet` and start as usual:

```sh
AGENT_FLEET_SCOPE=fleet bun start
```

To keep the setting, put `AGENT_FLEET_SCOPE=fleet` in `.env`. The background
service reads `.env` when it starts, so restart it after the change.

`bun run doctor` counts the other hosts your account can see. In the default
`host` scope it warns when other hosts are online, because their agents will not
appear.

What to expect:

- A session on another machine carries a chip with that host's name.
- Remote sessions are read from their terminal screens only. Claude Code
  transcripts and lifecycle hooks exist only on the VM, so remote status is less
  exact. An orchestrator on the VM can end up at a table instead of the bar. Pin
  it from its drawer with **Make this the orchestrator**, or use path B.
- Remote reads go through Superset's cloud and take about a second each. Updates
  from remote sessions arrive more slowly than local ones.
- If a host goes offline, its sessions keep their last observation and are
  marked stale until the host comes back.

## 2B. Run the viewer on the VM

On the VM, with the Superset host from step 1 running as the same user:

```sh
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/skriptr-ai/superset-agent-fleet.git
cd superset-agent-fleet
bun run doctor
bun start
```

If `superset` is not on the `PATH` of that shell, set
`SUPERSET_CLI=~/superset/bin/superset`. To keep the viewer running,
`./service/install-linux.sh` installs a systemd user service; it needs lingering
enabled as in step 1.

The server listens on the VM's `127.0.0.1` only. Reach it from your laptop with
an SSH tunnel:

```sh
ssh -N -L 4402:127.0.0.1:4400 <user>@<vm>
```

Open http://localhost:4402. The local port 4402 keeps it clear of a viewer
already running on your laptop at 4400. Stop the tunnel with `Ctrl+C`.

Do not make the VM's server listen on a public address. The page shows terminal
contents, which can include code and secrets. Agent Fleet refuses to bind to
every interface and requires `AGENT_FLEET_TOKEN` for any non-loopback address;
the SSH tunnel needs neither.

## Troubleshooting

| What you see                                 | Likely cause                                   | What to do                                                                                  |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Empty room, but your agents run on the VM    | The default `host` scope shows only the laptop | Set `AGENT_FLEET_SCOPE=fleet` (path A) and restart                                          |
| The VM is missing from `superset hosts list` | Other organization or account, or not started  | Check `superset auth whoami` on both machines; start with `--org`; add yourself as a member |
| The VM is listed as offline                  | Its host service stopped, often after a reboot | Start it again and run it under systemd                                                     |
| The VM is online but has no seats            | No agent sessions there                        | Start an agent in a VM workspace; shells and archived workspaces are not shown              |
| A notice says a host is unreachable          | A read of that host failed or timed out        | Its sessions stay stale until it answers; check `superset status` on the VM                 |
| A VM orchestrator sits at a table            | Its transcript is on the VM, not the laptop    | Pin it from the drawer, or use path B                                                       |

Run `bun run doctor` on the machine running the viewer, and include its output
when reporting a problem. It counts hosts but does not print their names.

## What has been checked

On September 30, 2026, with Superset CLI 1.30.2: path A showed another host's
agent next to the laptop's, and path B served the page and its API through an
SSH tunnel to a Linux VM. Setting up a new VM from scratch and signing in with
an API key were not repeated for this guide; those steps follow Superset's docs.
