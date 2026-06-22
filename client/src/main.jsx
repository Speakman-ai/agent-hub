import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import ConnectFirstScreen from './components/ConnectFirstScreen.jsx';
import { initSessionReplay } from './utils/sessionReplay.js';
import './index.css';

// Session replay records by default (sample rate 1) and only stops when an
// operator dials VITE_SESSION_REPLAY_SAMPLE_RATE down or the user toggles it off
// via the localStorage override. Fire-and-forget — a failure here must never
// block app render.
initSessionReplay().catch(() => {});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <ConnectFirstScreen>
        <App />
      </ConnectFirstScreen>
    </AuthGate>
  </React.StrictMode>,
);
