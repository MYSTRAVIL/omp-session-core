# omp-session-core: design

Date: 2026-11-25. Status: rollout step 1 built (0.1.0, not published). The code is authoritative where
this document and the code disagree.

## Why

Four omp extensions on the owner's machines each derive the same per-session facts from omp's events,
each with its own state machine:

| Per-session fact | Coral hook | Wallpaper forwarder | omp-remote bridge | omp-manager hook |
|---|---|---|---|---|
| Identity (id, file, cwd, subagent parent) | yes | yes | yes | yes |
| Session switch / clear / branch | yes | only `session_start` | yes | yes |
| Busy / idle | yes | yes | yes | yes |
| Waiting on the user (ask, approval, plan review) | | yes | yes | yes |
| Terminal focus | | listens | owns | |
| Terminal identity (pid, which terminal) | | pid | | yes |
| Desk idle time (last input) | | yes | yes (host agent) | |

A fix to that logic lands in up to four places today, and two extensions that both want terminal focus
fight over one terminal flag. omp-session-core owns these facts once and publishes them. Each app keeps
its transport and its own rules.

| App | Repo | Extension file | Keeps |
|---|---|---|---|
| Coral | `Documents\Programming\Projects\coral` (`hooks/coral-omp-hook.ts`) | `coral-omp-hook.ts` | inbox, request delivery, durable submit queue |
| llm-fleet-wallpaper | `Documents\Programming\Projects\llm-fleet-wallpaper` (`collector/hook/omp-forwarder.ts`) | `llm-fleet-forwarder.ts` | POST transport to its collector, the unread rule, tool activity |
| omp-remote | `Documents\Programming\Projects\omp-remote` | `omp-remote-bridge.ts` | transcript feed, prompt control, Collab, the DeskSeen rule |
| omp-manager | `Documents\Programming\Projects\vscode-omp-manager` | `vscode-session-restore.ts` | the VS Code terminal map file |

Out of scope for v1: tool activity, todos and subagent views. The apps want different detail there.

## Scope of the core

1. **Session identity:** id, session file, cwd, parent session for a subagent, and the switches that
   replace the session in a running process (`session_switch`, `session_clear`, `session_branch`).
2. **Lifecycle:** busy or idle, and what the session waits on the user for (ask, approval, plan
   review).
3. **Terminal:** focus reporting (writes DECSET 1004, strips `ESC[I` / `ESC[O` from the input,
   applies the first-key rule while the state is unknown, waits 100 ms for a state to settle), and
   terminal identity (pid, `WT_SESSION`, `TERM_PROGRAM`, `OMP_VSCODE_TERMINAL`).
4. **Desk idle time:** milliseconds since the machine's last keyboard or mouse input (`bun:ffi`
   `GetLastInputInfo` on Windows, `null` elsewhere until a probe exists).

The terminal code starts as a port of omp-remote `packages/bridge/src/terminal-focus.ts`. The idle
probe starts as a port of omp-remote `packages/agent/src/host-idle.ts`.

## Distribution

- npm package `@mystravil/omp-session-core`, ESM, no runtime dependencies, Bun target. It ships one
  bundled `dist/index.js` and type declarations that need no Bun types and no special tsconfig. It is
  published from the public GitHub repo through npm trusted publishing, like Hardpoint (CLAUDE.md,
  Release).
- Each app bundles its own copy. No app depends on another app or on a separately installed
  extension. An uninstall can never pull the core out from under another app.
- Apps that ship one standalone extension file (Coral hook, wallpaper forwarder, omp-manager hook)
  add a `bun build` step that inlines the core and keeps `@oh-my-pi/*` external. omp-remote's bridge
  build already bundles. `bun run consumer` proves this path on every release.

## Provider election

omp runs every extension's factory before it emits the first `session_start` (omp 19.0.1
`loader.ts` `bindPreparedExtensions`, then `runtime-init.ts` emits `session_start`). Subagents rebind
fresh extension instances to their own `ExtensionAPI` and event bus without re-evaluating modules, so
module state is shared across a process while buses are not. A subagent gets its own `session_start`
too: the task executor runs `initializeExtensions` for it.

- **Register:** at factory time each copy registers a candidate in a process-wide registry at
  `globalThis[Symbol.for('omp-session-core')]`, keyed by the extension's event bus. It also registers
  a handler for each omp event in its pass-on list (below).
- **Elect:** the first copy whose `session_start` handler runs elects: the candidate with the highest
  semver wins, and a tie goes to the first registered. The winner is the provider for that bus: only
  it installs the input listener, writes DECSET 1004, runs the state machine and publishes. Every
  other copy is a client and only subscribes.
- **Pass on every event:** each copy's handler passes the omp event to the provider's
  `handle(type, event, ctx)`. omp calls extensions in load order and hands every one the same event
  object (checked in omp 19.0.1), so the first copy's handler updates the provider and the rest are
  skipped by object identity. The state is therefore current inside every app's own handler for that
  event, whatever the load order, as long as the app calls `startSessionCore` before it registers
  handlers of its own. The provider also keeps running when omp suspends its own extension, as long
  as another copy still gets events. Every state handler is idempotent, so a missed skip costs only
  repeated work.
- **Pass-on list:** wider than v1's state machine needs: the session, agent, turn, message, tool,
  approval, plan review, compaction, retry, mode and goal events. A provider ignores types it has no
  use for, so a newer provider gets these from every older copy. An event type a newer provider
  wants that an older copy does not pass on still reaches it in its own extension's slot. The list
  holds no per-delta event (`message_update`, `tool_execution_update`).
- **Late copies stay clients:** a copy bound after the first `session_start` (omp replays the same
  event object to it) finds the provider set and never replaces it, even when it is newer.
