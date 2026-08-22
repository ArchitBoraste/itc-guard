import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../src/components/ErrorBoundary.jsx';
import { expectRenderErrors } from './setup.js';

function Boom({ message = 'Cannot read properties of undefined (reading ‘status’)' }) {
  throw new TypeError(message);
}

describe('error boundary', () => {
  it('shows what went wrong instead of a white screen', () => {
    expectRenderErrors();
    render(
      <ErrorBoundary scope="This screen">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('This screen stopped working');
    expect(screen.getByTestId('error-boundary')).toHaveTextContent(/reading/i);
    expect(screen.getByTestId('boundary-reload')).toBeInTheDocument();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary scope="This screen">
        <p>the actual screen</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('the actual screen')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary')).not.toBeInTheDocument();
  });

  it('offers a reload, since a broken render cannot be clicked out of', () => {
    expectRenderErrors();
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload }
    });

    render(
      <ErrorBoundary scope="ITC Guard">
        <Boom />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByTestId('boundary-reload'));
    expect(reload).toHaveBeenCalledOnce();
  });

  // This is what makes navigating away recover: App keys the boundary on the
  // route, so changing route remounts it with a clean slate.
  it('clears itself when remounted under a new key', () => {
    expectRenderErrors();
    const { rerender } = render(
      <ErrorBoundary key="actions" scope="This screen">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();

    rerender(
      <ErrorBoundary key="summary" scope="This screen">
        <p>a different screen</p>
      </ErrorBoundary>
    );
    expect(screen.queryByTestId('error-boundary')).not.toBeInTheDocument();
    expect(screen.getByText('a different screen')).toBeInTheDocument();
  });
});
