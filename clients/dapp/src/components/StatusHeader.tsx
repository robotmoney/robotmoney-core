/**
 * StatusHeader — public product context for the dapp landing surface.
 *
 * Operational details live in DebugPanel so the first screen stays
 * focused on the user-facing value proposition.
 */
export function StatusHeader() {
  return (
    <section className="status-header" data-testid="status-header">
      <div className="hero">
        <h1>One USDC transfer. Diversified exposure.</h1>
        <p className="hero-sub">
          Authorize an agent to allocate USDC across the bucket portfolio on your behalf. One
          integration, not twenty.
        </p>
      </div>
    </section>
  );
}
