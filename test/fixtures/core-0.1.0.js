// @bun
// src/desk-idle.ts
import { FFIType, dlopen } from "bun:ffi";
var unknownIdle = () => null;
var probe;
function windowsProbe() {
  const user32 = dlopen("user32.dll", {
    GetLastInputInfo: { args: [FFIType.ptr], returns: FFIType.i32 }
  });
  const kernel32 = dlopen("kernel32.dll", {
    GetTickCount: { args: [], returns: FFIType.u32 }
  });
  const info = new Uint32Array([8, 0]);
  return () => {
    if (user32.symbols.GetLastInputInfo(info) === 0)
      return null;
    return kernel32.symbols.GetTickCount() - (info[1] ?? 0) >>> 0;
  };
}
function loadProbe() {
  if (process.platform !== "win32")
    return unknownIdle;
  try {
    return windowsProbe();
  } catch {
    return unknownIdle;
  }
}
function deskIdleMs() {
  probe ??= loadProbe();
  try {
    return probe();
  } catch {
    return null;
  }
}

// src/guards.ts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// src/protocol.ts
var SESSION_STATE_CHANNEL = "session-state";
var TERMINAL_FOCUS_CHANNEL = "terminal-focus";
function asSessionState(value) {
  if (!isRecord(value) || value.v !== 1)
    return;
  if (typeof value.sessionId !== "string" || typeof value.cwd !== "string")
    return;
  if (value.status !== "busy" && value.status !== "idle")
    return;
  if (typeof value.subagent !== "boolean" || !Number.isFinite(value.at))
    return;
  return value;
}
function asTerminalFocus(value) {
  if (!isRecord(value) || value.v !== 1)
    return;
  if (typeof value.sessionId !== "string" || typeof value.focused !== "boolean")
    return;
  if (!Number.isFinite(value.at))
    return;
  return value;
}

// src/identity.ts
import { dirname, resolve } from "path";
function agentOf(ctx) {
  const agent = ctx.agent;
  if (!isRecord(agent))
    return;
  const { kind, id, name, depth, parentId } = agent;
  if (kind !== "main" && kind !== "sub")
    return;
  if (typeof id !== "string" || typeof name !== "string" || typeof depth !== "number")
    return;
  return typeof parentId === "string" ? { kind, id, name, depth, parentId } : { kind, id, name, depth };
}
var SESSION_FILE_EXT = ".jsonl";
function isSubagent(ctx, agent) {
  if (agent)
    return agent.kind === "sub";
  if (ctx.hasUI)
    return false;
  const file = ctx.sessionManager.getSessionFile?.();
  const parent = ctx.sessionManager.getHeader?.()?.parentSession;
  if (!file || !parent?.endsWith(SESSION_FILE_EXT))
    return false;
  return resolve(dirname(file)) === resolve(parent.slice(0, -SESSION_FILE_EXT.length));
}
function hasTerminal(ctx) {
  return ctx.hasUI === true && process.stdout.isTTY === true;
}
function terminalIdentity() {
  const env = process.env;
  const terminal = { pid: process.pid, ppid: process.ppid };
  if (env.WT_SESSION)
    terminal.wtSession = env.WT_SESSION;
  if (env.TERM_PROGRAM)
    terminal.termProgram = env.TERM_PROGRAM;
  if (env.OMP_VSCODE_TERMINAL)
    terminal.vscodeTerminal = env.OMP_VSCODE_TERMINAL;
  return terminal;
}

// src/terminal-focus.ts
var FOCUS_REPORTING_ON = "\x1B[?1004h";
var FOCUS_REPORTING_OFF = "\x1B[?1004l";
var FOCUS_IN = "\x1B[I";
var FOCUS_OUT = "\x1B[O";
var FOCUS_SETTLE_MS = 100;
var realSetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

