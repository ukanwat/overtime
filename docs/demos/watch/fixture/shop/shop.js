#!/usr/bin/env node
// A pretend checkout: prices a cart and logs what happened to logs/app.log, like a real service would.
import { appendFileSync, readFileSync } from "node:fs";
import { total } from "./pricing.js";

const log = (level, msg) => appendFileSync(new URL("./logs/app.log", import.meta.url), `${new Date().toISOString()} ${level} ${msg}\n`);
const [cmd, file] = process.argv.slice(2);
if (cmd !== "checkout" || !file) {
  console.error("usage: node shop.js checkout <cart.json>");
  process.exit(2);
}
const cart = JSON.parse(readFileSync(file, "utf8"));
try {
  const cents = total(cart);
  log("INFO", `checkout ok: order for ${cart.customer}, ${cart.items.length} items, $${(cents / 100).toFixed(2)}`);
  console.log(`✓ Order placed for ${cart.customer}: $${(cents / 100).toFixed(2)}`);
} catch (e) {
  log("ERROR", `checkout failed for ${cart.customer}: ${e.stack.split("\n").slice(0, 2).join(" | ")}`);
  console.log("✗ Something went wrong. Please try again.");
  process.exit(1);
}
