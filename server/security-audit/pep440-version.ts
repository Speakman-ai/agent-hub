interface Pep440Version {
  epoch: number;
  release: number[];
  pre: { phase: 'a' | 'b' | 'rc'; number: number } | null;
  post: number | null;
  dev: number | null;
  local: string[];
}

const PEP440_RE =
  /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[._-]?(a|alpha|b|beta|rc|c|pre|preview)[._-]?(\d*)?)?(?:(?:[._-]?(?:post|rev|r)[._-]?(\d*)?)|(?:-(\d+)))?(?:[._-]?dev[._-]?(\d*)?)?(?:\+([a-z0-9]+(?:[._-][a-z0-9]+)*))?$/i;

function parseOptionalNumber(raw: string | undefined): number {
  return raw ? Number(raw) : 0;
}

function normalizePrePhase(raw: string): 'a' | 'b' | 'rc' {
  const phase = raw.toLowerCase();
  if (phase === 'a' || phase === 'alpha') return 'a';
  if (phase === 'b' || phase === 'beta') return 'b';
  return 'rc';
}

export function parsePep440Version(input: string): Pep440Version | null {
  if (typeof input !== 'string') return null;
  const match = input.trim().match(PEP440_RE);
  if (!match) return null;

  return {
    epoch: Number(match[1] ?? 0),
    release: match[2].split('.').map((part) => Number(part)),
    pre: match[3]
      ? {
          phase: normalizePrePhase(match[3]),
          number: parseOptionalNumber(match[4]),
        }
      : null,
    post:
      match[5] !== undefined || match[6] !== undefined
        ? parseOptionalNumber(match[5] ?? match[6])
        : null,
    dev: match[7] !== undefined ? parseOptionalNumber(match[7]) : null,
    local: match[8] ? match[8].toLowerCase().split(/[._-]/) : [],
  };
}

export function isValidPep440Version(input: string): boolean {
  return parsePep440Version(input) !== null;
}

function compareNumber(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareRelease(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = compareNumber(a[i] ?? 0, b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareOptionalNumber(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareNumber(a, b);
}

function preRank(phase: 'a' | 'b' | 'rc'): number {
  switch (phase) {
    case 'a':
      return 0;
    case 'b':
      return 1;
    case 'rc':
      return 2;
  }
}

function baseStage(version: Pep440Version): number {
  if (version.pre) return preRank(version.pre.phase);
  if (version.dev !== null && version.post === null) return -1;
  if (version.post !== null) return 4;
  return 3;
}

function compareBaseStage(a: Pep440Version, b: Pep440Version): number {
  const stageDiff = compareNumber(baseStage(a), baseStage(b));
  if (stageDiff !== 0) return stageDiff;

  if (a.pre && b.pre) {
    const preDiff = compareNumber(a.pre.number, b.pre.number);
    if (preDiff !== 0) return preDiff;
    return compareOptionalNumber(a.dev, b.dev);
  }

  if (a.post !== null && b.post !== null) {
    const postDiff = compareNumber(a.post, b.post);
    if (postDiff !== 0) return postDiff;
    return compareOptionalNumber(a.dev, b.dev);
  }

  if (a.dev !== null || b.dev !== null) {
    return compareOptionalNumber(a.dev, b.dev);
  }

  return 0;
}

function compareNumericIdentifier(a: string, b: string): number {
  const na = a.replace(/^0+/, '') || '0';
  const nb = b.replace(/^0+/, '') || '0';
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

function compareLocal(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return -1;
  if (b.length === 0) return 1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const diff = compareNumericIdentifier(ai, bi);
      if (diff !== 0) return diff;
    } else if (an !== bn) {
      return an ? 1 : -1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }

  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function comparePep440Versions(a: string, b: string): number {
  const pa = parsePep440Version(a);
  const pb = parsePep440Version(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;

  const epochDiff = compareNumber(pa.epoch, pb.epoch);
  if (epochDiff !== 0) return epochDiff;

  const releaseDiff = compareRelease(pa.release, pb.release);
  if (releaseDiff !== 0) return releaseDiff;

  const stageDiff = compareBaseStage(pa, pb);
  if (stageDiff !== 0) return stageDiff;

  return compareLocal(pa.local, pb.local);
}
