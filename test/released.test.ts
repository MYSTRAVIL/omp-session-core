import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCopy, type Core, removeCopies } from "./copies";
import { FakeSession, FakeTerminal, MAIN_AGENT } from "./fake-omp";
import { type CapturedStdout, captureStdout } from "./stdout";

// Every version that shipped in an app stays here as the bundle that shipped, so the current
// source is tested against real old copies, not against itself rebuilt with an old number.
const fixtures = join(import.meta.dir, "fixtures");
const released = readdirSync(fixtures)
  .map((file) => /^core-(.+)\.js$/.exec(file))
  .filter((match): match is RegExpExecArray => match !== null)
  .map(([file, version]) => ({ file: join(fixtures, file!), version: version! }));

afterAll(removeCopies);

let stdout: CapturedStdout;
beforeEach(() => {
  stdout = captureStdout();
});
afterEach(() => stdout.restore());

function mainSession(): FakeSession {
  return new FakeSession({ id: "s1", hasUI: true, agent: MAIN_AGENT, terminal: new FakeTerminal() });
}

/** Loads a copy as an app would, with a handler of its own that reads the state. */
function loadApp(session: FakeSession, copy: Core, seen: string[]) {
  return session.load((pi) => {
    const core = copy.startSessionCore(pi);
    pi.on("agent_start", () => seen.push(`own:${core.state()?.status}`));
    return core;
  });
}

test("at least one released copy is kept", () => {
  expect(released.length).toBeGreaterThan(0);
});

for (const { file, version } of released) {
  describe(`released ${version}`, () => {
    // Each fixture is a bundle on disk, chosen at runtime, so it can only be imported dynamically.
    const load = async (): Promise<Core> => import(pathToFileURL(file).href);

    test.each(["released first", "current first"])("a newer current copy provides, and the released app follows it (%s)", async (order) => {
      const [old, current] = await Promise.all([load(), buildCopy("999.0.0")]);
      const session = mainSession();
      const seen: string[] = [];
      const currentFirst = order === "current first" ? loadApp(session, current, []) : undefined;
      const oldCore = loadApp(session, old, seen);
      const currentCore = currentFirst ?? loadApp(session, current, []);
      await session.start();
      await session.emit("agent_start");

      expect(currentCore.isProvider()).toBe(true);
      expect(oldCore.isProvider()).toBe(false);
      expect(seen).toEqual(["own:busy"]);
      expect(oldCore.state()?.status).toBe("busy");
    });

    test("an older current copy follows the released provider", async () => {
      const [old, current] = await Promise.all([load(), buildCopy("0.0.1")]);
      const session = mainSession();
      const seen: string[] = [];
      const currentCore = loadApp(session, current, seen);
      const oldCore = loadApp(session, old, []);
      await session.start();
      await session.emit("agent_start");

      expect(oldCore.isProvider()).toBe(true);
      expect(currentCore.isProvider()).toBe(false);
      expect(seen).toEqual(["own:busy"]);
      expect(currentCore.state()?.status).toBe("busy");
    });
  });
}
