import { stripAnsi } from './ansi-strip.js';

/**
 * Extract the device-authorization URL from `aws sso login --no-browser` output.
 */
export function extractAwsSsoLoginUrl(text: string): string | null {
  const plain = stripAnsi(text);
  const candidates = plain.match(/https:\/\/[^\s)\]"']+/g) ?? [];
  for (const url of candidates) {
    const u = url.replace(/[.,;:]+$/, '');
    if (u.includes('device.sso.') || u.includes('awsapps.com') || u.includes('amazonaws.com')) {
      return u;
    }
  }
  return candidates[0]?.replace(/[.,;:]+$/, '') ?? null;
}
