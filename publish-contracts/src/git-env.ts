// The environment of every git child that proves a counts checkout or the core checkout (issue 1740 review).
// Every GIT_* variable of the caller (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_CONFIG*, ...) is dropped, so the checks read the
// repository `-C` names and never one the environment redirects to. System and global config are off, replace refs are off (a refs/replace ref could fake ancestry),
// and the fsmonitor program of a repo-local config is off.

const SAFE: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" };

/** `base` without any GIT_* variable, plus the safe settings. */
export function scrubGitEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...SAFE };
}

/** Only PATH and HOME of `base` survive. */
export function gitEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  return scrubGitEnv({ PATH: base.PATH, HOME: base.HOME });
}
