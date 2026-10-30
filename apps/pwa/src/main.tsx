import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/index.js';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/home.css';
import './app/app.css';
import { App } from './app/App.js';
import { initTheme } from './components/ui/theme.js';
import { initServiceWorker } from './platform/service-worker.js';

// Thème mémorisé appliqué avant le premier rendu (clair par défaut, ADR-049).
initTheme();
initServiceWorker();

const container = document.getElementById('root');
if (!container) throw new Error('#root introuvable dans index.html.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
