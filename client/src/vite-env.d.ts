/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PORT: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_GIT_HASH: string;
  readonly VITE_DESKTOP_UPDATE_CHECK_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
