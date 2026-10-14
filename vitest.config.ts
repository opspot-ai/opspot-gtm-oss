import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@opspot/contracts": `${root}packages/contracts/src/index.ts`,
      "@opspot/packs": `${root}packages/packs/src/index.ts`,
      "@opspot/policy": `${root}packages/policy/src/index.ts`,
      "@opspot/storage": `${root}packages/storage/src/index.ts`,
      "@opspot/dispatch": `${root}packages/dispatch/src/index.ts`,
      "@opspot/adapters": `${root}packages/adapters/src/index.ts`,
      "@opspot/domain": `${root}packages/domain/src/index.ts`
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "json-summary"] }
  }
});
