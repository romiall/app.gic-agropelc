import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/index.js';
import './app/app.css';
import { App } from './app/App.js';
import { initServiceWorker } from './platform/service-worker.js';

initServiceWorker();

const container = document.getElementById('root');
if (!container) throw new Error('#root introuvable dans index.html.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
