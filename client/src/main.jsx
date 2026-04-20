import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import ConnectFirstScreen from './components/ConnectFirstScreen.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <ConnectFirstScreen>
        <App />
      </ConnectFirstScreen>
    </AuthGate>
  </React.StrictMode>,
);
