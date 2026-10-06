// Structured logs for the publish contracts CLI: one JSON object per line on stderr. Secret-looking keys are redacted by name
// (the same redaction the Safe tool uses), so a passphrase or key never reaches a log line.
import { jsonLogger, type Logger, type LogSink } from "./safe/log.ts";
export type { Logger, LogSink };
export const publishLogger = (sink?: LogSink, base: Record<string, unknown> = {}): Logger => jsonLogger(sink, { component: "publish", ...base });
