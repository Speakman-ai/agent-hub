import { describe, it, expect } from 'vitest';
import {
  extractCodexDeviceUrl,
  extractCodexDeviceUserCode,
  computeCodexUiStatus,
} from './codex-device-auth-parse.js';

const sampleDeviceOutput = `
Welcome to Codex [v0.122.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m

2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m
   \x1b[94mUYG9-Q1Q9N\x1b[0m

Device codes are a common phishing target. Never share this code.
`;

describe('extractCodexDeviceUrl', () => {
  it('parses the device verification URL with ANSI stripped', () => {
    expect(extractCodexDeviceUrl(sampleDeviceOutput)).toBe('https://auth.openai.com/codex/device');
  });
});

describe('extractCodexDeviceUserCode', () => {
  it('parses the one-time device code with ANSI stripped', () => {
    expect(extractCodexDeviceUserCode(sampleDeviceOutput)).toBe('UYG9-Q1Q9N');
  });
});

describe('computeCodexUiStatus', () => {
  it('returns missing when binary absent', () => {
    expect(
      computeCodexUiStatus({
        binaryPresent: false,
        loginInProgress: false,
        apiKeyConfigured: false,
        chatgptOAuthFromFile: false,
        cliApiKeyFromFile: false,
      }),
    ).toBe('missing');
  });

  it('returns pending during device login', () => {
    expect(
      computeCodexUiStatus({
        binaryPresent: true,
        loginInProgress: true,
        apiKeyConfigured: false,
        chatgptOAuthFromFile: false,
        cliApiKeyFromFile: false,
      }),
    ).toBe('pending');
  });

  it('returns authenticated when API key is configured', () => {
    expect(
      computeCodexUiStatus({
        binaryPresent: true,
        loginInProgress: false,
        apiKeyConfigured: true,
        chatgptOAuthFromFile: false,
        cliApiKeyFromFile: false,
      }),
    ).toBe('authenticated');
  });

  it('returns authenticated when ChatGPT OAuth cache exists', () => {
    expect(
      computeCodexUiStatus({
        binaryPresent: true,
        loginInProgress: false,
        apiKeyConfigured: false,
        chatgptOAuthFromFile: true,
        cliApiKeyFromFile: false,
      }),
    ).toBe('authenticated');
  });

  it('returns authenticated when only CLI-persisted API key exists in auth.json', () => {
    expect(
      computeCodexUiStatus({
        binaryPresent: true,
        loginInProgress: false,
        apiKeyConfigured: false,
        chatgptOAuthFromFile: false,
        cliApiKeyFromFile: true,
      }),
    ).toBe('authenticated');
  });
});
