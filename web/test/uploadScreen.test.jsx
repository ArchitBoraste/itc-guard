// The Upload screen: three cards, the Reconcile bar, history with Remove, and
// Clear all data. Fixtures are the API's own answers on the demo's dates.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import aug11 from './fixtures/aug-11sep.json';
import aug14 from './fixtures/aug-14sep.json';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      listUploads: vi.fn(),
      uploadFile: vi.fn(),
      uploadColumns: vi.fn(),
      previewUpload: vi.fn(),
      commitUpload: vi.fn(),
      deleteUpload: vi.fn(),
      createRun: vi.fn(),
      clearWorkspace: vi.fn(),
      listDemoFiles: vi.fn()
    }
  };
});

import { ApiError, api } from '../src/api.js';
import { UploadScreen } from '../src/screens/Upload.jsx';

const AUGUST = '2026-08';
const inventory = (fixture) => fixture.periods.find((entry) => entry.taxPeriod === AUGUST);

// On 7 Sep: the register and two IMS downloads, the 5 Sep one replaced by the 7 Sep one.
const UPLOADS_7SEP = [
  { id: 3, kind: 'IMS', original_filename: 'ims_aug26_as_of_07sep.json', tax_period: AUGUST, snapshot_date: '2026-09-07', row_count: 5, committed_at: '2026-09-07 04:42:00', created_at: '2026-09-07 04:42:00', replaced_by_upload_id: null },
  { id: 2, kind: 'IMS', original_filename: 'ims_aug26_as_of_05sep.json', tax_period: AUGUST, snapshot_date: '2026-09-05', row_count: 2, committed_at: '2026-09-07 04:40:00', created_at: '2026-09-07 04:40:00', replaced_by_upload_id: 3 },
  { id: 1, kind: 'PURCHASE_REGISTER', original_filename: 'purchase_register_aug26.xlsx', tax_period: AUGUST, snapshot_date: null, row_count: 11, committed_at: '2026-09-07 04:35:00', created_at: '2026-09-07 04:35:00', replaced_by_upload_id: null }
];

const CALENDAR_7SEP = {
  taxPeriod: AUGUST,
  deadlines: [
    { key: 'CUTOFF_MONTHLY', date: '2026-09-11', daysLeft: 4 },
    { key: 'GSTR2B_GENERATED', date: '2026-09-14', daysLeft: 7 },
    { key: 'GSTR3B_DUE', date: '2026-09-20', daysLeft: 13 }
  ]
};

function renderUpload(props = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  render(
    <UploadScreen
      period={AUGUST}
      inventory={{
        taxPeriod: AUGUST, hasBooks: true, hasPortal: true, runId: null,
        register: { documents: 11, suppliers: 11, invoices: 10, creditNotes: 1, debitNotes: 0, contacts: 11 },
        imsRecords: { records: 5, suppliers: 5, filed: 3, saved: 2 },
        twoB: null
      }}
      calendar={CALENDAR_7SEP}
      run={null}
      perVisitor
      dataVersion={0}
      refresh={refresh}
      navigate={navigate}
      {...props}
    />
  );
  return { refresh, navigate };
}

beforeEach(() => {
  api.listUploads.mockResolvedValue(UPLOADS_7SEP);
  api.listDemoFiles.mockResolvedValue([]);
});

describe('an empty workspace', () => {
  it('offers three files to choose and nothing to reconcile', async () => {
    api.listUploads.mockResolvedValue([]);
    renderUpload({ period: null, inventory: null, calendar: null });
    for (const kind of ['PURCHASE_REGISTER', 'IMS', 'GSTR2B']) {
      expect(within(screen.getByTestId(`card-${kind}`)).getByRole('button', { name: 'Choose file' })).toBeEnabled();
    }
    expect(screen.getByTestId('reconcile')).toBeDisabled();
    expect(screen.getByTestId('reconcile-bar')).toHaveTextContent('Add your purchase register and an IMS download to reconcile.');
    expect(await screen.findByTestId('empty-history')).toBeInTheDocument();
  });
});

