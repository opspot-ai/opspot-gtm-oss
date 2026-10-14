#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CommandInputSchemas, CommandNameSchema, localExecutionContext } from "@opspot/contracts";
import { createDefaultRuntime } from "@opspot/domain";

const context = localExecutionContext("mcp");
const runtime = createDefaultRuntime({ context });
const server = new Server(
  { name: "opspot-company-launch-engine", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CommandNameSchema.options.map((name) => ({
    name,
    description: `Company Launch Engine canonical command: ${name}`,
    inputSchema: z.toJSONSchema(CommandInputSchemas[name], { target: "draft-2020-12", io: "input" }) as any
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await runtime.service.execute(request.params.name, request.params.arguments ?? {}, context);
  return {
    isError: !result.ok,
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as any
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "venture://portfolio", name: "Portfolio scorecard", mimeType: "application/json" },
    ...runtime.storage.listVenturesInWorkspace(context.workspaceId).map((venture) => ({ uri: `venture://${venture.id}`, name: venture.name, mimeType: "application/json" }))
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const result =
    uri === "venture://portfolio"
      ? await runtime.service.execute("portfolio.scorecard", {}, context)
      : await runtime.service.execute("venture.get", { ventureId: uri.replace("venture://", "") }, context);
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result) }] };
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runtime.storage.close();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
