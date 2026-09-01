// How to use — the walkthrough for someone who opened the deployed link cold and
// has nobody standing next to them narrating it.
//
// Deliberately separate from About. About is provenance and the synthetic-data
// caveat: where the schemas came from, what the risk model was fitted on, what
// is out of scope. This one is only "what do I click, and what am I looking at".
// Merging them buries the walkthrough under three panels of caveats.
import { SAMPLES_URL } from '../lib/links.js';

const STEPS = [
  {
    title: 'A sample period is already loaded',
    body:
      'Nothing has to be uploaded to see the app work. One tax period of sample data — a ' +
      'purchase register, an IMS export and a GSTR-2B download — is loaded and already ' +
      'reconciled. Summary is showing it now.'
  },
  {
    title: 'Load a different period to watch it run',
    body:
      'Upload tab → pick a month in the dropdown next to “Load sample period” → load it. ' +
      'Six months are available. The three files go through the same parse-preview-commit ' +
      'path your own files would, the reconciliation runs, and you land back on Summary ' +
      'with the new month’s numbers. The as-of date moves with it: the 16th of the ' +
      'following month, after GSTR-2B generates on the 14th and before GSTR-3B falls due ' +
      'on the 20th.',
    to: 'upload',
    cta: 'Go to Upload'
  },
  {
    title: 'Or drop in your own three files',
    body:
      'The same screen takes a GSTN v2.4 purchase-register .xlsx or a GSTR-2 offline-tool ' +
      'CSV, plus IMS and GSTR-2B JSON from the portal. A spreadsheet that is neither ' +
      'template gets a column-mapping step rather than a failure.',
    to: 'upload'
  }
];

const SCREENS = [
  {
    to: 'summary',
    name: 'Summary',
    what:
      'What the whole period comes to. Expected input tax credit split into claimable, at ' +
      'risk, deferred and ineligible, then every document by how it landed. Reconciled ' +
      'against IMS and GSTR-2B together.',
    look: 'The red banner at the top. Anything left unactioned is DEEMED ACCEPTED at GSTR-3B — that is the loss this product exists to prevent.'
  },
  {
    to: 'alerts',
    name: 'Still fixable',
    what:
      'Purchases your supplier has not filed yet, so they can still put them right ' +
      'themselves — no amendment, and no waiting a month for the credit. Sorted by ' +
      'which suppliers are least reliable rather than by amount.',
    look: 'The ready-made message on each supplier card. Nothing is ever sent — you copy it and send it however you already talk to them.'
  },
  {
    to: 'actions',
    name: 'Actions',
    what:
      'Every document that needs a decision, grouped by what the engine recommends, with ' +
      'the score breakdown behind each match. Confirm or override, then download the IMS ' +
      'action JSON the portal accepts.',
    look: 'A SUGGESTED match. It shows why it scored what it did — a reject is never applied automatically, because a wrong one costs the trader a month of credit.'
  },
  {
    to: 'suppliers',
    name: 'Suppliers',
    what:
      'Each supplier’s filing record and risk band, with the reasons in words rather than ' +
      'as a bare score.',
    look: 'The reasons under a HIGH band. “Filed late in 4 of the last 6 months” is something you can check; “risk 0.41” is not.'
  }
];

export function HowToUseScreen({ onGoTo = null, hasData = false }) {
  const go = (route) => {
    if (onGoTo && (hasData || route === 'upload')) onGoTo(route);
  };

  return (
    <div className="screen screen-howto">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>How to use ITC Guard</h2>
            <p className="muted">
              It reads a trader&rsquo;s purchase register alongside their IMS and GSTR-2B
              downloads, works out which invoices agree and which do not, says what to
              accept, reject or chase, and writes the action file the GST portal accepts.
              The point of it is the money that leaks when nobody looks: an invoice left
              unactioned in IMS is <strong>deemed accepted</strong> when GSTR-3B is filed,
              whether or not it was ever real.
            </p>
          </div>
        </header>

        <div className="about-block">
          <ol className="howto-steps" data-testid="howto-steps">
            {STEPS.map((step) => (
              <li key={step.title}>
                <h4>{step.title}</h4>
                <p className="muted">{step.body}</p>
                {step.cta ? (
                  <button type="button" className="btn" onClick={() => go(step.to)}>
                    {step.cta}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h3>What to look at on each screen</h3>
            <p className="muted">
              Summary and Still fixable count different things on purpose, so their
              totals will not match and neither is part of the other. Each screen says
              so, and Still fixable spells it out under &ldquo;Why these numbers differ
              from Summary&rdquo;.
            </p>
          </div>
        </header>

        <div className="about-block">
          <div className="table-wrap">
            <table className="table about-table" data-testid="howto-screens">
              <thead>
                <tr>
                  <th>Screen</th>
                  <th>What it shows</th>
                  <th>What to look at</th>
                </tr>
              </thead>
              <tbody>
                {SCREENS.map((entry) => (
                  <tr key={entry.to}>
                    <td className="cell-strong">
                      <button
                        type="button"
                        className="link"
                        disabled={!hasData}
                        onClick={() => go(entry.to)}
                      >
                        {entry.name}
                      </button>
                    </td>
                    <td className="muted small">{entry.what}</td>
                    <td className="muted small">{entry.look}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h3>Nothing you do here can break anything</h3>
          </div>
        </header>
        <div className="about-block">
          <p className="muted">
            On the deployed link every visitor gets their own private copy of the data, so
            nothing you load or confirm is visible to anyone else. <strong>Reset my data</strong>{' '}
            in the header wipes your copy and reloads the sample period from scratch —
            uploads, decisions, runs and all. Use it freely; it takes a couple of seconds.
          </p>
          <p className="muted small">
            The sample files themselves are in the repository under{' '}
            <a href={SAMPLES_URL} target="_blank" rel="noreferrer noopener">
              <span className="mono">samples/</span>
            </a>
            . In real life a trader downloads GSTR-2B and the IMS export from{' '}
            <span className="mono">gst.gov.in</span> and exports the purchase register from
            their accounting software.
          </p>
        </div>
      </section>
    </div>
  );
}
