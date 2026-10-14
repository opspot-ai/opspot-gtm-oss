# OpSpot GTM

**Experimental, as-is source snapshot.**

This TypeScript project provides a local agent-native company runtime for an operator to define a venture, organize bounded initiatives, record evidence and receipts, and replan. The source includes a command-line interface, a stdio MCP server, a Next.js control UI, and a local worker.

## Local setup

Source configuration specifies Node.js 24 or later and pnpm 11.15.1 or later. From the repository root:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
```

The example environment selects local mode and uses ./data/engine.db. The control UI is configured for 127.0.0.1:3210; optional provider integrations require operator-supplied settings. Keep credentials in a local environment or secret manager.

These commands are derived from the source configuration and were not run in this sanitation pass.

## Limits

This is an experimental snapshot of existing code. Bugs and incomplete features may remain, and dependency versions may be older. Runtime behavior, builds, security, and production readiness were not verified in this pass.
