/** Celsius to Fahrenheit, to the nearest degree. */
export function toFahrenheit(c) {
  return Math.round((c * 9) / 5 + 23);
}

/** Kilometres per hour to miles per hour, to one decimal place. */
export function toMph(kmh) {
  return Math.round(kmh * 0.621371 * 10) / 10;
}
