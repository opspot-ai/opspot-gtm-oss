import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findEngineRoot } from "@opspot/domain";

const execFile = promisify(execFileCallback);
const schemaPattern = /^[a-z][a-z0-9_]{0,62}$/;
const restoreDatabasePattern = /^opspot_restore_[a-z0-9_]{1,40}$/;

type Connection = { host: string; port: string; database: string; environment: NodeJS.ProcessEnv };

function connection(raw: string | undefined, label: string): Connection {
  if (!raw) throw new Error(`${label} is required`);
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`${label} must be PostgreSQL`);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!url.hostname || !database) throw new Error(`${label} must identify a host and database`);
  const port = url.port || "5432";
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  return {
    host: url.hostname,
    port,
    database,
    environment: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: port,
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database,
      PGSSLMODE: url.searchParams.get("sslmode") ?? (local ? "prefer" : "require")
    }
  };
}

async function run(binary: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await execFile(binary, args, { env: environment, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })).stdout;
  } catch {
    throw new Error(`${binary} failed; inspect the database provider logs without copying credentials into receipts`);
  }
}

function schemaName(): string {
  const schema = process.env.OPSPOT_DATABASE_SCHEMA ?? "opspot_gtm";
  if (!schemaPattern.test(schema)) throw new Error("OPSPOT_DATABASE_SCHEMA is invalid");
  return schema;
}

async function backup(): Promise<void> {
  const root = findEngineRoot(process.cwd());
  const source = connection(process.env.DATABASE_URL, "DATABASE_URL");
  const schema = schemaName();
  const directory = path.join(root, "backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(directory, `cloud-${timestamp}.dump`);
  await run("pg_dump", ["--format=custom", "--compress=0", "--no-owner", "--no-acl", `--schema=${schema}`, `--file=${destination}`], source.environment);
  await chmod(destination, 0o600);
  const canary = process.env.OPSPOT_SECRET_CANARY;
  if (canary) {
    const materialized = await run("pg_restore", ["--file=-", destination], source.environment);
    if (materialized.includes(canary)) throw new Error("secret canary appeared in the Cloud backup");
  }
  const bytes = await readFile(destination);
  process.stdout.write(`${JSON.stringify({ ok: true, kind: "cloud-postgres-backup", destination, schema, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), secretCanaryAbsent: canary ? true : "not-exercised" })}\n`);
}

async function restoreVerify(): Promise<void> {
  const root = findEngineRoot(process.cwd());
  const sourceIndex = process.argv.indexOf("--source");
  const sourceArg = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
  if (!sourceArg) throw new Error("Usage: pnpm cloud:restore -- --source backups/cloud-...dump");
  const backupRoot = await realpath(path.join(root, "backups"));
  const sourceFile = await realpath(path.resolve(sourceArg));
  if (!sourceFile.startsWith(`${backupRoot}${path.sep}`)) throw new Error("restore source must be inside backups/");
  const production = connection(process.env.DATABASE_URL, "DATABASE_URL");
  const target = connection(process.env.RESTORE_DATABASE_URL, "RESTORE_DATABASE_URL");
  if (`${target.host}:${target.port}/${target.database}` === `${production.host}:${production.port}/${production.database}`) {
    throw new Error("restore target must not be the production database");
  }
  if (!restoreDatabasePattern.test(target.database) || process.env.OPSPOT_RESTORE_CONFIRM_DATABASE !== target.database) {
    throw new Error("restore verification requires an explicitly confirmed opspot_restore_* database");
  }
  const schema = schemaName();
  const before = Number((await run("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--command", `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='${schema}'`], target.environment)).trim());
  if (before !== 0) throw new Error("restore target is not empty");
  await run("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", `--dbname=${target.database}`, sourceFile], target.environment);
  const counts = (await run("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--field-separator=,", "--command", `SELECT (SELECT count(*) FROM ${schema}.workspaces),(SELECT count(*) FROM ${schema}.ventures),(SELECT count(*) FROM ${schema}.jobs),(SELECT count(*) FROM ${schema}.receipts)`], target.environment)).trim();
  const parsedCounts = counts.split(",").map(Number);
  if (parsedCounts.length !== 4 || parsedCounts.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("restored table counts are invalid");
  const [workspaces, companies, jobs, receipts] = parsedCounts as [number, number, number, number];
  const canary = process.env.OPSPOT_SECRET_CANARY;
  if (canary) {
    const materialized = await run("pg_dump", ["--format=plain", "--no-owner", "--no-acl", `--schema=${schema}`], target.environment);
    if (materialized.includes(canary)) throw new Error("secret canary appeared in the restored Cloud data");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, kind: "cloud-postgres-restore-verification", source: sourceFile, targetDatabase: target.database, schema, counts: { workspaces, companies, jobs, receipts }, secretCanaryAbsent: canary ? true : "not-exercised" })}\n`);
}

const mode = process.argv[2];
if (mode === "backup") await backup();
else if (mode === "restore-verify") await restoreVerify();
else throw new Error("Usage: cloud-backup-restore.ts backup | restore-verify --source <dump>");
