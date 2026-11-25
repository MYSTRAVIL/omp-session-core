const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(version: string): Parsed | undefined {
  const m = SEMVER.exec(version);
  if (!m) return undefined;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders two semver strings: negative when `a` is lower, positive when higher,
 * 0 when equal. Build metadata is ignored. A version that does not parse sorts
 * below every valid one, so a malformed copy never wins an election.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const d = compareIdentifiers(pa.pre[i]!, pb.pre[i]!);
    if (d !== 0) return d;
  }
  return pa.pre.length - pb.pre.length;
}
