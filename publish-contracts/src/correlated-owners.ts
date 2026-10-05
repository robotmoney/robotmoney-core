// The correlated-owners floor's input: a FILE of public addresses (never a key) that share one root of trust, for example
// owners derived from one mnemonic. The caller supplies the file (--correlated-owners-file, or CORRELATED_OWNERS_FILE);
// this package derives nothing and calls no credential tool. On chain 8453 the file is REQUIRED.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublishError } from "./errors.ts";
import { parseCorrelatedOwners } from "./floors.ts";

export interface LoadCorrelatedOpts {
  /** The --correlated-owners-file argument. */
  file?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Reads the file named by the argument, else by CORRELATED_OWNERS_FILE. Refuses when none is named or the file is missing. */
export function loadCorrelatedOwners(o: LoadCorrelatedOpts = {}): string[] {
  const env = o.env ?? process.env;
  const named = o.file ?? env.CORRELATED_OWNERS_FILE;
  if (!named) throw new PublishError("FLOOR", "chain 8453 needs --correlated-owners-file (or CORRELATED_OWNERS_FILE): a file of the addresses that share one root of trust, so the owner-independence floor can run");
  const path = resolve(o.cwd ?? process.cwd(), named);
  if (!existsSync(path)) throw new PublishError("FLOOR", `the correlated-owners file ${path} does not exist`);
  return parseCorrelatedOwners(readFileSync(path, "utf8"));
}
