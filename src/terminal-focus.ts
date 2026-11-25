/** Turns the terminal's focus reporting (DECSET 1004) on and off. */
export const FOCUS_REPORTING_ON = "\x1b[?1004h";
export const FOCUS_REPORTING_OFF = "\x1b[?1004l";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/** How long a reported state must hold before it is taken: on a refocus the
 *  VS Code terminal reports in, out, in within about 10 ms. */
export const FOCUS_SETTLE_MS = 100;

/** Runs `fn` once after `ms`; returns a canceller. Injected so tests own the clock. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export const realSetTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** What omp's raw terminal input listener returns. */
export interface TerminalInputResult {
  consume?: boolean;
  data?: string;
}

/**
 * Follows whether the terminal has the keyboard focus, from the reports the
 * terminal writes into its input once {@link FOCUS_REPORTING_ON} is sent.
 * `focused` is `undefined` until the first report: Windows Terminal sends
 * none before the first change. Until then a typed key says the terminal has
 * the focus.
 */
export class TerminalFocus {
  readonly #changed: (focused: boolean) => void;
  readonly #setTimer: SetTimer;
  #focused: boolean | undefined;
  #cancelSettle: (() => void) | undefined;

  constructor(changed: (focused: boolean) => void, setTimer: SetTimer = realSetTimer) {
    this.#changed = changed;
    this.#setTimer = setTimer;
  }

  get focused(): boolean | undefined {
    return this.#focused;
  }

  /**
   * One chunk of raw terminal input. The focus reports are taken out of it,
   * so omp never reads them as keys; input without one passes untouched.
   */
  input(data: string): TerminalInputResult | undefined {
    const lastIn = data.lastIndexOf(FOCUS_IN);
    const lastOut = data.lastIndexOf(FOCUS_OUT);
    if (lastIn < 0 && lastOut < 0) {
      // A reply the terminal sends of its own accord starts with ESC; so do
      // some keys, which are passed over.
      if (this.#focused === undefined && !data.startsWith("\x1b")) this.#report(true);
      return undefined;
    }
    this.#report(lastIn > lastOut);
    const rest = data.replaceAll(FOCUS_IN, "").replaceAll(FOCUS_OUT, "");
    return rest.length === 0 ? { consume: true } : { data: rest };
  }

  /** Drop a report still settling. */
  stop(): void {
    this.#cancelSettle?.();
    this.#cancelSettle = undefined;
  }

  #report(focused: boolean): void {
    this.#cancelSettle?.();
    this.#cancelSettle = this.#setTimer(() => {
      this.#cancelSettle = undefined;
      if (this.#focused === focused) return;
      this.#focused = focused;
      this.#changed(focused);
    }, FOCUS_SETTLE_MS);
  }
}
