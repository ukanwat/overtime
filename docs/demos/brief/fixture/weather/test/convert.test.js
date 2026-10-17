import { test } from "node:test";
import assert from "node:assert/strict";
import { toFahrenheit, toMph } from "../src/convert.js";

test("freezing and boiling", () => {
  assert.equal(toFahrenheit(0), 32);
  assert.equal(toFahrenheit(100), 212);
});

test("a warm day", () => {
  assert.equal(toFahrenheit(21), 70);
});

test("wind in mph", () => {
  assert.equal(toMph(14), 8.7);
});
