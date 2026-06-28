import { describe, expect, it } from 'vitest';
import { sessionControlAppIcon } from './sessionControlIcons';

describe('sessionControlAppIcon', () => {
  it('maps Consult to the mobile AppIcon singular chat bubble name', () => {
    const iconName = sessionControlAppIcon('consult');

    expect(iconName).toBe('chatbubble-outline');
  });
});
