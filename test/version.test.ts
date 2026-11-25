import { expect, test } from "bun:test";
import pkg from "../package.json";
import { VERSION } from "../src/version";

test("the version a copy runs its election with is the package's version", () => {
  expect(VERSION).toBe(pkg.version);
});
