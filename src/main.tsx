import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { BRAND } from './brand';
import { initClock } from './data/clock';
import { initNet } from './data/net';
import './styles/tokens.css';
import './styles/bwawa.css';
import './styles/app.css';

initClock();
initNet();
document.title = BRAND.name;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// Offline-first: the service worker caches the app so it opens with no signal. Updates apply on next open.
if ('serviceWorker' in navigator) registerSW({ immediate: true });