class TerminalFocus {
  #changed;
  #setTimer;
  #focused;
  #cancelSettle;
  constructor(changed, setTimer = realSetTimer) {
    this.#changed = changed;
    this.#setTimer = setTimer;
  }
  get focused() {
    return this.#focused;
  }
  input(data) {
    const lastIn = data.lastIndexOf(FOCUS_IN);
    const lastOut = data.lastIndexOf(FOCUS_OUT);
    if (lastIn < 0 && lastOut < 0) {
      if (this.#focused === undefined && !data.startsWith("\x1B"))
        this.#report(true);
      return;
    }
    this.#report(lastIn > lastOut);
    const rest = data.replaceAll(FOCUS_IN, "").replaceAll(FOCUS_OUT, "");
    return rest.length === 0 ? { consume: true } : { data: rest };
  }
  stop() {
    this.#cancelSettle?.();
    this.#cancelSettle = undefined;
  }
  #report(focused) {
    this.#cancelSettle?.();
    this.#cancelSettle = this.#setTimer(() => {
      this.#cancelSettle = undefined;
      if (this.#focused === focused)
        return;
      this.#focused = focused;
      this.#changed(focused);
    }, FOCUS_SETTLE_MS);
  }
}

// src/provider.ts
var focusReportingUsed = false;
var exitHookInstalled = false;
function writeTerminal(data) {
  try {
    process.stdout.write(data);
  } catch {}
}
function deepFreeze(value) {
  for (const field of Object.values(value)) {
    if (typeof field === "object" && field !== null)
      deepFreeze(field);
  }
  return Object.freeze(value);
}

