# Lousho Studio

A local web app for building, testing and watching every agent across your
projects — powered by [`lousho`](https://www.npmjs.com/package/lousho).

## Install & run

```sh
npx lousho-studio            # open Studio on the current folder
npx lousho-studio --workspace ~/code/my-app --port 5000
```

Or install it globally and use the `lousho-studio` command:

```sh
npm i -g lousho-studio
lousho-studio --workspace ~/code/my-app
```

If your project already has the SDK, `lousho studio` (from
`lousho`) launches the same app.

Studio prints a URL with a per-launch token — every API and WebSocket
request needs it, so keep the URL private to your machine (it binds to
`127.0.0.1` by default; pass `--host` to change that).

## Workspaces

A **workspace** is a project folder. Studio reads and writes each workspace's
agents under its `.lousho/` directory, so one Studio instance can follow many
projects. `--workspace <dir>` opens that folder and adds it to your workspace
list; the first run uses the current folder.

Runs use the project's own SDK when the workspace has `lousho`
installed, so Studio works across SDK versions. See
[Agent Forge](https://lousho.com/agent-forge) for the full guide.

## Options

```
Usage: lousho-studio [--workspace <dir>] [--port N] [--host H]

  --workspace <dir>  a project folder to open (default: the current folder)
  --port N           the port (default 4750)
  --host H           the interface to listen on (default 127.0.0.1)
  -v, --version      print the version
  -h, --help         show this help
```

## Requirements

Node.js >= 22.19. Provider API keys are configured inside Studio's Settings;
no keys are needed to open the app.

## Working on Studio

From the SDK repository root, `npx lousho studio --dev` runs Studio from
source: the API server (`tsx watch`) and the Vite dev server together. Open the
Vite URL (port 5173) for the UI. Without `--dev`, a checkout serves the built
bundle once `npm run build:studio` has produced `dist-server/`.

Studio has two test suites, run from `apps/agent-forge`:

```
npm test            # UI suite (vitest, watch mode)
npm run test:server # server suite
npm run test:all    # both, once, then exit
```

Check types and lint with `npm run typecheck`, `npm run typecheck:server` and
`npm run lint`.

To ship a change: merge it to main, run the Release workflow, then run
`npm run ship:studio` from the repository root. It builds the SDK, builds
Studio, and runs `lousho deploy --local --yes`. A `--local` deploy refuses to
start when any file under `server/`, `src/` or `shared/` is newer than
`dist-server/cli.cjs`; run `npm run build:studio` and deploy again.
