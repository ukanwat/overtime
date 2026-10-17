import { test } from "node:test";
import assert from "node:assert/strict";
import { line } from "../src/format.js";

test("one line for a rainy day", () => {
  assert.equal(line({ city: "Lisbon", temp: 21, rain: 2, cloud: 80, wind: 14 }), "Lisbon: 21°C (70°F), light rain, wind 14 km/h");
});

test("clear skies", () => {
  assert.equal(line({ city: "Oslo", temp: 4, rain: 0, cloud: 10, wind: 30 }), "Oslo: 4°C (39°F), clear, wind 30 km/h");
});
