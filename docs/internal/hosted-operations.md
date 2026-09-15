# Internal hosted operations

This records the existing Skriptr Vercel deployment. It is not a supported
self-hosting guide or the forthcoming public team app. Changes here require
access to the existing team infrastructure.

For local use, start with [the README](../../README.md).

## The public view

The same picture, at one URL, of every machine at once: **https://superset-agent-fleet.vercel.app**.
It is behind a token; `/api/login` is where you give it, and it stays in a cookie for a year.

No Vercel function can read a terminal, so the cloud reads nothing. Each machine runs the
server it runs anyway, scoped to itself, and **reports** every poll to `/api/push` with a key
that is that machine's alone (`lib/report.js`). The cloud keeps the latest snapshot per machine
and its recent events in the fleet's own Supabase project (`cloud/store.js`, `cloud/schema.sql`) and streams them to the page (`api/stream.js`)
in the same shape a machine's own stream has, one snapshot per machine, so the page merges them
with the code it already had. A poll whose world did not change is a heartbeat and stores
nothing, so an idle fleet costs the store nothing.

Pins made on the public page travel back to the machine that draws that session on its next
report; pins made on a machine's own page travel up. The cloud's set is the one that counts.

Secrets live in Doppler, project `agent-fleet`: `prd` holds what the cloud needs — the map of
machine name to push key, and the view token — and `prd_<machine>` holds each machine's own key
plus the address to report to. Install on a machine with its config and nothing else to set:

```bash
./service/install.sh --doppler prd_macbook          # macOS, as a login service
./service/install-linux.sh prd_dev_vm               # Linux, as a systemd user service
```

On a Linux host nobody logs in to, put a Doppler service token for that config in
`~/.config/superset-agent-fleet/doppler.env` as `DOPPLER_TOKEN=…` (mode 600) before installing.

**Joining, as a teammate.** The whole setup — key, Mac, VMs, checks — is one document written
to be handed to an agent: [team onboarding](join-the-fleet.md). Tell yours:

> Read `docs/join-the-fleet.md` in the superset-agent-fleet repo and set me up on this machine.

What follows is the same thing in short.

**Adding a developer.** One key per developer, for all of their machines, and their name over
their door. Anyone with access to the Doppler project can do it:

```bash
bin/fleet-add-developer jonas "Jonas"
```

That makes the config `prd_jonas` with the key and the name, and adds the key to the cloud's
map. The cloud reads the map from Vercel; Doppler's Vercel integration (set up once, in the
Doppler dashboard, syncing `prd` to the project's production environment with redeploy on)
carries it there. Without the sync, someone with Vercel access runs the command in the script's
header.

Then, on each of that developer's machines — Mac or VM — with the Superset host running and
`bun`, `superset` and `doppler` on PATH:

```bash
git clone git@github.com:skriptr-ai/superset-agent-fleet.git ~/Projects/superset-agent-fleet
cd ~/Projects/superset-agent-fleet
./service/install.sh --doppler prd_jonas          # macOS
./service/install-linux.sh prd_jonas              # Linux
```

The machine needs a way to read its config: `doppler login` on a Mac, or on a VM nobody logs
in to, a service token for just that config (`doppler configs tokens create <name> -p agent-fleet -c prd_jonas --plain`)
in `~/.config/superset-agent-fleet/doppler.env` as `DOPPLER_TOKEN=…`, mode 600, before
installing. Each machine's restaurant appears in that developer's room on its first report;
the label is bound to the machine's host name then, and no other developer's key can report
as it afterwards.

The view token is the same for everyone:
`doppler secrets get AGENT_FLEET_VIEW_TOKEN --plain -p agent-fleet -c prd`. Give it once,
over something private. Revoking a developer is removing their entry from the map.

The cloud's own variables, in Vercel: `AGENT_FLEET_PUSH_KEYS`, `AGENT_FLEET_VIEW_TOKEN`,
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Apply `cloud/schema.sql` once to the Supabase
project (`supabase db push`, or paste it into the SQL editor). Deploy with `vercel deploy --prod`.
`/api/health` says whether the cloud has its store.
