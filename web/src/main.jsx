import React from 'react';
import { createRoot } from 'react-dom/client';
// IBM Plex, self-hosted: the browser fetches only the subsets a page uses (₹ is
// in latin-ext), and nothing is loaded from Google at runtime.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/tokens.css';
import './styles/app.css';
import App from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';

// Outermost backstop. App has its own boundary around the routed screen, which
// keeps the navigation alive for the common case; this one catches the shell.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary scope="ITC Guard">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
