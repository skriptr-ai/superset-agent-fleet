# Contributing

Small fixes, clearer docs, new scenery, and better agent detection are all welcome.
For a large behavior change, open an issue with a concrete example before building it.

## Work locally

Fork the repository on GitHub, clone your fork, and create a branch. Then:

```sh
bun install
bun run demo
```

The demo uses fictional agents, so you can work on the UI without a Superset
account or exposing a real conversation. The running server prints its URL.
For live integration work, use [the local setup](docs/local-setup.md) and
`bun run dev` with your own Superset account.

There is no frontend build. The browser loads the files in `public/` directly.
Start with [the architecture guide](docs/architecture.md) to find the right file.

## Before a pull request

```sh
bun test
bun run check
```

Use `bun run format` to apply formatting. Include a regression test when changing
parsing, activity detection, or transport behavior. Use synthetic fixtures with
invented names, paths, and conversations. Do not copy real terminal output into tests.

For visual changes, open the demo and check the scene and conversation drawer.
Include a screenshot using fictional data. Add `?still=1` to the demo URL to pause
the scene for a consistent capture. The README images live in `docs/images/`.
Test the live Superset integration when
you change it, and say explicitly when you could not.

For live-update regressions, run `bun test/browser-server.js` and open
http://127.0.0.1:4414. Its fictional controls switch between live, partial, stale
and empty data. Check filtering, keyboard navigation, terminal expansion and
recovery while a conversation is selected. The **DOM regression checks** link
runs browser assertions for focus, selection, scroll preservation and cached-city
pixel equivalence. These browser checks are manual and separate from `bun test`.

Keep the pull request focused. Describe the problem, what changes for the user,
and the commands or browser checks you ran. Documentation-only changes do not need
a new test. Never include `.env` files, host manifests, tokens, transcripts, or
unredacted diagnostic output.

## Scope

The public product runs on localhost with each person's own Superset account.
The code in `api/`, `cloud/`, and `docs/internal/` supports an existing internal
deployment. Public team onboarding is planned separately.

## Reporting problems

Use the [issue tracker](https://github.com/skriptr-ai/superset-agent-fleet/issues)
for bugs and ideas. Include your OS, Bun and Superset versions, what you expected,
and a small reproduction. Review screenshots and logs for private content first.
For vulnerabilities, follow [SECURITY.md](SECURITY.md).

Be kind and specific when reviewing another person's work. Contributions are
licensed under the project's [MIT license](LICENSE).
