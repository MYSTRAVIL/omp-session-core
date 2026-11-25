import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { type SessionCore, type TerminalFocusV1, startSessionCore } from "../src/index";
import { FakeSession, FakeTerminal, MAIN_AGENT } from "./fake-omp";
import { type CapturedStdout, captureStdout } from "./stdout";

const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

let stdout: CapturedStdout;
beforeEach(() => {
  stdout = captureStdout();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  stdout.restore();
});

interface Started {
  session: FakeSession;
  terminal: FakeTerminal;
  core: SessionCore;
  focus: TerminalFocusV1[];
}

async function started(hasUI = true): Promise<Started> {
  const terminal = new FakeTerminal();
  const session = new FakeSession({ id: "s1", hasUI, agent: MAIN_AGENT, terminal });
  const core = session.load(startSessionCore);
  const focus: TerminalFocusV1[] = [];
  core.onFocus((f) => focus.push(f));
  await session.start();
  return { session, terminal, core, focus };
}

/** The user switches the focus, and the report holds long enough to settle. */
function settle(terminal: FakeTerminal, report: string): void {
  terminal.type(report);
  jest.advanceTimersByTime(100);
}

test("the provider asks a terminal session's terminal for focus reports", async () => {
  await started();

  expect(stdout.writes).toEqual([FOCUS_ON]);
});

test("focus reports never reach omp, and other input passes through", async () => {
  const { terminal } = await started();

  expect(terminal.type(FOCUS_IN)).toBeUndefined();
  expect(terminal.type(`a${FOCUS_OUT}b`)).toBe("ab");
  expect(terminal.type("x")).toBe("x");
});

test("a settled focus change goes out with the session id", async () => {
  const { terminal, core, focus } = await started();
  settle(terminal, FOCUS_OUT);

  expect(focus).toMatchObject([{ v: 1, sessionId: "s1", focused: false }]);
  expect(core.focus()).toMatchObject({ sessionId: "s1", focused: false });
});

test("after a switch the provider listens again and states the known focus under the new id", async () => {
  const { session, terminal, focus } = await started();
  settle(terminal, FOCUS_OUT);
  await session.switchTo("s2");

  expect(terminal.listeners.size).toBe(1);
  expect(terminal.type(FOCUS_IN)).toBeUndefined();
  expect(focus.at(-1)).toMatchObject({ sessionId: "s2", focused: false });
});

test("a silent move states the known focus under the new id", async () => {
  const { session, terminal, focus } = await started();
  settle(terminal, FOCUS_IN);
  session.id = "s1-moved";
  session.header = { continuationOf: "s1" };
  await session.emit("message_start", { message: {} });

  expect(focus.at(-1)).toMatchObject({ sessionId: "s1-moved", focused: true });
});

test("session_shutdown turns focus reporting off and stops taking input", async () => {
  const { session, terminal } = await started();
  await session.emit("session_shutdown");

  expect(stdout.writes.at(-1)).toBe(FOCUS_OFF);
  expect(terminal.listeners.size).toBe(0);
  expect(terminal.type(FOCUS_IN)).toBe(FOCUS_IN);
});

test("a session without a UI never touches the terminal", async () => {
  const { terminal } = await started(false);

  expect(stdout.writes).toEqual([]);
  expect(terminal.listeners.size).toBe(0);
});

test("a UI whose output is not a terminal never touches it", async () => {
  stdout.restore();
  stdout = captureStdout(false);
  const { terminal } = await started();

  expect(stdout.writes).toEqual([]);
  expect(terminal.listeners.size).toBe(0);
});

test("a subagent never touches the terminal, even with a UI", async () => {
  const terminal = new FakeTerminal();
  const session = new FakeSession({
    id: "tan1",
    hasUI: true,
    agent: { kind: "sub", id: "tan", name: "sub", depth: 0, parentId: "Main" },
    terminal,
  });
  const core = session.load(startSessionCore);
  await session.start();
  await session.emit("session_shutdown");

  expect(stdout.writes).toEqual([]);
  expect(terminal.listeners.size).toBe(0);
  expect(core.state()?.terminal).toBeUndefined();
});
