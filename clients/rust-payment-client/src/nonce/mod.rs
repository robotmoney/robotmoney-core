//! Canonical: docs/implementation-plan.md §4.6 — Nonce management
//!
//! `nonce` — single-flight per-agent file lock.
//!
//! Per `docs/implementation-plan.md` §3.6 and issue #12. The MVP CLI
//! is single-flight: each `rmpc deposit` invocation acquires an
//! exclusive OS-level advisory lock on
//! `<state_dir>/agent-<address>.lock` and holds it across the entire
//! `(eth_getTransactionCount → sign → broadcast → receipt)` window.
//! Concurrent invocations against the same agent address fail fast with
//! [`RmpcError::ErrConcurrentInvocation`] — there is no waiting, no
//! queueing, no replacement. A full nonce manager (with pending-tx
//! queue, replacement, gap recovery) is v1 work.
//!
//! Why advisory lock + lock file (not the nonce file itself):
//!
//! - We don't want to clobber the file we are reading from on contention.
//! - `fs2::try_lock_exclusive` is `O_NONBLOCK`-equivalent: a second
//!   invocation gets `WouldBlock` immediately and we map that to the
//!   named error. No timeouts, no flaky CI.
//! - The lock is *released by the kernel* when the file descriptor is
//!   closed (process exit or [`AgentLock`] drop), so a panicking
//!   invocation cannot leave a stale lock behind. A leftover *file* on
//!   disk is fine; it is reused on the next run.
//!
//! Lock files live alongside operator state in `state_dir`. The address
//! is rendered as lowercase hex (no checksum) so two invocations
//! disagreeing on EIP-55 casing still collide.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use alloy_primitives::Address;
use fs2::FileExt;

use crate::errors::{Result, RmpcError};

/// Filename pattern for the per-agent lock. Public so the e2e harness
/// can inspect it from the same `state_dir`.
///
/// The address is lowercase hex without the `0x` prefix; this matches
/// the convention used by existing keystore tooling.
pub fn lock_path(state_dir: &Path, address: &Address) -> PathBuf {
    state_dir.join(format!("agent-{}.lock", hex::encode(address.as_slice())))
}

/// RAII guard for the per-agent lock. Drop releases the OS-level lock
/// (the lock file itself is left on disk and reused on the next run).
///
/// The handle is intentionally `!Clone`: cloning would let two callers
/// believe they each hold the lock, defeating its purpose. To pass the
/// guard around, move it.
#[derive(Debug)]
pub struct AgentLock {
    /// Held purely so the file descriptor (and the lock) live as long
    /// as this struct does. Released by [`fs2::FileExt::unlock`] in
    /// `Drop`.
    file: File,
    path: PathBuf,
}

