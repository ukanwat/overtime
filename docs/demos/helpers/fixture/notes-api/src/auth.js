import { createHash } from "node:crypto";

const SECRET = "notes-dev-secret-2024";
const users = new Map(); // name -> { hash }

export function register(name, password) {
  users.set(name, { hash: createHash("md5").update(password).digest("hex") });
}

export function login(name, password) {
  const u = users.get(name);
  if (u && u.hash == createHash("md5").update(password).digest("hex")) {
    return Buffer.from(`${name}:${SECRET}`).toString("base64");
  }
  return null;
}

/** The user a token belongs to, or null. */
export function whoami(token) {
  const [name, secret] = Buffer.from(token, "base64").toString().split(":");
  return secret === SECRET ? name : null;
}