class Provider {
  #bus;
  #active = false;
  #seen = new WeakSet;
  #identity;
  #status = "idle";
  #waits = new Map;
  #last = new Map;
  #lastStateKey;
  #focus = new TerminalFocus((focused) => {
    try {
      this.#publishFocus(focused);
    } catch {}
  });
  #unlisten;
  #reporting = false;
  #handlers = new Map([
    ["session_start", (_, ctx) => this.#reset(ctx)],
    ["session_switch", (_, ctx) => this.#reset(ctx)],
    ["session_branch", (_, ctx) => this.#reset(ctx)],
    [
      "session_clear",
      (_, ctx) => {
        this.#follow(ctx);
        this.#status = statusOf(ctx);
        this.#publish();
      }
    ],
    ["agent_start", (_, ctx) => this.#busy(ctx)],
    ["turn_start", (_, ctx) => this.#busy(ctx)],
    ["message_start", (_, ctx) => this.#follow(ctx)],
    ["turn_end", (_, ctx) => this.#follow(ctx)],
    [
      "agent_end",
      (event, ctx) => {
        this.#follow(ctx);
        const continues = event.willContinue === true && event.awaitingAsyncWork !== true;
        this.#status = continues ? "busy" : "idle";
        for (const [key, kind] of this.#waits)
          if (kind !== "plan-review")
            this.#waits.delete(key);
        this.#publish();
      }
    ],
    [
      "tool_call",
      (event) => {
        if (event.toolName === "ask")
          this.#open(`ask:${String(event.toolCallId)}`, "ask");
      }
    ],
    ["tool_result", (event) => this.#close(`ask:${String(event.toolCallId)}`)],
    ["tool_approval_requested", (event) => this.#open(`approval:${String(event.toolCallId)}`, "approval")],
    ["tool_approval_resolved", (event) => this.#close(`approval:${String(event.toolCallId)}`)],
    ["plan_review_requested", (event) => this.#open(`plan:${String(event.reviewId)}`, "plan-review")],
    ["plan_review_resolved", (event) => this.#close(`plan:${String(event.reviewId)}`)],
    ["session_shutdown", () => this.#stopTerminal()]
  ]);
  constructor(bus) {
    this.#bus = bus;
  }
  handle(type, event, ctx) {
    try {
      const run = this.#handlers.get(type);
      if (!run || typeof event !== "object" || event === null || this.#seen.has(event))
        return;
      this.#seen.add(event);
      if (type === "session_start")
        this.#active = true;
      else if (!this.#active)
        return;
      run(event, ctx);
    } catch {}
  }
  current(channel) {
    return this.#last.get(channel);
  }
  #reset(ctx) {
    this.#identity = readIdentity(ctx, undefined);
    this.#status = statusOf(ctx);
    this.#waits.clear();
    const review = ctx.getPendingPlanReview?.();
    if (review)
      this.#waits.set(`plan:${review.reviewId}`, "plan-review");
    this.#publish();
    this.#listen(ctx);
  }
  #busy(ctx) {
    this.#follow(ctx);
    this.#status = "busy";
    this.#publish();
  }
  #follow(ctx) {
    const previous = this.#identity?.sessionId;
    if (ctx.sessionManager.getSessionId() === previous)
      return;
    const header = ctx.sessionManager.getHeader?.();
    const from = header?.continuationOf ?? header?.parentSession;
    const movedFrom = previous !== undefined && from === previous ? previous : undefined;
    this.#identity = readIdentity(ctx, movedFrom);
    if (!movedFrom)
      this.#waits.clear();
    this.#publish();
    this.#republishFocus();
  }
  #open(key, kind) {
    this.#waits.delete(key);
    this.#waits.set(key, kind);
    this.#publish();
  }
  #close(key) {
    if (this.#waits.delete(key))
      this.#publish();
  }
  #publish() {
    if (!this.#identity)
      return;
    const waitingOn = [...this.#waits.values()].at(-1);
    const state = { v: 1, ...this.#identity, status: this.#status };
    if (waitingOn)
      state.waitingOn = waitingOn;
    const key = JSON.stringify(state);
    if (key === this.#lastStateKey)
      return;
    this.#lastStateKey = key;
    this.#emit(SESSION_STATE_CHANNEL, { ...state, at: Date.now() });
  }
  #emit(channel, payload) {
    deepFreeze(payload);
    this.#last.set(channel, payload);
    try {
      this.#bus.emit(channel, payload);
    } catch {}
  }
  #listen(ctx) {
    this.#unlisten?.();
    this.#unlisten = undefined;
    const onTerminalInput = ctx.ui?.onTerminalInput;
    if (!hasTerminal(ctx) || typeof onTerminalInput !== "function")
      return;
    this.#unlisten = onTerminalInput.call(ctx.ui, (data) => {
      try {
        return this.#focus.input(data);
      } catch {
        return;
      }
    });
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => {
        if (focusReportingUsed)
          writeTerminal(FOCUS_REPORTING_OFF);
      });
    }
    focusReportingUsed = true;
    this.#reporting = true;
    writeTerminal(FOCUS_REPORTING_ON);
    this.#republishFocus();
  }
  #stopTerminal() {
    this.#unlisten?.();
    this.#unlisten = undefined;
    this.#focus.stop();
    if (!this.#reporting)
      return;
    this.#reporting = false;
    writeTerminal(FOCUS_REPORTING_OFF);
  }
  #republishFocus() {
    const focused = this.#focus.focused;
    if (focused !== undefined)
      this.#publishFocus(focused);
  }
  #publishFocus(focused) {
    if (!this.#identity || !this.#reporting)
      return;
    const focus = { v: 1, sessionId: this.#identity.sessionId, focused, at: Date.now() };
    this.#emit(TERMINAL_FOCUS_CHANNEL, focus);
  }
}
function statusOf(ctx) {
  return ctx.isIdle?.() === false ? "busy" : "idle";
}
function readIdentity(ctx, movedFrom) {
  const sessions = ctx.sessionManager;
  const agent = agentOf(ctx);
  const identity = {
    sessionId: sessions.getSessionId(),
    cwd: ctx.cwd ?? sessions.getCwd?.() ?? process.cwd(),
    subagent: isSubagent(ctx, agent)
  };
  const file = sessions.getSessionFile?.();
  if (file)
    identity.sessionFile = file;
  if (agent)
    identity.agent = agent;
  if (movedFrom)
    identity.movedFrom = movedFrom;
  if (hasTerminal(ctx))
    identity.terminal = terminalIdentity();
  return identity;
}

// src/semver.ts
var SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parse(version) {
  const m = SEMVER.exec(version);
  if (!m)
    return;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split(".")
  };
}
function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum)
    return Number(a) - Number(b);
  if (aNum)
    return -1;
  if (bNum)
    return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb)
    return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0;i < 3; i++) {
    const d = pa.core[i] - pb.core[i];
    if (d !== 0)
      return d;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0)
    return pb.pre.length - pa.pre.length;
  for (let i = 0;i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const d = compareIdentifiers(pa.pre[i], pb.pre[i]);
    if (d !== 0)
      return d;
  }
  return pa.pre.length - pb.pre.length;
}

// src/registry.ts
var KEY = Symbol.for("omp-session-core");
function isRegistryV1(value) {
  return isRecord(value) && value.registry === 1 && value.buses instanceof WeakMap;
}
function registry() {
  const existing = Reflect.get(globalThis, KEY);
  if (existing !== undefined)
    return isRegistryV1(existing) ? existing : undefined;
  const made = Object.freeze({ registry: 1, buses: new WeakMap });
  Object.defineProperty(globalThis, KEY, { value: made, enumerable: false, writable: false, configurable: false });
  return made;
}
function busEntry(reg, bus) {
  let entry = reg.buses.get(bus);
  if (!entry) {
    entry = Object.seal({ candidates: [], provider: undefined });
    reg.buses.set(bus, entry);
  }
  return entry;
}
function elect(entry) {
  if (entry.provider)
    return entry.provider;
  let best;
  for (const candidate of entry.candidates) {
    if (!best || compareVersions(candidate.version, best.version) > 0)
      best = candidate;
  }
  entry.provider = best;
  return best;
}

// src/version.ts
var VERSION = "0.1.0";

// src/index.ts
var PASSED_ON_EVENTS = [
  "session_start",
  "session_switch",
  "session_branch",
  "session_clear",
  "session_tree",
  "session_compact",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "tool_call",
  "tool_result",
  "tool_execution_start",
  "tool_execution_end",
  "tool_approval_requested",
  "tool_approval_resolved",
  "plan_review_requested",
  "plan_review_resolved",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "mode_changed",
  "goal_updated"
];
function startSessionCore(pi) {
  try {
    const bus = pi.events;
    if (!bus || typeof bus.on !== "function" || typeof bus.emit !== "function")
      return inertCore();
    const reg = registry();
    if (!reg)
      return inertCore();
    const entry = busEntry(reg, bus);
    const provider = new Provider(bus);
    const candidate = Object.freeze({
      version: VERSION,
      handle: (type, event, ctx) => provider.handle(type, event, ctx),
      current: (channel) => provider.current(channel),
      idleMs: deskIdleMs
    });
    entry.candidates.push(candidate);
    for (const type of PASSED_ON_EVENTS) {
      pi.on(type, (event, ctx) => {
        try {
          const current = type === "session_start" ? elect(entry) : entry.provider;
          current?.handle(type, event, ctx);
        } catch {}
        return;
      });
    }
    return clientCore(bus, entry, candidate);
  } catch {
    return inertCore();
  }
}
function subscribe(bus, channel, parse, listener) {
  try {
    const off = bus.on(channel, (data) => {
      const value = parse(data);
      if (value === undefined)
        return;
      try {
        listener(value);
      } catch {}
    });
    return () => {
      try {
        if (typeof off === "function")
          off();
      } catch {}
    };
  } catch {
    return () => {};
  }
}
function fromProvider(entry, read, fallback) {
  try {
    const provider = entry.provider;
    return provider ? read(provider) : fallback;
  } catch {
    return fallback;
  }
}
function clientCore(bus, entry, candidate) {
  return {
    version: VERSION,
    isProvider: () => entry.provider === candidate,
    onState: (listener) => subscribe(bus, SESSION_STATE_CHANNEL, asSessionState, listener),
    onFocus: (listener) => subscribe(bus, TERMINAL_FOCUS_CHANNEL, asTerminalFocus, listener),
    state: () => fromProvider(entry, (p) => asSessionState(p.current(SESSION_STATE_CHANNEL)), undefined),
    focus: () => fromProvider(entry, (p) => asTerminalFocus(p.current(TERMINAL_FOCUS_CHANNEL)), undefined),
    idleMs: () => entry.provider ? fromProvider(entry, (p) => p.idleMs(), null) : deskIdleMs()
  };
}
function inertCore() {
  return {
    version: VERSION,
    isProvider: () => false,
    onState: () => () => {},
    onFocus: () => () => {},
    state: () => {
      return;
    },
    focus: () => {
      return;
    },
    idleMs: deskIdleMs
  };
}
export {
  SESSION_STATE_CHANNEL,
  TERMINAL_FOCUS_CHANNEL,
  asSessionState,
  asTerminalFocus,
  startSessionCore
};
