import type * as BunFfi from "bun:ffi";

/** Reads how long the user has been idle; `null` when that is unknown. */
type IdleProbe = () => number | null;

const unknownIdle: IdleProbe = () => null;

/** Loaded on the first read, then reused; `unknownIdle` when it cannot load. */
let probe: IdleProbe | undefined;

/**
 * The Win32 probe: `GetLastInputInfo` fills a `LASTINPUTINFO` (u32 `cbSize`,
 * which must be 8, then u32 `dwTime`, the tick count of the last input), and
 * `GetTickCount` gives the current tick count. Both are 32-bit millisecond
 * counters, so their difference wraps with them (every ~49.7 days).
 */
function windowsProbe(): IdleProbe {
  // Required here, not imported at the top: the core must also load under Node, where an app
  // tests its extension and `bun:ffi` does not exist. There the require throws and idle is unknown.
  const { FFIType, dlopen }: typeof BunFfi = require("bun:ffi");
  const user32 = dlopen("user32.dll", {
    GetLastInputInfo: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const kernel32 = dlopen("kernel32.dll", {
    GetTickCount: { args: [], returns: FFIType.u32 },
  });
  const info = new Uint32Array([8, 0]);
  return () => {
    if (user32.symbols.GetLastInputInfo(info) === 0) return null;
    return (kernel32.symbols.GetTickCount() - (info[1] ?? 0)) >>> 0;
  };
}

function loadProbe(): IdleProbe {
  if (process.platform !== "win32") return unknownIdle;
  try {
    return windowsProbe();
  } catch {
    return unknownIdle;
  }
}

/**
 * Milliseconds since the last keyboard or mouse input in this process's logon
 * session, or `null` when that is unknown: on every platform but Windows, and
 * whenever the Win32 probe fails.
 */
export function deskIdleMs(): number | null {
  probe ??= loadProbe();
  try {
    return probe();
  } catch {
    return null;
  }
}
