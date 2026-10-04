import { useState } from 'react';
import { api } from '../api.js';
import { formatDate } from '../lib/calendar.js';
import { ConfirmDialog } from './ConfirmDialog.jsx';

function save({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Download IMS file". While any record would go out as Not decided the API
// answers 409 open_decisions with the counts; the trader sees them here and can
// still download, knowingly. Not decided is accepted automatically at GSTR-3B.
export function ImsDownloadButton({ run, dueDate = null, className = 'btn btn-primary', children = 'Download IMS file' }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);

  const download = async (acknowledgeOpenDecisions = false) => {
    setBusy(true);
    setError(null);
    try {
      save(await api.downloadImsActions(run.id, { acknowledgeOpenDecisions }));
      setOpen(null);
    } catch (err) {
      if (err.status === 409 && err.code === 'open_decisions') setOpen(err.body?.openDecisions ?? { count: 0 });
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const stale = Boolean(run?.staleness?.isStale);
  const byCategory = open?.byCategory;
  const lines = byCategory
    ? [
        [byCategory.phantom?.count, 'not in your books'],
        [byCategory.verify?.count, 'probably the same invoice, not yet confirmed'],
        [byCategory.other?.count, 'with a different amount or another open question']
      ].filter(([count]) => count > 0)
    : [];

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => download(false)}
        disabled={!run || busy || stale}
        title={stale ? 'Re-run first: these results are out of date' : undefined}
        data-testid="download-ims"
      >
        {busy && !open ? 'Preparing…' : children}
      </button>
      {error ? (
        <span className="inline-error" role="alert">
          {error.message}
        </span>
      ) : null}
      <ConfirmDialog
        open={Boolean(open)}
        title={`${open?.count ?? 0} record${open?.count === 1 ? '' : 's'} not decided yet`}
        confirmLabel="Download anyway"
        busy={busy}
        onConfirm={() => download(true)}
        onCancel={() => setOpen(null)}
      >
        <p>
          They go to the portal as Not decided, which is accepted automatically
          {dueDate ? ` on ${formatDate(dueDate)}` : ' when GSTR-3B is filed'}.
        </p>
        {lines.length ? (
          <ul data-testid="open-decision-counts">
            {lines.map(([count, words]) => (
              <li key={words}>
                {count} {words}
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
