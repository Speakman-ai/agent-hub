import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShortcutsHelpModal from './ShortcutsHelpModal.jsx';

const shortcuts = [
  {
    id: 'test-action',
    label: 'Test action',
    description: 'Run the test action',
    binding: 'Mod+Shift+N',
    group: 'Create',
  },
  {
    id: 'show-help',
    label: 'Show help',
    binding: '?',
    group: 'Help',
  },
];

describe('ShortcutsHelpModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ShortcutsHelpModal isOpen={false} onClose={() => {}} shortcuts={shortcuts} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the list of shortcuts when open', () => {
    render(<ShortcutsHelpModal isOpen={true} onClose={() => {}} shortcuts={shortcuts} />);
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
    expect(screen.getByText('Test action')).toBeInTheDocument();
    expect(screen.getByText('Show help')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelpModal isOpen={true} onClose={onClose} shortcuts={shortcuts} />);
    // The backdrop is the parent of the dialog panel; click outside the panel.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog.parentElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside the panel', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelpModal isOpen={true} onClose={onClose} shortcuts={shortcuts} />);
    fireEvent.click(screen.getByText('Test action'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelpModal isOpen={true} onClose={onClose} shortcuts={shortcuts} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
