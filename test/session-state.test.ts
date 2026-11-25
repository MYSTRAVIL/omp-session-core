import { afterEach, beforeEach, expect, test } from "bun:test";
import { type SessionCore, type SessionStateV1, startSessionCore } from "../src/index";
import { FakeSession, FakeTerminal, MAIN_AGENT, type SessionInit } from "./fake-omp";
import { type CapturedStdout, captureStdout } from "./stdout";

let stdout: CapturedStdout;
beforeEach(() => {
  stdout = captureStdout();
});
afterEach(() => stdout.restore());

interface Started {
  session: FakeSession;
  core: SessionCore;
  states: SessionStateV1[];
}

async function started(init: Partial<SessionInit> = {}): Promise<Started> {
  const session = new FakeSession({ id: "s1", hasUI: true, agent: MAIN_AGENT, terminal: new FakeTerminal(), ...init });
  const core = session.load(startSessionCore);
  const states: SessionStateV1[] = [];
  core.onState((state) => states.push(state));
  await session.start();
  return { session, core, states };
}

test("a started session reports its identity, idle, and the terminal it runs in", async () => {
  const { core } = await started();

  expect(core.state()).toMatchObject({
    v: 1,
    sessionId: "s1",
    sessionFile: "/sessions/s1.jsonl",
    cwd: "/work",
    agent: MAIN_AGENT,
    subagent: false,
    status: "idle",
    terminal: { pid: process.pid, ppid: process.ppid },
  });
  expect(core.state()?.waitingOn).toBeUndefined();
  expect(core.state()?.movedFrom).toBeUndefined();
});

test("the terminal identity carries the terminal's environment", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { WT_SESSION: "wt-1", TERM_PROGRAM: "vscode", OMP_VSCODE_TERMINAL: "term-7" });
  try {
    const { core } = await started();
    expect(core.state()?.terminal).toMatchObject({ wtSession: "wt-1", termProgram: "vscode", vscodeTerminal: "term-7" });
  } finally {
    for (const key of ["WT_SESSION", "TERM_PROGRAM", "OMP_VSCODE_TERMINAL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a session whose output is not a terminal reports none", async () => {
  stdout.restore();
  stdout = captureStdout(false);
  const { core } = await started();

  expect(core.state()?.terminal).toBeUndefined();
});

test("agent_start makes the session busy, and agent_end idle", async () => {
  const { session, states } = await started();
  await session.emit("agent_start");
  await session.emit("agent_end", { messages: [] });

  expect(states.map((s) => s.status)).toEqual(["idle", "busy", "idle"]);
});

test("an agent_end with a continuation scheduled keeps the session busy", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("agent_end", { messages: [], willContinue: true });

  expect(core.state()?.status).toBe("busy");
});

test("an agent_end that only waits on a background job is idle", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });

  expect(core.state()?.status).toBe("idle");
});

test("a session that is streaming when the core starts reports busy", async () => {
  const session = new FakeSession({ id: "s1", hasUI: true, agent: MAIN_AGENT });
  session.idle = false;
  const core = session.load(startSessionCore);
  await session.start();

  expect(core.state()?.status).toBe("busy");
});

test("a state goes out only when it changes", async () => {
  const { session, states } = await started();
  await session.emit("agent_start");
  await session.emit("turn_start", { turnIndex: 0 });
  await session.emit("message_start", { message: {} });
  await session.emit("turn_end", { turnIndex: 0 });

  expect(states.map((s) => s.status)).toEqual(["idle", "busy"]);
});

test("an ask waits on the user until its tool result", async () => {
  const { session, states } = await started();
  await session.emit("agent_start");
  await session.emit("tool_call", { toolName: "ask", toolCallId: "c1", input: {} });
  await session.emit("tool_result", { toolName: "ask", toolCallId: "c1", input: {} });

  expect(states.map((s) => s.waitingOn)).toEqual([undefined, undefined, "ask", undefined]);
});

test("other tools do not wait on the user", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("tool_call", { toolName: "bash", toolCallId: "c1", input: {} });

  expect(core.state()?.waitingOn).toBeUndefined();
});

test("a tool approval waits on the user until it is resolved", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("tool_approval_requested", { sessionId: "s1", toolCallId: "c1", toolName: "bash" });
  expect(core.state()?.waitingOn).toBe("approval");
  await session.emit("tool_approval_resolved", { sessionId: "s1", toolCallId: "c1", toolName: "bash", approved: true });

  expect(core.state()?.waitingOn).toBeUndefined();
});

