// Structured JSON logging: one JSON object per line, to stderr by default. Anything that looks like a secret is redacted by key
// name, so a signer passphrase, key or keystore can never reach a log line even if a caller passes it by mistake.
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;
export interface Logger { log(level: LogLevel, event: string, fields?: Record<string, unknown>): void }

const SECRET_KEY = /pass(word|phrase)?|private|secret|mnemonic|keystore(_?json)?$|^key$|seed/i;
const SAFE_KEYS = new Set(["keystore_path", "keystore_address", "passphrase_source", "signer_kind"]);

export function redact(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key) && !SAFE_KEYS.has(key)) return "[redacted]";
  if (depth > 6) return "[deep]";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  return value;
}

export function jsonLogger(sink: LogSink = (l) => process.stderr.write(l + "\n"), base: Record<string, unknown> = { component: "safe" }): Logger {
  return {
    log(level, event, fields = {}) {
      sink(JSON.stringify(redact({ ts: new Date().toISOString(), level, event, ...base, ...fields })));
    },
  };
}

export const silentLogger: Logger = { log() {} };
