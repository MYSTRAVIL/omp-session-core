/** True for any non-null object; its fields stay `unknown` until checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
