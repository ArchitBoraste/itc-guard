import { Component } from 'react';

// The only class component in the app. React has no hook equivalent — an error
// boundary needs componentDidCatch.
//
// Why it exists: React unmounts the ENTIRE tree when a render throws and nothing
// catches it. One bad optional-chain in one panel takes the whole page to white,
// and because the tree is gone the nav bar goes with it, so the user cannot even
// click away. Mid-demo that is unrecoverable.
//
// Used twice, deliberately:
//   * around the routed screen, keyed on the route — a screen that throws leaves
//     the header, banner and navigation alive, and moving to another screen
//     remounts the boundary and clears the error by itself.
//   * around the whole app, as the backstop for the shell itself.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ stack: info?.componentStack ?? null });
    // Keep the real trace in the console; the panel below shows the readable half.
    console.error('[itc-guard] render failed', error, info);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const { scope = 'This screen', onReset = null } = this.props;

    return (
      <div className="boundary" role="alert" data-testid="error-boundary">
        <h2>{scope} stopped working</h2>
        <p>
          Something in the page threw an error. Nothing you had uploaded or confirmed is
          affected — decisions are saved on the server as you make them, not in this page.
        </p>

        <pre className="boundary-message mono">{String(error?.message ?? error)}</pre>

        <div className="boundary-actions">
          {onReset ? (
            <button type="button" className="btn" onClick={onReset} data-testid="boundary-reset">
              Try this screen again
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            data-testid="boundary-reload"
            onClick={() => window.location.reload()}
          >
            Reload the app
          </button>
        </div>

        {stack ? (
          <details className="boundary-details">
            <summary>Where it happened</summary>
            <pre className="mono small">{stack.trim()}</pre>
          </details>
        ) : null}
      </div>
    );
  }
}
