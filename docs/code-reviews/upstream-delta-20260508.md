# Upstream Delta Review — `robotmoney/robot-money` vs `robotmoney-skills`

**Date:** 2026-05-08  
**Upstream:** `github.com/robotmoney/robot-money` @ `4db2f60` ("audit changes")  
**Our fork:** `lucky-tensor/robotmoney-skills` @ `e54de4f`  
**Anchor:** `docs/code-reviews/code-review-codex-20260508-1522.md`

This document answers two questions:
1. Which of our five review findings are also present in the upstream contracts (i.e., the bugs originate there)?
2. What does the upstream have that our fork doesn't, and does it introduce new risks?

---

## Finding Status in Upstream

| Finding | Our review | Upstream status |
|---------|-----------|-----------------|
| F1 — `_decimalsOffset = 0` (inflation) | HIGH | **Present** — identical line 132 |
| F2 — `totalAssets()` misses idle USDC | HIGH | **Present** — identical lines 136–143 |
| F3 — Gateway CEI violation | MEDIUM | **N/A** — upstream has no gateway contract |
| F4 — `MorphoAdapter.withdraw()` unverified amount | MEDIUM | **Present** — identical lines 42–45 |
| F5 — Vault `unpause()` uses `EMERGENCY_ROLE` | MEDIUM | **Present** — identical lines 434–435 |

All four vault/adapter findings trace back to the upstream source. The upstream `4db2f60` commit is labelled "audit changes" — so these were present after their own audit pass.

---

## What the Upstream Has That Our Fork Doesn't

The upstream includes a `server/` directory: a TypeScript/Express admin server that holds the vault admin private key in memory and exposes every vault admin operation as an authenticated HTTP endpoint. Our fork removed this in favour of the wallet-based dapp + `rmpc` agent client. That architectural decision was correct. The server introduces several risks described below.

---

## New Findings in Upstream (not present in our fork)

---

### Finding U1 — HIGH: Server Holds Admin Private Key in Memory

**File:** `server/src/config/env.ts:12`, `server/src/services/vault.ts:6`

```typescript
// env.ts
privateKey: requireEnv("PRIVATE_KEY"),

// vault.ts — module-level singleton
const wallet = new ethers.Wallet(config.privateKey, provider);
export const vault = new ethers.Contract(config.vaultAddress, VAULT_ABI, wallet);
```

The server process loads the admin private key at startup into a module-level `ethers.Wallet` singleton that persists for the lifetime of the process. This wallet is presumed to hold `ADMIN_ROLE` on the vault (it calls `addAdapter`, `grantRole`, `emergencyWithdraw`, `shutdownVault`, etc.).

**A single compromise of the server process — or the environment it runs in — gives an attacker:**
- Full `ADMIN_ROLE` authority: add a malicious adapter, drain funds via `adminRebalance`, set a new `feeRecipient`, grant themselves roles
- `EMERGENCY_ROLE` operations if the same key holds both: `emergencyWithdraw` (pulls all funds to vault, unpauses possible), `forceRemoveAdapter`, `shutdownVault`

There is no multisig quorum, no HSM, no hardware isolation. The security of the entire vault collapses to the security of a single process's environment variables.

**Contrast with our fork:** The dapp uses the operator's own wallet via wagmi (key never touches the server). `rmpc` uses an Argon2id + AES-256-GCM encrypted keystore, never loads the key for admin operations. Admin operations require a human-in-the-loop wallet signature.

**Recommendation:** The server architecture should not hold admin private keys. At minimum, migrate to a multisig (e.g. Safe) and have the server construct unsigned transactions that are then queued for multisig approval. Better: the dapp pattern already implemented in our fork.

---

### Finding U2 — MEDIUM: Error Messages from ethers/RPC Leaked to HTTP Clients

**File:** `server/src/routes/status.ts:10`, `server/src/routes/admin.ts:30`

```typescript
// status.ts
res.status(500).json({ error: (err as Error).message });

// admin.ts
p.then((result) => res.json(result))
 .catch((err: Error) => res.status(500).json({ error: err.message }));
```

