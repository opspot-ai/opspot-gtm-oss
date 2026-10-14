import { spawn } from "node:child_process";

const port = Number(process.env.ENGINE_PORT ?? "3210");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("ENGINE_PORT must be a valid TCP port");
const workspaceId = process.env.ENGINE_WORKSPACE_ID ?? "workspace_local";
if (workspaceId !== "workspace_local") throw new Error("ENGINE_MODE=local requires ENGINE_WORKSPACE_ID=workspace_local");

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const localEnvironment = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_local_only",
  OPSPOT_APP_ORIGIN: process.env.OPSPOT_APP_ORIGIN ?? "https://local.opspot.invalid",
  ENGINE_MODE: "local",
  ENGINE_WORKSPACE_ID: workspaceId
};
const children = [
  { name: "control", process: spawn(pnpm, ["--dir", "apps/control", "exec", "next", "start", "-H", "127.0.0.1", "-p", String(port)], { stdio: "inherit", env: localEnvironment }) },
  { name: "worker", process: spawn(pnpm, ["--dir", "apps/worker", "start"], { stdio: "inherit", env: localEnvironment }) }
];

let stopping = false;
let unexpectedExit = false;
let requestedStop = false;
function stopChildren(signal: NodeJS.Signals): void {
  for (const child of children) if (child.process.exitCode === null) child.process.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    requestedStop = true;
    stopChildren(signal);
  });
}

const results = await Promise.all(children.map(({ name, process: child }) => new Promise<number | null>((resolve) => {
  child.once("error", (error) => {
    process.stderr.write(`${name} failed to start: ${error.message}\n`);
    if (!stopping) {
      unexpectedExit = true;
      stopping = true;
      stopChildren("SIGTERM");
    }
    resolve(1);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      unexpectedExit = true;
      stopping = true;
      process.stderr.write(`${name} exited unexpectedly (${code ?? "signal"}); stopping sibling\n`);
      stopChildren("SIGTERM");
    }
    resolve(code);
  });
})));
process.exitCode = unexpectedExit || (!requestedStop && results.some((code) => code !== 0)) ? 1 : 0;
