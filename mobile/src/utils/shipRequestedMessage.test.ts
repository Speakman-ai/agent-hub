import { describe, expect, it } from 'vitest';
import { parseShipRequestedMetadata, shipRequestedCopy } from './shipRequestedMessage';

describe('shipRequestedCopy', () => {
  it('describes an automatic ship', () => {
    const meta = parseShipRequestedMetadata(JSON.stringify({ kind: 'ship_requested', auto: true }));
    expect(shipRequestedCopy(meta).title).toBe('Shipping automatically');
  });

  it('never mentions the retired Create ticket & PR flow', () => {
    const meta = parseShipRequestedMetadata(JSON.stringify({ kind: 'ship_requested' }));
    const copy = shipRequestedCopy(meta);
    expect(copy.title).toBe('Ship requested');
    expect(`${copy.title} ${copy.body}`).not.toMatch(/ticket/i);
  });
});
