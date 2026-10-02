import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { IMS_ACTION_CODE, ACTION_LABEL, IMS_ACTIONS } from '../lib/vocab.js';
import { InlineError } from './States.jsx';

// The download is the product's output: the file the trader uploads to the
// portal. Before handing it over it says exactly what is in it — how many records
// carry which action, and how many of those are the trader's own decisions rather
// than the engine's suggestions. Nobody should upload a file to the GST portal
// without seeing that.

// N is never a decision. While any record would go out as N the API holds the file
// back, and hands it over only once the trader has said here that they mean it.
export function openDecisionWarning({ count, byCategory }) {
  return [
    `${count} record${count === 1 ? '' : 's'} will go to the portal as N (no action), ` +
      'which is deemed acceptance at GSTR-3B:',
    `  ${byCategory.phantom.count} on the portal but not in your books`,
    `  ${byCategory.verify.count} probably the same invoice, not yet verified`,
    `  ${byCategory.other.count} other records with no decision`,
    '',
    'Download anyway?'
  ].join('\n');
}

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
  const open = summary?.openDecisions;
  const acknowledgeOpenDecisions = Boolean(open?.count);
  // The file is built from stored verdicts. If the portal has moved since they
  // were computed, the envelope would carry an Accept for a record that no longer
  // agrees — and once uploaded, that is final.
  const stale = Boolean(run.staleness?.isStale);

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
        {stale ? (
          <span className="download-blocked" data-testid="download-blocked">
            <span className="btn btn-primary is-disabled" aria-disabled="true">
              Download IMS action JSON
            </span>
            <span className="small bad">
              Re-run the reconciliation first — this run is out of date.
            </span>
          </span>
        ) : !summary ? (
          // Until the summary says whether anything would go out as N, there is no
          // way to ask the question the download depends on.
          <span className="btn btn-primary is-disabled" aria-disabled="true">
            Download IMS action JSON
          </span>
        ) : (
          <a
            className="btn btn-primary"
            href={api.imsActionsUrl(run.id, { acknowledgeOpenDecisions })}
            download={`ims-actions-run-${run.id}.json`}
            data-testid="download-ims-json"
            onClick={(event) => {
              if (acknowledgeOpenDecisions && !window.confirm(openDecisionWarning(open))) {
                event.preventDefault();
              }
            }}
          >
            Download IMS action JSON
          </a>
        )}
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