test("the newest open wait is the one reported", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("tool_approval_requested", { toolCallId: "c1", toolName: "bash" });
  await session.emit("tool_call", { toolName: "ask", toolCallId: "c2", input: {} });
  expect(core.state()?.waitingOn).toBe("ask");
  await session.emit("tool_result", { toolName: "ask", toolCallId: "c2", input: {} });

  expect(core.state()?.waitingOn).toBe("approval");
});

test("the end of a turn closes asks and approvals left open, but a plan review outlasts it", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("plan_review_requested", { reviewId: "r1" });
  await session.emit("tool_call", { toolName: "ask", toolCallId: "c1", input: {} });
  await session.emit("tool_approval_requested", { toolCallId: "c2", toolName: "bash" });
  await session.emit("agent_end", { messages: [] });
  expect(core.state()?.waitingOn).toBe("plan-review");
  await session.emit("plan_review_resolved", { reviewId: "r1", choice: "execute", by: "local" });

  expect(core.state()?.waitingOn).toBeUndefined();
});

test("a plan review already open when the core starts counts", async () => {
  const session = new FakeSession({ id: "s1", hasUI: true, agent: MAIN_AGENT });
  session.pendingPlanReview = { reviewId: "r1" };
  const core = session.load(startSessionCore);
  await session.start();

  expect(core.state()?.waitingOn).toBe("plan-review");
});

test("a switch reports the new session and drops the old one's waits", async () => {
  const { session, core } = await started();
  await session.emit("tool_approval_requested", { toolCallId: "c1", toolName: "bash" });
  await session.switchTo("s2", "resume");

  expect(core.state()).toMatchObject({ sessionId: "s2", sessionFile: "/sessions/s2.jsonl", status: "idle" });
  expect(core.state()?.waitingOn).toBeUndefined();
  expect(core.state()?.movedFrom).toBeUndefined();
});

test("a silent move reports the new id and the id it moved from, and keeps the open wait", async () => {
  const { session, core } = await started();
  await session.emit("agent_start");
  await session.emit("tool_call", { toolName: "ask", toolCallId: "c1", input: {} });
  // omp moves the session at its first write and emits nothing for it.
  session.id = "s1-moved";
  session.header = { parentSession: "s1", continuationOf: "s1" };
  await session.emit("turn_end", { turnIndex: 0 });

  expect(core.state()).toMatchObject({ sessionId: "s1-moved", movedFrom: "s1", status: "busy", waitingOn: "ask" });
});

test("a fork is not a move", async () => {
  const { session, core } = await started();
  await session.switchTo("s2", "fork", { parentSession: "s1" });
  await session.emit("agent_start");

  expect(core.state()?.sessionId).toBe("s2");
  expect(core.state()?.movedFrom).toBeUndefined();
});

test("a subagent is known from ctx.agent", async () => {
  const { core } = await started({
    id: "sub1",
    hasUI: false,
    terminal: undefined,
    agent: { kind: "sub", id: "0-Task", name: "task", depth: 1, parentId: "Main" },
  });

  expect(core.state()).toMatchObject({
    subagent: true,
    agent: { kind: "sub", id: "0-Task", name: "task", depth: 1, parentId: "Main" },
  });
  expect(core.state()?.terminal).toBeUndefined();
});

test("on omp without ctx.agent a subagent is known from its file layout, and a fork is not one", async () => {
  const sub = await started({
    id: "sub1",
    file: "/sessions/s1/0-Task.jsonl",
    hasUI: false,
    agent: undefined,
    header: { parentSession: "/sessions/s1.jsonl" },
  });
  const fork = await started({
    id: "fork1",
    file: "/sessions/fork1.jsonl",
    hasUI: false,
    agent: undefined,
    header: { parentSession: "/sessions/s1.jsonl" },
  });

  expect(sub.core.state()?.subagent).toBe(true);
  expect(sub.core.state()?.agent).toBeUndefined();
  expect(fork.core.state()?.subagent).toBe(false);
});

test("an app cannot change the state other apps read", async () => {
  const { core } = await started();
  const state = core.state();

  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state?.terminal)).toBe(true);
});

test("a session that throws on every read never throws into omp", async () => {
  const { session, core } = await started();
  session.broken = true;
  await session.emit("agent_start");
  await session.emit("tool_call", { toolName: "ask", toolCallId: "c1", input: {} });
  await session.switchTo("s2");
  await session.emit("agent_end", { messages: [] });

  expect(session.thrown).toEqual([]);
  expect(core.state()?.sessionId).toBe("s1");
});
