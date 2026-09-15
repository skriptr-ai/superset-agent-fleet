# Open-source readiness

Status: implemented locally; publication and GitHub settings changes are separate.

## Accepted scope

The public version runs on localhost with the user's own Superset login. A separate demo uses
fictional data and requires no account. The existing Vercel and Supabase deployment remains internal.
The README announces a free team web app as coming soon; it does not offer public team deployment.

This supersedes the initial proposal to document a team-owned Vercel deployment. Hosted sharing,
authentication, identity, schema changes, and deployment automation are outside this change.

## Included

- MIT license, contributor guide, security reporting guidance, GitHub issue forms and PR template.
- Short README with real demo screenshots, local quickstart, controls, privacy, and documentation links.
- Local setup and architecture guides; existing team operations preserved under `docs/internal/`.
- Foreground start, validated configuration, `.env.example`, and a read-only doctor command.
- Default host scope, optional weather requests, and conservative private-API fallback.
- Standalone fictional demo with fixed data, clock, weather, and pause controls.
- Optional macOS/Linux service scripts with configured ports and no unrelated process termination.
- Pinned Bun/Prettier versions, lockfile, editor settings, and CI without company credentials.
- Focused tests for configuration, diagnostics, services, transport fallback, and the demo.

## Before publication

Review the final diff and validation report. The repository is already public. Commit and push are
separate actions; no repository settings or hosted resources were changed by this implementation.
Private vulnerability reporting is currently disabled on GitHub. Enabling it is a useful next
repository setting; until then, `SECURITY.md` documents how to request a private channel.

The checked-out Git history was scanned with Gitleaks 8.30.1 using `--log-opts=--all` and full
redaction. The scanner reported 51 scanned commits and no secret matches. This is a pattern-based
secret scan, not a claim that every historical internal detail is appropriate for publication.

## Verification limits

The final local check passed 148 tests across 12 files, including a repeat from a clean copy
without `.env` or installed packages. Formatting, local documentation links, shell syntax, and
the working-tree Gitleaks scan passed. Generated launchd XML passed `plutil -lint`.
Browser checks covered the fictional demo, conversation drawer, pause/resume, and a live local
collector displaying 15 agents. Neither browser session reported console errors or warnings.

The implementation is tested against Bun 1.3.14 and Superset CLI 1.28.0 on macOS. New-account
configuration is exercised with isolated synthetic fixtures. A second person's real Superset
account and live Linux service installation have not been verified. The internal deployment is
not redeployed or otherwise changed as part of this work.
