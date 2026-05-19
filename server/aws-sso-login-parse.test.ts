import { describe, it, expect } from 'vitest';
import { extractAwsSsoLoginUrl } from './aws-sso-login-parse.js';

describe('extractAwsSsoLoginUrl', () => {
  it('extracts device SSO URL from typical aws output', () => {
    const text = `
Browser will not be automatically opened.
Please visit the following URL:

https://device.sso.us-east-2.amazonaws.com/

Then enter the code: ABCD-1234
`;
    expect(extractAwsSsoLoginUrl(text)).toBe('https://device.sso.us-east-2.amazonaws.com/');
  });
});
