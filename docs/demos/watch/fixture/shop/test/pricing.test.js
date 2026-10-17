import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../pricing.js";

test("no coupon", () => {
  assert.equal(total({ items: [{ cents: 500, qty: 2 }] }), 1000);
});

test("a coupon takes its percentage off", () => {
  assert.equal(total({ coupon: "WELCOME10", items: [{ cents: 1000, qty: 1 }] }), 900);
});
