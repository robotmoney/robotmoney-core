/** The only process this package's rehearsal helpers spawn is cast. Tests inject a fake Cast. */
export type Cast = (args: string[], env?: Record<string, string>) => Promise<string>;

export const realCast: Cast = async (args, env) => {
  const p = Bun.spawn(["cast", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(env ?? {}) } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`cast ${args[0]} failed: ${err.trim().split("\n").slice(-2).join(" ")}`);
  return out.trim();
};

export function rpcHost(url: string): string {
  let a = url.replace(/^[a-z]+:\/\//i, "");
  a = a.split(/[/?#]/)[0] ?? "";
  a = a.slice(a.lastIndexOf("@") + 1);
  a = a.startsWith("[") ? a.slice(1, a.indexOf("]")) : a.split(":")[0] ?? "";
  return a.toLowerCase();
}
export const isLoopback = (url: string): boolean => ["127.0.0.1", "localhost", "::1"].includes(rpcHost(url));

export const PLAINTEXT_ENV = ["PRIVATE_KEY", "ETH_PRIVATE_KEY", "MNEMONIC", "ETH_MNEMONIC", "ETH_PASSWORD"];
