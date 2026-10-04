import { useEffect, useId, useRef } from 'react';

// A modal question with one way forward and one way back. Escape and the backdrop
// cancel; focus starts on Cancel so Enter never confirms by accident, and returns
// to whatever opened the dialog when it closes.
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}) {
  const titleId = useId();
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);
  // Read through a ref so a parent's new callback each render does not re-run
  // the effect and pull focus back to Cancel.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    cancelRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') cancel.current();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      // Keep Tab inside the dialog.
      const focusable = dialogRef.current.querySelectorAll('button:not(:disabled), a[href]');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
