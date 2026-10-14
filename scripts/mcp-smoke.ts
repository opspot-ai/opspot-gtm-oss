import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CommandInputSchemas, CommandNameSchema } from "@opspot/contracts";
import { findEngineRoot } from "@opspot/domain";
import { z } from "zod";

function stable(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

const root = findEngineRoot(process.cwd());
const scratch = await mkdtemp(path.join(os.tmpdir(), "opspot-mcp-contract-"));
const childEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  ENGINE_MODE: "local",
  ENGINE_ROOT: root,
  ENGINE_DB_PATH: path.join(scratch, "engine.db"),
  ENGINE_WORKSPACE_ID: "workspace_local"
};
if (process.env.HOME) childEnv.HOME = process.env.HOME;
if (process.env.TMPDIR) childEnv.TMPDIR = process.env.TMPDIR;
if (process.env.LANG) childEnv.LANG = process.env.LANG;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "apps", "mcp", "src", "index.ts")
  ],
  cwd: root,
  env: childEnv
});
const client = new Client({ name: "opspot-mcp-contract-smoke", version: "1.0.5" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const actualNames = listed.tools.map((tool) => tool.name).sort();
  const expectedNames = [...CommandNameSchema.options].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`MCP tool parity failed: expected ${expectedNames.length} canonical commands, received ${actualNames.length}`);
  }

  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of expectedNames) {
    const tool = byName.get(name);
    const schema = z.toJSONSchema(CommandInputSchemas[name], { target: "draft-2020-12", io: "input" });
    if (!tool || stable(tool.inputSchema) !== stable(schema)) {
      throw new Error(`MCP input schema mismatch for ${name}`);
    }
  }

  const bootstrap = await client.callTool({
    name: "company.bootstrap",
    arguments: {
      idea: "A fictional local agency that organizes research work without external actions.",
      owner: "mcp-contract-smoke",
      destination: "cash-flow",
      horizonDays: 14,
      budgetCents: 0,
      constraints: ["Synthetic local smoke only; no provider or external action"],
      requestedAt: new Date().toISOString(),
      idempotencyKey: "mcp-contract-bootstrap-v1"
    }
  });
  if (bootstrap.isError) throw new Error(`Synthetic MCP bootstrap failed: ${JSON.stringify(bootstrap.content)}`);
  const ventureId = String((bootstrap.structuredContent as { data?: { ventureId?: string } } | undefined)?.data?.ventureId ?? "");
  if (!ventureId.startsWith("venture_")) throw new Error("Synthetic MCP bootstrap returned no venture id");

  const company = await client.callTool({ name: "company.get", arguments: { ventureId } });
  if (company.isError) throw new Error(`MCP company read failed: ${JSON.stringify(company.content)}`);

  const scorecard = await client.callTool({ name: "portfolio.scorecard", arguments: {} });
  if (scorecard.isError) throw new Error(`MCP portfolio scorecard failed: ${JSON.stringify(scorecard.content)}`);

  const resources = await client.listResources();
  const resourceUris = resources.resources.map((resource) => resource.uri).sort();
  const companyUri = `venture://${ventureId}`;
  if (!resourceUris.includes("venture://portfolio") || !resourceUris.includes(companyUri)) {
    throw new Error("MCP resources did not expose the portfolio and synthetic company");
  }

  for (const uri of ["venture://portfolio", companyUri]) {
    const resource = await client.readResource({ uri });
    const content = resource.contents.find((item) => item.uri === uri);
    if (!content || !("text" in content) || typeof content.text !== "string") {
      throw new Error(`MCP resource read returned no text for ${uri}`);
    }
    const parsed = JSON.parse(content.text) as { ok?: boolean };
    if (parsed.ok !== true) throw new Error(`MCP resource read failed for ${uri}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    toolCount: actualNames.length,
    schemaCount: expectedNames.length,
    syntheticRead: true,
    resourceUris
  })}\n`);
} finally {
  try {
    await client.close();
  } catch {
    // The connection may already have closed after a transport failure.
  }
  await rm(scratch, { recursive: true, force: true });
}
