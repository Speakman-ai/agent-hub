/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PORT: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_GIT_HASH: string;
  readonly VITE_DESKTOP_UPDATE_CHECK_URL: string;
  // Vendor control-plane endpoints — unset for self-hosted builds (no phone-home).
  readonly VITE_BUG_REPORT_ENDPOINT: string;
  readonly VITE_REPLAY_INGEST_ENDPOINT: string;
  readonly VITE_RELEASE_BUCKET_BASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
