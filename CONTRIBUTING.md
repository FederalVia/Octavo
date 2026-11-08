# Contributing

Thanks for helping out! See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Setup

```bash
git clone https://github.com/FederalVia/Octavo.git
cd octavo
npm install
npm run build
```

Requires Node.js 20+.

## Development with hot reload

Run these in two terminals:

```bash
npm run dev:server    # API + MCP on :4321, watching packages/server; vault in ./vault (git-ignored)
npm run dev:web       # Vite on http://localhost:5173, proxying /api and /mcp to :4321
```

`packages/core` is consumed from its built output. After changing it, run `npm run build -w @octavo/core`, or keep `npx tsc -w -p packages/core` running.

To work on the desktop app: `npm run desktop`.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck
npm test            # core, server (REST, auth, MCP round-trip, CLI, backups) and web unit tests
npm run build
```

When changing the UI, try both views (atlas and network) at desktop and phone widths, and with a large vault as well as a small one.

## Guidelines

- Notes must stay plain Markdown that Obsidian can open. Don't add proprietary file formats or hidden metadata files.
- Everything that changes files goes through `Vault` in `packages/core`, so that path checks, atomic writes, the index and live events stay consistent.
- New MCP tools need clear descriptions (Claude reads them), errors returned as `isError` results rather than thrown, and a test in `packages/server/test`.
- Keep pull requests focused, and describe what you tested.

## License

By contributing, you agree that your contributions are licensed under the project's [AGPL-3.0-or-later](LICENSE) license.
