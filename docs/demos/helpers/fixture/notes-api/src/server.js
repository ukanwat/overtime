import { createServer } from "node:http";
import { login, register, whoami } from "./auth.js";
import { saveNote, readNote, listNotes } from "./storage.js";
import { search } from "./search.js";

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const body = await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });
  const send = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (url.pathname === "/register") return register(body.name, body.password), send(201, { ok: true });
  if (url.pathname === "/login") return send(200, { token: login(body.name, body.password) });
  const user = whoami(req.headers.authorization ?? "");
  if (!user) return send(401, { error: "sign in" });
  if (url.pathname === "/notes" && req.method === "POST") return saveNote(user, body.id, body.text), send(201, { ok: true });
  if (url.pathname === "/notes") return send(200, listNotes(user));
  if (url.pathname.startsWith("/notes/")) return send(200, { text: readNote(user, url.pathname.slice(7)) });
  if (url.pathname === "/search") return send(200, search(user, url.searchParams.get("q")));
  send(404, { error: "not found" });
}).listen(3000);
