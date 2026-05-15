interface NavBarProps {
  readonly aboutOpen: boolean;
  readonly onToggleAbout: () => void;
}

export function NavBar({ aboutOpen, onToggleAbout }: NavBarProps) {
  return (
    <header className="nav" data-testid="nav">
      <a className="nav-brand" href="/">
        ROBOT<span>MONEY</span>
      </a>
      <button
        type="button"
        className="nav-about-button"
        data-testid="about-button"
        aria-controls="about-modal"
        aria-expanded={aboutOpen}
        onClick={onToggleAbout}
      >
        About
      </button>
    </header>
  );
}
