import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import 'katex/dist/katex.min.css';
import './styles.css';
import { getToken, setToken } from './api';
import { applyAppearance } from './appearance';

applyAppearance();

// Drawings load Excalidraw's fonts from the copy shipped with the app (see vite.config.ts).
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL('excalidraw-assets/', location.href.split('#')[0]).href;

// Phone links carry the access key (?token=…): remember it.
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) setToken(urlToken);

const key = getToken();
if (key) {
  // "Add to Home Screen" saves either the page address or the manifest's start
  // address, and home-screen apps get their own storage, so both must carry the key.
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = `./manifest.webmanifest?token=${encodeURIComponent(key)}`;
  const url = new URL(location.href);
  if (isIos && !standalone) {
    // In Safari, keep the key in the address bar so the home-screen icon includes it.
    if (url.searchParams.get('token') !== key) {
      url.searchParams.set('token', key);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } else if (url.searchParams.has('token')) {
    // Everywhere else, keep the key out of the address bar.
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

// Offline copies (needs HTTPS or localhost; not used inside the desktop app, which is always local).
if ('serviceWorker' in navigator && window.isSecureContext && !window.octavoDesktop) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
