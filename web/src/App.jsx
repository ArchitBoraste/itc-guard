import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { formatPeriod } from './lib/calendar.js';
import {
  ConfirmationResetBanner,
  DeemedAcceptanceBanner
} from './components/DeemedAcceptanceBanner.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { ErrorBox, InlineError, Loading } from './components/States.jsx';
import { PreparingScreen, ResetMyData } from './components/DemoSession.jsx';
import { UploadScreen } from './screens/Upload.jsx';
import { SummaryScreen } from './screens/Summary.jsx';
import { ActionsScreen } from './screens/Actions.jsx';
import { SuppliersScreen } from './screens/Suppliers.jsx';
import { AlertsScreen } from './screens/Alerts.jsx';
import { AboutScreen } from './screens/About.jsx';

const ROUTES = [
  { id: 'upload', label: 'Upload' },
  { id: 'summary', label: 'Summary' },
  // Sits before Actions on purpose: preventive work happens earlier in the month
  // than the accept/reject pass, and the nav should read in that order.
  { id: 'alerts', label: 'Before cut-off' },
  { id: 'actions', label: 'Actions' },
  { id: 'suppliers', label: 'Suppliers' },
  // Needs no run and no data, so it stays clickable on a cold start — which is
  // exactly when someone is most likely to want to know what they are looking at.
  { id: 'about', label: 'About', alwaysEnabled: true }
];

// The hash is `#/route?key=value`. The query part is session state that belongs
// to the WHOLE app rather than to one screen — today that is the as-of date, the
// clock everything on screen is being read at.
//
// It lives in the URL rather than in component state for three reasons: it
// survives navigating away and back (it did not, and the Before cut-off screen
// silently snapped back to the run's date), it survives a reload, and it makes a
// particular point in the filing month a link someone can send.
function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return {
    route: ROUTES.some((route) => route.id === path) ? path : null,
    params: new URLSearchParams(query)
  };
}

function writeHash(route, params) {
  const query = params.toString();
  window.location.hash = `#/${route}${query ? `?${query}` : ''}`;
}

