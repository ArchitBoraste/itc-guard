import { useEffect, useId, useRef, useState } from 'react';

// Email a supplier from the app. To is the contact on file and not editable: the
// server sends to the contact current at send time, never to a typed address.
// Subject and body are the trader's to change; the server adds the
// "[ITC Guard #…]" tag the reply is matched by.
export function ComposeDialog({ open, to, fromName, initialSubject, initialBody, onSend, onCancel }) {
  const titleId = useId();
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);
  const firstField = useRef(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!open) return undefined;
    setSubject(initialSubject);
    setBody(initialBody);
    setError(null);
    const opener = document.activeElement;
    firstField.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') cancel.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
    // Only on opening: the draft is the trader's once the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSend({ subject, body });
    } catch (err) {
      setError(err.message ?? 'The email could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <form
        className="dialog compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onSubmit={submit}
        data-testid="compose-dialog"
      >
        <h2 className="dialog-title" id={titleId}>
          Email supplier
        </h2>
        <div className="compose-meta">
          <span className="muted">From</span>
          <span>{fromName ?? 'You'}</span>
          <span className="muted">To</span>
          <span data-testid="compose-to">{to}</span>
        </div>
        <label className="compose-field">
          <span className="muted">Subject</span>
          <input
            ref={firstField}
            className="input"
            value={subject}
            maxLength={300}
            onChange={(event) => setSubject(event.target.value)}
            data-testid="compose-subject"
          />
        </label>
        <label className="compose-field">
          <span className="muted">Message</span>
          <textarea
            className="input compose-body"
            value={body}
            rows={9}
            onChange={(event) => setBody(event.target.value)}
            data-testid="compose-body"
          />
        </label>
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !body.trim()} data-testid="compose-send">
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
