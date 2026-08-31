#!/usr/bin/env python3
"""Run `forge coverage` and fail loudly *before* the runner runs out of memory.

WHY THIS EXISTS (issue #1298)
-----------------------------
`forge-coverage-gate` used to run `forge coverage --report lcov --ir-minimum`.
`--ir-minimum` enables `viaIR`, and solc's viaIR pipeline holds the whole
compilation unit's Yul IR in memory at once, so its peak RSS grows steeply and
super-linearly with the compile set. Peak RSS of the whole coverage run,
pinned solc 0.8.24, measured on an unconstrained host:

    174 files (`dev` @ 969cfc84), `--ir-minimum`    -> 17.48 GiB, 7m12s
    178 files (#1293 @ 3faeadd9), `--ir-minimum`    -> 18.00 GiB, 9m30s
    174 files, no `--ir-minimum`                    ->  2.27 GiB, 0m24s
    178 files, no `--ir-minimum`                    ->  2.30 GiB, 1m10s

A GitHub-hosted `ubuntu-latest` runner has 16 GB of RAM, and both viaIR figures
are above it. `dev` at 174 files survived only because the allocator reuses
arenas under memory pressure rather than growing; four more Solidity files were
enough that it no longer could, and the kernel took the runner down mid-compile.
GitHub surfaces that as `The runner has received a shutdown signal` +
`exit code 143`, which reads like infrastructure flake and provokes a re-run
that cannot possibly succeed. Two agents each burned a diagnosis cycle on it.

Dropping `--ir-minimum` removed the memory cliff (see the workflow comment for
why the flag was not needed). This guard exists so the cliff cannot be
rediscovered the same way: it measures the actual peak RSS of the coverage run
and fails with an explanatory message once the run consumes more than
`COVERAGE_MEM_CEILING_PCT` of the runner's RAM — far below the point at which
the kernel would kill the runner. A red gate that says "coverage now uses 55%
of runner RAM" is a diagnosis; `exit code 143` is not.

HOW THE MEASUREMENT WORKS
-------------------------
`forge` shells out to `solc`, so the memory that matters belongs to a
grandchild of this script. `getrusage(RUSAGE_CHILDREN).ru_maxrss` reports the
maximum RSS reached by any waited-for descendant, propagated transitively up
the process tree -- the same number GNU `/usr/bin/time -v` reports, and
`/usr/bin/time` is not installed on GitHub-hosted runners. Python is, because
this job already sets it up for `check_gateway_coverage.py`.

USAGE
    python3 .github/scripts/run_coverage_memory_guard.py forge coverage ...
    python3 .github/scripts/run_coverage_memory_guard.py --self-test

The `--self-test` mode runs in CI immediately before the real coverage step. A
memory guard that cannot go red is worse than no guard, so the self-test proves
the measurement sees a known allocation, that the guard passes under budget,
that it fails over budget, and that a failing inner command still propagates.

ENVIRONMENT
    COVERAGE_MEM_CEILING_PCT  hard fail above this % of MemTotal (default 50)
    COVERAGE_MEM_WARN_PCT     warn above this % of MemTotal (default 35)
"""

from __future__ import annotations

import os
import resource
import subprocess
import sys

DEFAULT_CEILING_PCT = 50.0
DEFAULT_WARN_PCT = 35.0

# Fallback when /proc/meminfo is unreadable: the documented RAM of a
# GitHub-hosted `ubuntu-latest` standard runner.
FALLBACK_MEM_TOTAL_KIB = 16 * 1024 * 1024


def _mem_total_kib() -> tuple[int, bool]:
    """Return (MemTotal in KiB, measured?) for the machine running this job."""
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]), True
    except (OSError, ValueError, IndexError):
        pass
    return FALLBACK_MEM_TOTAL_KIB, False


def _pct_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        print(f"  [warn] {name}={raw!r} is not a number; using {default}")
        return default
    if not 0 < value <= 100:
        print(f"  [warn] {name}={value} out of range (0, 100]; using {default}")
        return default
    return value


