import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import './index.css';

// Outermost backstop. App has its own boundary around the routed screen, which
// keeps the nav alive for the common case; this one catches the shell itself.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary scope="ITC Guard">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
