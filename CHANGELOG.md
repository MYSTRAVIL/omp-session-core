# Changelog

## Unreleased

## 0.1.3

- `onState` and `onFocus` call a new listener at once with the current state or focus, then with
  each change. omp defers binding extensions that register nothing needed before the first frame,
  so a copy bound after `session_start` missed the first state until the next change. Found by
  omp-manager's release run.

## 0.1.2

- The shipped types use `.js` import specifiers, so an app on `moduleResolution: NodeNext` (or
  node16) imports them without TS2834/TS2460. Found by Coral's adoption.
- `bun:ffi` loads on the first desk idle read instead of at import, so the core loads under Node
  (an app's vitest run) with no alias; `idleMs()` is `null` there.
- `before_agent_start` is a move check point too, so an app's own `before_agent_start` handler sees
  a move made between turns on omp without persistence notices.

## 0.1.1

- With several waits open, `waitingOn` reports the most pressing one: an approval outranks a plan
  review, which outranks an ask. 0.1.0 reported the newest.
- A move outside any turn (for example `/model` before the first prompt of a resumed session that
  another omp holds) now reaches the state at once: the provider follows omp's persistence notices.
  Found by omp-manager's adoption.
- A resolved plan review reports busy when the approved plan already runs.

## 0.1.0

First release.

- `startSessionCore(pi)`: each omp extension bundles its own copy. The copies elect one provider per
  omp event bus at the first `session_start`, and the highest version wins.
- Every copy passes omp's events on to the provider, so `state()` is current inside any extension's
  own handlers, whatever the load order.
- `session-state` v1: session identity, subagent, silent moves (`movedFrom`), busy or idle, what the
  session waits on the user for (ask, approval, plan review), and the terminal it runs in.
- `terminal-focus` v1: the provider turns on the terminal's focus reporting, removes the reports from
  omp's input, and publishes each settled change.
- `idleMs()`: milliseconds since the desk's last keyboard or mouse input (Windows; `null` elsewhere).
