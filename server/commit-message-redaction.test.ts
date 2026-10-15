import { describe, expect, it } from 'vitest';
import { actorForTrailer, parseRedactionTerms, redactTerms } from './commit-message-redaction.js';

describe('commit message redaction', () => {
  const terms = parseRedactionTerms('Widget Corp=>Acme; secretco=>Example');

  it('parses FROM=>TO pairs and drops malformed ones', () => {
    expect(terms).toEqual([
      { from: 'Widget Corp', to: 'Acme' },
      { from: 'secretco', to: 'Example' },
    ]);
    expect(parseRedactionTerms('noarrow; =>x; a=>b=>c')).toEqual([]);
    expect(parseRedactionTerms(null)).toEqual([]);
  });

  it('matches across casing and separators, preserving case', () => {
    expect(redactTerms('Widget Corp, widget-corp, WIDGET_CORP, widgetcorp', terms)).toBe(
      'Acme, acme, ACME, acme',
    );
    expect(redactTerms('the Widget\n * Corp app', terms)).toBe('the Acme app');
    expect(redactTerms('https://hub.secretco.io/x', terms)).toBe('https://hub.example.io/x');
  });

  it('leaves text alone with no terms', () => {
    expect(redactTerms('Widget Corp', [])).toBe('Widget Corp');
  });

  it('strips the mail domain from the merge actor', () => {
    expect(actorForTrailer('someone@private.example')).toBe('someone');
    expect(actorForTrailer('u1')).toBe('u1');
  });
});
