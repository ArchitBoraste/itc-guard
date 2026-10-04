import { PageHeader } from '../components/PageHeader.jsx';

const SCREENS = [
  ['Upload', 'Add your purchase register and the latest IMS download; GSTR-2B once the portal makes it on the 14th.'],
  ['Overview', 'What your books hold, what is ready to claim, and what needs you before GSTR-3B.'],
  ['IMS decisions', 'Accept, reject or hold each IMS record, then download the file and upload it in IMS on the portal.'],
  ['Not filed yet', 'Invoices in your books your supplier has not filed, with a message to send them.'],
  ['Corrections', 'Fixes you asked suppliers for last month, and whether they have arrived.'],
  ['Suppliers', 'Who you buy from, how they file, who to call, and how reliable they have been.']
];

const MONTH = [
  ['11th', 'Monthly suppliers’ cut-off', 'An invoice filed in GSTR-1 by now reaches your GSTR-2B this month.'],
  ['13th', 'Quarterly suppliers’ cut-off', 'The same for suppliers who file quarterly, through IFF.'],
  ['14th', 'GSTR-2B is generated', 'Your statement of filed invoices for the month.'],
  ['20th', 'GSTR-3B is due', 'Any IMS record you have not decided is accepted automatically.']
];

export function HelpScreen() {
  return (
    <>
      <PageHeader title="Help" subtitle="What each screen is for, and the dates that matter each month." />

      <section className="card card-pad" aria-labelledby="help-screens">
        <h2 className="card-title" id="help-screens">
          The screens
        </h2>
        <ul className="help-list" data-testid="help-screens">
          {SCREENS.map(([name, line]) => (
            <li key={name}>
              <strong>{name}</strong>
              <span className="secondary">{line}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card card-pad help-month" aria-labelledby="help-month">
        <h2 className="card-title" id="help-month">
          Your month
        </h2>
        <ol className="calendar plain-list" data-testid="help-calendar">
          {MONTH.map(([day, title, line]) => (
            <li key={day} className="calendar-day">
              <div className="calendar-date">{day}</div>
              <div className="strong-line">{title}</div>
              <div className="small secondary">{line}</div>
            </li>
          ))}
        </ol>
        <p className="small muted">Of the month after the one you are filing for: August&apos;s cut-off is 11 September.</p>
      </section>

      <section className="card card-pad" aria-labelledby="help-data">
        <h2 className="card-title" id="help-data">
          Your data
        </h2>
        <p className="secondary" data-testid="help-privacy">
          Each visitor gets a private workspace; nothing is shared. Clear all data on the Upload screen deletes it.
        </p>
      </section>
    </>
  );
}
