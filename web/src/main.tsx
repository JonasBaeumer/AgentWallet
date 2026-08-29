import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WalletSdkProvider } from './wallet/WalletSdkContext';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletSdkProvider>
      <App />
    </WalletSdkProvider>
  </StrictMode>,
);
