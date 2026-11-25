// Type check only, run by `tsc` in `bun run test`: an app hands omp's real `ExtensionAPI` to the
// core as it is, with no cast. omp's per-event `on` overloads must fit the core's `pi` type.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type SessionCore, startSessionCore } from "../../src/index";

export function factory(pi: ExtensionAPI): SessionCore {
  return startSessionCore(pi);
}
