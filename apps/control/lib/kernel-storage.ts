import { PostgresKernelStorage } from "@opspot/storage";

let cachedStorage: Promise<PostgresKernelStorage> | undefined;

function databaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for Cloud storage");
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("DATABASE_URL must be PostgreSQL");
  return value;
}

export function getCloudKernelStorage(): Promise<PostgresKernelStorage> {
  if (typeof window !== "undefined") throw new Error("Cloud kernel storage is server-only");
  if (!cachedStorage) {
    const connecting = PostgresKernelStorage.connect(databaseUrl(), {
      schema: process.env.OPSPOT_DATABASE_SCHEMA ?? "opspot_gtm",
      max: 2
    });
    cachedStorage = connecting;
    void connecting.catch(() => {
      if (cachedStorage === connecting) cachedStorage = undefined;
    });
  }
  return cachedStorage;
}

export async function closeCloudKernelStorageForTests(): Promise<void> {
  const storage = cachedStorage;
  cachedStorage = undefined;
  if (storage) await (await storage).close();
}
