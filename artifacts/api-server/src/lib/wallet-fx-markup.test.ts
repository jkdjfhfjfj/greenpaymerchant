import assert from "node:assert/strict";
import test from "node:test";
import { combineWalletFxMarkupBps } from "./wallet-math";

test("target-currency spread is added to the active schedule markup", () => {
  assert.equal(combineWalletFxMarkupBps(125, 75), 200);
});

test("combined wallet FX markup must remain below 100 percent", () => {
  assert.throws(() => combineWalletFxMarkupBps(9_950, 50), /must be below 10,000 bps/);
});

test("wallet FX markup rejects negative or fractional basis points", () => {
  assert.throws(() => combineWalletFxMarkupBps(-1, 1), /integer basis points/);
  assert.throws(() => combineWalletFxMarkupBps(0, 1.5), /integer basis points/);
});