// About — what this is, where its file formats came from, and what the numbers
// on every other screen are actually made of.
//
// It exists because the rest of the app is deliberately confident: it says
// "recommend ACCEPT" and puts a rupee figure next to it. That confidence is
// earned against SYNTHETIC data and nothing else, and a screen that says so has
// to be one click away rather than a paragraph in a README nobody opens.

// Counted from the suites, not estimated. `cd api && npm test` and
// `docker compose exec web npm test` print these totals as their last line.
export const TEST_COUNTS = { api: 566, web: 86 };

const SCHEMA_SOURCES = [
  {
    what: 'IMS download + upload JSON',
    from: 'IMS_Offline_Utility_V1_1.xlsm',
    how: 'Read out of the VBA modules — ImportMod.bas is portal to tool, ExportMod.bas is tool to portal. That second one defines the file this app writes.'
  },
  {
    what: 'GSTR-2B JSON, and GSTN’s own matching algorithm',
    from: 'GSTR2B_Offline_Matching_Tool_v2.9.exe',
    how: 'Unpacked to a Node/Angular app. Its two SQL views are the entire official matcher, which is how we can state exactly what it cannot match.'
  },
  {
    what: 'Purchase register template',
    from: 'GSTN Returns Offline Tool V3.2.4',
    how: 'The section-wise CSV templates, plus the v2.4 spreadsheet from the 2B tool. The two formats disagree about whether a row is one invoice or one invoice × one tax rate; both are supported.'
  }
];

const DROPPED_FEATURES = [
  ['gstr3b_filed_ratio', 'Nothing the app ingests carries it. 2B has a cfs flag, but whether it means GSTR-1 or GSTR-3B is unverified.'],
  ['amendment_rate', 'The generator declares the amendment sections and never fills them, so it is 0 on every row.'],
  ['filed_ratio_6m', 'Every generated supplier reaches 2B every month, so it is 1 on every row.']
];

export function AboutScreen() {
  return (
    <div className="screen screen-about">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>About ITC Guard</h2>
            <p className="muted">
              A hackathon prototype — Omnikon 2026, team Omni_FinTech_13. It reads a
              trader&rsquo;s purchase register alongside their IMS and GSTR-2B downloads,
              says which invoices to accept, reject or hold, and writes the action file the
              GST portal accepts. It is not a filed, audited or certified product, and no
              part of it has been run against a real GST return.
            </p>
          </div>
        </header>

        <div className="about-block">
          <h3>Where the file formats came from</h3>
          <p className="muted">
            GSTN publishes the offline tools but not their schemas. Every portal field name
            in this app was recovered by taking apart the tools GSTN itself distributes, so
            the vocabulary here is the government&rsquo;s own rather than a guess at it.
          </p>
          <div className="table-wrap">
            <table className="table about-table" data-testid="about-sources">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Recovered from</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                {SCHEMA_SOURCES.map((source) => (
                  <tr key={source.what}>
                    <td className="cell-strong">{source.what}</td>
                    <td className="mono small">{source.from}</td>
                    <td className="muted small">{source.how}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Written up in full under <span className="mono">docs/</span> — one file per
            schema, plus a domain reference for the filing lifecycle they sit in.
          </p>
        </div>
      </section>

      <section className="panel panel-caution" data-testid="about-synthetic">
        <header className="panel-head">
          <div>
            <h3>Every figure in this app is synthetic</h3>
          </div>
        </header>

        <div className="about-block">
          <p>
            The suppliers, the invoices, the filing dates and the mismatches all come out of{' '}
            <span className="mono">tools/generate-fixtures.js</span>, a generator written for
            this project. Six tax periods, 40 suppliers, 2,461 documents, one fixed seed.
            Nothing here has touched a real GSTIN, a real invoice or a real filing.
          </p>
          <p>
            That matters most for the supplier risk model. It is a logistic regression
            trained on 200 supplier-months that this same generator produced, so what it has
            largely learned is the generator&rsquo;s own rules. Its held-out scores are
            evidence about the generator and about nothing else. Read a HIGH band as
            &ldquo;this is the shape of the feature the model would use&rdquo;, never as a
            claim about a real supplier.
          </p>
          <p className="muted">
            Three of the seven requested risk features could not be learned from this corpus
            at all, and training drops them rather than fitting a meaningless coefficient:
          </p>
          <ul className="about-list">
            {DROPPED_FEATURES.map(([name, why]) => (
              <li key={name}>
                <span className="mono">{name}</span> — <span className="muted">{why}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            The last of those has a consequence no metric can reveal: the model has no term
            for a supplier who stops reporting altogether. That case is caught by an
            out-of-distribution check that hands the supplier back to the hand-weighted
            scorer, not by the model.
          </p>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h3>What is tested</h3>
            <p className="muted">
              {TEST_COUNTS.api} API tests and {TEST_COUNTS.web} front-end tests, all
              passing. What they hold, rather than what they count:
            </p>
          </div>
        </header>

        <div className="about-block">
          <ul className="about-list" data-testid="about-tests">
            <li>
              <strong>The matching engine is pure</strong> — a test asserts it imports no
              database, filesystem or network module, so the scoring logic can be reasoned
              about on its own.
            </li>
            <li>
              <strong>Accuracy against labelled ground truth</strong> — every generated
              document carries the answer it should produce, and the engine is measured
              against all 2,461 of them across six periods, per bucket.
            </li>
            <li>
              <strong>Money never becomes a float</strong> — integer paise from the adapter
              boundary to the screen, with credit-note signs asserted separately because
              getting one wrong inflates a claim.
            </li>
            <li>
              <strong>Re-uploading is safe</strong> — the same file twice produces no
              duplicate rows and no phantom changes, and an amended record is recognised as
              the same document with new amounts rather than as a new one.
            </li>
            <li>
              <strong>A stale decision cannot be acted on</strong> — when a supplier amends
              a record the trader had already confirmed, the confirmation is dropped and the
              API refuses to accept it. Tested through the real HTTP route, against MySQL.
            </li>
            <li>
              <strong>The portal cannot be handed an upload it will reject</strong> — the
              blocked-action flags are honoured, and remarks are held to ASCII and 250
              characters.
            </li>
            <li>
              <strong>The screens survive their failures</strong> — a thrown component is
              caught by an error boundary that leaves the navigation alive, and a rejected
              upload can be dismissed without unmounting the app.
            </li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h3>Not built</h3>
            <p className="muted">
              Out of scope for the prototype, deliberately rather than by omission.
            </p>
          </div>
        </header>
        <div className="about-block">
          <p className="muted">
            No login — every request is served as a single stubbed trader. No GSP or portal
            API integration: files are downloaded and uploaded by hand, which is what the
            IMS offline utility is for. No email or WhatsApp sending — the app writes the
            chase message and the trader sends it. No OCR, no GSTR-2A parsing, no audit log,
            and no file storage service: uploaded files are held in the database as a blob,
            which is a prototype shortcut and not how this would ship.
          </p>
        </div>
      </section>
    </div>
  );
}
