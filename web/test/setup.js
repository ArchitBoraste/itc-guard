import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Testing Library's default budget for findBy*/waitFor is 1000ms of WALL CLOCK,
// and that is the wrong unit for this suite. Several tests wait on a real React
// render triggered by a click or a 1500ms poll; the app is not slow, the runner
// is — vitest runs the files in parallel inside the web container, and under that
// contention a render that normally lands in 50ms occasionally takes over a
// second. That produced a suite that went red roughly one run in three, on
// assertions that were correct, which is worse than a slow suite: a red run
// nobody trusts is a red run nobody reads.
//
// This weakens nothing. Every one of those assertions still fails if the thing
// being waited for never happens — the only change is how long we are willing to
// wait before concluding that it never will.
configure({ asyncUtilTimeout: 15000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A render that throws is reported through console.error rather than by rejecting,
// so a test that renders a broken tree would otherwise pass while spraying stack
// traces. Tests that deliberately throw opt in via expectRenderErrors().
const realConsoleError = console.error;
let allowRenderErrors = false;

export function expectRenderErrors() {
  allowRenderErrors = true;
}

beforeEach(() => {
  allowRenderErrors = false;
  console.error = (...args) => {
    if (allowRenderErrors) return;
    realConsoleError(...args);
  };
});
