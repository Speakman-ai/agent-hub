import { stripAnsi } from './ansi-strip.js';

/** AWS IAM Identity Center device codes are typically `ABCD-1234`. */
const USER_CODE_PATTERN = '[A-Z0-9]{4}-[A-Z0-9]{4}';

/**
 * Extract the device user code from `aws sso login --no-browser` output.
 */
export function extractAwsSsoUserCode(text: string): string | null {
  const plain = stripAnsi(text);
  const fromUrl = plain.match(new RegExp(`[?&#]user_code=(${USER_CODE_PATTERN})`, 'i'))?.[1];
  if (fromUrl) return fromUrl.toUpperCase();

  const enterCode = plain.match(
    new RegExp(
      `(?:enter|type|use)\\s+(?:the\\s+)?(?:verification\\s+)?code[:\\s]+(${USER_CODE_PATTERN})`,
      'i',
    ),
  )?.[1];
  if (enterCode) return enterCode.toUpperCase();

  const lineCode = plain.match(new RegExp(`^\\s*(${USER_CODE_PATTERN})\\s*$`, 'im'))?.[1];
  if (lineCode) return lineCode.toUpperCase();

  return null;
}

/**
 * Append `user_code` to a device-authorization URL when the CLI prints them separately.
 */
export function appendAwsSsoUserCodeToUrl(url: string, userCode: string): string {
  if (/[?&#]user_code=/i.test(url)) return url;
  const encoded = encodeURIComponent(userCode);
  if (url.includes('#')) {
    const hash = url.slice(url.indexOf('#') + 1);
    if (hash.includes('?')) {
      return `${url}&user_code=${encoded}`;
    }
    return `${url}?user_code=${encoded}`;
  }
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}user_code=${encoded}`;
}

function scoreAwsSsoLoginUrl(url: string): number {
  let score = 0;
  if (/[?&#]user_code=/i.test(url)) score += 100;
  if (url.includes('device.sso.')) score += 50;
  if (url.includes('/device') || url.includes('#/device')) score += 40;
  if (url.includes('awsapps.com')) score += 10;
  return score;
}

function isAwsSsoLoginUrlCandidate(url: string): boolean {
  return (
    url.includes('device.sso.') ||
    url.includes('awsapps.com') ||
    (url.includes('amazonaws.com') && url.includes('sso'))
  );
}

function needsUserCodeForDeviceFlow(url: string): boolean {
  return url.includes('device.sso.') || url.includes('/device') || url.includes('#/device');
}

/**
 * Extract the device-authorization URL from `aws sso login --no-browser` output.
 * When the CLI prints the URL and code separately, returns a single URL with
 * `user_code` embedded so opening it completes sign-in without manual entry.
 */
export function extractAwsSsoLoginUrl(text: string): string | null {
  const plain = stripAnsi(text);
  const userCode = extractAwsSsoUserCode(plain);
  const candidates = (plain.match(/https:\/\/[^\s)\]"']+/g) ?? []).map((u) =>
    u.replace(/[.,;:]+$/, ''),
  );
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => scoreAwsSsoLoginUrl(b) - scoreAwsSsoLoginUrl(a));
  const best =
    sorted.find((u) => isAwsSsoLoginUrlCandidate(u)) ?? sorted[0]?.replace(/[.,;:]+$/, '');
  if (!best) return null;

  if (/[?&#]user_code=/i.test(best)) return best;
  if (userCode) return appendAwsSsoUserCodeToUrl(best, userCode);
  if (needsUserCodeForDeviceFlow(best)) return null;
  return best;
}
