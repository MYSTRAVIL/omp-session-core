import type {
  OmpContext,
  OmpExtensionApi,
  OmpInputResult,
  OmpSessionHeader,
} from "../src/omp";

type Handler = (event: unknown, ctx: OmpContext) => unknown;
type InputListener = (data: string) => OmpInputResult;

/** omp's `EventBus`: `emit` calls each handler synchronously, and a handler's throw is caught. */
export class FakeEventBus {
  readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
  /** Everything emitted, in order. */
  readonly sent: { channel: string; data: unknown }[] = [];

  on = (channel: string, handler: (data: unknown) => void): (() => void) => {
    let set = this.#listeners.get(channel);
    if (!set) this.#listeners.set(channel, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };

  emit = (channel: string, data: unknown): void => {
    this.sent.push({ channel, data });
    for (const handler of this.#listeners.get(channel) ?? []) {
      try {
        handler(data);
      } catch {
        // omp logs it.
      }
    }
  };

  /** The payloads emitted on `channel`, in order. */
  sentOn(channel: string): unknown[] {
    return this.sent.filter((s) => s.channel === channel).map((s) => s.data);
  }
}

/** omp's TUI input: extension listeners see each chunk of raw input first, in order. */
export class FakeTerminal {
  readonly listeners = new Set<InputListener>();

  /** Raw input from the terminal; returns what reaches omp's editor, or `undefined` when a listener consumed it. */
  type(data: string): string | undefined {
    let current = data;
    for (const listener of this.listeners) {
      const result = listener(current);
      if (result?.consume) return undefined;
      if (result?.data !== undefined) current = result.data;
    }
    return current.length === 0 ? undefined : current;
  }
}

export interface SessionInit {
  id: string;
  file?: string;
  cwd?: string;
  hasUI?: boolean;
  /** `ctx.agent`; leave out to model omp before 18.3.2. */
  agent?: unknown;
  header?: OmpSessionHeader | null;
  /** The TUI's input; only a session with a UI has one. */
  terminal?: FakeTerminal;
}

export const MAIN_AGENT = { kind: "main", id: "Main", name: "main", depth: 0 } as const;

/** One omp session: its event bus, the extensions bound to it, and the `ctx` omp hands their handlers. */
export class FakeSession {
  readonly bus = new FakeEventBus();
  readonly #extensions: Map<string, Handler[]>[] = [];
  readonly #suspended = new Set<Map<string, Handler[]>>();
  #sessionStartEvent: Record<string, unknown> | undefined;
  /** What a handler threw into omp. */
  readonly thrown: unknown[] = [];
  id: string;
  file: string | undefined;
  cwd: string;
  hasUI: boolean;
  agent: unknown;
  header: OmpSessionHeader | null;
  terminal: FakeTerminal | undefined;
  idle = true;
  pendingPlanReview: { reviewId: string } | undefined;
  /** Makes every `sessionManager` call throw, as a broken or disposed session might. */
  broken = false;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.file = init.file ?? `/sessions/${init.id}.jsonl`;
    this.cwd = init.cwd ?? "/work";
    this.hasUI = init.hasUI ?? false;
    this.agent = init.agent;
    this.header = init.header ?? null;
    this.terminal = init.terminal;
  }

  /** Bind one extension, as omp does: its factory runs with a fresh `pi` on this session's bus. */
  load<T>(factory: (pi: OmpExtensionApi) => T): T {
    const handlers = new Map<string, Handler[]>();
    this.#extensions.push(handlers);
    const pi = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      events: this.bus,
    };
    return factory(pi as unknown as OmpExtensionApi);
  }

  /** Bind one extension on an omp without `pi.events`. */
  loadWithoutBus<T>(factory: (pi: OmpExtensionApi) => T): T {
    const handlers = new Map<string, Handler[]>();
    this.#extensions.push(handlers);
    const pi = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    };
    return factory(pi as unknown as OmpExtensionApi);
  }

  ctx(): OmpContext {
    const guard = (): void => {
      if (this.broken) throw new Error("session disposed");
    };
    const terminal = this.hasUI ? this.terminal : undefined;
    const ctx: OmpContext = {
      hasUI: this.hasUI,
      cwd: this.cwd,
      sessionManager: {
        getSessionId: () => (guard(), this.id),
        getSessionFile: () => (guard(), this.file),
        getCwd: () => (guard(), this.cwd),
        getHeader: () => (guard(), this.header),
      },
      isIdle: () => this.idle,
      getPendingPlanReview: () => this.pendingPlanReview,
      ui: {
        onTerminalInput: (handler) => {
          if (!terminal) return () => {};
          terminal.listeners.add(handler);
          return () => {
            terminal.listeners.delete(handler);
          };
        },
      },
    };
    if (this.agent !== undefined) ctx.agent = this.agent;
    return ctx;
  }

  /** Emit an omp event to every active extension's handlers, in load order, as omp's runner does. */
  async emit(type: string, fields: Record<string, unknown> = {}): Promise<unknown[]> {
    const event = { type, ...fields };
    if (type === "session_start") this.#sessionStartEvent = event;
    return this.#emitTo(this.#extensions, event);
  }

  /** omp replays the same `session_start` event object to an extension bound after it went out. */
  async replayStartToLast(): Promise<void> {
    if (this.#sessionStartEvent) await this.#emitTo(this.#extensions.slice(-1), this.#sessionStartEvent);
  }

  /** omp suspends an extension: it keeps its module state but gets no more events. `index` is its load order. */
  suspend(index: number): void {
    const extension = this.#extensions[index];
    if (extension) this.#suspended.add(extension);
  }

  async #emitTo(extensions: Map<string, Handler[]>[], event: Record<string, unknown>): Promise<unknown[]> {
    const type = String(event.type);
    // One ctx and one event object for every extension, as omp's runner passes them.
    const ctx = this.ctx();
    const results: unknown[] = [];
    for (const handlers of extensions) {
      if (this.#suspended.has(handlers)) continue;
      for (const handler of handlers.get(type) ?? []) {
        try {
          results.push(await handler(event, ctx));
        } catch (error) {
          this.thrown.push(error);
        }
      }
    }
    return results;
  }

  start(): Promise<unknown[]> {
    return this.emit("session_start");
  }

  /** `/new` or `/resume`: omp drops extension input listeners, then emits `session_switch`. */
  async switchTo(id: string, reason: "new" | "resume" | "fork" = "new", header: OmpSessionHeader | null = null): Promise<void> {
    const previousSessionFile = this.file;
    this.terminal?.listeners.clear();
    this.id = id;
    this.file = `/sessions/${id}.jsonl`;
    this.header = header;
    await this.emit("session_switch", { reason, previousSessionFile });
  }
}
