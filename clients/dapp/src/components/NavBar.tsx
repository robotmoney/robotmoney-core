interface NavBarProps {
  readonly debugOpen: boolean;
  readonly onToggleDebug: () => void;
}

export function NavBar({ debugOpen, onToggleDebug }: NavBarProps) {
  return (
    <header className="nav" data-testid="nav">
      <a className="nav-brand" href="/">
        ROBOT<span>MONEY</span>
      </a>
      <button
        type="button"
        className="nav-debug-button"
        data-testid="debug-panel-toggle"
        aria-controls="debug-panel"
        aria-expanded={debugOpen}
        onClick={onToggleDebug}
      >
        Debug
      </button>
    </header>
  );
}
