/**
 * The parts of omp's extension API the core uses, typed structurally so the
 * core depends on no omp package and accepts any omp version. Members that
 * older omp lacks are optional and checked before use.
 */

/** omp's extension event bus (`pi.events`). */
export interface OmpEventBus {
  on(channel: string, handler: (data: unknown) => void): unknown;
  emit(channel: string, data: unknown): void;
}

export interface OmpSessionHeader {
  /** A fork's or a move's previous session id; a subagent's parent session file. */
  parentSession?: string;
  /** The id a move left (omp 18.13.2+); a fork never sets it. */
  continuationOf?: string;
}

export interface OmpSessionManager {
  getSessionId(): string;
  getSessionFile?(): string | undefined;
  getCwd?(): string;
  getHeader?(): OmpSessionHeader | null;
}

/** What omp's raw terminal input listener returns. */
export type OmpInputResult = { consume?: boolean; data?: string } | undefined;

/** The `ctx` omp passes to every event handler. */
export interface OmpContext {
  hasUI: boolean;
  cwd?: string;
  sessionManager: OmpSessionManager;
  /** omp 18.3.2+. */
  agent?: unknown;
  isIdle?(): boolean;
  ui?: { onTerminalInput?(handler: (data: string) => OmpInputResult): () => void };
  getPendingPlanReview?(): { reviewId: string } | undefined;
}

/** omp's `ExtensionAPI` (`pi`), as the default export of an extension receives it. */
export interface OmpExtensionApi {
  on(event: string, handler: (event: never, ctx: never) => unknown): void;
  /** Absent on old omp; the core then stays inert. */
  readonly events?: OmpEventBus;
}
