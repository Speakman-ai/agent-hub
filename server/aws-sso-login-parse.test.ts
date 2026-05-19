import { describe, it, expect } from 'vitest';
import {
  appendAwsSsoUserCodeToUrl,
  extractAwsSsoLoginUrl,
  extractAwsSsoUserCode,
} from './aws-sso-login-parse.js';

describe('extractAwsSsoUserCode', () => {
  it('reads user_code from a query string', () => {
    expect(
      extractAwsSsoUserCode('open https://device.sso.us-east-2.amazonaws.com/?user_code=abcd-1234'),
    ).toBe('ABCD-1234');
  });

  it('reads a code printed on its own line', () => {
    const text = `
https://device.sso.us-east-2.amazonaws.com/

Then enter the code: WXYZ-9876
`;
    expect(extractAwsSsoUserCode(text)).toBe('WXYZ-9876');
  });
});

describe('appendAwsSsoUserCodeToUrl', () => {
  it('appends query param for device.sso URLs', () => {
    expect(
      appendAwsSsoUserCodeToUrl('https://device.sso.us-east-2.amazonaws.com/', 'ABCD-1234'),
    ).toBe('https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234');
  });

  it('appends query param after hash routes for portal device pages', () => {
    expect(
      appendAwsSsoUserCodeToUrl('https://d-9a670b4c46.awsapps.com/start/#/device', 'ABCD-1234'),
    ).toBe('https://d-9a670b4c46.awsapps.com/start/#/device?user_code=ABCD-1234');
  });
});

describe('extractAwsSsoLoginUrl', () => {
  it('combines device SSO URL and separate code into one auto-login link', () => {
    const text = `
Browser will not be automatically opened.
Please visit the following URL:

https://device.sso.us-east-2.amazonaws.com/

Then enter the code: ABCD-1234
`;
    expect(extractAwsSsoLoginUrl(text)).toBe(
      'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234',
    );
  });

  it('keeps an already-complete URL unchanged', () => {
    const text =
      'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234\nThen enter the code: WXYZ-9999\n';
    expect(extractAwsSsoLoginUrl(text)).toBe(
      'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234',
    );
  });

  it('prefers device.sso URLs over portal start URLs when both appear', () => {
    const text = `
sso_start_url = https://d-9a670b4c46.awsapps.com/start/
open https://device.sso.us-east-2.amazonaws.com/
Then enter the code: ABCD-1234
`;
    expect(extractAwsSsoLoginUrl(text)).toBe(
      'https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-1234',
    );
  });

  it('builds portal device URLs with embedded user_code', () => {
    const text = `
https://d-9a670b4c46.awsapps.com/start/#/device

Then enter the code: PQRS-5678
`;
    expect(extractAwsSsoLoginUrl(text)).toBe(
      'https://d-9a670b4c46.awsapps.com/start/#/device?user_code=PQRS-5678',
    );
  });

  it('returns null until a device-flow URL has a user code', () => {
    expect(extractAwsSsoLoginUrl('https://device.sso.us-east-2.amazonaws.com/\n')).toBeNull();
  });
});
