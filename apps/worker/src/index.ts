#!/usr/bin/env node
import { createDefaultRuntime } from "@opspot/domain";

if ((process.env.ENGINE_MODE ?? "local") !== "local") throw new Error("the standalone worker requires ENGINE_MODE=local");
const once = process.argv.includes("--once");
const runtime = createDefaultRuntime();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

try {
  do {
    await runtime.autonomy.scheduleDue(runtime.service.context.workspaceId);
    const result =
      (await runtime.autonomy.runWorkerOnce(runtime.service.context.workspaceId)) ??
      (await runtime.initiativeWorker.runOnce(runtime.service.context.workspaceId)) ??
      (runtime.goldenWorker ? await runtime.goldenWorker.runOnce(runtime.service.context.workspaceId) : null);
    if (result) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
    if (once) break;
    if (!result) await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!stopping);
} finally {
  runtime.storage.close();
}
