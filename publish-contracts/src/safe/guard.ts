// Credential rules checked before any network call: plaintext signing material in the environment is refused against any non-loopback RPC.
import { isLoopbackRpc } from "./chain.ts";
import { SafeToolError } from "./errors.ts";

export function assertNoPlaintextKeys(rpcUrl: string, env: NodeJS.ProcessEnv): void {
  if (isLoopbackRpc(rpcUrl)) return;
  if (env.ETH_PRIVATE_KEY || env.PRIVATE_KEY) {
    throw new SafeToolError("PLAINTEXT_KEY_REFUSED", "refusing a private key in the environment against a non-loopback RPC. Use an encrypted keystore from the credential engine or a hardware wallet.");
  }
}
