import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

export function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="18" height="18">
        <path
          d="M5 26.5C10 26.5 13.2 24.6 15.6 20.8C18.8 15.4 19.6 5 16.4 5C13.2 5 13.4 15 16.4 20.8C18.8 24.6 22 26.5 27 26.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function NavBrand({ collapsed, onToggle }: { collapsed: boolean; onToggle?: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="nav-brand">
      <LogoMark />
      {!collapsed && (
        <span className="nav-wordmark">
          Lousho{' '}
          <span className="nav-version">v{__LOUSHO_VERSION__}</span>
        </span>
      )}
      {onToggle && (
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm nav-collapse"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          aria-controls="primary-nav"
          onClick={onToggle}
        >
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
