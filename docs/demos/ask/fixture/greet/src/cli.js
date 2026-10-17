#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { greet } from "./greet.js";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const names = opt("--name-file") ? readFileSync(opt("--name-file"), "utf8").split("\n").filter(Boolean) : [args.find((a) => !a.startsWith("-")) ?? "world"];
for (const n of names) console.log(greet(n, { lang: opt("--lang"), loud: args.includes("--loud") }));
