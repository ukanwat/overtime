import { connect } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * Whether this machine can reach the internet: a name can be looked up and a well-known address
 * answers. Only a hint (a proxy can make it fail while things work), so Overtime treats the machine as
 * offline only when this fails and no backend has made progress for a while either.
 */
export async function probeOnline(timeoutMs = 4_000): Promise<boolean> {
  // Behind a proxy, direct connections may be blocked while everything works: no verdict there.
  if (["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((k) => process.env[k])) return true;
  const tcp = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port: 443 });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  const dns = (name: string) =>
    Promise.race([lookup(name).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
  const [reach, names] = await Promise.all([
    Promise.all([tcp("1.1.1.1"), tcp("8.8.8.8")]).then((r) => r.some(Boolean)),
    Promise.all([dns("one.one.one.one"), dns("dns.google")]).then((r) => r.some(Boolean)),
  ]);
  return reach && names;
}
