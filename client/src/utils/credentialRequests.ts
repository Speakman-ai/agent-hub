const CREDENTIAL_FENCE_RE = /```agenthub:credential-request\s*\n?([\s\S]*?)\n?```/g;

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface CredentialRequestField {
  key: string;
  label: string;
  type: 'text' | 'username' | 'password';
}

export interface CredentialRequestBlock {
  requestId: string;
  service: string;
  purpose: string;
  fields: CredentialRequestField[];
  ttlSeconds?: number;
}

export interface CredentialRequestExtraction {
  strippedText: string;
  requests: CredentialRequestBlock[];
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cleanText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, max);
}

function parseField(raw: unknown): CredentialRequestField | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as { key?: unknown; label?: unknown; type?: unknown };
  const key = cleanText(item.key, '', 64);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return null;
  const type =
    item.type === 'username' || item.type === 'password' || item.type === 'text'
      ? item.type
      : 'text';
  return {
    key,
    label: cleanText(item.label, key, 80),
    type,
  };
}

export function parseCredentialRequestEnvelope(raw: string): CredentialRequestBlock | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const service = cleanText(parsed.service, 'Credential request', 120);
  const purpose = cleanText(parsed.purpose, 'Sign in for this session', 240);
  const requestIdRaw = cleanText(parsed.requestId, `cred-${simpleHash(raw)}`, 128);
  const requestId = REQUEST_ID_RE.test(requestIdRaw) ? requestIdRaw : `cred-${simpleHash(raw)}`;
  const rawFields = Array.isArray(parsed.fields) ? parsed.fields : null;
  if (!rawFields || rawFields.length === 0 || rawFields.length > 6) return null;
  const fields = rawFields.map(parseField).filter(Boolean) as CredentialRequestField[];
  if (fields.length !== rawFields.length) return null;
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) return null;
    seen.add(field.key);
  }
  const ttlSeconds =
    typeof parsed.ttlSeconds === 'number' && Number.isFinite(parsed.ttlSeconds)
      ? Math.max(1, Math.min(Math.floor(parsed.ttlSeconds), 3600))
      : undefined;
  return ttlSeconds
    ? { requestId, service, purpose, fields, ttlSeconds }
    : { requestId, service, purpose, fields };
}

export function extractCredentialRequestBlocks(text: string): CredentialRequestExtraction {
  if (!text || !text.includes('agenthub:credential-request')) {
    return { strippedText: text, requests: [] };
  }
  const requests: CredentialRequestBlock[] = [];
  const replacements: Array<{ start: number; end: number }> = [];
  CREDENTIAL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREDENTIAL_FENCE_RE.exec(text)) !== null) {
    const request = parseCredentialRequestEnvelope(match[1]?.trim() ?? '');
    if (!request) continue;
    requests.push(request);
    replacements.push({ start: match.index, end: match.index + match[0].length });
  }
  let strippedText = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    strippedText = strippedText.slice(0, r.start) + strippedText.slice(r.end);
  }
  return {
    strippedText: strippedText.replace(/\n{3,}/g, '\n\n').trim(),
    requests,
  };
}
