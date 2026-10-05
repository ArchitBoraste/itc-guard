import { useEffect, useId, useRef, useState } from 'react';

// Send a WhatsApp to a supplier from the app. Opening the dialog asks the server
// what the send would do (POST /api/messages/preview): the number, and whether it
// goes as the approved template (a thread's first message, or 24 hours after the
// supplier last wrote) or as the full message. Nothing is sent until Send.
// A refusal keeps the dialog open with the server's reason and offers the
// trader's own WhatsApp (the wa.me link) instead.
// How the message goes, and why: the server's reason (services/supplierWhatsapp.js).
function formatLine(preview) {
  if (preview.reason === 'text_mode') {
    return "The full message as free text. WhatsApp delivers it only within 24 hours of the supplier's last message.";
  }
  if (preview.format === 'text') return 'The full message: they wrote in the last 24 hours';
  return `Your approved template “${preview.templateName}”: WhatsApp's rule for a first message`;
}

export function WhatsAppDialog({ open, request, contactName = null, fallbackUrl = null, preview, onSend, onCancel }) {
  const titleId = useId();
  const [state, setState] = useState({ phase: 'loading', preview: null, error: null });
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setState({ phase: 'loading', preview: null, error: null });
    preview(request)
      .then((result) => alive && setState({ phase: 'ready', preview: result, error: null }))
      .catch((err) => alive && setState({ phase: 'error', preview: null, error: err.message ?? 'WhatsApp is not available.' }));
    const opener = document.activeElement;
    cancelRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') cancel.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
    // Only on opening: the request is fixed while the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const { phase, preview: shown, error } = state;

  const send = async () => {
    setBusy(true);
    try {
      await onSend();
    } catch (err) {
      setState((current) => ({ ...current, error: err.message ?? 'The WhatsApp could not be sent.' }));
    } finally {
      setBusy(false);
    }
  };

  const unapproved = shown?.format === 'template' && shown.templateStatus && shown.templateStatus !== 'APPROVED';

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <div className="dialog compose-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="whatsapp-dialog">
        <h2 className="dialog-title" id={titleId}>
          Send on WhatsApp
        </h2>
        {phase === 'loading' ? <div className="caption">Checking what WhatsApp will send…</div> : null}
        {shown ? (
          <>
            <div className="compose-meta">
              <span className="muted">To</span>
              <span data-testid="whatsapp-to">
                {shown.toDisplay}
                {contactName ? ` (${contactName})` : ''}
              </span>
              <span className="muted">As</span>
              <span data-testid="whatsapp-format">{formatLine(shown)}</span>
            </div>
            {unapproved ? (
              <div className="inline-error" data-testid="whatsapp-template-warning">
                WhatsApp Manager shows this template as {shown.templateStatus}. Meta refuses it until it is approved.
              </div>
            ) : null}
            <div className="whatsapp-preview" data-testid="whatsapp-preview">
              {shown.text ?? (
                <>
                  <span className="muted">Template {shown.templateName} with: </span>
                  {(shown.values ?? []).join(' · ')}
                </>
              )}
            </div>
          </>
        ) : null}
        {error ? (
          <div className="inline-error" role="alert">
            {error}
            {fallbackUrl ? (
              <>
                {' '}
                <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" data-testid="whatsapp-fallback">
                  Open in WhatsApp instead
                </a>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={send}
            disabled={busy || phase !== 'ready'}
            data-testid="whatsapp-send"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