describe('the cards on 7 Sep', () => {
  it('describe the register and the IMS download', async () => {
    renderUpload();
    const register = screen.getByTestId('card-PURCHASE_REGISTER');
    expect(register).toHaveTextContent('11documents');
    expect(register).toHaveTextContent('10 invoices · 1 credit note · contacts for 11 suppliers');
    expect(await within(register).findByText('purchase_register_aug26.xlsx')).toBeInTheDocument();

    const ims = screen.getByTestId('card-IMS');
    expect(ims).toHaveTextContent('Downloaded 7 Sep · 3 filed · 2 saved, not filed');
    expect(within(ims).getByRole('button', { name: 'Upload newer download' })).toBeInTheDocument();
  });

  it('lock GSTR-2B until the 14th, saying how long', () => {
    renderUpload();
    const twoB = screen.getByTestId('card-GSTR2B');
    expect(screen.getByTestId('lock-GSTR2B')).toHaveTextContent('Opens 14 Sep');
    expect(twoB).toHaveTextContent('7 days');
    expect(twoB).toHaveTextContent("The portal generates August's GSTR-2B on 14 Sep.");
    expect(within(twoB).getByRole('button', { name: 'Choose file' })).toBeDisabled();
  });

  it('open GSTR-2B on the 14th', () => {
    renderUpload({ calendar: aug14.clock.calendar });
    expect(screen.queryByTestId('lock-GSTR2B')).toBeNull();
    expect(within(screen.getByTestId('card-GSTR2B')).getByRole('button', { name: 'Choose file' })).toBeEnabled();
  });
});

describe('uploading', () => {
  it('reads the file, commits it, and follows it to its period', async () => {
    api.uploadFile.mockResolvedValue({ id: 9, detected_format: 'IMS_JSON', warnings: [] });
    api.commitUpload.mockResolvedValue({ taxPeriod: AUGUST, parsed: 10 });
    const { refresh } = renderUpload();
    const file = new File(['{}'], 'ims_aug26_as_of_11sep.json', { type: 'application/json' });
    await userEvent.upload(screen.getByTestId('file-IMS'), file);
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ prefer: AUGUST }));
    expect(api.uploadFile).toHaveBeenCalledWith('IMS', file);
    expect(api.commitUpload).toHaveBeenCalledWith(9);
  });

  it("shows another trader's file being refused on the card", async () => {
    api.uploadFile.mockRejectedValue(
      new ApiError('These files belong to GSTIN 29AAACX1234A1Z5; this workspace is for 27AABCS1080F1ZN.', {
        status: 422,
        code: 'gstin_mismatch'
      })
    );
    renderUpload();
    await userEvent.upload(screen.getByTestId('file-PURCHASE_REGISTER'), new File(['x'], 'other.xlsx'));
    expect(await screen.findByTestId('error-PURCHASE_REGISTER')).toHaveTextContent('this workspace is for 27AABCS1080F1ZN');
  });

  it("shows the API's refusal of a GSTR-2B before the 14th", async () => {
    api.uploadFile.mockRejectedValue(
      new ApiError('GSTR-2B for August 2026 is generated on 14 Sep 2026, and the workspace date is 11 Sep 2026.', {
        status: 409,
        code: 'gstr2b_not_generated'
      })
    );
    renderUpload({ period: null, inventory: null, calendar: null });
    await userEvent.upload(screen.getByTestId('file-GSTR2B'), new File(['{}'], 'gstr2b_aug26.json'));
    expect(await screen.findByTestId('error-GSTR2B')).toHaveTextContent('is generated on 14 Sep 2026');
  });

  it('asks which column is which for a register it does not recognise, contacts and frequency included', async () => {
    api.uploadFile.mockResolvedValue({ id: 5, detected_format: 'UNKNOWN' });
    api.uploadColumns.mockResolvedValue({
      mappable: true,
      headers: ['GSTIN', 'Bill No', 'Bill Date', 'Taxable', 'Contact', 'Return frequency'].map((text, index) => ({ index, text })),
      mapped: { supplierGstin: 0 },
      suggested: { invoiceNo: { index: 1, header: 'Bill No', confidence: 'HIGH' } },
      mappableFields: ['supplierGstin', 'invoiceNo', 'invoiceDate', 'taxableValue', 'docType', 'contactPerson', 'filingFrequency'],
      requiredFields: ['supplierGstin', 'invoiceNo', 'invoiceDate', 'taxableValue']
    });
    api.previewUpload.mockResolvedValue({});
    api.commitUpload.mockResolvedValue({ taxPeriod: AUGUST });
    const { refresh } = renderUpload();
    await userEvent.upload(screen.getByTestId('file-PURCHASE_REGISTER'), new File(['a,b'], 'tally.csv'));

    const mapper = await screen.findByTestId('column-mapper');
    expect(within(mapper).getByText('Supplier contact and filing frequency (optional)')).toBeInTheDocument();
    expect(screen.getByTestId('map-filingFrequency')).toBeInTheDocument();
    expect(screen.getByTestId('apply-mapping')).toBeDisabled();

    await userEvent.selectOptions(screen.getByTestId('map-invoiceDate'), '2');
    await userEvent.selectOptions(screen.getByTestId('map-taxableValue'), '3');
    await userEvent.selectOptions(screen.getByTestId('map-filingFrequency'), '5');
    await userEvent.click(within(mapper).getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('apply-mapping'));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(api.commitUpload).toHaveBeenCalledWith(5, {
      columnMap: { supplierGstin: 0, invoiceNo: 1, invoiceDate: 2, taxableValue: 3, filingFrequency: 5 },
      allInvoices: true
    });
  });
});

