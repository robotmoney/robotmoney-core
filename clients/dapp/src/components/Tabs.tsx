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
  /** Controlled active tab id. When provided, the component operates in
   * controlled mode: the parent must update this value via onTabChange. */
  activeTabId?: string;
  /** Called when the user selects a tab (controlled mode). */
  onTabChange?: (tabId: string) => void;
  testId?: string;
}

export function Tabs({ tabs, defaultTabId, activeTabId, onTabChange, testId = "admin-tabs" }: TabsProps) {
  const initial = tabs.find((t) => t.id === defaultTabId)?.id ?? tabs[0]?.id ?? "";
  const [internalActive, setInternalActive] = useState(initial);

  // Controlled mode when activeTabId is provided, otherwise use internal state.
  const active = activeTabId !== undefined ? activeTabId : internalActive;
  function setActive(tabId: string) {
    if (activeTabId !== undefined) {
      onTabChange?.(tabId);
    } else {
      setInternalActive(tabId);
    }
  }

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
