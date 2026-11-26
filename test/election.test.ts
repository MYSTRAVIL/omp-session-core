import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import { buildCopy, type Core, removeCopies } from "./copies";
import { FakeSession, FakeTerminal, MAIN_AGENT } from "./fake-omp";
import { type CapturedStdout, captureStdout } from "./stdout";

const FOCUS_ON = "\x1b[?1004h";

let older: Core;
let olderTwin: Core;
let newer: Core;

beforeAll(async () => {
  [older, olderTwin, newer] = await Promise.all([
    buildCopy("0.1.0"),
    buildCopy("0.1.0"),
    buildCopy("0.2.0"),
  ]);
});
afterAll(removeCopies);

let stdout: CapturedStdout;
beforeEach(() => {
  stdout = captureStdout();
});
afterEach(() => stdout.restore());

function mainSession(id = "s1"): FakeSession & { terminal: FakeTerminal } {
  const terminal = new FakeTerminal();
  return Object.assign(new FakeSession({ id, hasUI: true, agent: MAIN_AGENT, terminal }), { terminal });
}

function focusReportingWrites(): number {
  return stdout.writes.filter((w) => w === FOCUS_ON).length;
}

test.each(["older first", "newer first"])("the newer copy provides when it loads %s", async (order) => {
  const session = mainSession();
  const load = (copy: Core) => session.load(copy.startSessionCore);
  const recentFirst = order === "newer first" ? load(newer) : undefined;
  const old = load(older);
  const recent = recentFirst ?? load(newer);
  await session.start();

  expect(recent.isProvider()).toBe(true);
  expect(old.isProvider()).toBe(false);
  expect(session.terminal.listeners.size).toBe(1);
  expect(focusReportingWrites()).toBe(1);
  expect(session.bus.sentOn("session-state")).toHaveLength(1);
});

test("between equal versions the first copy to load provides", async () => {
  const session = mainSession();
  const first = session.load(older.startSessionCore);
  const second = session.load(olderTwin.startSessionCore);
  await session.start();

  expect(first.isProvider()).toBe(true);
  expect(second.isProvider()).toBe(false);
});

test("a client reads the provider's state in its own session_start handler, whichever loads first", async () => {
  const session = mainSession();
  let seen: unknown;
  session.load((pi) => {
    const core = older.startSessionCore(pi);
    pi.on("session_start", () => {
      seen = core.state()?.sessionId;
    });
    return core;
  });
  session.load(newer.startSessionCore);
  await session.start();

  expect(seen).toBe("s1");
});

test("an app that loads before the provider reads the new state inside its own handler for the same event", async () => {
  const session = mainSession();
  const seen: string[] = [];
  session.load((pi) => {
    const core = older.startSessionCore(pi);
    pi.on("agent_start", () => seen.push(`start:${core.state()?.status}`));
    pi.on("tool_call", () => seen.push(`ask:${core.state()?.waitingOn}`));
    pi.on("agent_end", () => seen.push(`end:${core.state()?.status}`));
    return core;
  });
  session.load(newer.startSessionCore);
  await session.start();
  await session.emit("agent_start");
  await session.emit("tool_call", { toolName: "ask", toolCallId: "c1", input: {} });
  await session.emit("agent_end", { messages: [] });

  expect(seen).toEqual(["start:busy", "ask:ask", "end:idle"]);
});

test("the provider handles each omp event once, however many copies pass it on", async () => {
  const session = mainSession();
  session.load(older.startSessionCore);
  session.load(olderTwin.startSessionCore);
  session.load(newer.startSessionCore);
  await session.start();
  await session.switchTo("s2");

  // Focus reporting goes on at the start and again after the switch, once each.
  expect(focusReportingWrites()).toBe(2);
  expect(session.terminal.listeners.size).toBe(1);
});

test("the provider keeps working when omp suspends its own extension", async () => {
  const session = mainSession();
  const old = session.load(older.startSessionCore);
  const recent = session.load(newer.startSessionCore);
  await session.start();
  session.suspend(1);
  await session.emit("agent_start");

  expect(recent.isProvider()).toBe(true);
  expect(old.state()?.status).toBe("busy");
});

test("the provider keeps its role across a session switch", async () => {
  const session = mainSession();
  const old = session.load(older.startSessionCore);
  const recent = session.load(newer.startSessionCore);
  await session.start();
  await session.switchTo("s2");

  expect(recent.isProvider()).toBe(true);
  expect(old.isProvider()).toBe(false);
  expect(session.terminal.listeners.size).toBe(1);
  expect(old.state()?.sessionId).toBe("s2");
});

