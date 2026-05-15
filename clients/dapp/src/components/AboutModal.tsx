/**
 * AboutModal — lightweight informational overlay shown to general users.
 * Displays app version, git commit SHA, environment class, and a link to
 * the developer /debug page. Does NOT expose raw contract addresses or
 * chain diagnostics.
 */

interface AboutModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly envClass: string;
}

export function AboutModal({ open, onClose, envClass }: AboutModalProps) {
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      data-testid="about-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel">
        <div className="modal-header">
          <h2 id="about-modal-title">About Robot Money</h2>
          <button type="button" data-testid="about-modal-close" onClick={onClose}>
            Close
          </button>
        </div>

        <dl className="about-rows">
          <div className="debug-row">
            <dt>Version</dt>
            <dd data-testid="about-version">{__DAPP_VERSION__}</dd>
          </div>
          <div className="debug-row">
            <dt>Commit</dt>
            <dd data-testid="about-commit">{__GIT_COMMIT__}</dd>
          </div>
          <div className="debug-row">
            <dt>Environment</dt>
            <dd data-testid="about-env">{envClass}</dd>
          </div>
        </dl>

        <div className="about-footer">
          <a href="/debug" data-testid="about-debug-link">
            Developer debug
          </a>
        </div>
      </div>
    </div>
  );
}
