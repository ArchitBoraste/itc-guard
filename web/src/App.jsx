import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { formatPeriod } from './lib/calendar.js';
import {
  ConfirmationResetBanner,
  DeemedAcceptanceBanner
} from './components/DeemedAcceptanceBanner.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { ErrorBox, Loading } from './components/States.jsx';
import { UploadScreen } from './screens/Upload.jsx';
import { SummaryScreen } from './screens/Summary.jsx';
import { ActionsScreen } from './screens/Actions.jsx';
import { SuppliersScreen } from './screens/Suppliers.jsx';

const ROUTES = [
  { id: 'upload', label: 'Upload' },
  { id: 'summary', label: 'Summary' },
  { id: 'actions', label: 'Actions' },
  { id: 'suppliers', label: 'Suppliers' }
];

function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.some((route) => route.id === raw) ? raw : null;
}

function useHashRoute(fallback) {
  const [route, setRoute] = useState(() => readHash() ?? fallback);

  useEffect(() => {
    const onChange = () => setRoute(readHash() ?? fallback);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [fallback]);

  const navigate = useCallback((next) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  return [route, navigate];
}

export default function App() {
  const [org, setOrg] = useState(null);
  const [runs, setRuns] = useState(null);
  const [period, setPeriod] = useState(null);
  const [run, setRun] = useState(null);
  const [results, setResults] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [runError, setRunError] = useState(null);
  const [booting, setBooting] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);

  const [route, navigate] = useHashRoute('summary');

  // --- boot ----------------------------------------------------------------

  const boot = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      const [orgBody, runList] = await Promise.all([api.org(), api.listRuns()]);
      setOrg(orgBody);
      setRuns(runList);
      setPeriod((current) => current ?? runList[0]?.taxPeriod ?? null);
    } catch (err) {
      setBootError(err);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  // --- the selected period's run + its results -----------------------------

  const loadRun = useCallback(async (taxPeriod) => {
    if (!taxPeriod) {
      setRun(null);
      setResults(null);
      return;
    }
    setLoadingRun(true);
    setRunError(null);
    try {
      const found = await api.getRunByPeriod(taxPeriod);
      setRun(found);
      setResults(found ? await api.listAllResults(found.id) : null);
    } catch (err) {
      setRunError(err);
      setRun(null);
      setResults(null);
    } finally {
      setLoadingRun(false);
    }
  }, []);

  useEffect(() => {
    loadRun(period);
  }, [period, loadRun]);

  // Totals move when a decision is confirmed, so the run has to be re-read rather
  // than patched locally — claimable/at-risk are recomputed server-side.
  const refreshRun = useCallback(async () => {
    if (!run) return;
    try {
      const [fresh, freshResults] = await Promise.all([
        api.getRun(run.id),
        api.listAllResults(run.id)
      ]);
      setRun(fresh);
      setResults(freshResults);
    } catch (err) {
      setRunError(err);
    }
  }, [run]);

  // Applies one confirmed decision to local state without a full refetch, so a
  // 400-row list does not flash on every click.
  const patchResult = useCallback((resultId, confirmedAction) => {
    setResults((current) =>
      current?.map((result) =>
        result.id === resultId
          ? { ...result, confirmedAction, confirmedAt: new Date().toISOString() }
          : result
      ) ?? current
    );
  }, []);

  const afterIngest = useCallback(
    async (taxPeriod) => {
      const runList = await api.listRuns();
      setRuns(runList);
      if (taxPeriod) {
        setPeriod(taxPeriod);
        await loadRun(taxPeriod);
      }
      navigate('summary');
    },
    [loadRun, navigate]
  );

  const goToActions = useCallback(() => navigate('actions'), [navigate]);

  const hasData = Boolean(runs?.length);
  const periods = useMemo(() => runs?.map((entry) => entry.taxPeriod) ?? [], [runs]);

  // With nothing loaded there is only one useful screen. Send people there rather
  // than showing three empty ones.
  useEffect(() => {
    if (!booting && !hasData && route !== 'upload') navigate('upload');
  }, [booting, hasData, route, navigate]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">ITC</span>
          <div>
            <div className="brand-name">ITC Guard</div>
            <div className="brand-sub">
              {org?.org
                ? `${org.org.tradeName ?? org.org.legalName} · ${org.org.gstin}`
                : 'GST input tax credit reconciliation'}
            </div>
          </div>
        </div>

        <nav className="nav">
          {ROUTES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`nav-item ${route === entry.id ? 'is-active' : ''}`}
              data-testid={`nav-${entry.id}`}
              disabled={!hasData && entry.id !== 'upload'}
              onClick={() => navigate(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="period-picker">
          <label htmlFor="period">Tax period</label>
          <select
            id="period"
            data-testid="period-select"
            value={period ?? ''}
            disabled={!periods.length}
            onChange={(event) => setPeriod(event.target.value)}
          >
            {periods.length ? (
              periods.map((entry) => (
                <option key={entry} value={entry}>
                  {formatPeriod(entry)}
                </option>
              ))
            ) : (
              <option value="">no runs yet</option>
            )}
          </select>
        </div>
      </header>

      {hasData ? (
        <div className="banners">
          <DeemedAcceptanceBanner
            run={run}
            results={results}
            loading={loadingRun}
            onGoToActions={goToActions}
          />
          <ConfirmationResetBanner results={results} onGoToActions={goToActions} />
        </div>
      ) : null}

      <main className="content">
        {/* Keyed on the route and period so navigating away from a screen that threw
            remounts the boundary and clears the error — the nav bar above stays
            mounted throughout, so there is always a way out. */}
        <ErrorBoundary key={`${route}:${period ?? ''}`} scope="This screen">
        {booting ? (
          <Loading label="Starting up" rows={4} />
        ) : bootError ? (
          <ErrorBox
            error={bootError}
            onRetry={boot}
            title="Cannot reach the API"
          />
        ) : route === 'upload' ? (
          <UploadScreen org={org} runs={runs} onIngested={afterIngest} />
        ) : runError ? (
          <ErrorBox error={runError} onRetry={() => loadRun(period)} title="Cannot load this run" />
        ) : loadingRun ? (
          <Loading label={`Loading ${formatPeriod(period)}`} rows={6} />
        ) : route === 'summary' ? (
          <SummaryScreen run={run} results={results} onGoToActions={goToActions} />
        ) : route === 'actions' ? (
          <ActionsScreen
            run={run}
            results={results}
            onConfirmed={patchResult}
            onRefresh={refreshRun}
          />
        ) : (
          <SuppliersScreen run={run} />
        )}
        </ErrorBoundary>
      </main>

      <footer className="footer">
        <span>
          Money is held as integer paise end to end and rounded to whole rupees only for
          display.
        </span>
        {run ? (
          <span className="mono muted">
            run #{run.id} · engine {run.engineVersion} · {run.mode.toLowerCase()}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
