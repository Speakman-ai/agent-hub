/**
 * Minimal mock of the 'electron' module for Vitest.
 * Only stubs the APIs used by notifications.ts.
 */

export class Notification {
  options: unknown;
  _handlers: Record<string, (...args: unknown[]) => void>;

  constructor(options: unknown) {
    this.options = options;
    this._handlers = {};
  }

  static isSupported() {
    return true;
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    this._handlers[event] = handler;
    return this;
  }

  show() {}
}

export const app = {
  getPath: () => '/tmp/electron-test',
};

export const nativeImage = {
  createFromPath: () => ({}),
};

export default { Notification, app, nativeImage };
