# pi-rexlings

Run [Pi](https://github.com/earendil-works/pi) subagents in background
[Rex](https://www.superlogical.com/rex/docs) tabs. When a child finishes, its
tab closes and its answer returns to the parent.

## Setup

Requires `pi` 1.4+ and `rex` on `PATH`, with support for `rex api`, `rex events`,
and `rex block inspect`. Tested on Linux: Pi 1.4.0 and 1.5.2 with Rex
0.1.0-preview.22; Pi 1.6.1 with Rex 0.1.0-preview.25.

```sh
pi install git:github.com/lukasl-dev/pi-rexlings
```

Start Pi in a Rex tab, or `/reload` if it’s already running there.

With [pi.nix](https://github.com/lukasl-dev/pi.nix), add
`github:lukasl-dev/pi-rexlings` as an input and use this extension path:

```nix
"${inputs.pi-rexlings.packages.${pkgs.stdenv.hostPlatform.system}.default}/src/extension.ts"
```

## Use

> Use `rex_subagent` to summarise `README.md` in one sentence. Don’t edit files.

By default the child uses the parent’s Rex session, working directory, model
and thinking level. To use a different session, find it with
`rex_sessions_list` or create one with `rex_session_create`, then pass its ID
or exact, unique name as `session`. Results arrive automatically; don’t poll.

`/rexlings list` shows runs; `/rexlings doctor` checks the setup.
`/rexlings interrupt <name-or-id>` sends Escape. `/rexlings cancel <name-or-id>`
closes only the child’s block. `/reload` resumes supervision.

## Other machines

Register the host with `rex hosts add` on the parent machine. Pass the exact
`host` from `rex_hosts_list`, a destination `session`, and an absolute `cwd`.
No separate host config or relay.

The destination needs `pi` on Rex’s `PATH` or an absolute `piCommand`.
Runtime order: Node 22.18+, Bun, then `nix-shell -p nodejs` if neither is
installed. The first launch copies the launcher into the destination Pi
profile’s `rexlings/runtime/`. Keep the destination session and server running
until the report arrives.

## Configuration

The Pi profile (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) can contain
`rexlings/config.json` with `piCommand` (command and arguments),
`terminal.naming` (`random` or `task`), and `terminal.prefix`.

```json
{
  "piCommand": ["pi"],
  "terminal": { "naming": "task", "prefix": "review" }
}
```

Run files stay under `rexlings/runs/` on the parent and `rexlings/incoming/`
on the remote host. Children are not sandboxed.

## Development

```sh
npm ci
npm run check
npm run test:integration
```

Integration tests use disposable local Rex servers and Pi profiles.
