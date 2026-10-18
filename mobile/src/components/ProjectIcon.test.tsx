// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Text: ({ children, style }: any) => <span style={style}>{children}</span>,
  View: ({ style }: any) => <div style={Object.assign({}, ...style.filter(Boolean))} />,
}));
import ProjectIcon from './ProjectIcon';

it('renders the full symbol and falls back to the project color when cleared', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  flushSync(() => root.render(<ProjectIcon project={{ icon: '👩🏽‍💻', color: '#ff0000' }} />));
  expect(container.textContent).toBe('👩🏽‍💻');
  flushSync(() => root.render(<ProjectIcon project={{ icon: null, color: '#ff0000' }} />));
  expect(container.textContent).toBe('');
  expect((container.firstChild as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)');
  flushSync(() => root.unmount());
});
