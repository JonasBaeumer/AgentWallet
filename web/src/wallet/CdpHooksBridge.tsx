import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  useCreateSpendPermission,
  useCurrentUser,
  useGetAccessToken,
  useIsInitialized,
  useIsSignedIn,
  useListSpendPermissions,
  useRevokeSpendPermission,
  useSignInWithEmail,
  useSignInWithOAuth,
  useSignInWithSms,
  useSignOut,
  useVerifyEmailOTP,
  useVerifySmsOTP,
} from '@coinbase/cdp-hooks';
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { WalletSdkContextProvider } from './WalletSdkContext';
import {
  BASE_SEPOLIA_USDC,
  CreatePermissionInput,
  SpendPermissionView,
  WalletSdkValue,
} from './types';

interface CdpUserShape {
  userId: string;
  evmSmartAccounts?: string[];
  evmSmartAccountObjects?: Array<{ address: string }>;
}

interface CdpPermissionShape {
  permissionHash: string;
  revoked?: boolean;
  permission: {
    spender: string;
    token: string;
    allowance: bigint | string;
    period: number | string;
    start: number | string;
    end: number | string;
  };
}

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Coinbase wallet request failed';
}

function useUsdcBalance(address: `0x${string}` | null) {
  const [balanceAtomic, setBalanceAtomic] = useState<bigint | null>(null);
  const [balancePending, setBalancePending] = useState(false);

  useEffect(() => {
    if (!address) {
      setBalanceAtomic(null);
      return;
    }
    let active = true;
    const load = async () => {
      setBalancePending(true);
      try {
        const balance = await publicClient.readContract({
          address: BASE_SEPOLIA_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        });
        if (active) setBalanceAtomic(balance);
      } catch {
        if (active) setBalanceAtomic(null);
      } finally {
        if (active) setBalancePending(false);
      }
    };
    void load();
    const interval = window.setInterval(load, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [address]);

  return { balanceAtomic, balancePending };
}

export function CdpHooksBridge({ children }: { children: ReactNode }) {
  const initialization = useIsInitialized();
  const signedIn = useIsSignedIn();
  const current = useCurrentUser() as unknown as {
    currentUser?: CdpUserShape | null;
    user?: CdpUserShape | null;
  };
  const currentUser = current.currentUser ?? current.user ?? null;
  const email = useSignInWithEmail();
  const emailOtp = useVerifyEmailOTP();
  const sms = useSignInWithSms();
  const smsOtp = useVerifySmsOTP();
  const oauth = useSignInWithOAuth();
  const accessToken = useGetAccessToken();
  const signOutHook = useSignOut();
  const list = useListSpendPermissions();
  const create = useCreateSpendPermission();
  const revoke = useRevokeSpendPermission();

  const smartAccountAddress =
    currentUser?.evmSmartAccountObjects?.[0]?.address ?? currentUser?.evmSmartAccounts?.[0] ?? null;
  const normalizedAddress =
    smartAccountAddress && /^0x[0-9a-fA-F]{40}$/.test(smartAccountAddress)
      ? (smartAccountAddress as `0x${string}`)
      : null;
  const { balanceAtomic, balancePending } = useUsdcBalance(normalizedAddress);

  const rawList = list as unknown as {
    data?: { spendPermissions?: CdpPermissionShape[] };
    status?: string;
    error?: unknown;
    refetch: () => Promise<unknown>;
  };
  const permissions = useMemo<SpendPermissionView[]>(
    () =>
      (rawList.data?.spendPermissions ?? []).map((entry) => ({
        permissionHash: entry.permissionHash as `0x${string}`,
        spender: entry.permission.spender as `0x${string}`,
        token: entry.permission.token,
        allowanceAtomic: BigInt(entry.permission.allowance),
        periodSeconds: Number(entry.permission.period),
        start: Number(entry.permission.start),
        end: Number(entry.permission.end),
        revoked: Boolean(entry.revoked),
      })),
    [rawList.data],
  );

  const createPermission = useCallback(
    async (input: CreatePermissionInput) => {
      await create.createSpendPermission({
        network: 'base-sepolia',
        spender: input.spender,
        token: 'usdc',
        allowance: input.allowanceAtomic,
        periodInDays: input.periodInDays,
        useCdpPaymaster: true,
      });
      await rawList.refetch();
    },
    [create, rawList],
  );

  const revokePermission = useCallback(
    async (permissionHash: `0x${string}`) => {
      await revoke.revokeSpendPermission({
        network: 'base-sepolia',
        permissionHash,
        useCdpPaymaster: true,
      });
      await rawList.refetch();
    },
    [rawList, revoke],
  );

  const value: WalletSdkValue = {
    isInitialized: initialization.isInitialized,
    initializationError: null,
    isSignedIn: signedIn.isSignedIn,
    identity: currentUser
      ? { userId: currentUser.userId, smartAccountAddress: normalizedAddress }
      : null,
    permissions,
    permissionsPending: rawList.status === 'pending',
    permissionError: rawList.error ? message(rawList.error) : null,
    balanceAtomic,
    balancePending,
    sendEmailOtp: async (address) => (await email.signInWithEmail({ email: address })).flowId,
    verifyEmailOtp: async (flowId, otp) => {
      await emailOtp.verifyEmailOTP({ flowId, otp });
    },
    sendSmsOtp: async (phoneNumber) => (await sms.signInWithSms({ phoneNumber })).flowId,
    verifySmsOtp: async (flowId, otp) => {
      await smsOtp.verifySmsOTP({ flowId, otp });
    },
    signInWithGoogle: async () => {
      await oauth.signInWithOAuth('google');
    },
    getAccessToken: accessToken.getAccessToken,
    createPermission,
    revokePermission,
    refreshPermissions: async () => {
      await rawList.refetch();
    },
    signOut: signOutHook.signOut,
  };

  return <WalletSdkContextProvider value={value}>{children}</WalletSdkContextProvider>;
}

export function formatUsdc(amount: bigint | null): string {
  if (amount === null) return 'Unavailable';
  const [whole, fraction = ''] = formatUnits(amount, 6).split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)} USDC`;
}

export function parseUsdc(value: string): bigint {
  return parseUnits(value, 6);
}