describe('reconciling', () => {
  it('reconciles the period and opens Overview', async () => {
    api.createRun.mockResolvedValue({ id: 1 });
    const { refresh, navigate } = renderUpload();
    await userEvent.click(screen.getByTestId('reconcile'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('overview'));
    expect(api.createRun).toHaveBeenCalledWith(AUGUST);
    expect(refresh).toHaveBeenCalled();
  });

  it('becomes "See results" once the period has a run, since uploads rebuild it', async () => {
    api.listUploads.mockResolvedValue(aug11.uploads);
    renderUpload({ run: aug11.run, inventory: inventory(aug11) });
    expect(screen.queryByTestId('reconcile')).toBeNull();
    expect(screen.getByTestId('see-results')).toHaveTextContent('See results');
    await waitFor(() =>
      expect(screen.getByTestId('reconcile-bar')).toHaveTextContent('Purchase register against IMS as of 11 Sep')
    );
  });
});

describe('upload history', () => {
  it('greys out a replaced download and says what replaced it', async () => {
    renderUpload();
    const table = await screen.findByTestId('upload-history');
    const replaced = within(table).getByText('ims_aug26_as_of_05sep.json').closest('tr');
    expect(replaced).toHaveClass('is-muted');
    expect(replaced).toHaveTextContent('Replaced by 7 Sep');
    expect(within(table).getByText('ims_aug26_as_of_07sep.json').closest('tr')).toHaveTextContent('IMS · as of 7 Sep');
  });

  it('removes a file only after confirming', async () => {
    api.deleteUpload.mockResolvedValue({});
    const { refresh } = renderUpload();
    await screen.findByTestId('upload-history');
    await userEvent.click(screen.getByRole('button', { name: 'Remove ims_aug26_as_of_07sep.json' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove ims_aug26_as_of_07sep.json?' });
    expect(dialog).toHaveTextContent('Its records leave August 2026');
    expect(api.deleteUpload).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteUpload).toHaveBeenCalledWith(3));
    expect(refresh).toHaveBeenCalled();
  });
});

describe('Clear all data', () => {
  it('asks first, then empties the workspace', async () => {
    api.clearWorkspace.mockResolvedValue({});
    const { refresh } = renderUpload();
    await userEvent.click(screen.getByTestId('clear-all'));
    const dialog = screen.getByRole('dialog', { name: 'Clear all data?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear all data' }));
    await waitFor(() => expect(api.clearWorkspace).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it('is not offered on a shared workspace', () => {
    renderUpload({ perVisitor: false });
    expect(screen.queryByTestId('clear-all')).toBeNull();
  });
});
