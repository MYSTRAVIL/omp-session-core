import { expect, test } from "bun:test";
import { TerminalFocus } from "../src/terminal-focus";
import { ManualTimers } from "./manual-timers";

function tracker() {
  const changes: boolean[] = [];
  const timers = new ManualTimers();
  const focus = new TerminalFocus((focused) => changes.push(focused), timers.setTimer);
  return { focus, timers, changes };
}

test("a refocus that flickers in, out, in settles as one focus-in", () => {
  const { focus, timers, changes } = tracker();
  focus.input("\x1b[O");
  timers.fire();
  // VS Code's refocus: three reports before any of them settles.
  focus.input("\x1b[I");
  focus.input("\x1b[O");
  focus.input("\x1b[I");
  timers.fire();
  expect(changes).toEqual([false, true]);
  expect(focus.focused).toBe(true);
});

test("focus is unknown until the first report, and a repeat of the state is not a change", () => {
  const { focus, timers, changes } = tracker();
  expect(focus.focused).toBeUndefined();
  focus.input("\x1b[I");
  timers.fire();
  focus.input("\x1b[I");
  timers.fire();
  expect(changes).toEqual([true]);
});

test("while the focus is unknown a typed key says the terminal has it; a reply from the terminal does not", () => {
  const { focus, timers, changes } = tracker();
  // Windows Terminal reports nothing until the first change.
  expect(focus.input("\x1b[6;18t")).toBeUndefined();
  timers.fire();
  expect(changes).toEqual([]);
  expect(focus.input("h")).toBeUndefined();
  timers.fire();
  expect(changes).toEqual([true]);
});

test("focus reports are taken out of the input; other input passes untouched", () => {
  const { focus } = tracker();
  expect(focus.input("\x1b[I")).toEqual({ consume: true });
  expect(focus.input("a\x1b[Ob\x1b[Ic")).toEqual({ data: "abc" });
  // An arrow key and plain text are not focus reports.
  expect(focus.input("\x1b[A")).toBeUndefined();
  expect(focus.input("hello")).toBeUndefined();
});

test("several reports in one chunk settle on the last", () => {
  const { focus, timers, changes } = tracker();
  focus.input("\x1b[I\x1b[O");
  timers.fire();
  expect(changes).toEqual([false]);
});
