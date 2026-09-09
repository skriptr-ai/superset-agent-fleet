---
name: orchestrate-fleet
description: Send a message to another Superset workspace in a way the fleet view can see. Use whenever you are about to run `superset terminals send` — briefing a worker, sending a follow-up, a dependency result, review feedback or a handoff — and whenever you are coordinating several agents across workspaces at all. Complements the `orchestrate` skill, which covers the coordination itself; this covers how the sending has to be written.
allowed-tools: Bash(superset:*), Bash(superset-send:*), Bash(curl:*), Bash(chmod:*), Bash(mkdir:*)
---

# Sending so the fleet can see it

Use `superset-send` in place of `superset terminals send`. Same flags, same behaviour, same
exit code:

```bash
superset-send --workspace <workspace-id> --terminal <terminal-id> --text "<message>"
```

That is the whole rule. Everything below is why it matters and what to do when the wrapper is
not installed.

## Why not the plain command

Superset Agent Fleet draws the fleet — who is orchestrating, who is working for whom, what was
said — by reading each orchestrator's terminal screen and recovering the `superset` commands
from it. There is no message history in the CLI to ask instead.

That works only when the command reaches the screen with a literal workspace id in it, and the
natural way to brief several workers does not:

```bash
# Reasonable shell. Invisible to the fleet view.
while IFS=$'\t' read -r task ws term; do
  superset terminals send --workspace "$ws" --terminal "$term" --text "$(cat briefs/$task.md)"
done < workers.tsv
```

Every one of those sends reaches the screen as `--workspace "$ws"`. The id was resolved inside
a shell nobody else can see, so the message has no recipient — not truncated, not scrolled
away, genuinely absent. This is not hypothetical: an orchestration of seven workers sent all
seven briefs this way and showed up as no orchestrator at all.

`superset-send` fixes it from the other end. The shell expands `"$ws"` before the wrapper runs,
so the real id is always recorded, and it files the message before handing your arguments
straight to the real CLI. Loop freely. Write whatever shell you would normally write.

It also records who sent it, exactly, from `SUPERSET_WORKSPACE_ID` — which is something no
screen can ever say for certain.

## Install it if it is missing

Check once at the start of an orchestration, and install it if it is not there:

```bash
command -v superset-send >/dev/null || {
  mkdir -p ~/.local/bin
  curl -fsSL https://raw.githubusercontent.com/skriptr-ai/superset-agent-fleet/agent-fleet@0.1.1/bin/superset-send \
    -o ~/.local/bin/superset-send
  chmod +x ~/.local/bin/superset-send
}
```

If `~/.local/bin` turns out not to be on PATH, `~/.claude/skills/superset/bin` always is inside
a Superset workspace — but it is Superset's own directory and an update may clear it, so treat
it as the fallback rather than the home. On a host where the repository is checked out,
`service/install.sh` puts the wrapper in both and you need none of this.

The URL is pinned to this plugin's own release tag rather than to a branch, so what you install
is the wrapper this skill was written against. A fix to the wrapper ships as a version bump.

## If you genuinely cannot install it

Fall back to the plain CLI, and shape the command so it survives being read off a screen. Each
of these exists because a real orchestration broke on it:

- **One `superset terminals send` per shell invocation.** Not a loop, not several joined by
  `&&`. Only the most recent command is legible on some harnesses.
- **A literal uuid after `--workspace`.** Never `"$ws"`, never `"$SUPERSET_WORKSPACE_ID"`,
  never a value read from a file. Paste the id.
- **`--workspace <uuid>` first, immediately after `terminals send`.** Claude Code truncates a
  displayed command after about two lines; anything past that is never on screen.
- **Keep the command short.** Put a long brief in a file and pass `--text "$(cat brief.md)"`.
  The id stays literal, the command stays legible, and the body can be any length.

These are worth following even with the wrapper installed: they cost nothing and they keep
`terminals read` check-ins visible too.

## What this does not change

Nothing about how you coordinate. Task dependencies, worker prompts, completion envelopes and
verification are the `orchestrate` skill's business and are unaffected. This is only about the
one command that carries a message between two workspaces.
