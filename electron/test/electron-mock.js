/**
 * Minimal mock of the 'electron' module for Vitest.
 * Only stubs the APIs used by notifications.js.
 */

export class Notification {
  constructor(options) {
    this.options = options;
    this._handlers = {};
  }

  static isSupported() {
    return true;
  }

  on(event, handler) {
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