test("each subagent bus elects its own provider, and a subagent never touches the terminal", async () => {
  const main = mainSession();
  main.load(older.startSessionCore);
  main.load(newer.startSessionCore);
  await main.start();
  // omp reruns every extension factory for a subagent, on a bus of its own.
  const sub = new FakeSession({
    id: "sub1",
    hasUI: false,
    agent: { kind: "sub", id: "0-Task", name: "task", depth: 1, parentId: "Main" },
  });
  const subOld = sub.load(older.startSessionCore);
  const subRecent = sub.load(newer.startSessionCore);
  await sub.start();

  expect(subRecent.isProvider()).toBe(true);
  expect(subOld.isProvider()).toBe(false);
  expect(subOld.state()).toMatchObject({ sessionId: "sub1", subagent: true });
  expect(subOld.state()?.terminal).toBeUndefined();
  expect(main.bus.sentOn("session-state")).toHaveLength(1);
  expect(main.terminal.listeners.size).toBe(1);
  expect(focusReportingWrites()).toBe(1);
});

test("a copy bound after the first session_start stays a client, even when newer", async () => {
  const session = mainSession();
  const old = session.load(older.startSessionCore);
  await session.start();
  const late = session.load(newer.startSessionCore);
  await session.replayStartToLast();

  expect(old.isProvider()).toBe(true);
  expect(late.isProvider()).toBe(false);
  expect(session.terminal.listeners.size).toBe(1);
  expect(late.state()?.sessionId).toBe("s1");
});

test("a copy omp binds after the first session_start gets the current state and focus at once", async () => {
  jest.useFakeTimers();
  try {
    const session = mainSession();
    session.load(older.startSessionCore);
    await session.start();
    session.terminal.type("\x1b[O");
    jest.advanceTimersByTime(100);
    // omp defers an extension that registers nothing needed before the first frame: its factory
    // runs after session_start went out, so its listeners join after the first state.
    const states: string[] = [];
    const focus: boolean[] = [];
    session.load((pi) => {
      const core = newer.startSessionCore(pi);
      core.onState((state) => states.push(`${state.sessionId}:${state.status}`));
      core.onFocus((f) => focus.push(f.focused));
      return core;
    });
    await session.replayStartToLast();

    expect(states).toEqual(["s1:idle"]);
    expect(focus).toEqual([false]);
  } finally {
    jest.useRealTimers();
  }
});

test("an older client follows the state a newer provider publishes", async () => {
  const session = mainSession();
  const old = session.load(older.startSessionCore);
  session.load(newer.startSessionCore);
  const statuses: string[] = [];
  old.onState((state) => statuses.push(state.status));
  await session.start();
  await session.emit("agent_start");
  await session.emit("agent_end", { messages: [] });

  expect(statuses).toEqual(["idle", "busy", "idle"]);
  expect(old.state()?.status).toBe("idle");
});

test("the registry keeps its frozen v1 shape", async () => {
  const session = mainSession();
  session.load(older.startSessionCore);
  session.load(newer.startSessionCore);
  await session.start();

  const registry: unknown = Reflect.get(globalThis, Symbol.for("omp-session-core"));
  expect(registry).toBeObject();
  const { registry: tag, buses } = registry as { registry: unknown; buses: WeakMap<object, unknown> };
  expect(tag).toBe(1);
  expect(Object.keys(registry as object).sort()).toEqual(["buses", "registry"]);
  expect(Object.isFrozen(registry)).toBe(true);
  expect(buses).toBeInstanceOf(WeakMap);
  const bus = buses.get(session.bus) as { candidates: object[]; provider: object };
  expect(Object.keys(bus).sort()).toEqual(["candidates", "provider"]);
  expect(bus.candidates).toHaveLength(2);
  expect(bus.provider).toBe(bus.candidates[1]!);
  for (const candidate of bus.candidates) {
    expect(Object.keys(candidate).sort()).toEqual(["current", "handle", "idleMs", "version"]);
  }
});

test("on omp without pi.events the core stays inert and never throws", async () => {
  const session = mainSession();
  const core = session.loadWithoutBus(newer.startSessionCore);
  await session.start();
  await session.emit("agent_start");

  expect(core.isProvider()).toBe(false);
  expect(core.state()).toBeUndefined();
  expect(session.thrown).toEqual([]);
  expect(session.terminal.listeners.size).toBe(0);
  expect(stdout.writes).toEqual([]);
});
