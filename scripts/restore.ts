import { copyFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findEngineRoot } from "@opspot/domain";

const root = findEngineRoot(process.cwd());
const sourceIndex = process.argv.indexOf("--source");
const targetIndex = process.argv.indexOf("--target");
const sourceArg = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
const targetArg = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
if (!sourceArg || !targetArg) throw new Error("Usage: pnpm restore --source backups/file.sqlite --target data/runtime/restore-verify.sqlite");
const source = await realpath(path.resolve(sourceArg));
const backupRoot = await realpath(path.join(root, "backups"));
if (!source.startsWith(`${backupRoot}${path.sep}`)) throw new Error("restore source must be inside backups/");
const target = path.resolve(targetArg);
const runtimeRoot = path.join(root, "data", "runtime");
if (!target.startsWith(`${runtimeRoot}${path.sep}`)) throw new Error("restore target must be inside data/runtime/");
await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
const db = new DatabaseSync(target);
try {
  const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (integrity !== "ok") throw new Error(`restored database failed integrity: ${integrity}`);
  process.stdout.write(`${JSON.stringify({ ok: true, source, target, integrity })}\n`);
} finally {
  db.close();
}
