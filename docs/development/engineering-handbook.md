# Robot Money — Engineering Handbook

Durable engineering principles that hold across features and outlive any single
issue. These are **not** product requirements (see `docs/prd.md`) or
architecture specifics (see `docs/architecture.md`); they are the working rules
the codebase is held to, written so that a new contributor — human or agent —
can understand both *what* the rule is and *why* it is industry-standard rather
than a local invention.

## Principles

- [Single Production Codebase](single-production-codebase.md) — there is one
  production codebase; environments differ only by configuration and seeded
  data, never by code variants.

## How to use this handbook

- Read the relevant principle before designing a change that touches its area.
- When a principle and a deadline conflict, raise it explicitly rather than
  quietly forking behaviour — the whole point of writing these down is that they
  are not re-litigated per task.
- Each principle cites prior art with dates so the rule can be defended, not
  just asserted.
