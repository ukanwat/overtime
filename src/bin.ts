#!/usr/bin/env node
// Checked before anything else loads, so an old Node gets one clear sentence instead of a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`Overtime needs Node.js 22.19 or newer; this is ${process.versions.node}. Install a newer Node (https://nodejs.org) and try again.`);
  process.exit(1);
}
await import("./cli.js");
