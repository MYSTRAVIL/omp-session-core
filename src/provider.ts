import { agentOf, hasTerminal, isSubagent, terminalIdentity } from "./identity.js";
import type { OmpContext, OmpEventBus } from "./omp.js";
import {
  SESSION_STATE_CHANNEL,
  type SessionStateV1,
  type SessionStatus,
  TERMINAL_FOCUS_CHANNEL,
  type TerminalFocusV1,
  type WaitingOn,
} from "./protocol.js";
import { FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, TerminalFocus } from "./terminal-focus.js";

/** The fields of a session state that only change when omp runs another session. */
type Identity = Pick<
  SessionStateV1,
  "sessionId" | "sessionFile" | "cwd" | "agent" | "subagent" | "movedFrom" | "terminal"
>;

/** An omp event, read field by field. */
type OmpEvent = Record<string, unknown>;

/**
 * Which open wait the state reports when several are open: an approval holds
 * a tool call, a plan review holds the plan's run, an ask is one question.
 */
const WAIT_RANK: readonly WaitingOn[] = ["approval", "plan-review", "ask"];

/** Whether this copy ever turned focus reporting on; the exit hook turns it off. */
let focusReportingUsed = false;
let exitHookInstalled = false;

function writeTerminal(data: string): void {
  try {
    process.stdout.write(data);
  } catch {
    // A closed terminal reports nothing either way.
  }
}

function deepFreeze<T extends object>(value: T): T {
  for (const field of Object.values(value)) {
    if (typeof field === "object" && field !== null) deepFreeze(field);
  }
  return Object.freeze(value);
}

/**
 * Runs the session state machine for one event bus. Every copy builds one;
 * only the elected one gets events, through {@link handle}, from whichever
 * copy's omp handler runs first.
 */
