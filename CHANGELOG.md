# Changelog

## Unreleased

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
