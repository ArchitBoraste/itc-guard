import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { InlineError } from './States.jsx';

// Rebuilding a period on demand.
//
// The stale banner on Actions offers this too, but only when the run has NOTICED
// it is out of date. That covers new portal data and nothing else: change the
// engine, the weights, the recommendation wording — anything upstream of the
// stored results — and every verdict on screen is from the old code with no
// signal that says so. Until this existed the only way to rebuild was to upload a
// file, which is an odd thing to have to do to see your own change.
//
// So the control is persistent: any period with a run can be re-run, whether or
// not anything looks wrong.
//
// The run keeps its mode and filing scheme. Its date is the workspace's, which the
// server applies to every run, so it is not sent.
export function useRerun(run, onRefresh) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const rerun = useCallback(async () => {
    if (!run?.taxPeriod) return;
    setBusy(true);
    setError(null);
    try {
      await api.createRun({
        taxPeriod: run.taxPeriod,
        mode: run.mode,
        filingScheme: run.filingScheme
      });
      await onRefresh?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, [run, onRefresh]);

  return { rerun, busy, error };
}

// The plain button, for places where a rebuild is available rather than urgent.
// Actions renders its own inside the stale banner, where the surrounding text is
// doing the explaining.
export function RerunButton({
  run,
  onRefresh,
  label = 'Re-run reconciliation',
  className = 'btn',
  testId = 'rerun-reconciliation'
}) {
  const { rerun, busy, error } = useRerun(run, onRefresh);
  if (!run) return null;

  return (
    <span className="rerun-control">
      <button
        type="button"
        className={className}
        data-testid={testId}
        disabled={busy}
        onClick={rerun}
        title="Rebuild this period's verdicts from the data currently loaded"
      >
        {busy ? 'Re-running…' : label}
      </button>
      <InlineError error={error} />
    </span>
  );
}
