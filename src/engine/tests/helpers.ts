// Shared engine-test helpers — import eq from here instead of redefining it
// per file. Why `eq` exists at all: @types/node types `assert.strictEqual` as
// `strictEqual<T>(actual: unknown, expected: T): asserts actual is T`, so
// consecutive strictEqual calls narrow a closure-mutated variable to `never`
// (TS2322); the `unknown` parameters defeat that narrowing. It takes EXACTLY
// two arguments because strictEqual's message parameter rejects
// `string | undefined` under this @types/node (TS2769).
import { strictEqual } from "node:assert";

export function eq(actual: unknown, expected: unknown): void {
  strictEqual(actual, expected);
}
