import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

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
