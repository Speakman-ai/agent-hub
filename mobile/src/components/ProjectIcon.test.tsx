// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { expect, it, vi } from 'vitest';

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: { testID?: string }) => (
    <span data-testid={props.testID} data-icon={name}>
      {name}
    </span>
  );
  return {
    Folder: icon('Folder'),
  };
});

import ProjectIcon from './ProjectIcon';

it('always renders the folder icon', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  flushSync(() => root.render(<ProjectIcon project={{ icon: 'Rocket', color: '#ff0000' }} />));
  expect(container.querySelector('[data-icon="Folder"]')).toBeTruthy();
  flushSync(() => root.render(<ProjectIcon project={{ icon: null, color: '#ff0000' }} />));
  expect(container.querySelector('[data-icon="Folder"]')).toBeTruthy();
  flushSync(() => root.unmount());
});