def _self_test() -> int:
    """Prove the guard can measure, can pass, and can go red.

    A memory guard that is structurally incapable of failing is worse than no
    guard, because it looks like protection. This exercises the real code path
    end to end against a subprocess that allocates a known amount, under both a
    generous and an impossible ceiling.
    """
    alloc_mib = 256
    allocator = [
        sys.executable,
        "-c",
        f"b = bytearray({alloc_mib} * 1024 * 1024); b[::4096] = b'x' * len(b[::4096])",
    ]
    me = [sys.executable, os.path.abspath(__file__)]
    failures: list[str] = []

    # 1. A run well under the ceiling must pass and must report a non-trivial
    #    peak — if the measurement silently read zero, the guard is blind.
    generous = dict(os.environ, COVERAGE_MEM_CEILING_PCT="99", COVERAGE_MEM_WARN_PCT="98")
    ok_run = subprocess.run(
        me + allocator, env=generous, capture_output=True, text=True, check=False
    )
    if ok_run.returncode != 0:
        failures.append(f"under-ceiling run should exit 0, got {ok_run.returncode}")
    peak_line = [ln for ln in ok_run.stdout.splitlines() if "peak RSS" in ln]
    if not peak_line:
        failures.append("under-ceiling run printed no peak-RSS line")
    else:
        try:
            measured_gib = float(peak_line[0].split(":")[1].strip().split()[0])
        except (IndexError, ValueError):
            measured_gib = -1.0
        # Expect at least half of what the child touched; anything near zero
        # means RUSAGE_CHILDREN is not seeing the descendant at all.
        if measured_gib < (alloc_mib / 2) / 1024:
            failures.append(
                f"measured peak {measured_gib} GiB is implausibly low for a "
                f"{alloc_mib} MiB allocation — the measurement is not working"
            )

    # 2. The same run under an unreachable ceiling must go red.
    strict = dict(os.environ, COVERAGE_MEM_CEILING_PCT="0.01", COVERAGE_MEM_WARN_PCT="0.005")
    red_run = subprocess.run(
        me + allocator, env=strict, capture_output=True, text=True, check=False
    )
    if red_run.returncode == 0:
        failures.append("over-ceiling run should have failed, but exited 0")
    if "FAIL:" not in red_run.stdout:
        failures.append("over-ceiling run did not print a FAIL explanation")

    # 3. A failing inner command must propagate its status even when memory is fine.
    inner_fail = subprocess.run(
        me + [sys.executable, "-c", "raise SystemExit(7)"],
        env=generous,
        capture_output=True,
        text=True,
        check=False,
    )
    if inner_fail.returncode != 7:
        failures.append(
            f"inner command exit status should propagate as 7, got {inner_fail.returncode}"
        )

    for failure in failures:
        print(f"SELF-TEST FAIL: {failure}", file=sys.stderr)
    if failures:
        return 1
    print("SELF-TEST OK: memory guard measures, passes under budget, and goes red over it.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return _self_test()

    command = argv[1:]
    if not command:
        print(
            "usage: run_coverage_memory_guard.py <command> [args...]",
            file=sys.stderr,
        )
        return 2

    completed = subprocess.run(command, check=False)

    peak_kib = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    mem_total_kib, measured = _mem_total_kib()
    ceiling_pct = _pct_env("COVERAGE_MEM_CEILING_PCT", DEFAULT_CEILING_PCT)
    warn_pct = _pct_env("COVERAGE_MEM_WARN_PCT", DEFAULT_WARN_PCT)

    used_pct = 100.0 * peak_kib / mem_total_kib
    peak_gib = peak_kib / 1024 / 1024
    total_gib = mem_total_kib / 1024 / 1024
    ceiling_gib = total_gib * ceiling_pct / 100.0
    headroom_gib = ceiling_gib - peak_gib
    source = "/proc/meminfo" if measured else "assumed ubuntu-latest default"

    print()
    print("=== forge coverage memory headroom (issue #1298) ===")
    print(f"  peak RSS of the coverage run : {peak_gib:.2f} GiB")
    print(f"  runner RAM                   : {total_gib:.2f} GiB ({source})")
    print(f"  used                         : {used_pct:.1f}% of runner RAM")
    print(f"  ceiling                      : {ceiling_gib:.2f} GiB ({ceiling_pct:g}%)")
    print(f"  headroom to ceiling          : {headroom_gib:.2f} GiB")
    if peak_gib > 0:
        print(f"  growth room before ceiling   : {ceiling_gib / peak_gib:.1f}x")

    if used_pct > ceiling_pct:
        print()
        print(
            f"FAIL: the coverage compile peaked at {peak_gib:.2f} GiB, which is "
            f"{used_pct:.1f}% of this runner's {total_gib:.2f} GiB — above the "
            f"{ceiling_pct:g}% ceiling."
        )
        print(
            "This gate is deliberately red BEFORE the runner OOMs. If it were "
            "allowed to keep growing, the next failure would arrive as "
            "'The runner has received a shutdown signal' / 'exit code 143' "
            "mid-compile, which reads as infrastructure flake and cannot be "
            "fixed by re-running (issue #1298)."
        )
        print("Options, roughly in order of preference:")
        print(
            "  - check nothing re-introduced `--ir-minimum` / `via_ir` into the "
            "coverage compile; viaIR is what made this job memory-bound"
        )
        print("  - reduce what the coverage profile has to compile in one solc unit")
        print("  - move to a runner with more RAM, then raise the ceiling here")
        print(
            "  - if the growth is legitimate and the margin is still real, raise "
            "COVERAGE_MEM_CEILING_PCT deliberately, in a commit that says why"
        )
        # A memory regression is reported even when the coverage run itself
        # passed; if forge also failed, its status is the more urgent one.
        return completed.returncode or 1

    if used_pct > warn_pct:
        print()
        print(
            f"::warning::forge coverage peaked at {peak_gib:.2f} GiB "
            f"({used_pct:.1f}% of runner RAM); the gate fails above "
            f"{ceiling_pct:g}%. See issue #1298."
        )

    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
