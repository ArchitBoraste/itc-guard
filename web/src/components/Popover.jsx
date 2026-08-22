import { useEffect, useRef, useState } from 'react';

// A click-triggered popover anchored to its own trigger. Closes on Escape and on
// a click outside — a hover tooltip would be wrong here, because the score
// breakdown is something a trader reads carefully before rejecting an invoice.
export function Popover({ label, title, children, className = '', testId = null, triggerLabel = null }) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (hostRef.current && !hostRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className={`popover-host ${className}`} ref={hostRef}>
      <button
        type="button"
        className="popover-trigger"
        aria-expanded={open}
        // The visible label is often just a number; screen readers need the noun.
        aria-label={triggerLabel ?? title}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <div className="popover" role="dialog" aria-label={title}>
          <div className="popover-head">
            <strong>{title}</strong>
            <button type="button" className="link" onClick={() => setOpen(false)}>
              close
            </button>
          </div>
          <div className="popover-body">{children}</div>
        </div>
      ) : null}
    </span>
  );
}