impl AgentLock {
    /// Acquire an exclusive lock for `address` under `state_dir`.
    ///
    /// `state_dir` is created if missing — `rmpc` is normally run by an
    /// operator who has already provisioned the directory, but in tests
    /// we want one-call setup. We do not pre-fsync the directory; this
    /// is advisory locking, not durable state.
    ///
    /// On contention returns [`RmpcError::ErrConcurrentInvocation`].
    pub fn acquire(state_dir: &Path, address: &Address) -> Result<Self> {
        std::fs::create_dir_all(state_dir).map_err(|e| {
            RmpcError::ErrConfig(format!(
                "nonce: cannot create state dir {}: {e}",
                state_dir.display()
            ))
        })?;

        let path = lock_path(state_dir, address);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { file, path }),
            Err(e) => {
                // `fs2` returns a `WouldBlock`-class error on contention.
                // Anything else (EACCES on a read-only fs, EIO, …) is
                // operator misconfig and gets surfaced as `ErrIo`.
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Err(RmpcError::ErrConcurrentInvocation)
                } else {
                    Err(RmpcError::ErrIo(e))
                }
            }
        }
    }

    /// Path to the lock file. Useful for diagnostics; do not open it
    /// from another handle while the guard is alive.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for AgentLock {
    fn drop(&mut self) {
        // `unlock` is best-effort: by the time we reach Drop the
        // descriptor is moments away from being closed (which also
        // releases the lock), so a failure here is informational only.
        // We deliberately do not log — the daemon's logger may already
        // be torn down on shutdown paths.
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn addr() -> Address {
        address!("00000000000000000000000000000000000000aa")
    }

    #[test]
    fn first_acquire_succeeds_and_creates_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let lock = AgentLock::acquire(dir.path(), &addr()).expect("first acquire");
        assert!(lock.path().exists(), "lock file must exist on disk");
        drop(lock);
    }

    #[test]
    fn second_acquire_while_held_returns_concurrent_invocation() {
        let dir = tempfile::tempdir().unwrap();
        let _held = AgentLock::acquire(dir.path(), &addr()).unwrap();
        let err = AgentLock::acquire(dir.path(), &addr()).unwrap_err();
        assert!(
            matches!(err, RmpcError::ErrConcurrentInvocation),
            "expected ErrConcurrentInvocation, got {err:?}"
        );
    }

    #[test]
    fn release_on_drop_lets_next_invocation_acquire() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _held = AgentLock::acquire(dir.path(), &addr()).unwrap();
        } // drop → unlock
        AgentLock::acquire(dir.path(), &addr()).expect("after drop");
    }

    #[test]
    fn different_addresses_do_not_contend() {
        let dir = tempfile::tempdir().unwrap();
        let a = address!("00000000000000000000000000000000000000aa");
        let b = address!("00000000000000000000000000000000000000bb");
        let _la = AgentLock::acquire(dir.path(), &a).unwrap();
        let _lb = AgentLock::acquire(dir.path(), &b).expect("disjoint addresses must not contend");
    }

    /// Two threads contending on `acquire` for the same address: while one
    /// thread holds the lock, the other thread's acquire MUST fail with
    /// `ErrConcurrentInvocation`. This is deterministic: the holder
    /// acquires *before* the barrier releases, then both threads
    /// rendezvous, the contender attempts to acquire while the holder is
    /// guaranteed to still own the lock, and only after the contender has
    /// observed contention does the holder release.
    ///
    /// The earlier "racing-only" formulation (both threads call `acquire`
    /// after a single barrier and the test asserts exactly one winner)
    /// was racy: if the contender's `try_lock_exclusive` arrived after
    /// the holder had already dropped, both calls would succeed and the
    /// `oks == 1` assertion would fail spuriously. We don't lose
    /// coverage: a second test (`second_acquire_while_held_returns_…`)
    /// already exercises the in-process held-lock semantics, and this
    /// version additionally proves the result holds across threads
    /// (different file descriptors) under a forced overlap.
    #[test]
    fn racing_threads_only_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().to_path_buf();

        // Holder thread acquires first, parks at the barrier with the
        // lock still held, then waits for the contender to finish before
        // releasing. Two barriers form the rendezvous: `start` (holder
        // has the lock; contender may now race) and `done` (contender
        // has its result; holder may release).
        let start = Arc::new(Barrier::new(2));
        let done = Arc::new(Barrier::new(2));

        let p_holder = path.clone();
        let s_holder = start.clone();
        let d_holder = done.clone();
        let holder = thread::spawn(move || -> Result<()> {
            let lock = AgentLock::acquire(&p_holder, &addr())?;
            s_holder.wait(); // signal: lock is held
            d_holder.wait(); // wait until contender has observed contention
            drop(lock);
            Ok(())
        });

        let p_contender = path;
        let s_contender = start;
        let d_contender = done;
        let contender = thread::spawn(move || -> Result<()> {
            s_contender.wait(); // wait until holder has the lock
            let result = AgentLock::acquire(&p_contender, &addr()).map(drop);
            d_contender.wait(); // signal: contender done, holder may release
            result
        });

        let holder_result = holder.join().unwrap();
        let contender_result = contender.join().unwrap();

        holder_result.expect("holder must acquire successfully");
        let err = contender_result.expect_err("contender must fail while holder is alive");
        assert!(
            matches!(err, RmpcError::ErrConcurrentInvocation),
            "contender must see ErrConcurrentInvocation, got {err:?}"
        );

        // Sanity: after both threads exit, a fresh acquire must succeed
        // (the holder's drop released the kernel-level lock).
        AgentLock::acquire(dir.path(), &addr()).expect("post-race acquire must succeed");
    }

    #[test]
    fn lock_path_uses_lowercase_hex_without_0x() {
        let dir = Path::new("/tmp/example-state-dir");
        let p = lock_path(dir, &address!("00000000000000000000000000000000000000Aa"));
        // Lowercase, no 0x: two invocations passing different EIP-55
        // checksums collide on the same lock file.
        assert!(p
            .to_string_lossy()
            .ends_with("agent-00000000000000000000000000000000000000aa.lock"));
    }
}
