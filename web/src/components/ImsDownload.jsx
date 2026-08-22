import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { IMS_ACTION_CODE, ACTION_LABEL, IMS_ACTIONS } from '../lib/vocab.js';
import { InlineError } from './States.jsx';

// The download is the product's output: the file the trader uploads to the
// portal. Before handing it over it says exactly what is in it — how many records
// carry which action, and how many of those are the trader's own decisions rather
// than the engine's suggestions. Nobody should upload a file to the GST portal
// without seeing that.
export function ImsDownload({ run, compact = false }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!run) return;
    setError(null);
    try {
      setSummary(await api.imsActionsSummary(run.id));
    } catch (err) {
      setError(err);
      setSummary(null);
    }
  }, [run]);

  useEffect(() => {
    load();
  }, [load]);

  if (!run) return null;

  const stats = summary?.stats;
  const byAction = stats?.byAction ?? {};

  return (
    <section
      className={`panel ims-download ${compact ? 'is-compact' : ''}`}
      data-testid="ims-download"
    >
      <header className="panel-head">
        <div>
          <h2>IMS action file</h2>
          <p className="muted">
            {stats
              ? `${stats.records} record${stats.records === 1 ? '' : 's'} · ` +
                `${stats.confirmed} confirmed by you, ${stats.recommended} left as recommended`
              : 'Building the upload envelope…'}
          </p>
        </div>
        <a
          className="btn btn-primary"
          href={api.imsActionsUrl(run.id)}
          download={`ims-actions-run-${run.id}.json`}
          data-testid="download-ims-json"
        >
          Download IMS action JSON
        </a>
      </header>

      <InlineError error={error} onDismiss={() => setError(null)} />

      {stats ? (
        <>
          <div className="action-codes">
            {IMS_ACTIONS.map((action) => {
              const code = IMS_ACTION_CODE[action];
              const count = byAction[code] ?? 0;
              return (
                <div
                  key={action}
                  className={`code-chip ${count ? '' : 'is-zero'}`}
                  data-testid={`ims-count-${code}`}
                >
                  <span className="code-letter">{code}</span>
                  <span className="code-name">{ACTION_LABEL[action]}</span>
                  <span className="code-count mono">{count}</span>
                </div>
              );
            })}
          </div>

          <p className="muted small">
            Records with no IMS action recorded still go into the file carrying{' '}
            <strong>N</strong> — they are not dropped, because N is precisely the state that
            gets deemed accepted at GSTR-3B.
          </p>

          {summary.warnings?.length ? (
            <div className="warn-list" data-testid="ims-warnings">
              <strong>{summary.warnings.length} warning(s) from the writer</strong>
              <ul>
                {summary.warnings.slice(0, 6).map((warning, index) => (
                  <li key={index} className="mono small">
                    {typeof warning === 'string' ? warning : JSON.stringify(warning)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {stats.skipped?.length ? (
            <p className="muted small">
              {stats.skipped.length} result(s) had no IMS action to write and were left out.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
