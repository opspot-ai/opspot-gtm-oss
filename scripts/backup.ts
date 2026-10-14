import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createDefaultRuntime, findEngineRoot } from "@opspot/domain";

const root = findEngineRoot(process.cwd());
const runtime = createDefaultRuntime({ root });
try {
  runtime.storage.checkpoint();
  const directory = path.join(root, "backups");
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(directory, `engine-${timestamp}.sqlite`);
  runtime.storage.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  process.stdout.write(`${JSON.stringify({ ok: true, destination, integrity: runtime.storage.integrityCheck() })}\n`);
} finally {
  runtime.storage.close();
}
