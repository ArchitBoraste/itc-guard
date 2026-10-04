import { useState } from 'react';
import { Icon } from './Icon.jsx';

export const NAV = [
  { id: 'upload', label: 'Upload', icon: 'upload' },
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'decisions', label: 'IMS decisions', icon: 'decisions', badge: 'decisions', badgeTone: 'warn' },
  { id: 'notfiled', label: 'Not filed yet', icon: 'clock', badge: 'notFiled' },
  { id: 'corrections', label: 'Corrections', icon: 'corrections', badge: 'corrections', badgeTone: 'warn' },
  { id: 'suppliers', label: 'Suppliers', icon: 'suppliers' }
];

const BADGE_WORDS = {
  decisions: 'need a decision',
  notFiled: 'not filed',
  corrections: 'waiting'
};

function NavLink({ item, route, href, count, onNavigate }) {
  return (
    <a
      className="nav-link"
      href={href(item.id)}
      aria-current={route === item.id ? 'page' : undefined}
      data-testid={`nav-${item.id}`}
      onClick={onNavigate}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
      {count ? (
        <span className={`nav-badge${item.badgeTone === 'warn' ? ' is-warn' : ''}`} data-testid={`badge-${item.id}`}>
          {count}
          <span className="visually-hidden"> {BADGE_WORDS[item.badge]}</span>
        </span>
      ) : null}
    </a>
  );
}

// The navy rail. Below 900px it folds into a bar with a menu button.
export function Sidebar({ route, href, badges = {}, trader = null }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <aside className={`sidebar${open ? ' is-open' : ''}`}>
      <div className="sidebar-head">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            IG
          </div>
          <div>
            <div className="brand-name">ITC Guard</div>
            <div className="brand-sub">GST credit reconciliation</div>
          </div>
        </div>
        <button
          type="button"
          className="menu-button"
          aria-expanded={open}
          aria-controls="main-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'close' : 'menu'} />
        </button>
      </div>

      <nav className="sidebar-nav" id="main-nav" aria-label="Main">
        <ul className="nav-list">
          {NAV.map((item) => (
            <li key={item.id}>
              <NavLink
                item={item}
                route={route}
                href={href}
                count={item.badge ? badges[item.badge] : 0}
                onNavigate={close}
              />
            </li>
          ))}
        </ul>
        <div className="nav-spacer" />
        <ul className="nav-list">
          <li>
            <NavLink item={{ id: 'help', label: 'Help', icon: 'help' }} route={route} href={href} onNavigate={close} />
          </li>
        </ul>
      </nav>

      {trader?.name || trader?.gstin ? (
        <div className="sidebar-foot" data-testid="trader">
          {trader.name ? <div className="sidebar-trader">{trader.name}</div> : null}
          {trader.gstin ? <div className="mono">{trader.gstin}</div> : null}
        </div>
      ) : null}
    </aside>
  );
}
