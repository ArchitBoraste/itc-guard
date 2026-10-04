import { useState } from 'react';
import { api } from '../api.js';
import { formatPeriod } from '../lib/calendar.js';
import { EmptyState } from './EmptyState.jsx';
import { InlineError } from './States.jsx';

// What a period needs, for screens that cannot show anything without a run.
export function NoRun({ period, inventory, navigate, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const canRun = Boolean(inventory?.hasBooks && inventory?.hasPortal);

  const reconcile = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createRun(period);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <EmptyState
        title={period ? `${formatPeriod(period)} is not reconciled yet` : 'Nothing uploaded yet'}
        action={
          canRun ? (
            <button type="button" className="btn btn-primary" onClick={reconcile} disabled={busy}>
              {busy ? 'Reconciling…' : `Reconcile ${formatPeriod(period)}`}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => navigate('upload')}>
              Upload files
            </button>
          )
        }
      >
        {canRun
          ? 'Your books and the portal files are in. Reconcile to see what matches.'
          : 'Upload your purchase register and the latest IMS download to start.'}
        <InlineError error={error} />
      </EmptyState>
    </section>
  );
}