export class Provider {
  readonly #bus: OmpEventBus;
  #active = false;
  /** The omp events already handled: every copy passes on the same event object. */
  readonly #seen = new WeakSet<object>();
  #identity: Identity | undefined;
  #status: SessionStatus = "idle";
  /** Open waits on the user, by key; the highest-ranked kind is the one reported. */
  readonly #waits = new Map<string, WaitingOn>();
  /** The last payload emitted on each channel. */
  readonly #last = new Map<string, unknown>();
  #lastStateKey: string | undefined;
  readonly #focus = new TerminalFocus((focused) => {
    try {
      this.#publishFocus(focused);
    } catch {
      // A timer callback must not throw into omp's process.
    }
  });
  #unlisten: (() => void) | undefined;
  #reporting = false;
  /** Session managers whose move notices this provider follows, and how to stop following them. */
  #noticed = new WeakSet<object>();
  readonly #unwatchMoves: (() => void)[] = [];

  /** What each omp event does to the state. Every handler is idempotent. */
  readonly #handlers = new Map<string, (event: OmpEvent, ctx: OmpContext) => void>([
    ["session_start", (_, ctx) => this.#reset(ctx)],
    ["session_switch", (_, ctx) => this.#reset(ctx)],
    ["session_branch", (_, ctx) => this.#reset(ctx)],
    [
      "session_clear",
      (_, ctx) => {
        this.#follow(ctx);
        this.#status = statusOf(ctx);
        this.#publish();
      },
    ],
    ["agent_start", (_, ctx) => this.#busy(ctx)],
    ["turn_start", (_, ctx) => this.#busy(ctx)],
    // A move's first write lands after `agent_start`, so the id is checked
    // again as each message starts and each turn ends. A move made between
    // turns on omp without persistence notices shows by `before_agent_start`.
    ["before_agent_start", (_, ctx) => this.#follow(ctx)],
    ["message_start", (_, ctx) => this.#follow(ctx)],
    ["turn_end", (_, ctx) => this.#follow(ctx)],
    [
      "agent_end",
      (event, ctx) => {
        this.#follow(ctx);
        // `willContinue` means omp already scheduled the next run, except with
        // `awaitingAsyncWork` (omp 18.11.0+): then only a background job's result
        // can resume it, and the session takes input meanwhile.
        const continues = event.willContinue === true && event.awaitingAsyncWork !== true;
        this.#status = continues ? "busy" : "idle";
        // Asks and approvals live inside a turn; a plan review can outlast it.
        for (const [key, kind] of this.#waits) if (kind !== "plan-review") this.#waits.delete(key);
        this.#publish();
      },
    ],
    [
      "tool_call",
      (event) => {
        if (event.toolName === "ask") this.#open(`ask:${String(event.toolCallId)}`, "ask");
      },
    ],
    ["tool_result", (event) => this.#close(`ask:${String(event.toolCallId)}`)],
    ["tool_approval_requested", (event) => this.#open(`approval:${String(event.toolCallId)}`, "approval")],
    ["tool_approval_resolved", (event) => this.#close(`approval:${String(event.toolCallId)}`)],
    ["plan_review_requested", (event) => this.#open(`plan:${String(event.reviewId)}`, "plan-review")],
    [
      "plan_review_resolved",
      (event, ctx) => {
        // omp emits the close after the overlay shuts, so an approved plan may already run.
        if (ctx.isIdle?.() === false) this.#status = "busy";
        this.#waits.delete(`plan:${String(event.reviewId)}`);
        this.#publish();
      },
    ],
    [
      "session_shutdown",
      () => {
        this.#stopTerminal();
        for (const unwatch of this.#unwatchMoves.splice(0)) unwatch();
        this.#noticed = new WeakSet();
      },
    ],
  ]);

  constructor(bus: OmpEventBus) {
    this.#bus = bus;
  }

  /**
   * One omp event. Handled once per event object, ignored when its type has
   * no handler or before the first `session_start`. Never throws.
   */
  handle(type: string, event: unknown, ctx: unknown): void {
    try {
      const run = this.#handlers.get(type);
      if (!run || typeof event !== "object" || event === null || this.#seen.has(event)) return;
      this.#seen.add(event);
      if (type === "session_start") this.#active = true;
      else if (!this.#active) return;
      // omp's own event and ctx, as its runner passed them to every extension.
      run(event as OmpEvent, ctx as OmpContext);
    } catch {
      // Never throw into omp: a throwing `tool_call` handler blocks the tool.
    }
  }

  current(channel: string): unknown {
    return this.#last.get(channel);
  }

  /** A session starts, or omp replaces it with another (`/new`, `/resume`, `/fork`, `/branch`). */
  #reset(ctx: OmpContext): void {
    this.#identity = readIdentity(ctx, undefined);
    this.#status = statusOf(ctx);
    this.#waits.clear();
    const review = ctx.getPendingPlanReview?.();
    if (review) this.#waits.set(`plan:${review.reviewId}`, "plan-review");
    this.#publish();
    this.#watchMoves(ctx);
    // omp drops extension input listeners when it replaces the session.
    this.#listen(ctx);
  }

  /**
   * A write outside any turn (e.g. `/model` before the first prompt of a
   * resumed session another omp holds) moves the session with no event; omp
   * 18.5+ raises only a persistence notice. Followed once per session manager.
   */
  #watchMoves(ctx: OmpContext): void {
    const sessions = ctx.sessionManager;
    if (typeof sessions.onPersistenceNotice !== "function" || this.#noticed.has(sessions)) return;
    this.#noticed.add(sessions);
    const unwatch = sessions.onPersistenceNotice(() => {
      try {
        this.#follow(ctx);
      } catch {
        // The notice comes from omp's write path: never throw into it.
      }
    });
    if (typeof unwatch === "function") this.#unwatchMoves.push(unwatch);
  }

  #busy(ctx: OmpContext): void {
    this.#follow(ctx);
    this.#status = "busy";
    this.#publish();
  }

  /**
   * Follows a session id that changed with no event. Since 18.4.9 omp leases a
   * session to the live process that writes it: a process that resumed a
   * session another live omp holds moves, at its first write, to a sibling
   * file with a new id whose header names the old id, in `continuationOf`
   * since 18.13.2 (a fork never sets it), before that only in `parentSession`.
   */
  #follow(ctx: OmpContext): void {
    const previous = this.#identity?.sessionId;
    if (ctx.sessionManager.getSessionId() === previous) return;
    const header = ctx.sessionManager.getHeader?.();
    const from = header?.continuationOf ?? header?.parentSession;
    const movedFrom = previous !== undefined && from === previous ? previous : undefined;
    this.#identity = readIdentity(ctx, movedFrom);
    if (!movedFrom) this.#waits.clear();
    this.#publish();
    this.#republishFocus();
  }

  #open(key: string, kind: WaitingOn): void {
    this.#waits.set(key, kind);
    this.#publish();
  }

  #close(key: string): void {
    if (this.#waits.delete(key)) this.#publish();
  }

  #publish(): void {
    if (!this.#identity) return;
    const open = new Set(this.#waits.values());
    const waitingOn = WAIT_RANK.find((kind) => open.has(kind));
    const state: Omit<SessionStateV1, "at"> = { v: 1, ...this.#identity, status: this.#status };
    if (waitingOn) state.waitingOn = waitingOn;
    const key = JSON.stringify(state);
    if (key === this.#lastStateKey) return;
    this.#lastStateKey = key;
    this.#emit(SESSION_STATE_CHANNEL, { ...state, at: Date.now() });
  }

  #emit(channel: string, payload: object): void {
    deepFreeze(payload);
    this.#last.set(channel, payload);
    try {
      this.#bus.emit(channel, payload);
    } catch {
      // Older omp may let a listener's throw through.
    }
  }

  /**
   * Ask the terminal for focus reports and take them out of omp's input, when
   * the session has the terminal: a UI in a TTY, and not a subagent, whose
   * shutdown would otherwise turn the reports off under the main session.
   */
  #listen(ctx: OmpContext): void {
    this.#unlisten?.();
    this.#unlisten = undefined;
    const onTerminalInput = ctx.ui?.onTerminalInput;
    if (!this.#identity?.terminal || typeof onTerminalInput !== "function") return;
    this.#unlisten = onTerminalInput.call(ctx.ui, (data: string) => {
      try {
        return this.#focus.input(data);
      } catch {
        return undefined;
      }
    });
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      // Left on, the shell would get the reports as stray input.
      process.once("exit", () => {
        if (focusReportingUsed) writeTerminal(FOCUS_REPORTING_OFF);
      });
    }
    focusReportingUsed = true;
    this.#reporting = true;
    writeTerminal(FOCUS_REPORTING_ON);
    // The new session starts with the focus the terminal already has.
    this.#republishFocus();
  }

  #stopTerminal(): void {
    this.#unlisten?.();
    this.#unlisten = undefined;
    this.#focus.stop();
    if (!this.#reporting) return;
    this.#reporting = false;
    writeTerminal(FOCUS_REPORTING_OFF);
  }

  #republishFocus(): void {
    const focused = this.#focus.focused;
    if (focused !== undefined) this.#publishFocus(focused);
  }

  #publishFocus(focused: boolean): void {
    if (!this.#identity || !this.#reporting) return;
    const focus: TerminalFocusV1 = { v: 1, sessionId: this.#identity.sessionId, focused, at: Date.now() };
    this.#emit(TERMINAL_FOCUS_CHANNEL, focus);
  }
}

function statusOf(ctx: OmpContext): SessionStatus {
  return ctx.isIdle?.() === false ? "busy" : "idle";
}

function readIdentity(ctx: OmpContext, movedFrom: string | undefined): Identity {
  const sessions = ctx.sessionManager;
  const agent = agentOf(ctx);
  const identity: Identity = {
    sessionId: sessions.getSessionId(),
    cwd: ctx.cwd ?? sessions.getCwd?.() ?? process.cwd(),
    subagent: isSubagent(ctx, agent),
  };
  const file = sessions.getSessionFile?.();
  if (file) identity.sessionFile = file;
  if (agent) identity.agent = agent;
  if (movedFrom) identity.movedFrom = movedFrom;
  if (!identity.subagent && hasTerminal(ctx)) identity.terminal = terminalIdentity();
  return identity;
}
