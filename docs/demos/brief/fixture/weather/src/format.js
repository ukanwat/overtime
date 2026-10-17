import { toFahrenheit } from "./convert.js";

/** One line for a forecast: "Lisbon: 21°C (70°F), light rain, wind 14 km/h". */
export function line(f) {
  const sky = f.rain ? (f.rain > 5 ? "heavy rain" : "light rain") : f.cloud > 60 ? "cloudy" : "clear";
  return `${f.city}: ${f.temp}°C (${toFahrenheit(f.temp)}°F), ${sky}, wind ${f.wind} km/h`;
}
