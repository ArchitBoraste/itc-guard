import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Only the `api` object is stubbed; ApiError stays real, because the screen
// constructs one for the unmappable-xlsx case and the test asserts its message.
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
      createRun: vi.fn(),
      seedDemo: vi.fn()
    }
  };
});

import { api } from '../src/api.js';
import { UploadScreen } from '../src/screens/Upload.jsx';

const ORG = {
  org: { gstin: '27AABCS1429F1Z8', legalName: 'Sharma Electronics Private Limited' },
  demoPeriods: ['2026-04'],
  defaultDemoPeriod: '2026-04'
};

function mountUploadPanel(props = {}) {
  return render(
    <UploadScreen org={ORG} runs={[{ taxPeriod: '2026-04' }]} onIngested={vi.fn()} {...props} />
  );
}

function dropFile(name, contents = 'x', type = 'text/csv') {
  const input = screen.getByTestId('file-PURCHASE_REGISTER');
  fireEvent.change(input, { target: { files: [new File([contents], name, { type })] } });
}

beforeEach(() => {
  api.listUploads.mockResolvedValue([]);
});

describe('upload screen — a rejected file can be dismissed', () => {
  // The reported crash: dismissing parked `undefined` under the zone's key rather
  // than removing it, and the next render did `state.status` on that undefined.
  // React unmounted the whole tree, so the page went white and the nav went with
  // it. If that regresses, render() below throws and this test fails.
  it('dismisses a non-GSTN .xlsx rejection without unmounting the screen', async () => {
    api.uploadFile.mockResolvedValue({ id: 7, detected_format: 'UNKNOWN' });
    api.uploadColumns.mockResolvedValue({
      uploadId: 7,
      format: 'UNKNOWN',
      layout: 'XLSX',
      mappable: false,
      headerRow: 5,
      headers: [],
      mapped: {},
      suggested: {},
      mappableFields: [],
      requiredFields: [],
      missingFields: []
    });

    mountUploadPanel();
    dropFile('ledger.xlsx', 'PK', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const error = await screen.findByTestId('inline-error');
    expect(error).toHaveTextContent(/not the GSTN v2\.4 template/i);
    // No mapping step is offered for a file mapping cannot rescue.
    expect(screen.queryByTestId('column-mapper')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('inline-error')).not.toBeInTheDocument();
    });

    // Still mounted, and the zone is back to its initial state rather than stuck.
    expect(screen.getByTestId('dropzone-PURCHASE_REGISTER')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /choose a file/i })).toHaveLength(3);
    expect(screen.queryByTestId('reconcile-panel')).not.toBeInTheDocument();
  });

  it('dismisses a parse failure and lets the same zone be used again', async () => {
    api.uploadFile.mockRejectedValueOnce(
      Object.assign(new Error('row 2: document date is not d-MMM-yy'), { status: 422 })
    );

    mountUploadPanel();
    dropFile('books.csv');

    expect(await screen.findByTestId('inline-error')).toHaveTextContent(/not d-MMM-yy/);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByTestId('inline-error')).not.toBeInTheDocument());

    // A second, successful drop on the cleared zone still works.
    api.uploadFile.mockResolvedValue({ id: 9, detected_format: 'GSTR2_CSV' });
    api.previewUpload.mockResolvedValue({
      detectedFormat: 'GSTR2_CSV',
      totalRows: 2,
      taxPeriod: '2026-05',
      rows: [{ taxPeriod: '2026-05' }]
    });
    api.commitUpload.mockResolvedValue({ parsed: 2, taxPeriod: '2026-05' });

    dropFile('books.csv');
    expect(await screen.findByTestId('rowcount-PURCHASE_REGISTER')).toHaveTextContent('2');
  });

  it('cancelling the column mapper does not blank the screen either', async () => {
    api.uploadFile.mockResolvedValue({ id: 11, detected_format: 'UNKNOWN' });
    api.uploadColumns.mockResolvedValue(columnsFixture());

    mountUploadPanel();
    dropFile('tally.csv');

    await screen.findByTestId('column-mapper');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByTestId('column-mapper')).not.toBeInTheDocument());
    expect(screen.getByTestId('dropzone-PURCHASE_REGISTER')).toBeInTheDocument();
    expect(screen.queryByTestId('reconcile-panel')).not.toBeInTheDocument();
  });
});

