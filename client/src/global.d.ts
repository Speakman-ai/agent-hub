/** Electron preload bridge (see electron/preload). */
interface ElectronAPI {
  isElectron?: boolean;
  getConnectionConfig?: (...args: any[]) => any;
  saveConnectionConfig?: (...args: any[]) => any;
  saveAuthToken?: (...args: any[]) => any;
  navigateToOrg?: (...args: any[]) => any;
  selectDirectory?: (...args: any[]) => any;
  onDesktopUpdateAvailable?: (...args: any[]) => any;
  checkForDesktopUpdate?: (...args: any[]) => any;
  getDesktopUpdateHealth?: (...args: any[]) => any;
  showNotification?: (...args: any[]) => any;
  [key: string]: any;
}

/** Vitest mock surface on spied/mocked functions. */
interface MockCallRecord {
  calls: unknown[][];
  results: { type: string; value: unknown }[];
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }

  var __TEST__: Record<string, unknown> | undefined;

  interface GlobalThis {
    [key: string]: any;
  }
}

export {};
