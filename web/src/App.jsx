import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Sidebar } from './components/Sidebar.jsx';
import { TopBar } from './components/TopBar.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { ErrorBox, Loading } from './components/States.jsx';
import { MailProvider } from './components/MailProvider.jsx';
import { notFiledRows } from './lib/overview.js';
import { UploadScreen } from './screens/Upload.jsx';
import { OverviewScreen } from './screens/Overview.jsx';
import { DecisionsScreen } from './screens/Decisions.jsx';
import { NotFiledScreen } from './screens/NotFiled.jsx';
import { CorrectionsScreen } from './screens/Corrections.jsx';
import { SuppliersScreen } from './screens/Suppliers.jsx';
import { HelpScreen } from './screens/Help.jsx';

export const ROUTES = ['upload', 'overview', 'decisions', 'notfiled', 'corrections', 'suppliers', 'help'];
const PERIOD = /^\d{4}-\d{2}$/;

// The location is `#/<route>?period=YYYY-MM`: a screen and a month survive a
// reload and can be linked to. Upload is the default screen.
function readHash() {
  const [path, search = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  const period = new URLSearchParams(search).get('period');
  return { route: ROUTES.includes(path) ? path : 'upload', period: PERIOD.test(period ?? '') ? period : null };
}

const hashFor = (route, period) => `#/${route}${period ? `?period=${period}` : ''}`;

function useHashLocation() {
  const [location, setLocation] = useState(readHash);
  useEffect(() => {
    const onChange = () => setLocation(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((route, period) => {
    window.location.hash = hashFor(route, period);
    setLocation(readHash());
  }, []);
  return [location, go];
}

const shortLegalName = (name) => (name ? name.replace(/\bPrivate Limited$/i, 'Pvt Ltd') : null);

export default function App() {
  const [location, go] = useHashLocation();
  const [sessionReady, setSessionReady] = useState(false);
  const [perVisitor, setPerVisitor] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [booted, setBooted] = useState(false);

  const [org, setOrg] = useState(null);
  const [periods, setPeriods] = useState([]);

  const [clock, setClock] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [run, setRun] = useState(null);
  const [results, setResults] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [periodError, setPeriodError] = useState(null);
  // Screens that fetch their own data (uploads, alerts, suppliers) re-read on this.
  const [dataVersion, setDataVersion] = useState(0);

  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState(null);
  const [rerunning, setRerunning] = useState(false);
  const loadToken = useRef(0);

  const periodList = useMemo(() => periods.map((entry) => entry.taxPeriod), [periods]);
  const period = location.period && periodList.includes(location.period) ? location.period : periodList[0] ?? null;
  const inventory = periods.find((entry) => entry.taxPeriod === period) ?? null;

  // --- loading -----------------------------------------------------------------

  const loadWorkspace = useCallback(async () => {
    const [orgBody, list] = await Promise.all([api.org(), api.listPeriods()]);
    setOrg(orgBody?.org ?? null);
    setPeriods(list);
    return list;
  }, []);

  const loadPeriod = useCallback(async (taxPeriod, { quiet = false } = {}) => {
    const token = ++loadToken.current;
    if (!quiet) setPeriodLoading(true);
    try {
      const [clockBody, found, correctionList] = await Promise.all([
        api.clock(taxPeriod),
        taxPeriod ? api.getRunByPeriod(taxPeriod) : null,
        taxPeriod ? api.listCorrections(taxPeriod) : null
      ]);
      const rows = found ? await api.listAllResults(found.id) : null;
      if (token !== loadToken.current) return;
      setClock(clockBody.clock);
      setCalendar(clockBody.calendar);
      setRun(found ?? null);
      setResults(rows);
      setCorrections(correctionList);
      setPeriodError(null);
    } catch (err) {
      if (token === loadToken.current) setPeriodError(err);
    } finally {
      if (token === loadToken.current) setPeriodLoading(false);
    }
  }, []);

  // The visitor's workspace exists once /session has answered; nothing else may
  // run before it.
  useEffect(() => {
    let cancelled = false;
    api
      .session()
      .then((session) => {
        if (cancelled) return;
        setPerVisitor(Boolean(session?.perVisitor));
        setSessionReady(true);
      })
      .catch((err) => !cancelled && setBootError(err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    loadWorkspace()
      .then(() => setBooted(true))
      .catch(setBootError);
  }, [sessionReady, loadWorkspace]);

  useEffect(() => {
    if (!booted) return;
    loadPeriod(period);
  }, [booted, period, loadPeriod]);

  // After anything that changes data: the period list, then the period in view
  // (or `prefer`, a period a new file just created), then every screen's own reads.
  const refresh = useCallback(
    async ({ prefer = null } = {}) => {
      const list = (await loadWorkspace()).map((entry) => entry.taxPeriod);
      const target = prefer && list.includes(prefer) ? prefer : list.includes(period) ? period : list[0] ?? null;
      if (target !== period) go(readHash().route, target);
      else await loadPeriod(target, { quiet: true });
      setDataVersion((value) => value + 1);
    },
    [loadWorkspace, loadPeriod, period, go]
  );

  // A decision moves the run's totals, so the run and its results are re-read.
  const reloadPeriod = useCallback(() => loadPeriod(period, { quiet: true }), [loadPeriod, period]);

  const setAsOf = useCallback(
    async (asOfDate) => {
      setClockBusy(true);
      setClockError(null);
      try {
        await api.setClock(asOfDate, period);
        await refresh();
      } catch (err) {
        setClockError(err);
      } finally {
        setClockBusy(false);
      }
    },
    [period, refresh]
  );

  const rerun = useCallback(async () => {
    if (!period) return;
    setRerunning(true);
    try {
      await api.createRun(period);
      await refresh();
    } catch (err) {
      setPeriodError(err);
    } finally {
      setRerunning(false);
    }
  }, [period, refresh]);

  const href = useCallback((route) => hashFor(route, period), [period]);
  const navigate = useCallback((route) => go(route, period), [go, period]);

  const badges = {
    decisions: run?.openDecisions?.count ?? 0,
    notFiled: results ? notFiledRows(results).length : 0,
    corrections: corrections?.counts?.waiting ?? 0
  };

  const trader = org?.gstinAdopted
    ? { name: shortLegalName(org.legalName) ?? org.tradeName, gstin: org.gstin }
    : null;

  const screen = {
    period,
    periods,
    inventory,
    org,
    clock,
    calendar,
    run,
    results,
    corrections,
    dataVersion,
    perVisitor,
    navigate,
    href,
    refresh,
    reloadPeriod,
    rerun,
    rerunning
  };

  let content;
  if (bootError) {
    content = <ErrorBox error={bootError} title="Cannot reach ITC Guard" onRetry={() => window.location.reload()} />;
  } else if (!booted) {
    content = <Loading label="Starting up" rows={4} />;
  } else if (location.route === 'help') {
    content = <HelpScreen />;
  } else if (location.route === 'upload') {
    content = <UploadScreen {...screen} />;
  } else if (periodError) {
    content = <ErrorBox error={periodError} title="Cannot load this period" onRetry={() => loadPeriod(period)} />;
  } else if (periodLoading && !run) {
    content = <Loading label="Loading" rows={6} />;
  } else if (location.route === 'overview') {
    content = <OverviewScreen {...screen} />;
  } else if (location.route === 'decisions') {
    content = <DecisionsScreen {...screen} />;
  } else if (location.route === 'notfiled') {
    content = <NotFiledScreen {...screen} />;
  } else if (location.route === 'corrections') {
    content = <CorrectionsScreen {...screen} />;
  } else {
    content = <SuppliersScreen {...screen} />;
  }

  return (
    <MailProvider refreshKey={dataVersion}>
    <div className="shell">
      <Sidebar route={location.route} href={href} badges={badges} trader={trader} />
      <div className="main">
        <TopBar
          periods={periodList}
          period={period}
          onPeriodChange={(next) => go(location.route, next)}
          asOfDate={clock?.asOfDate ?? null}
          onAsOfChange={setAsOf}
          clockBusy={clockBusy || !booted}
          clockError={clockError}
          calendar={calendar}
          stale={Boolean(run?.staleness?.isStale)}
          onRerun={rerun}
          rerunning={rerunning}
        />
        <main className="page" id="content">
          <ErrorBoundary key={`${location.route}:${period ?? ''}`} scope="This screen">
            {content}
          </ErrorBoundary>
        </main>
      </div>
    </div>
    </MailProvider>
  );
}
