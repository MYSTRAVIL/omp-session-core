import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CoreModule from "../src/index";

export type Core = typeof CoreModule;

const dir = mkdtempSync(join(tmpdir(), "omp-session-core-"));
let built = 0;

/**
 * Bundles the core as an app would, stamped with `version`, and loads it as a
 * module of its own: two copies share only `globalThis`, like two extensions
 * that each bundled the core.
 */
export async function buildCopy(version: string): Promise<Core> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "stamp-version",
        setup(build) {
          build.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({
            contents: `export const VERSION = ${JSON.stringify(version)};`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  const output = result.outputs[0];
  if (!result.success || !output) throw new AggregateError(result.logs, "bundling the core failed");
  const file = join(dir, `core-${version}-${built++}.js`);
  await Bun.write(file, await output.text());
  // Each copy is a bundle written at runtime, so it can only be imported dynamically.
  return import(pathToFileURL(file).href);
}

export function removeCopies(): void {
  rmSync(dir, { recursive: true, force: true });
}
