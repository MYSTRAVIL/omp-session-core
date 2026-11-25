// Proves the package works the way an app consumes it: build, pack, install the tarball into a
// throwaway app, type-check that app as an ESM and a CommonJS project, bundle its extension into
// one file as omp needs, and run the bundle against a minimal omp. Leaves the tarball in pack/.
// Usage: bun scripts/consumer.ts
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}`);
  return out;
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`consumer check failed: ${what}`);
  console.log(`ok: ${what}`);
}

run(["bun", "run", "build"], root);
rmSync(join(root, "pack"), { recursive: true, force: true });
run(["bun", "pm", "pack", "--destination", "pack", "--quiet"], root);
const tarball = readdirSync(join(root, "pack")).find((f) => f.endsWith(".tgz"));
if (!tarball) throw new Error("bun pm pack wrote no tarball");
const tarballPath = join(root, "pack", tarball);

const files = run(["tar", "-tzf", tarballPath], root).split(/\r?\n/).filter(Boolean);
check(files.includes("package/dist/index.js") && files.includes("package/dist/index.d.ts"), "the tarball ships dist/index.js and its types");
check(!files.some((f) => /^package\/(src|test|memory|scripts)\//.test(f)), "the tarball ships no source, tests, memory or scripts");

const app = mkdtempSync(join(tmpdir(), "omp-session-core-consumer-"));
try {
  await Bun.write(
    join(app, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: { "@mystravil/omp-session-core": `file:${tarballPath}` } }),
  );
  run(["bun", "install"], app);

  // An extension written the way the README says, typed strictly, with no Bun types in scope.
  await Bun.write(
    join(app, "ext.ts"),
    `import { type OmpExtensionApi, type SessionStateV1, startSessionCore } from "@mystravil/omp-session-core";

export const seen: string[] = [];

export let idle: number | null | undefined;

export default function (pi: OmpExtensionApi): void {
  const core = startSessionCore(pi);
  core.onState((state: SessionStateV1) => seen.push(\`state:\${state.status}\`));
  pi.on("agent_start", () => seen.push(\`own:\${core.state()?.status}\`));
  idle = core.idleMs();
}
`,
  );
  const tsconfig = (module: string, moduleResolution: string) =>
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: false, target: "ES2022", module, moduleResolution }, files: ["ext.ts"] });
  await Bun.write(join(app, "tsconfig.esm.json"), tsconfig("ESNext", "bundler"));
  await Bun.write(join(app, "tsconfig.cjs.json"), tsconfig("CommonJS", "node10"));
  await Bun.write(join(app, "tsconfig.nodenext.json"), tsconfig("NodeNext", "NodeNext"));
  run(["bun", tsc, "-p", "tsconfig.esm.json"], app);
  check(true, "an ESM app type-checks against the shipped types");
  run(["bun", tsc, "-p", "tsconfig.cjs.json"], app);
  check(true, "a CommonJS app type-checks against the shipped types");
  run(["bun", tsc, "-p", "tsconfig.nodenext.json"], app);
  check(true, "an ESM app on NodeNext resolution type-checks against the shipped types");

  // Apps test their extension under Node (vitest), where bun:ffi does not exist: the core must load.
  const node = process.platform === "win32" && (await Bun.file("C:\\dev\\nodejs\\node.exe").exists()) ? "C:\\dev\\nodejs\\node.exe" : "node";
  const loaded = run(
    [node, "--input-type=module", "-e", 'const m = await import("@mystravil/omp-session-core"); console.log(typeof m.startSessionCore, m.startSessionCore({ on() {} }).idleMs());'],
    app,
  ).trim();
  check(loaded === "function null", `the core loads under Node, with no desk idle there (${loaded})`);

  const bundle = await Bun.build({ entrypoints: [join(app, "ext.ts")], target: "bun", format: "esm", external: ["@oh-my-pi/*"] });
  const output = bundle.outputs[0];
  if (!bundle.success || !output) throw new AggregateError(bundle.logs, "bundling the app's extension failed");
  const code = await output.text();
  check(!/(from|import)\s*\(?\s*["']@mystravil\/omp-session-core["']/.test(code), "the app's extension bundles the core into one file");
  const bundled = join(app, "ext-bundled.ts");
  await Bun.write(bundled, code);

  // A minimal omp: one bus, handlers called in registration order with one shared event object.
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const pi = {
    on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
    events: {
      on: (channel: string, handler: (data: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        listeners.set(channel, set.add(handler));
        return () => set.delete(handler);
      },
      emit: (channel: string, data: unknown) => {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
    },
  };
  const ctx = { hasUI: false, cwd: app, sessionManager: { getSessionId: () => "consumer-1" }, isIdle: () => true };
  const emit = async (type: string) => {
    const event = { type };
    for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
  };
  // The bundle is written at runtime above, so it can only be imported dynamically.
  const extension = await import(pathToFileURL(bundled).href);
  extension.default(pi);
  await emit("session_start");
  await emit("agent_start");
  check(extension.seen.join(",") === "state:idle,state:busy,own:busy", `the bundled extension follows the session (${extension.seen.join(",")})`);
  const idleOk = process.platform === "win32" ? typeof extension.idle === "number" : extension.idle === null;
  check(idleOk, `desk idle works in the bundled extension under Bun (${extension.idle})`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
console.log(`consumer test passed: pack/${tarball}`);
