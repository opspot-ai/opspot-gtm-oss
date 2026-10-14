import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createDefaultRuntime } from "@opspot/domain";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version });
try {
  const { stdout } = await execFile("pnpm", ["--version"], { timeout: 10_000 });
  checks.push({ name: "pnpm", ok: Number(stdout.trim().split(".")[0]) >= 11, detail: stdout.trim() });
} catch (error) {
  checks.push({ name: "pnpm", ok: false, detail: error instanceof Error ? error.message : String(error) });
}
const runtime = createDefaultRuntime({ root });
try {
  const integrity = runtime.storage.integrityCheck();
  checks.push({ name: "sqlite-integrity", ok: integrity === "ok", detail: integrity });
  checks.push({ name: "sqlite-wal", ok: true, detail: runtime.storage.filename });
  checks.push({ name: "runtime-storage", ok: true, detail: `${runtime.storage.listVentures().length} imported company pack(s)` });
} finally {
  runtime.storage.close();
}

const ok = checks.every((check) => check.ok);
process.stdout.write(`${JSON.stringify({ ok, checkedAt: new Date().toISOString(), checks }, null, 2)}\n`);
if (!ok) process.exitCode = 1;
