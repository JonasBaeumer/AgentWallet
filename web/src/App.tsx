import { FormEvent, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Clipboard,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  Network,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Unplug,
  UserRound,
  WalletCards,
} from 'lucide-react';
import {
  AgentWalletUser,
  ApiError,
  authenticateAgentWallet,
  bindCustomerWallet,
  CustomerWallet,
  disconnectCustomerWallet,
  getCustomerWallet,
} from './api';
import { formatUsdc, parseUsdc } from './wallet/CdpHooksBridge';
import { useWalletSdk } from './wallet/WalletSdkContext';

type AuthMethod = 'email' | 'sms';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      invalid_session: 'Your Coinbase session expired. Sign in again.',
      provider_unavailable: 'Coinbase verification is temporarily unavailable.',
      crypto_onboarding_disabled: 'Crypto onboarding is not enabled on this environment.',
      wallet_already_bound: 'This Coinbase wallet belongs to another AgentWallet account.',
      wallet_identity_mismatch: 'This AgentWallet account is bound to another Coinbase wallet.',
      wallet_disconnect_blocked: 'Revoke the active permission before disconnecting.',
    };
    return messages[error.code] ?? 'The request could not be completed.';
  }
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function compactAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function StatusMessage({ message, tone = 'error' }: { message: string; tone?: 'error' | 'info' }) {
  return (
    <div className={`status-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <AlertCircle size={18} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function AppHeader({ profile, onLock }: { profile: AgentWalletUser | null; onLock: () => void }) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">
          <WalletCards size={22} />
        </span>
        <span>AgentWallet</span>
      </div>
      <div className="header-actions">
        <span className="network-badge">
          <span className="network-dot" /> Base Sepolia
        </span>
        {profile && (
          <button className="icon-button" type="button" onClick={onLock} title="Lock AgentWallet">
            <LogOut size={18} />
          </button>
        )}
      </div>
    </header>
  );
}

function ProgressRail({ stage }: { stage: number }) {
  const steps = ['AgentWallet', 'Coinbase', 'Smart Account', 'Permission'];
  return (
    <nav className="progress-rail" aria-label="Wallet setup progress">
      {steps.map((label, index) => {
        const number = index + 1;
        const complete = number < stage;
        const active = number === stage;
        return (
          <div
            className={`progress-step ${complete ? 'complete' : ''} ${active ? 'active' : ''}`}
            key={label}
          >
            <span className="step-indicator">{complete ? <Check size={15} /> : number}</span>
            <span>{label}</span>
          </div>
        );
      })}
    </nav>
  );
}

function AgentWalletAccess({
  onAuthenticated,
}: {
  onAuthenticated: (apiKey: string, user: AgentWalletUser, wallet: CustomerWallet | null) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const user = await authenticateAgentWallet(apiKey.trim());
      const wallet = await getCustomerWallet(apiKey.trim());
      onAuthenticated(apiKey.trim(), user, wallet);
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status === 401
          ? 'Invalid AgentWallet key.'
          : errorMessage(reason),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="setup-panel auth-panel" aria-labelledby="agentwallet-access-title">
      <div className="section-heading">
        <span className="section-icon">
          <KeyRound size={20} />
        </span>
        <div>
          <p className="eyebrow">Customer access</p>
          <h1 id="agentwallet-access-title">Open your wallet setup</h1>
        </div>
      </div>
      <form onSubmit={submit} className="stack-form">
        <label htmlFor="agentwallet-key">AgentWallet API key</label>
        <div className="input-with-icon">
          <KeyRound size={18} aria-hidden="true" />
          <input
            id="agentwallet-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        {error && <StatusMessage message={error} />}
        <button
          className="primary-button"
          disabled={pending || apiKey.trim().length < 16}
          type="submit"
        >
          {pending ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
          Continue
        </button>
      </form>
      <p className="privacy-note">The key remains in this browser tab and is never stored.</p>
    </section>
  );
}

function CoinbaseSignIn() {
  const wallet = useWalletSdk();
  const [method, setMethod] = useState<AuthMethod>('email');
  const [destination, setDestination] = useState('');
  const [flowId, setFlowId] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const nextFlow =
        method === 'email'
          ? await wallet.sendEmailOtp(destination.trim())
          : await wallet.sendSmsOtp(destination.trim());
      setFlowId(nextFlow);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!flowId) return;
    setPending(true);
    setError(null);
    try {
      if (method === 'email') await wallet.verifyEmailOtp(flowId, otp);
      else await wallet.verifySmsOtp(flowId, otp);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const google = async () => {
    setPending(true);
    setError(null);
    try {
      await wallet.signInWithGoogle();
    } catch (reason) {
      setError(errorMessage(reason));
      setPending(false);
    }
  };

  if (!wallet.isInitialized) {
    return (
      <section className="setup-panel centered-state" aria-live="polite">
        {wallet.initializationError ? (
          <StatusMessage message={wallet.initializationError} />
        ) : (
          <>
            <LoaderCircle className="spin" size={26} />
            <h1>Initializing Coinbase Wallet</h1>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="setup-panel auth-panel" aria-labelledby="coinbase-signin-title">
      <div className="section-heading">
        <span className="coinbase-mark" aria-hidden="true">
          C
        </span>
        <div>
          <p className="eyebrow">Coinbase Wallet</p>
          <h1 id="coinbase-signin-title">Sign in to your Smart Account</h1>
        </div>
      </div>
      {!flowId ? (
        <>
          <div className="segmented-control" role="group" aria-label="Sign-in method">
            <button
              className={method === 'email' ? 'selected' : ''}
              type="button"
              onClick={() => setMethod('email')}
            >
              <Mail size={17} /> Email
            </button>
            <button
              className={method === 'sms' ? 'selected' : ''}
              type="button"
              onClick={() => setMethod('sms')}
            >
              <Smartphone size={17} /> SMS
            </button>
          </div>
          <form onSubmit={begin} className="stack-form">
            <label htmlFor="cdp-destination">
              {method === 'email' ? 'Email address' : 'Mobile number'}
            </label>
            <input
              id="cdp-destination"
              type={method === 'email' ? 'email' : 'tel'}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={method === 'email' ? 'you@example.com' : '+1 555 000 0000'}
              autoComplete={method === 'email' ? 'email' : 'tel'}
              required
            />
            {error && <StatusMessage message={error} />}
            <button
              className="primary-button"
              type="submit"
              disabled={pending || !destination.trim()}
            >
              {pending ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
              Send code
            </button>
          </form>
          <div className="divider">
            <span>or</span>
          </div>
          <button className="secondary-button" type="button" onClick={google} disabled={pending}>
            <span className="google-g" aria-hidden="true">
              G
            </span>{' '}
            Continue with Google
          </button>
        </>
      ) : (
        <form onSubmit={verify} className="stack-form">
          <div className="destination-line">
            Code sent to <strong>{destination}</strong>
          </div>
          <label htmlFor="cdp-otp">Verification code</label>
          <input
            id="cdp-otp"
            className="otp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
            required
          />
          {error && <StatusMessage message={error} />}
          <button className="primary-button" type="submit" disabled={pending || otp.length !== 6}>
            {pending ? <LoaderCircle className="spin" size={18} /> : <CheckCircle2 size={18} />}
            Verify
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setFlowId(null);
              setOtp('');
              setError(null);
            }}
          >
            Use another address
          </button>
        </form>
      )}
    </section>
  );
}

function BindSmartAccount({
  apiKey,
  onBound,
}: {
  apiKey: string;
  onBound: (wallet: CustomerWallet) => void;
}) {
  const sdk = useWalletSdk();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = sdk.identity?.smartAccountAddress;

  if (!address) {
    return (
      <section className="setup-panel centered-state">
        <AlertCircle size={28} />
        <h1>Smart Account unavailable</h1>
        <p>This Coinbase account does not have a supported EVM Smart Account.</p>
        <button className="secondary-button" type="button" onClick={sdk.signOut}>
          Sign out
        </button>
      </section>
    );
  }

  const bind = async () => {
    setPending(true);
    setError(null);
    try {
      const accessToken = await sdk.getAccessToken();
      onBound(await bindCustomerWallet(apiKey, accessToken, address));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="setup-panel bind-panel" aria-labelledby="bind-title">
      <div className="section-heading">
        <span className="section-icon">
          <WalletCards size={21} />
        </span>
        <div>
          <p className="eyebrow">Smart Account ready</p>
          <h1 id="bind-title">Connect it to AgentWallet</h1>
        </div>
      </div>
      <dl className="identity-list">
        <div>
          <dt>Network</dt>
          <dd>Base Sepolia</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd className="mono">{compactAddress(address)}</dd>
        </div>
      </dl>
      {error && <StatusMessage message={error} />}
      <button className="primary-button" type="button" onClick={bind} disabled={pending}>
        {pending ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
        Connect Smart Account
      </button>
      <button className="text-button" type="button" onClick={sdk.signOut}>
        Use another Coinbase account
      </button>
    </section>
  );
}

function WalletDashboard({
  apiKey,
  profile,
  wallet,
  onDisconnected,
}: {
  apiKey: string;
  profile: AgentWalletUser;
  wallet: CustomerWallet;
  onDisconnected: () => void;
}) {
  const sdk = useWalletSdk();
  const [copied, setCopied] = useState(false);
  const [allowance, setAllowance] = useState('5');
  const [periodDays, setPeriodDays] = useState('7');
  const [action, setAction] = useState<'create' | 'revoke' | 'disconnect' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executor = wallet.executorAddress?.toLowerCase() as `0x${string}` | undefined;
  const permission = useMemo(
    () => sdk.permissions.find((item) => !item.revoked && item.spender.toLowerCase() === executor),
    [executor, sdk.permissions],
  );
  const networkMismatch = wallet.network !== 'base-sepolia' || wallet.chainId !== 84532;
  const identityMismatch =
    sdk.identity?.smartAccountAddress?.toLowerCase() !== wallet.customerAddress.toLowerCase();

  const copy = async () => {
    await navigator.clipboard.writeText(wallet.customerAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const createPermission = async (event: FormEvent) => {
    event.preventDefault();
    if (!executor) return;
    setAction('create');
    setError(null);
    try {
      const atomic = parseUsdc(allowance);
      if (atomic <= 0n) throw new Error('Allowance must be greater than zero.');
      await sdk.createPermission({
        spender: executor,
        allowanceAtomic: atomic,
        periodInDays: Number(periodDays),
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const revokePermission = async () => {
    if (!permission) return;
    setAction('revoke');
    setError(null);
    try {
      await sdk.revokePermission(permission.permissionHash);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const disconnect = async () => {
    setAction('disconnect');
    setError(null);
    try {
      await disconnectCustomerWallet(apiKey);
      await sdk.signOut();
      onDisconnected();
    } catch (reason) {
      setError(errorMessage(reason));
      setAction(null);
      setConfirmDisconnect(false);
    }
  };

  if (networkMismatch || identityMismatch) {
    return (
      <section className="setup-panel centered-state">
        <AlertCircle size={30} />
        <h1>{networkMismatch ? 'Unsupported network' : 'Wallet identity mismatch'}</h1>
        <p>
          {networkMismatch
            ? 'Only Base Sepolia is enabled.'
            : 'Sign in with the Coinbase wallet already connected to this account.'}
        </p>
        <button className="secondary-button" type="button" onClick={sdk.signOut}>
          Sign out
        </button>
      </section>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-title">
        <div>
          <p className="eyebrow">{profile.email}</p>
          <h1>Crypto wallet</h1>
        </div>
        <span className={`status-chip ${wallet.status === 'ACTIVE' ? 'active' : ''}`}>
          <span /> {wallet.status === 'ACTIVE' ? 'Ready' : 'Setup pending'}
        </span>
      </div>

      <section className="balance-band" aria-labelledby="balance-title">
        <div>
          <p id="balance-title" className="eyebrow">
            Base Sepolia balance
          </p>
          <div className="balance-value">
            {sdk.balancePending ? (
              <LoaderCircle className="spin" size={26} />
            ) : (
              formatUsdc(sdk.balanceAtomic)
            )}
          </div>
          <button className="address-button" type="button" onClick={copy}>
            <span className="mono">{compactAddress(wallet.customerAddress)}</span>
            {copied ? <Check size={16} /> : <Clipboard size={16} />}
          </button>
        </div>
        <div className="balance-actions">
          <a
            className="secondary-button"
            href="https://portal.cdp.coinbase.com/products/faucet"
            target="_blank"
            rel="noreferrer"
          >
            <CircleDollarSign size={18} /> Fund wallet <ExternalLink size={15} />
          </a>
          <a
            className="icon-button"
            href={`https://sepolia.basescan.org/address/${wallet.customerAddress}`}
            target="_blank"
            rel="noreferrer"
            title="View on BaseScan"
          >
            <ExternalLink size={18} />
          </a>
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="data-panel" aria-labelledby="account-details-title">
          <div className="panel-heading">
            <h2 id="account-details-title">Account</h2>
            <Network size={19} />
          </div>
          <dl className="data-list">
            <div>
              <dt>Network</dt>
              <dd>Base Sepolia</dd>
            </div>
            <div>
              <dt>Chain ID</dt>
              <dd>84532</dd>
            </div>
            <div>
              <dt>Smart Account</dt>
              <dd className="mono">{compactAddress(wallet.customerAddress)}</dd>
            </div>
            <div>
              <dt>Executor</dt>
              <dd className="mono">{executor ? compactAddress(executor) : 'Provisioning'}</dd>
            </div>
          </dl>
        </section>

        <section className="data-panel" aria-labelledby="permission-title">
          <div className="panel-heading">
            <h2 id="permission-title">Spend permission</h2>
            <ShieldCheck size={19} />
          </div>
          {!executor ? (
            <div className="empty-state">
              <LoaderCircle className="spin" size={22} />
              <strong>Executor provisioning</strong>
              <span>Permission controls will unlock when the executor is ready.</span>
            </div>
          ) : permission ? (
            <>
              <dl className="data-list">
                <div>
                  <dt>Status</dt>
                  <dd className="positive">Active</dd>
                </div>
                <div>
                  <dt>Allowance</dt>
                  <dd>{formatUsdc(permission.allowanceAtomic)}</dd>
                </div>
                <div>
                  <dt>Period</dt>
                  <dd>{Math.round(permission.periodSeconds / 86_400)} days</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{new Date(permission.end * 1_000).toLocaleDateString()}</dd>
                </div>
              </dl>
              <button
                className="danger-button"
                type="button"
                onClick={revokePermission}
                disabled={action !== null}
              >
                {action === 'revoke' ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Unplug size={17} />
                )}
                Revoke permission
              </button>
            </>
          ) : (
            <form className="permission-form" onSubmit={createPermission}>
              <div className="field-grid">
                <label>
                  Allowance
                  <input
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={allowance}
                    onChange={(event) => setAllowance(event.target.value)}
                    required
                  />
                  <span>USDC</span>
                </label>
                <label>
                  Period
                  <select
                    value={periodDays}
                    onChange={(event) => setPeriodDays(event.target.value)}
                  >
                    <option value="1">1 day</option>
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                  </select>
                </label>
              </div>
              <button className="primary-button" type="submit" disabled={action !== null}>
                {action === 'create' ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <ShieldCheck size={18} />
                )}
                Create permission
              </button>
            </form>
          )}
          {sdk.permissionError && <StatusMessage message={sdk.permissionError} />}
        </section>
      </div>

      {error && <StatusMessage message={error} />}

      <section className="disconnect-band">
        <div>
          <h2>Disconnect wallet</h2>
          <p>Wallet and payment history remain in AgentWallet.</p>
        </div>
        {!confirmDisconnect ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => setConfirmDisconnect(true)}
            disabled={Boolean(permission)}
          >
            <Unplug size={17} /> Disconnect
          </button>
        ) : (
          <div className="confirm-actions">
            <button
              className="text-button"
              type="button"
              onClick={() => setConfirmDisconnect(false)}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={disconnect}
              disabled={action !== null}
            >
              {action === 'disconnect' ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Unplug size={17} />
              )}
              Confirm disconnect
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export function App() {
  const sdk = useWalletSdk();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentWalletUser | null>(null);
  const [storedWallet, setStoredWallet] = useState<CustomerWallet | null>(null);

  const lock = () => {
    setApiKey(null);
    setProfile(null);
    setStoredWallet(null);
  };

  const stage = !profile
    ? 1
    : !sdk.isSignedIn
      ? 2
      : !storedWallet || storedWallet.status === 'CLOSED'
        ? 3
        : 4;

  return (
    <div className="app-shell">
      <AppHeader profile={profile} onLock={lock} />
      <div className="workspace">
        <aside>
          <ProgressRail stage={stage} />
        </aside>
        <main>
          {!profile || !apiKey ? (
            <AgentWalletAccess
              onAuthenticated={(key, user, wallet) => {
                setApiKey(key);
                setProfile(user);
                setStoredWallet(wallet);
              }}
            />
          ) : !sdk.isSignedIn ? (
            <CoinbaseSignIn />
          ) : !storedWallet || storedWallet.status === 'CLOSED' ? (
            <BindSmartAccount apiKey={apiKey} onBound={setStoredWallet} />
          ) : (
            <WalletDashboard
              apiKey={apiKey}
              profile={profile}
              wallet={storedWallet}
              onDisconnected={() => setStoredWallet(null)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
