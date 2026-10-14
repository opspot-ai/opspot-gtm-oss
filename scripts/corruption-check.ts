import { copyFile, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findEngineRoot } from "@opspot/domain";

const root = findEngineRoot(process.cwd());
const sourceIndex = process.argv.indexOf("--source");
const sourceArg = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
if (!sourceArg) throw new Error("Usage: pnpm check:corruption --source backups/file.sqlite");
const source = await realpath(path.resolve(sourceArg));
const backupRoot = await realpath(path.join(root, "backups"));
if (!source.startsWith(`${backupRoot}${path.sep}`)) throw new Error("corruption check source must be inside backups/");
const target = path.join(root, "data", "runtime", "corruption-verify.sqlite");
await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
const handle = await open(target, "r+");
try {
  await handle.truncate(512);
} finally {
  await handle.close();
}

let detected = false;
let detail = "";
try {
  const database = new DatabaseSync(target);
  try {
    const integrity = (database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    detected = integrity !== "ok";
    detail = integrity;
  } finally {
    database.close();
  }
} catch (error) {
  detected = true;
  detail = error instanceof Error ? error.message : String(error);
}
if (!detected) throw new Error("corrupted copy was not detected");
process.stdout.write(`${JSON.stringify({ ok: true, source, corruptedCopy: target, detected, detail })}\n`);
