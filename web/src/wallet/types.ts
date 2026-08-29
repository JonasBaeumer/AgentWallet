export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export interface WalletIdentity {
  userId: string;
  smartAccountAddress: `0x${string}` | null;
}

export interface SpendPermissionView {
  permissionHash: `0x${string}`;
  spender: `0x${string}`;
  token: string;
  allowanceAtomic: bigint;
  periodSeconds: number;
  start: number;
  end: number;
  revoked: boolean;
}

export interface CreatePermissionInput {
  spender: `0x${string}`;
  allowanceAtomic: bigint;
  periodInDays: number;
}

export interface WalletSdkValue {
  isInitialized: boolean;
  initializationError: string | null;
  isSignedIn: boolean;
  identity: WalletIdentity | null;
  permissions: SpendPermissionView[];
  permissionsPending: boolean;
  permissionError: string | null;
  balanceAtomic: bigint | null;
  balancePending: boolean;
  sendEmailOtp(email: string): Promise<string>;
  verifyEmailOtp(flowId: string, otp: string): Promise<void>;
  sendSmsOtp(phoneNumber: string): Promise<string>;
  verifySmsOtp(flowId: string, otp: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  getAccessToken(): Promise<string>;
  createPermission(input: CreatePermissionInput): Promise<void>;
  revokePermission(permissionHash: `0x${string}`): Promise<void>;
  refreshPermissions(): Promise<void>;
  signOut(): Promise<void>;
}
