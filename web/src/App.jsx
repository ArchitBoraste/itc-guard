import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState({ state: 'loading' });

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((body) => setHealth({ state: 'ready', body }))
      .catch((err) => setHealth({ state: 'error', message: err.message }));
  }, []);

  return (
    <main>
      <h1>ITC Guard</h1>
      <p className="tagline">GST Input Tax Credit reconciliation for small traders.</p>

      <section>
        <h2>API</h2>
        {health.state === 'loading' && <p>checking…</p>}
        {health.state === 'error' && <p className="bad">unreachable — {health.message}</p>}
        {health.state === 'ready' && (
          <p className={health.body.ok ? 'good' : 'bad'}>
            api {health.body.ok ? 'ok' : 'down'} · db {health.body.db ? 'ok' : 'down'}
          </p>
        )}
      </section>
    </main>
  );
}
