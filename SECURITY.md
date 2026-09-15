# Security

## Report a vulnerability privately

Please do not put credentials, terminal contents, or an exploitable vulnerability
in a public issue. Find a maintainer through the
[repository's contributors](https://github.com/skriptr-ai/superset-agent-fleet/graphs/contributors)
and use a private contact method listed on their profile.

If no private contact method is available, open an issue asking for a private
security reporting channel. Include no vulnerability details in that request.

Include the affected revision, a minimal reproduction, and the impact you observed.
Use fictional data and omit secrets. Fixes target the current default branch;
older snapshots do not have a separate security maintenance policy.

## Local data

The live view reads terminal screens and relevant Claude Code transcripts on your
machine. Its UI can show prompts, replies, paths, and anything else printed in those
screens. Treat the page and screenshots as you would your terminal.

The supported public setup listens on localhost. It has no login screen by default,
so processes and users that can access that local port can read the view.
Do not expose it through a public tunnel or reverse proxy.

See [privacy and local storage](docs/local-setup.md#privacy-and-local-storage)
for the files it reads and the optional network requests it makes.
