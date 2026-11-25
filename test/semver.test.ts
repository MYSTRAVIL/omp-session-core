import { expect, test } from "bun:test";
import { compareVersions } from "../src/semver";

test("versions compare by major, then minor, then patch, as numbers", () => {
  expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
  expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
});

test("a prerelease is below its release, and prerelease fields compare by semver rules", () => {
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
});

test("build metadata does not change the order", () => {
  expect(compareVersions("1.0.0+abc", "1.0.0+def")).toBe(0);
});

test("a version that does not parse is below every valid one", () => {
  expect(compareVersions("garbage", "0.0.0")).toBeLessThan(0);
  expect(compareVersions("0.0.1", "1.0")).toBeGreaterThan(0);
  expect(compareVersions("x", "y")).toBe(0);
});
