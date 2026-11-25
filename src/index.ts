import { deskIdleMs } from "./desk-idle.js";
import type { OmpEventBus, OmpExtensionApi } from "./omp.js";
import {
  SESSION_STATE_CHANNEL,
  type SessionStateV1,
  TERMINAL_FOCUS_CHANNEL,
  type TerminalFocusV1,
  asSessionState,
  asTerminalFocus,
} from "./protocol.js";
import { Provider } from "./provider.js";
import { type BusV1, type CandidateV1, busEntry, elect, registry } from "./registry.js";
import { VERSION } from "./version.js";

export * from "./protocol.js";
export type { OmpExtensionApi } from "./omp.js";

/** One app's view of the session core on its event bus. */
export interface SessionCore {
  /** This copy's version. */
  readonly version: string;
  /** True when this copy runs the state machine for its bus; false before the first `session_start`. */
  isProvider(): boolean;
  /** Every change to the session's state. Returns the unsubscribe. */
  onState(listener: (state: SessionStateV1) => void): () => void;
  /** Every settled change of the terminal's focus. Returns the unsubscribe. */
  onFocus(listener: (focus: TerminalFocusV1) => void): () => void;
  /** The session's current state; `undefined` until the provider has started. */
  state(): SessionStateV1 | undefined;
  /** The terminal's last settled focus; `undefined` until the terminal has reported one. */
  focus(): TerminalFocusV1 | undefined;
  /** Milliseconds since the desk's last keyboard or mouse input; `null` when unknown (every platform but Windows). */
  idleMs(): number | null;
}

/**
 * The omp events every copy passes on to its bus's provider. A provider
 * ignores the types it has no use for, so the list is wider than this
 * version's state machine: a newer provider gets these from every older copy.
 * It holds no per-delta event (`message_update`, `tool_execution_update`) and
 * none whose handler result omp acts on beyond `undefined`.
 */
const PASSED_ON_EVENTS = [
  "session_start",
  "session_switch",
  "session_branch",
  "session_clear",
  "session_tree",
  "session_compact",
  "session_shutdown",
  "before_agent_start",
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
  "goal_updated",
] as const;

/**
 * Joins the session core on this extension's event bus. Call it from the
 * extension's factory, before the extension registers handlers of its own:
 * then the state is up to date inside each of them. It never throws, and on
 * an omp without `pi.events` it returns a core that reports nothing.
 */
export function startSessionCore(pi: OmpExtensionApi): SessionCore {
  try {
    const bus = pi.events;
    if (!bus || typeof bus.on !== "function" || typeof bus.emit !== "function") return inertCore();
    const reg = registry();
    if (!reg) return inertCore();
    const entry = busEntry(reg, bus);
    const provider = new Provider(bus);
    const candidate: CandidateV1 = Object.freeze({
      version: VERSION,
      handle: (type: string, event: unknown, ctx: unknown) => provider.handle(type, event, ctx),
      current: (channel: string) => provider.current(channel),
      idleMs: deskIdleMs,
    });
    entry.candidates.push(candidate);
    // Whichever copy's handler runs first passes the event on to the provider
    // (and elects it at the first `session_start`), so the provider is up to
    // date before any app's own handler for that event runs.
    for (const type of PASSED_ON_EVENTS) {
      pi.on(type, (event: unknown, ctx: unknown) => {
        try {
          const current = type === "session_start" ? elect(entry) : entry.provider;
          current?.handle(type, event, ctx);
        } catch {
          // Never throw into omp.
        }
        return undefined;
      });
    }
    return clientCore(bus, entry, candidate);
  } catch {
    return inertCore();
  }
}

function subscribe<T>(
  bus: OmpEventBus,
  channel: string,
  parse: (data: unknown) => T | undefined,
  listener: (value: T) => void,
): () => void {
  try {
    const off = bus.on(channel, (data) => {
      const value = parse(data);
      if (value === undefined) return;
      try {
        listener(value);
      } catch {
        // An app's listener must not break the others.
      }
    });
    return () => {
      try {
        if (typeof off === "function") off();
      } catch {
        // Unsubscribing never throws.
      }
    };
  } catch {
    return () => {};
  }
}

/** Reads the provider, which may be another copy of any version. */
function fromProvider<T>(entry: BusV1, read: (provider: CandidateV1) => T, fallback: T): T {
  try {
    const provider = entry.provider;
    return provider ? read(provider) : fallback;
  } catch {
    return fallback;
  }
}

function clientCore(bus: OmpEventBus, entry: BusV1, candidate: CandidateV1): SessionCore {
  return {
    version: VERSION,
    isProvider: () => entry.provider === candidate,
    onState: (listener) => subscribe(bus, SESSION_STATE_CHANNEL, asSessionState, listener),
    onFocus: (listener) => subscribe(bus, TERMINAL_FOCUS_CHANNEL, asTerminalFocus, listener),
    state: () => fromProvider(entry, (p) => asSessionState(p.current(SESSION_STATE_CHANNEL)), undefined),
    focus: () => fromProvider(entry, (p) => asTerminalFocus(p.current(TERMINAL_FOCUS_CHANNEL)), undefined),
    idleMs: () => (entry.provider ? fromProvider(entry, (p) => p.idleMs(), null) : deskIdleMs()),
  };
}

function inertCore(): SessionCore {
  return {
    version: VERSION,
    isProvider: () => false,
    onState: () => () => {},
    onFocus: () => () => {},
    state: () => undefined,
    focus: () => undefined,
    idleMs: deskIdleMs,
  };
}
