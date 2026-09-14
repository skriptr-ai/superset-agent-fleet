# Joining the fleet

This puts your machines — your Mac and any VMs you run agents on — into the team's public
fleet view at **https://superset-agent-fleet.vercel.app**, where you get a restaurant of your
own with your name over the door. It is written to be handed to an agent: tell yours to read
this file and set you up, and it has everything it needs.

Nothing here opens a port or exposes a machine. Each machine reports outward to the cloud, and
only the cloud is public, behind a token.

## What you need before starting

- **Access to the `agent-fleet` project in Doppler**, the team's secrets manager. Ask Preben if
  `doppler secrets --only-names -p agent-fleet -c prd` does not answer.
- **The view token**, from Preben, over something private. It is one token for the whole team.
- On every machine you want in the view: the **Superset host running and logged in**
  (`superset status` says `running: true`), and `bun`, `superset` and `doppler` on PATH.

## Step 1 — a key of your own (once, from any machine)

One key serves all of your machines. Pick a short lowercase slug for yourself and the name you
want over your door, and run, from a checkout of this repository:

```bash
git clone git@github.com:skriptr-ai/superset-agent-fleet.git ~/Projects/superset-agent-fleet
cd ~/Projects/superset-agent-fleet
bin/fleet-add-developer <slug> "<Name>"        # e.g.  bin/fleet-add-developer jonas "Jonas"
```

This creates the Doppler config `prd_<slug>` holding your key, your name, and the cloud's
address, and registers the key with the cloud's store, which knows it from then on. Nothing
needs redeploying. Re-running it is safe and keeps your key.

If it says a config for your slug already exists, someone did this for you; carry on.

## Step 2 — your Mac

Your `doppler login` is what the service uses, so make sure it works first:

```bash
doppler secrets --only-names -p agent-fleet -c prd_<slug>      # must list AGENT_FLEET_PUSH_KEY
```

Then install the login service. It starts when you log in, restarts if it dies, and serves
your own copy of the view at http://localhost:4400 as well as reporting to the cloud:

```bash
cd ~/Projects/superset-agent-fleet
./service/install.sh --doppler prd_<slug>
```

## Step 3 — each VM

The same repository and the same config, as a systemd user service. A VM nobody logs in to
should not depend on a personal Doppler login, so it gets a **service token** scoped to your
config only. Make it on your Mac and put it on the VM without ever printing it:

```bash
doppler configs tokens create <vm-name> -p agent-fleet -c prd_<slug> --plain \
  | ssh <user>@<vm> 'umask 077; mkdir -p ~/.config/superset-agent-fleet; sed "s/^/DOPPLER_TOKEN=/" > ~/.config/superset-agent-fleet/doppler.env'
```

Then on the VM:

```bash
git clone git@github.com:skriptr-ai/superset-agent-fleet.git ~/Projects/superset-agent-fleet
cd ~/Projects/superset-agent-fleet
./service/install-linux.sh prd_<slug>
```

The installer needs `bun` (it also looks in `~/.bun/bin`), `doppler`, and the `superset` CLI
(it also looks in `~/superset/bin`). The user must be allowed to keep services running when
logged out: `loginctl show-user $USER -p Linger` should say `yes`; if not,
`sudo loginctl enable-linger $USER`.

Repeat for every VM. They all use the same `prd_<slug>`; each gets its own service token.

## Step 4 — check it took

On each machine:

```bash
curl -s localhost:4400/api/health | jq .cloud
```

`error` must be `null` and `lastOkAt` a recent timestamp. A `401` means the cloud does not
know your key: run step 1 again. A `null` `cloud` means the server is not running under
Doppler; re-run the install.

Then open https://superset-agent-fleet.vercel.app/api/login, paste the view token, and look
for your name over a door. Every machine of yours fills that one room; each card says which
machine its session is on.

## Things an agent must not do while setting this up

- **Never print a key or token.** Pipe them, as above. Do not `cat` the env file, do not echo a
  secret, do not paste one into a chat.
- **Never bind the server to a non-loopback address.** Reporting is outbound; nothing needs
  to listen.
- **Do not edit `prd`'s key map by hand.** `bin/fleet-add-developer` is the one way in, so an
  entry is never malformed.
- **Do not create a second key for the same person.** One developer, one key, all machines.

## Updating later

```bash
cd ~/Projects/superset-agent-fleet && git pull
launchctl kickstart -k gui/$(id -u)/ai.skriptr.superset-agent-fleet     # Mac
systemctl --user restart superset-agent-fleet                          # VM
```

## Leaving

Ask someone with access to the cloud's store to remove your row from `fleet_keys`, then
`./service/uninstall.sh` on the Mac and `systemctl --user disable --now superset-agent-fleet`
on each VM.
