import { createContext, ReactNode, useContext } from 'react';
import { CDPReactProvider, type Config } from '@coinbase/cdp-react';
import { CdpHooksBridge } from './CdpHooksBridge';
import { MockWalletProvider } from './MockWalletProvider';
import { WalletSdkValue } from './types';

const WalletSdkContext = createContext<WalletSdkValue | null>(null);

export function useWalletSdk(): WalletSdkValue {
  const value = useContext(WalletSdkContext);
  if (!value) throw new Error('Wallet SDK provider is missing');
  return value;
}

export function WalletSdkContextProvider({
  value,
  children,
}: {
  value: WalletSdkValue;
  children: ReactNode;
}) {
  return <WalletSdkContext.Provider value={value}>{children}</WalletSdkContext.Provider>;
}

export function WalletSdkProvider({ children }: { children: ReactNode }) {
  if (import.meta.env.VITE_CDP_MOCK === 'true') {
    return <MockWalletProvider>{children}</MockWalletProvider>;
  }

  const projectId = import.meta.env.VITE_CDP_PROJECT_ID?.trim();
  if (!projectId) {
    const unavailable: WalletSdkValue = {
      isInitialized: false,
      initializationError: 'VITE_CDP_PROJECT_ID is not configured',
      isSignedIn: false,
      identity: null,
      permissions: [],
      permissionsPending: false,
      permissionError: null,
      balanceAtomic: null,
      balancePending: false,
      sendEmailOtp: async () => Promise.reject(new Error('CDP is not configured')),
      verifyEmailOtp: async () => Promise.reject(new Error('CDP is not configured')),
      sendSmsOtp: async () => Promise.reject(new Error('CDP is not configured')),
      verifySmsOtp: async () => Promise.reject(new Error('CDP is not configured')),
      signInWithGoogle: async () => Promise.reject(new Error('CDP is not configured')),
      getAccessToken: async () => Promise.reject(new Error('CDP is not configured')),
      createPermission: async () => Promise.reject(new Error('CDP is not configured')),
      revokePermission: async () => Promise.reject(new Error('CDP is not configured')),
      refreshPermissions: async () => Promise.resolve(),
      signOut: async () => Promise.resolve(),
    };
    return <WalletSdkContextProvider value={unavailable}>{children}</WalletSdkContextProvider>;
  }

  const config: Config = {
    projectId,
    ethereum: {
      createOnLogin: 'smart',
      enableSpendPermissions: true,
    },
    appName: 'AgentWallet',
    authMethods: ['email', 'sms', 'oauth:google'],
  };

  return (
    <CDPReactProvider config={config}>
      <CdpHooksBridge>{children}</CdpHooksBridge>
    </CDPReactProvider>
  );
}
