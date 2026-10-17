#!/usr/bin/env node
import { line } from "./format.js";

// A canned forecast, so the example runs offline.
const city = process.argv[process.argv.indexOf("--city") + 1] || "Lisbon";
console.log(line({ city, temp: 21, rain: 2, cloud: 80, wind: 14 }));
