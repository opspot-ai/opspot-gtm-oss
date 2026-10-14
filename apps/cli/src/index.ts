#!/usr/bin/env node
import { createDefaultRuntime } from "@opspot/domain";
import { CommandNameSchema, localExecutionContext } from "@opspot/contracts";

function usage(): never {
  process.stderr.write(`Usage: pnpm cli <command> [--input '{"key":"value"}'] [--json]\n\nCommands:\n${CommandNameSchema.options.map((name) => `  ${name}`).join("\n")}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0];
if (!command || command === "--help" || command === "-h") usage();
const inputIndex = args.indexOf("--input");
let input: unknown = {};
if (inputIndex >= 0) {
  const raw = args[inputIndex + 1];
  if (!raw) usage();
  try {
    input = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

const context = localExecutionContext("cli");
const runtime = createDefaultRuntime({ context });
try {
  const result = await runtime.service.execute(command, input, context);
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`${humanSummary(result.command, result.data)}\n`);
  else process.stderr.write(`${result.error?.code}: ${result.error?.message}\n`);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  runtime.storage.close();
}

function humanSummary(name: string | undefined, data: unknown): string {
  if (name === "portfolio.scorecard") {
    const scorecard = data as any;
    const rows = scorecard.ventures?.map(
      (venture: any) => `${venture.ventureId}: ${venture.lifecycleState}; gaps=${venture.gapCount}; tasks=${venture.tasks?.succeeded}/${venture.tasks?.total}; proof=${venture.proofTiers?.join(",") || "none"}`
    );
    return [`Portfolio @ ${scorecard.generatedAt}`, ...(rows ?? []), `Dashboard: ${scorecard.dashboardUrl}`].join("\n");
  }
  return `${name}\n${JSON.stringify(data, null, 2)}`;
}
