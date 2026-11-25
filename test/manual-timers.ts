import type { SetTimer } from "../src/terminal-focus";

/** Timers fire only when the test says so. */
export class ManualTimers {
  readonly #timers = new Set<() => void>();

  readonly setTimer: SetTimer = (fn) => {
    this.#timers.add(fn);
    return () => {
      this.#timers.delete(fn);
    };
  };

  /** Run every pending timer once. */
  fire(): void {
    const due = [...this.#timers];
    this.#timers.clear();
    for (const fn of due) fn();
  }
}
