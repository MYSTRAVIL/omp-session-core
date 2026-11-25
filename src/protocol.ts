/**
 * What the provider publishes on omp's extension event bus (`pi.events`).
 *
 * Within a protocol version, payloads only gain fields; clients ignore fields
 * they do not know. A breaking change gets a new channel name, and the
 * provider emits both channels for one deprecation window.
 */

import { isRecord } from "./guards.js";

/** Every change to a session's state, as {@link SessionStateV1}. */
export const SESSION_STATE_CHANNEL = "session-state";
/** Each settled terminal focus state, as {@link TerminalFocusV1}. */
export const TERMINAL_FOCUS_CHANNEL = "terminal-focus";

export type SessionStatus = "busy" | "idle";
export type WaitingOn = "ask" | "approval" | "plan-review";

/** The agent a session runs, as omp 18.3.2+ reports it in `ctx.agent`. */
export interface AgentIdentity {
  kind: "main" | "sub";
  /** omp's agent registry id, e.g. `Main` or `0-Explore`. */
  id: string;
  name: string;
  depth: number;
  /** Registry id of the spawning agent; absent for a top-level session. */
  parentId?: string;
}

/** The terminal a session with a UI runs in. */
export interface TerminalIdentity {
  pid: number;
  ppid: number;
  /** `WT_SESSION`: the Windows Terminal tab. */
  wtSession?: string;
  /** `TERM_PROGRAM`, e.g. `vscode`. */
  termProgram?: string;
  /** `OMP_VSCODE_TERMINAL`: the VS Code terminal omp-manager started. */
  vscodeTerminal?: string;
}

export interface SessionStateV1 {
  v: 1;
  sessionId: string;
  /** Absent for a session omp does not persist. */
  sessionFile?: string;
  cwd: string;
  /** Absent on omp before 18.3.2. */
  agent?: AgentIdentity;
  /** True when omp runs this session as a subagent (task, eval `agent()`, `/tan`). */
  subagent: boolean;
  /**
   * The id this session moved from. omp 18.4.9+ moves a resumed session that
   * another live omp holds to a new id at its first write, with no event.
   */
  movedFrom?: string;
  status: SessionStatus;
  /** What the session waits on the user for; absent when it waits on nothing. With several open, an approval outranks a plan review, which outranks an ask. */
  waitingOn?: WaitingOn;
  /** Present when the session has a UI in a terminal and is not a subagent: then its provider owns the terminal's focus reporting. */
  terminal?: TerminalIdentity;
  /** When this state began, in ms since the epoch. */
  at: number;
}

export interface TerminalFocusV1 {
  v: 1;
  sessionId: string;
  focused: boolean;
  at: number;
}

/** The payload as a v1 session state, or `undefined` when it is not one. */
export function asSessionState(value: unknown): SessionStateV1 | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  if (typeof value.sessionId !== "string" || typeof value.cwd !== "string") return undefined;
  if (value.status !== "busy" && value.status !== "idle") return undefined;
  if (typeof value.subagent !== "boolean" || !Number.isFinite(value.at)) return undefined;
  return value as unknown as SessionStateV1;
}

/** The payload as a v1 focus state, or `undefined` when it is not one. */
export function asTerminalFocus(value: unknown): TerminalFocusV1 | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  if (typeof value.sessionId !== "string" || typeof value.focused !== "boolean") return undefined;
  if (!Number.isFinite(value.at)) return undefined;
  return value as unknown as TerminalFocusV1;
}
