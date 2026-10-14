import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { venturePackJsonSchema } from "@opspot/packs";
import { findEngineRoot } from "@opspot/domain";

const root = findEngineRoot(process.cwd());
const output = path.join(root, "ventures", "schema", "venture-pack-v1.schema.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(venturePackJsonSchema(), null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
