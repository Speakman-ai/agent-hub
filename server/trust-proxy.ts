/**
 * Express `trust proxy` for TRUST_PROXY (e.g. 1 = one hop, AWS ALB).
 * Empty / 0 => only trust loopback.
 */
export function trustProxyValueFromEnv(env: NodeJS.ProcessEnv = process.env): number | 'loopback' {
  const t = (env.TRUST_PROXY || '').trim();
  if (t === '' || t === '0') {
    return 'loopback';
  }
  if (t === '1' || t === 'true' || t === 'yes') {
    return 1;
  }
  if (/^\d+$/.test(t)) {
    const n = Math.min(32, Math.max(0, parseInt(t, 10)));
    if (n <= 0) {
      return 'loopback';
    }
    return n;
  }
  return 'loopback';
}
