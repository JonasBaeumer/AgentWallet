export type StepStatus = 'pass' | 'fail' | 'skip' | 'warn';

export interface StepResult {
  name: string;
  status: StepStatus;
  message: string;
}

export interface SetupContext {
  nonInteractive: boolean;
  os: 'darwin' | 'linux';
  hasBrew: boolean;
  hasApt: boolean;
  results: StepResult[];
  envPath: string;
  envVars: Record<string, string>;
  skipTelegram: boolean;
  generatedApiKey: string | null;
  /** Services that were auto-launched during Phase 8 */
  launchedServices: Set<string>;
}
