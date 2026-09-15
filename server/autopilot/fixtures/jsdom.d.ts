// Minimal ambient declaration for the `jsdom` root devDependency, used only by
// the Autopilot browser-journey fixture. jsdom ships no types and the server
// tsconfig does not include the DOM lib, so the window is intentionally loose.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: any;
  }
}
