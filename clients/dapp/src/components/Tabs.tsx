// Canonical: docs/architecture.md §5.3 — Human Dapp

import { useState, type ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  tabs: TabDef[];
  defaultTabId?: string;
  testId?: string;
}

export function Tabs({ tabs, defaultTabId, testId = "admin-tabs" }: TabsProps) {
  const initial = tabs.find((t) => t.id === defaultTabId)?.id ?? tabs[0]?.id ?? "";
  const [active, setActive] = useState(initial);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="tabs" data-testid={testId}>
      <div role="tablist" className="tabs-list">
        {tabs.map((t) => {
          const selected = t.id === current?.id;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={selected}
              data-testid={`tab-${t.id}`}
              data-active={selected}
              className="tab-trigger"
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {current && (
        <div role="tabpanel" className="tab-panel" data-testid={`tabpanel-${current.id}`}>
          {current.content}
        </div>
      )}
    </div>
  );
}
