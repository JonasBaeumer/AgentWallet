import { ReactNode, useEffect, useMemo, useState } from 'react';
import { WalletSdkContextProvider } from './WalletSdkContext';
import { CreatePermissionInput, SpendPermissionView, WalletSdkValue } from './types';

const SMART_ACCOUNT = `0x${'1'.repeat(40)}` as `0x${string}`;

export function MockWalletProvider({ children }: { children: ReactNode }) {
  const [initialized, setInitialized] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [permissions, setPermissions] = useState<SpendPermissionView[]>([]);
  const walletMissing =
    new URLSearchParams(window.location.search).get('mock') === 'missing-wallet';

  useEffect(() => {
    const timeout = window.setTimeout(() => setInitialized(true), 120);
    return () => window.clearTimeout(timeout);
  }, []);

  const value = useMemo<WalletSdkValue>(
    () => ({
      isInitialized: initialized,
      initializationError: null,
      isSignedIn: signedIn,
      identity: signedIn
        ? { userId: 'mock-cdp-user', smartAccountAddress: walletMissing ? null : SMART_ACCOUNT }
        : null,
      permissions,
      permissionsPending: false,
      permissionError: null,
      balanceAtomic: signedIn ? 24_500_000n : null,
      balancePending: false,
      sendEmailOtp: async () => 'mock-email-flow',
      verifyEmailOtp: async (_flowId, otp) => {
        if (otp !== '123456') throw new Error('The verification code is incorrect or expired');
        setSignedIn(true);
      },
      sendSmsOtp: async () => 'mock-sms-flow',
      verifySmsOtp: async (_flowId, otp) => {
        if (otp !== '123456') throw new Error('The verification code is incorrect or expired');
        setSignedIn(true);
      },
      signInWithGoogle: async () => setSignedIn(true),
      getAccessToken: async () => 'mock-cdp-access-token',
      createPermission: async (input: CreatePermissionInput) => {
        if (input.allowanceAtomic === 13_000_000n) {
          throw new Error('The wallet signature was rejected');
        }
        setPermissions([
          {
            permissionHash: `0x${'2'.repeat(64)}`,
            spender: input.spender,
            token: 'usdc',
            allowanceAtomic: input.allowanceAtomic,
            periodSeconds: input.periodInDays * 86_400,
            start: Math.floor(Date.now() / 1_000),
            end: Math.floor(Date.now() / 1_000) + input.periodInDays * 86_400,
            revoked: false,
          },
        ]);
      },
      revokePermission: async (permissionHash) => {
        setPermissions((current) =>
          current.map((permission) =>
            permission.permissionHash === permissionHash
              ? { ...permission, revoked: true }
              : permission,
          ),
        );
      },
      refreshPermissions: async () => undefined,
      signOut: async () => {
        setSignedIn(false);
        setPermissions([]);
      },
    }),
    [initialized, permissions, signedIn, walletMissing],
  );

  return <WalletSdkContextProvider value={value}>{children}</WalletSdkContextProvider>;
}
