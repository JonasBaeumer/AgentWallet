/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CDP_PROJECT_ID?: string;
  readonly VITE_CDP_MOCK?: string;
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
