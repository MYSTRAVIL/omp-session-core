import { dirname, resolve } from "node:path";
import { isRecord } from "./guards.js";
import type { OmpContext } from "./omp.js";
import type { AgentIdentity, TerminalIdentity } from "./protocol.js";

/** `ctx.agent` as omp 18.3.2+ reports it; `undefined` on older omp or when it is malformed. */
export function agentOf(ctx: OmpContext): AgentIdentity | undefined {
  const agent = ctx.agent;
  if (!isRecord(agent)) return undefined;
  const { kind, id, name, depth, parentId } = agent;
  if (kind !== "main" && kind !== "sub") return undefined;
  if (typeof id !== "string" || typeof name !== "string" || typeof depth !== "number") return undefined;
  return typeof parentId === "string" ? { kind, id, name, depth, parentId } : { kind, id, name, depth };
}

const SESSION_FILE_EXT = ".jsonl";

/**
 * True when omp runs this session as a subagent (a `task`, eval `agent()` or
 * `/tan` child) rather than as a session of its own. omp 18.3.2+ says so in
 * `ctx.agent.kind` (not `depth`: a `/tan` clone is a subagent at depth 0).
 *
 * Older omp is inferred from the session's layout: omp runs a subagent in the
 * parent's process, headless, and stores it in the parent's artifacts dir:
 * `<parent>.jsonl` gets `<parent>/<agentId>.jsonl`, with the parent file
 * recorded as the header's `parentSession`. A fork also records a parent but
 * lives beside it, and a subagent transcript reopened in the TUI has a UI, so
 * neither counts.
 */
export function isSubagent(ctx: OmpContext, agent: AgentIdentity | undefined): boolean {
  if (agent) return agent.kind === "sub";
  if (ctx.hasUI) return false;
  const file = ctx.sessionManager.getSessionFile?.();
  const parent = ctx.sessionManager.getHeader?.()?.parentSession;
  if (!file || !parent?.endsWith(SESSION_FILE_EXT)) return false;
  return resolve(dirname(file)) === resolve(parent.slice(0, -SESSION_FILE_EXT.length));
}

/** True when the session has a UI in a terminal: only then does it take terminal input. */
export function hasTerminal(ctx: OmpContext): boolean {
  return ctx.hasUI === true && process.stdout.isTTY === true;
}

/** The terminal this process runs in. */
export function terminalIdentity(): TerminalIdentity {
  const env = process.env;
  const terminal: TerminalIdentity = { pid: process.pid, ppid: process.ppid };
  if (env.WT_SESSION) terminal.wtSession = env.WT_SESSION;
  if (env.TERM_PROGRAM) terminal.termProgram = env.TERM_PROGRAM;
  if (env.OMP_VSCODE_TERMINAL) terminal.vscodeTerminal = env.OMP_VSCODE_TERMINAL;
  return terminal;
}
