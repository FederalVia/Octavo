import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import 'katex/dist/katex.min.css';
import './styles.css';
import { setToken } from './api';

// Phone links carry the access key once (?token=…): remember it, then remove it from the address bar.
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  setToken(urlToken);
  history.replaceState(null, '', location.pathname + location.hash);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