`ethers.js` error messages on RPC failures frequently contain:
- The full RPC URL (including any API key embedded in the path: e.g. `https://base-mainnet.g.alchemy.com/v2/ALCHEMY_API_KEY`)
- ABI-decoded revert reasons that expose internal contract state
- Transaction details including `from`, `to`, `data`, `gasLimit`

Any caller who can reach the server (including unauthenticated callers hitting `/status`) and trigger an RPC error will receive these details in the response body.

**Recommendation:** Wrap errors before returning: log `err.message` server-side, return a generic "internal error" to the client. The explorer API in our fork correctly does this (`ApiError::Database` → "internal error").

---

### Finding U3 — MEDIUM: `/status` Endpoint Carries No Authentication

**File:** `server/src/index.ts:10-11`

```typescript
app.use("/status", statusRoutes);   // no auth middleware
app.use("/admin", adminRoutes);     // auth applied here only
```

The `/status` route returns a detailed snapshot of vault internals: all adapter addresses and balances, rebalance timing (`lastRebalanceAt`, `nextAvailableAt`), TVL cap, per-deposit cap, exit fee, fee recipient address, and shutdown state.

All of this is derivable from on-chain state, so it is not secret. However, a structured, off-chain API endpoint makes reconnaissance significantly easier for an attacker planning a front-running or timing attack against the rebalance window. The `nextAvailableAt` field is particularly useful: it tells an attacker exactly when the next keeper rebalance call will be eligible, allowing precise front-running of adapter-level pricing.

**Recommendation:** Either add the `auth` middleware to `/status` (consistent with the rest of the server), or accept that this endpoint is public and ensure it never returns data that is not already on-chain. At minimum, remove `nextAvailableAt` and `lastRebalanceAt` from the unauthenticated response.

---

### Finding U4 — LOW: API Key Comparison Not Constant-Time

**File:** `server/src/middleware/auth.ts:5`

```typescript
if (key !== config.apiKey) {
```

JavaScript's `!==` operator on strings is not guaranteed to be constant-time. In a local network environment where an attacker can make many rapid requests and measure response latency, it may be possible to distinguish a prefix match from a full mismatch, enabling a character-by-character brute-force of the API key.

In practice this is very hard to exploit over a network (latency variance dominates), but the fix is trivial:

```typescript
import { timingSafeEqual } from "crypto";
const provided = Buffer.from(key ?? "", "utf8");
const expected = Buffer.from(config.apiKey, "utf8");
if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { ... }
```

**Recommendation:** Use `crypto.timingSafeEqual` for the comparison.

---

### Finding U5 — LOW: No Audit Log for Admin Operations

**File:** `server/src/routes/admin.ts` (all routes)

The `handle()` helper submits transactions and returns the tx hash. There is no structured log of which API key caller submitted which admin action at what time. If the API key is compromised and an attacker calls `shutdownVault` or `addAdapter`, there is no server-side record linking the HTTP request to the on-chain transaction.

**Recommendation:** Log a structured entry (timestamp, action name, tx hash, caller IP) for every admin route invocation, successful or not. This is the equivalent of the audit log that `rmpc` implements in `logging.rs::AuditSink`.

---

## Architectural Summary

| Dimension | `robot-money` upstream | `robotmoney-skills` fork |
|-----------|----------------------|--------------------------|
| Admin key custody | Hot key in server env var | Wallet-based (operator's hardware/software wallet) |
| Agent key custody | N/A | Argon2id + AES-256-GCM keystore, loaded only when needed |
| Admin operation auth | Single API key | Wallet signature (on-chain AccessControl) |
| Agent operation auth | N/A | On-chain policy (per-payment + per-window caps) |
| Gateway contract | None | `RobotMoneyGateway` with CEI + policy enforcement |
| Audit trail | None | `rmpc` JSON audit log |
| Error leakage | RPC error messages exposed | Masked behind generic "internal error" |
| Vault findings | F1 + F2 + F4 + F5 unaddressed | Same (fixes pending issues #160–#164) |

Our fork's architectural decisions — removing the hot-key server, adding the gateway, adding the `rmpc` policy layer — represent a meaningful security uplift over the upstream. The four vault-level findings (F1, F2, F4, F5) need to be fixed in both codebases.

---

*Review conducted 2026-05-08 against `robot-money` @ `4db2f60` and `robotmoney-skills` @ `e54de4f`.*