function useHashRoute(fallback) {
  const [state, setState] = useState(readHash);

  useEffect(() => {
    const onChange = () => setState(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  // Writing the hash fires `hashchange` — but only when the value actually
  // changes, so the state is set here too rather than relying on the event.
  const apply = useCallback((route, params) => {
    writeHash(route, params);
    setState(readHash());
  }, []);

  const navigate = useCallback(
    (next) => apply(next, readHash().params), // query survives the move
    [apply]
  );

  const setParam = useCallback(
    (key, value) => {
      const { route, params } = readHash();
      if (value === null || value === undefined || value === '') params.delete(key);
      else params.set(key, value);
      apply(route ?? fallback, params);
    },
    [apply, fallback]
  );

  return [state.route ?? fallback, navigate, state.params, setParam];
}

export default function App() {
  const [session, setSession] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [org, setOrg] = useState(null);
  const [runs, setRuns] = useState(null);
  const [period, setPeriod] = useState(null);
  const [run, setRun] = useState(null);
  const [results, setResults] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [runError, setRunError] = useState(null);
  const [booting, setBooting] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);

  const [route, navigate, params, setParam] = useHashRoute('summary');

  // The as-of date rides in the URL so it holds across screens and reloads. An
  // absent or hand-mangled value falls back to the run's own date rather than
  // being sent to an API that would reject it.
  const asOfParam = params.get('asOf');
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfParam ?? '') ? asOfParam : null;
  const setAsOf = useCallback((value) => setParam('asOf', value), [setParam]);

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

  // --- this visitor's own copy of the demo ---------------------------------
  //
  // On a public deployment the first call mints a private org and sets the
  // session cookie, so nothing below it may run until it has answered. Usually it
  // returns READY immediately — orgs are seeded in advance and handed out warm.
  const refreshSession = useCallback(async () => {
    try {
      const next = await api.session();
      setSession(next);
      return next;
    } catch (err) {
      // An API that predates this route is a single-org deployment, not a
      // failure: carry on as before rather than blocking the whole app.
      if (err.status === 404) {
        const legacy = { state: 'READY', perVisitor: false };
        setSession(legacy);
        return legacy;
      }
      setBootError(err);
      setBooting(false);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // While the org is being seeded, ask again. The seed is a few seconds; polling
  // costs one small query and is simpler than a socket for a demo that will not
  // outlive the judging.
  useEffect(() => {
    if (session?.state !== 'PROVISIONING') return undefined;
    const timer = setInterval(() => refreshSession(), 1500);
    return () => clearInterval(timer);
  }, [session?.state, refreshSession]);

  // Load the data once — and again after a reset, because the state flips back
  // through PROVISIONING and this key goes null and returns.
  const sessionReady = session?.state === 'READY';
  useEffect(() => {
    if (!sessionReady) return;
    boot();
  }, [sessionReady, boot]);

  // Wipes and reloads THIS visitor's org. Everything held for the old data is
  // dropped first so nothing renders against run ids that no longer exist.
  const resetMyData = useCallback(async () => {
    setResetting(true);
    setBootError(null);
    setRunError(null);
    try {
      const next = await api.resetSession();
      setRuns(null);
      setResults(null);
      setRun(null);
      setPeriod(null);
      setOrg(null);
      setBooting(true);
      setSession((current) => ({ ...current, ...next }));
    } catch (err) {
      setBootError(err);
    } finally {
      setResetting(false);
    }
  }, []);

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

  // A commit re-runs the period on the server. Nothing navigates, but whatever is
  // held for that period in memory is now a version behind — including the run the
  // Actions screen is about to render verdicts from.
  const afterDataChanged = useCallback(
    async (taxPeriod) => {
      const runList = await api.listRuns();
      setRuns(runList);
      if (taxPeriod && taxPeriod === period) await loadRun(taxPeriod);
    },
    [period, loadRun]
  );

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
  // Gated on the session too: an org that is still being seeded has no runs yet,
  // and redirecting to Upload while it is being built shows the wrong screen for
  // the two seconds before the data lands.
  useEffect(() => {
    if (!sessionReady) return;
    if (!booting && !hasData && route !== 'upload' && route !== 'about') navigate('upload');
  }, [sessionReady, booting, hasData, route, navigate]);

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
              disabled={!hasData && entry.id !== 'upload' && !entry.alwaysEnabled}
              onClick={() => navigate(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {/* Only on a deployment that gives each visitor their own copy. On a
            single-org dev run this button would wipe the developer's own data,
            so the API says whether it applies and the UI believes it. */}
        {session?.perVisitor ? (
          <ResetMyData onReset={resetMyData} busy={resetting || session.state === 'PROVISIONING'} />
        ) : null}

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

      {/* A seed or a reset that failed. The org is usable but empty, so this has
          to say why rather than leaving a blank app to be interpreted. */}
      {session?.error ? (
        <div className="banners">
          <InlineError
            error={{ message: `Could not load your sample data: ${session.error}` }}
            onDismiss={resetMyData}
          />
        </div>
      ) : null}

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
        {/* About is checked first, ahead of booting and ahead of the API error:
            it is static text about the project and reads correctly when nothing
            else in the app can load. */}
        {route === 'about' ? (
          <AboutScreen />
        ) : session?.state === 'PROVISIONING' ? (
          /* This visitor's private copy is being built. Rare — the pool usually
             has one ready — but it is what a reset always goes through. */
          <PreparingScreen />
        ) : booting ? (
          <Loading label="Starting up" rows={4} />
        ) : bootError ? (
          <ErrorBox
            error={bootError}
            onRetry={boot}
            title="Cannot reach the API"
          />
        ) : route === 'upload' ? (
          <UploadScreen
            org={org}
            runs={runs}
            onIngested={afterIngest}
            onDataChanged={afterDataChanged}
          />
        ) : runError ? (
          <ErrorBox error={runError} onRetry={() => loadRun(period)} title="Cannot load this run" />
        ) : loadingRun ? (
          <Loading label={`Loading ${formatPeriod(period)}`} rows={6} />
        ) : route === 'summary' ? (
          <SummaryScreen
            run={run}
            results={results}
            onGoToActions={goToActions}
            onRefresh={refreshRun}
          />
        ) : route === 'alerts' ? (
          <AlertsScreen run={run} taxPeriod={period} asOf={asOf} onAsOfChange={setAsOf} />
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
