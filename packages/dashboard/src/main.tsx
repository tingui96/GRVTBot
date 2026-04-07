import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';
import { applyThemeToDocument, useUiStore } from './stores/ui-store';

// Apply persisted theme BEFORE React mounts so we don't flash the wrong
// background. The store rehydrates synchronously from localStorage.
applyThemeToDocument(useUiStore.getState().theme);

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
