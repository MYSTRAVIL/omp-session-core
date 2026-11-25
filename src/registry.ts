import { isRecord } from "./guards";
import { compareVersions } from "./semver";

/**
 * The process-wide registry every copy of the core shares, at
 * `globalThis[Symbol.for("omp-session-core")]`.
 *
 * FROZEN. Copies of every version read a registry that any other copy made,
 * so these shapes never change. A different shape needs a new symbol.
 */
export interface RegistryV1 {
  readonly registry: 1;
  /** One entry per omp event bus (`pi.events`): the main session's and each subagent's. */
  readonly buses: WeakMap<object, BusV1>;
}

export interface BusV1 {
  /** Every copy bound to this bus, in the order they registered. */
  readonly candidates: CandidateV1[];
  /** Set once, at the first `session_start` on the bus, and never changed. */
  provider: CandidateV1 | undefined;
}

export interface CandidateV1 {
  readonly version: string;
  /**
   * One omp event, passed on by whichever copy's handler runs first, so the
   * provider is up to date before any app's own handler for that event.
   * Every copy passes on the same event object; the provider handles it once
   * and ignores event types it does not know. A `session_start` starts it.
   */
  handle(type: string, event: unknown, ctx: unknown): void;
  /** The last payload the provider emitted on `channel`, or `undefined`. */
  current(channel: string): unknown;
  /** Milliseconds since the desk's last keyboard or mouse input, or `null` when unknown. */
  idleMs(): number | null;
}

const KEY = Symbol.for("omp-session-core");

function isRegistryV1(value: unknown): value is RegistryV1 {
  return isRecord(value) && value.registry === 1 && value.buses instanceof WeakMap;
}

/** The registry, made on first use; `undefined` when something else holds the key. */
export function registry(): RegistryV1 | undefined {
  const existing: unknown = Reflect.get(globalThis, KEY);
  if (existing !== undefined) return isRegistryV1(existing) ? existing : undefined;
  const made: RegistryV1 = Object.freeze({ registry: 1, buses: new WeakMap<object, BusV1>() });
  Object.defineProperty(globalThis, KEY, { value: made, enumerable: false, writable: false, configurable: false });
  return made;
}

/** The bus's entry, made on first use. */
export function busEntry(reg: RegistryV1, bus: object): BusV1 {
  let entry = reg.buses.get(bus);
  if (!entry) {
    entry = Object.seal({ candidates: [], provider: undefined });
    reg.buses.set(bus, entry);
  }
  return entry;
}

/**
 * The bus's provider, electing it on the first call: the highest version
 * wins, and a tie goes to the first registered. Every copy runs the same rule,
 * so whichever copy elects, the result is the same.
 */
export function elect(entry: BusV1): CandidateV1 | undefined {
  if (entry.provider) return entry.provider;
  let best: CandidateV1 | undefined;
  for (const candidate of entry.candidates) {
    if (!best || compareVersions(candidate.version, best.version) > 0) best = candidate;
  }
  entry.provider = best;
  return best;
}
