# omp-session-core

Shared per-session state for [oh-my-pi](https://omp.sh) extensions.

Several extensions can run in one omp process, and each one wants the same facts about the session:
which session it is, whether it is busy, whether it waits on the user, whether its terminal has the
focus. omp-session-core derives those facts once and publishes them on omp's extension event bus.

Each extension bundles its own copy. At runtime the copies elect one provider per event bus, and the
highest version wins. Only the provider reads the terminal and runs the state machine; the other
copies subscribe. An extension never depends on another one being installed, and an outdated copy
stands down when a newer one is present.

## Use

```ts
import { startSessionCore } from "@mystravil/omp-session-core";

export default function (pi) {
  // First thing in the factory, before your own pi.on handlers.
  const core = startSessionCore(pi);
  core.onState((state) => {
    // { sessionId, sessionFile?, cwd, agent?, subagent, movedFrom?, status, waitingOn?, terminal?, at }
  });
  core.onFocus(({ sessionId, focused }) => {});
  pi.on("agent_end", () => {
    core.state(); // already reflects this agent_end, whichever extension provides
  });
  core.idleMs(); // ms since the desk's last input; null off Windows
}
```

Every copy passes omp's events on to the provider, so `state()` is current inside each of your own
handlers, whichever extension loaded first. `onState` and `onFocus` call a new listener at once with
the current state or focus, so an extension omp binds late misses nothing.

`startSessionCore` never throws. On an omp without `pi.events` it returns a core that reports
nothing.

## Develop

`bun install`, then `bun run test` (type check and tests) and `bun run consumer` (builds, packs, and
proves the tarball in a throwaway app). Design and state rules:
`docs/specs/2026-11-25-omp-session-core-design.md`. Changes: `CHANGELOG.md`.