describe('upload screen — column mapping pre-fill', () => {
  it('pre-selects the adapter’s guesses and marks them as guesses', async () => {
    api.uploadFile.mockResolvedValue({ id: 11, detected_format: 'UNKNOWN' });
    api.uploadColumns.mockResolvedValue(columnsFixture());

    mountUploadPanel();
    dropFile('tally.csv');

    await screen.findByTestId('column-mapper');

    expect(screen.getByTestId('map-supplierGstin')).toHaveValue('0');
    expect(screen.getByTestId('map-invoiceNo')).toHaveValue('1');
    expect(screen.getByTestId('map-invoiceDate')).toHaveValue('2');
    expect(screen.getByTestId('map-taxableValue')).toHaveValue('3');

    // Every required field is filled, so Apply is live without any manual work.
    expect(screen.getByTestId('apply-mapping')).toBeEnabled();

    // Guesses are labelled, and the note says how many.
    expect(screen.getByTestId('guessed-supplierGstin')).toBeInTheDocument();
    expect(screen.getByTestId('guess-note')).toHaveTextContent('4');
  });

  it('leaves a field the adapter could not place unset, and Apply disabled', async () => {
    api.uploadFile.mockResolvedValue({ id: 12, detected_format: 'UNKNOWN' });
    api.uploadColumns.mockResolvedValue(
      columnsFixture({
        headers: [{ index: 0, text: 'Col A' }, { index: 1, text: 'Col B' }],
        suggested: {}
      })
    );

    mountUploadPanel();
    dropFile('mystery.csv');

    await screen.findByTestId('column-mapper');
    expect(screen.getByTestId('map-supplierGstin')).toHaveValue('');
    expect(screen.getByTestId('apply-mapping')).toBeDisabled();
    expect(screen.queryByTestId('guess-note')).not.toBeInTheDocument();
  });

  it('drops the guessed mark once the user overrides that field', async () => {
    api.uploadFile.mockResolvedValue({ id: 13, detected_format: 'UNKNOWN' });
    api.uploadColumns.mockResolvedValue(columnsFixture());

    mountUploadPanel();
    dropFile('tally.csv');

    await screen.findByTestId('column-mapper');
    expect(screen.getByTestId('guessed-invoiceNo')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('map-invoiceNo'), { target: { value: '2' } });

    await waitFor(() =>
      expect(screen.queryByTestId('guessed-invoiceNo')).not.toBeInTheDocument()
    );
    // The other guesses are untouched.
    expect(screen.getByTestId('guessed-supplierGstin')).toBeInTheDocument();
    expect(screen.getByTestId('guess-note')).toHaveTextContent('3');
  });
});

// Shaped exactly like GET /api/uploads/:id/columns for the reported CSV.
function columnsFixture(overrides = {}) {
  return {
    uploadId: 11,
    format: 'UNKNOWN',
    layout: 'CSV',
    mappable: true,
    headerRow: 1,
    headers: [
      { index: 0, text: 'Party GSTIN' },
      { index: 1, text: 'Bill No' },
      { index: 2, text: 'Bill Date' },
      { index: 3, text: 'Net Amount' }
    ],
    mapped: {},
    suggested: {
      supplierGstin: { index: 0, header: 'Party GSTIN', score: 0.8, confidence: 'MEDIUM' },
      invoiceNo: { index: 1, header: 'Bill No', score: 1, confidence: 'HIGH' },
      invoiceDate: { index: 2, header: 'Bill Date', score: 1, confidence: 'HIGH' },
      taxableValue: { index: 3, header: 'Net Amount', score: 1, confidence: 'HIGH' }
    },
    mappableFields: [
      'supplierGstin', 'supplierName', 'invoiceNo', 'invoiceDate', 'taxableValue', 'igst'
    ],
    requiredFields: ['supplierGstin', 'invoiceNo', 'invoiceDate', 'taxableValue'],
    missingFields: ['supplierGstin', 'invoiceNo', 'invoiceDate', 'taxableValue'],
    ...overrides
  };
}
