<!-- Living document. Open-ended modeling and assurance questions that must be
studied before the related product decision can be made. Split out of
docs/development/open-questions.md (which tracks product/engineering decisions);
these are research/analysis tracks, not features to build. Subsection
identifiers (§3.8, §3.10) are retained as stable cross-reference anchors. -->

# Robot Money — Research Questions

Open-ended modeling and analysis derived from the source documents under
`docs/papers/`. Unlike the product/engineering questions in
`docs/development/open-questions.md`, these are not decisions to make or features
to build — they are studies that must be carried out (and, for §3.10, repeated)
before the related product topic can be settled.

---

## Inclusion-attack economic bounds (§3.8)

The whitepaper argues the inclusion attack is self-punishing because attackers'
`$RM` loses value if their token underperforms, but the magnitude is not
modeled: how much `$RM` must an attacker hold to swing allocation, vs. the vault
buy pressure produced, vs. expected `$RM` loss from underperformance? Without
numbers, "self-punishing" is an assertion, not a proof. Requires economic
modeling; applicable once RM governance controls agent-token inclusion or
per-vault asset selection (see `docs/development/open-questions.md` §1.3).
**Research open.**

## Protocol-agent resilience and failure modes (§3.10)

This is a research and assurance topic, not a product-feature decision.
Vault-level safety controls already exist — `RobotMoneyVault` and `BasketVault`
expose `EMERGENCY_ROLE` pause, emergency unwind, and shutdown. What remains open
is the *off-chain* protocol agent (publishes shortlists, runs the default
allocation, posts the public narrative) as a single point of failure: offline,
compromise, hallucinated allocation, or operator departure. The likely
requirement is a standing research project with **periodic audits** of agent
behavior and operator key custody, rather than a contract feature. Out of scope
while the only on-chain vote is RM-token router weights. **Research open.**
