import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OrganizationMenu from './OrganizationMenu';

const options = [
  { id: 'org-1', name: 'Group 1' },
  { id: 'org-2', name: 'Menu check' },
  { id: 'independent', name: 'Independent', independent: true },
];

describe('OrganizationMenu', () => {
  it('filters options as you type and selects with Enter', () => {
    const onSelect = vi.fn();
    render(
      <OrganizationMenu
        options={options}
        selectedId="org-1"
        onSelect={onSelect}
        testId="org-switch"
      />,
    );

    fireEvent.click(screen.getByTestId('org-switch'));
    const search = screen.getByTestId('org-switch-search');
    expect(screen.getByRole('option', { name: 'Independent' })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'menu' } });
    expect(screen.getByRole('option', { name: 'Menu check' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Group 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Independent' })).not.toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('org-2');
    expect(screen.queryByTestId('org-switch-search')).not.toBeInTheDocument();
  });

  it('says when nothing matches', () => {
    render(<OrganizationMenu options={options} selectedId="org-1" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Organization'));
    fireEvent.change(screen.getByLabelText('Search organizations'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('runs the manage action from the open menu and closes it', () => {
    const onManage = vi.fn();
    render(
      <OrganizationMenu
        options={options}
        selectedId="org-1"
        onSelect={vi.fn()}
        testId="org-switch"
        manageLabel="Manage organizations"
        onManage={onManage}
      />,
    );
    fireEvent.click(screen.getByTestId('org-switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Manage organizations' }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('org-switch-search')).not.toBeInTheDocument();
  });

  it('omits the manage row without an action', () => {
    render(<OrganizationMenu options={options} selectedId="org-1" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Organization'));
    expect(screen.queryByTestId('organization-menu-manage')).not.toBeInTheDocument();
  });
});
