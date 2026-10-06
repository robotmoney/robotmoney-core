// Hidden prompt. Refuses when there is no terminal: an unattended job must get its secrets from the environment
// (GitHub Environment secrets), never from a passphrase that nobody can type.
export async function hidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("no terminal: unattended jobs take secrets from their environment (GitHub Environment secrets), not from a typed passphrase");
  process.stdout.write(`${question}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let input = "";
      const onData = (data: Buffer) => {
        // A pasted value arrives as one chunk, a typed one as single keystrokes: handle every character either way.
        for (const ch of stripEscapes(data.toString())) {
          const r = applyKey(input, ch);
          input = r.input;
          if (r.done) { stdin.off("data", onData); process.stdout.write("\n"); resolve(input); return; }
          if (r.cancelled) { stdin.off("data", onData); reject(new Error("cancelled")); return; }
        }
      };
      stdin.on("data", onData);
    });
  } finally { stdin.setRawMode(false); stdin.pause(); }
}

/** One keystroke applied to the input so far. Pure, so it is testable without a terminal. */
export function applyKey(input: string, ch: string): { input: string; done?: boolean; cancelled?: boolean } {
  if (ch === "\r" || ch === "\n") return { input, done: true };
  if (ch === "\u0003") return { input, cancelled: true };
  if (ch === "\x7f" || ch === "\b") return { input: input.slice(0, -1) };
  if (ch >= " ") return { input: input + ch };
  return { input };
}

/** Arrow keys and similar arrive as ESC [ ... letter; they must not end up in a secret. */
export const stripEscapes = (chunk: string): string => chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
