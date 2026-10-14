import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { createDefaultRuntime } from "@opspot/domain";
import { venturePackJsonSchema } from "@opspot/packs";
import { writeFile } from "node:fs/promises";

const root = process.cwd();
const importExample = process.argv.includes("--import-example");
await Promise.all([mkdir(path.join(root, "data"), { recursive: true }), mkdir(path.join(root, "ventures", "schema"), { recursive: true })]);
await writeFile(path.join(root, "ventures", "schema", "venture-pack-v1.schema.json"), `${JSON.stringify(venturePackJsonSchema(), null, 2)}\n`, "utf8");

const runtime = createDefaultRuntime({ root });
try {
  const results = [];
  if (importExample) {
    const relative = "ventures/synthetic-example.yaml";
    await cp(path.join(root, "examples", "synthetic-company.yaml"), path.join(root, relative));
    const result = await runtime.service.execute("venture.create_or_update_pack", { packPath: path.join(root, relative) });
    if (!result.ok) throw new Error(`${relative}: ${result.error?.message}`);
    results.push(result.data);
  }
  const integrity = runtime.storage.integrityCheck();
  if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);
  process.stdout.write(`${JSON.stringify({ ok: true, root, database: runtime.storage.filename, journalMode: "WAL", integrity, packs: results, exampleImported: importExample }, null, 2)}\n`);
} finally {
  runtime.storage.close();
}