- **Outdated copies stand down:** an app not updated yet ships an older core, and the newer copy
  wins. Each app therefore gets at least the version it bundled.
- **The registry contract is frozen:** old copies must read a registry made by new ones. Any change
  to these shapes needs a new symbol:

  ```ts
  { registry: 1, buses: WeakMap<bus, { candidates: Candidate[], provider: Candidate | undefined }> }
  Candidate = { version: string, handle(type: string, event, ctx): void, current(channel: string): unknown, idleMs(): number | null }
  ```

  The registry object is frozen and defined non-writable on `globalThis`; bus entries are sealed.

## Protocol

Events go out on the omp extension bus (`pi.events`). The bus keeps no state, so each candidate
exposes `current(channel)`: the last payload its provider emitted on that channel. Payloads are
frozen, so one app cannot change what another reads.

- `terminal-focus`, `v: 1`: `{ v, sessionId, focused, at }`. Unchanged from what the omp-remote bridge
  emits since omp-remote `220505d`; the wallpaper forwarder consumes it today. It goes out on each
  settled change, and again under the new id when the session id changes.
- `session-state`, `v: 1`: emitted on every change (`at` excluded from the comparison):

  ```ts
  { v: 1, sessionId, sessionFile?, cwd, agent?: { kind, id, name, depth, parentId? }, subagent,
    movedFrom?, status: 'busy' | 'idle', waitingOn?: 'ask' | 'approval' | 'plan-review',
    terminal?: { pid, ppid, wtSession?, termProgram?, vscodeTerminal? }, at }
  ```

  `sessionFile` is absent for a session omp does not persist. `agent` is omp's `ctx.agent` (18.3.2+).
  `subagent` comes from `ctx.agent.kind`, or on older omp from the omp-remote bridge's file-layout rule.
  `terminal` is present when the session has a UI, stdout is a TTY, and the session is not a
  subagent. Only such a session's provider takes terminal input and writes DECSET 1004: a subagent's
  shutdown must not turn focus reporting off under the main session. The design's `parentSessionId`
  is left out: omp gives a subagent its parent's session file and agent id, not the parent session
  id, and no consumer reads it today.
- `desk-idle` is a pull, not an event: `idleMs(): number | null`, read through the provider.

Versioning:

- The package follows semver. Each event carries its own protocol `v`.
- Within a protocol version, changes only add fields. Clients ignore fields they do not know.
- A breaking change gets a new channel name (`session-state.v2`). The provider emits both channels
  for one deprecation window.

## State rules

| Fact | Rule |
|---|---|
| Start | `session_start`: identity from `ctx`; status from `ctx.isIdle()`; a plan review already open (`ctx.getPendingPlanReview()`) counts. |
| Switch | `session_switch`, `session_branch`: new identity, waits dropped, input listener installed again (omp drops extension input listeners when it replaces the session). |
| Silent move | The id is checked on `message_start`, `turn_end`, every status event, and each persistence notice from `sessionManager.onPersistenceNotice` (omp 18.5+), which catches a move outside any turn. A new id whose header names the old one (`continuationOf ?? parentSession`) is a move: `movedFrom` is set and open waits stay. Any other new id drops the waits. |
| Busy | `agent_start`, `turn_start`. |
| Idle | `agent_end`, unless `willContinue` without `awaitingAsyncWork`. A background-job wait is idle: the session takes input. |
| Ask | `tool_call` with `toolName === 'ask'` until its `tool_result`. |
| Approval | `tool_approval_requested` until `tool_approval_resolved`, by `toolCallId`. |
| Plan review | `plan_review_requested` until `plan_review_resolved`, by `reviewId`. omp emits the close after the overlay shuts, so the close re-reads `ctx.isIdle()`: an approved plan that already runs is busy. |
| Waiting on | The highest-ranked open wait: approval, then plan review, then ask (0.1.1+; 0.1.0 reported the newest). `agent_end` closes asks and approvals; a plan review outlasts the turn. |
| Shutdown | `session_shutdown` turns focus reporting off and removes the input listener. A process exit hook also turns it off. |

Every handler is guarded: nothing the core does throws into omp, and each handler returns
`undefined`, so it never blocks or rewrites a tool call.

## Rollout

The omp-remote bridge already owns focus reporting by itself. Two owners of the terminal input would
conflict, so the bridge moves first.

1. Done: the core with an election harness. A fake omp `ExtensionAPI`, event bus and TUI input
   listener set (`test/fake-omp.ts`). Election tests bundle the core more than once at different
   versions (`test/copies.ts`) and cover both load orders, a tie, a session switch, subagent buses, a
   late copy, an older client reading a newer provider, current state inside an earlier app's own
   handlers, one handling per event across three copies, a suspended provider extension, and the
   frozen registry shape. Smoke runs in real omp 19.0.1 print mode with two copies (0.1.0 loaded
   first, 0.2.0 second): 0.2.0 was elected, both extensions got the same event object, and the
   0.1.0 app saw busy in its own `agent_start` handler and idle in its own `agent_end` handler.
2. omp-remote's bridge adopts the core and drops its own `TerminalFocus`. It keeps the DeskSeen rule.
3. The wallpaper forwarder, omp-manager hook and Coral hook adopt the core and delete their duplicate
   state machines, one app at a time.

Release rule: once a version ships in an app, commit its bundle as `test/fixtures/core-<version>.js`
and run the election tests against every fixture, so a real old copy, not a rebuilt one, keeps
reading registries made by new code.

## Open questions

- Desk idle time on Linux and macOS.
- Whether Coral wants focus or desk idle at all, or only identity and lifecycle.
- omp's own user-wait tracking (`user-wait.ts`, wrapping `ui.select/confirm/input/...`) is not
  exposed to extensions. A dialog another extension opens is not a `waitingOn` today.
