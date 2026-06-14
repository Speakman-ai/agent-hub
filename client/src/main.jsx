import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import ConnectFirstScreen from './components/ConnectFirstScreen.jsx';
import { initSessionReplay } from './utils/sessionReplay.js';
import './index.css';

// Session replay is off by default; this is a no-op unless this client samples
// in (VITE_SESSION_REPLAY_SAMPLE_RATE or the localStorage override). Fire-and-
// forget — a failure here must never block app render.
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
