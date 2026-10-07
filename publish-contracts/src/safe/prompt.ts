// Hidden prompt, same behavior as src/keystore/prompt.ts: refuses without a terminal, never echoes, strips escape sequences.
import { SafeToolError } from "./errors.ts";

export async function hiddenPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new SafeToolError("PASSPHRASE_UNAVAILABLE", "no terminal for the hidden passphrase prompt: pass a 0600 passphrase file path instead");
  process.stderr.write(`${question}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let input = "";
      const onData = (data: Buffer) => {
        for (const ch of stripEscapes(data.toString())) {
          const r = applyKey(input, ch);
          input = r.input;
          if (r.done) { stdin.off("data", onData); process.stderr.write("\n"); resolve(input); return; }
          if (r.cancelled) { stdin.off("data", onData); reject(new SafeToolError("PASSPHRASE_UNAVAILABLE", "passphrase prompt cancelled")); return; }
        }
      };
      stdin.on("data", onData);
    });
  } finally { stdin.setRawMode(false); stdin.pause(); } // pause-guard: allow (Node stdin, not a vault)
}

export function applyKey(input: string, ch: string): { input: string; done?: boolean; cancelled?: boolean } {
  if (ch === "\r" || ch === "\n") return { input, done: true };
  if (ch === "\u0003") return { input, cancelled: true };
  if (ch === "\x7f" || ch === "\b") return { input: input.slice(0, -1) };
  if (ch >= " ") return { input: input + ch };
  return { input };
}

export const stripEscapes = (chunk: string): string => chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
