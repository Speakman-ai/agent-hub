import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DevServerSection from './DevServerSection';
import { api } from '../utils/api';
import { SECRET_MASK } from '../utils/devServerConfig';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectSecrets: vi.fn(),
    putProjectSecrets: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const project = {
  id: 'proj-1',
  name: 'Demo',
  cwd: '/tmp/demo',
  prEnv: {
    preview: { enabled: true, compose: { entryService: 'web', entryPort: 3000 } },
    devServer: {
      startCommand: 'pnpm dev',
      env: { API_URL: 'http://localhost:4000' },
      secretKeys: ['STRIPE_KEY'],
      portMap: [{ internalPort: 3000, label: 'web', primary: true }],
    },
  },
};

describe('DevServerSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getProjectSecrets as any).mockResolvedValue({
      secrets: [{ key: 'STRIPE_KEY', kind: 'secret' }],
    });
    (api.putProjectSecrets as any).mockResolvedValue({});
    (api.updateProject as any).mockResolvedValue({});
  });

  it('renders saved config into the form fields', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() =>
      expect((screen.getByTestId('dev-server-start-command') as HTMLInputElement).value).toBe(
        'pnpm dev',
      ),
    );
    expect(screen.getByTestId('dev-server-env-section')).toBeInTheDocument();
    expect(screen.getByTestId('dev-server-secrets-section')).toBeInTheDocument();
    expect(screen.getByTestId('dev-server-ports-section')).toBeInTheDocument();
  });

  it('masks a stored secret — value input is empty with a masked placeholder', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-row')).toBeInTheDocument());
    const secretInput = screen.getByTestId('dev-server-secret-value') as HTMLInputElement;
    // Write-only: no plaintext ever populates the field.
    expect(secretInput.value).toBe('');
    expect(secretInput.type).toBe('password');
    expect(secretInput.placeholder).toContain('••••••••');
    // The status marker reflects the stored secret.
    expect(screen.getByTestId('dev-server-secret-status').textContent).toContain('set');
  });

  it('saves the dev-server config payload without round-tripping the stored secret', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() =>
      expect((screen.getByTestId('dev-server-start-command') as HTMLInputElement).value).toBe(
        'pnpm dev',
      ),
    );

    fireEvent.change(screen.getByTestId('dev-server-start-command'), {
      target: { value: 'pnpm start' },
    });
    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));

    // The stored secret was untouched → no secrets PUT (nothing to write).
    expect(api.putProjectSecrets).not.toHaveBeenCalled();

    const [pid, body] = (api.updateProject as any).mock.calls[0];
    expect(pid).toBe('proj-1');
    expect(body.prEnv.devServer).toEqual({
      startCommand: 'pnpm start',
      env: { API_URL: 'http://localhost:4000' },
      secretKeys: ['STRIPE_KEY'],
      portMap: [{ internalPort: 3000, label: 'web', primary: true }],
    });
    // Sibling prEnv config (preview) is preserved through the PATCH.
    expect(body.prEnv.preview).toBeDefined();
  });

  it('keeps the just-saved edits in the form (no revert from the stale project prop)', async () => {
    render(<DevServerSection projects={[project]} />);
    const startInput = () => screen.getByTestId('dev-server-start-command') as HTMLInputElement;
    await waitFor(() => expect(startInput().value).toBe('pnpm dev'));

    fireEvent.change(startInput(), { target: { value: 'pnpm start' } });
    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
    // The form is re-derived from the saved payload, not a reload that reads
    // the stale (pre-save) project prop — so the edit survives.
    await waitFor(() => expect(screen.getByTestId('dev-server-saved')).toBeInTheDocument());
    expect(startInput().value).toBe('pnpm start');
  });

  it('flips a freshly saved secret reference to the stored/masked state and clears its input', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-add')).toBeInTheDocument());

    // Add a brand-new secret with a typed value.
    fireEvent.click(screen.getByTestId('dev-server-secret-add'));
    const keyInputs = screen.getAllByLabelText('secret key') as HTMLInputElement[];
    const valueInputs = screen.getAllByLabelText('secret value') as HTMLInputElement[];
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'NEW_TOKEN' } });
    fireEvent.change(valueInputs[valueInputs.length - 1], { target: { value: 'tok_123' } });

    fireEvent.click(screen.getByTestId('dev-server-save'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));

    // After save the new secret renders as stored (masked, value cleared).
    await waitFor(() => {
      const statuses = screen.getAllByTestId('dev-server-secret-status');
      expect(statuses.every((s) => s.textContent?.includes('set'))).toBe(true);
    });
    const valuesAfter = screen.getAllByLabelText('secret value') as HTMLInputElement[];
    expect(valuesAfter.every((v) => v.value === '')).toBe(true);
  });

  it('writes a freshly typed secret value (write-only) and MASKs the untouched one', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-value')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('dev-server-secret-value'), {
      target: { value: 'sk_live_new' },
    });
    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(api.putProjectSecrets).toHaveBeenCalledTimes(1));
    const [, secretsPayload] = (api.putProjectSecrets as any).mock.calls[0];
    expect(secretsPayload).toContainEqual({
      key: 'STRIPE_KEY',
      value: 'sk_live_new',
      kind: 'secret',
    });
    // No masked duplicate for the same key.
    expect(secretsPayload.filter((s: any) => s.key === 'STRIPE_KEY')).toHaveLength(1);
    // Config PATCH still fires.
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
  });

  it('blocks save when a stored secret is renamed to a new key with a blank value', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-value')).toBeInTheDocument());
    // STRIPE_KEY loads as stored (masked). Rename it to a key with no stored
    // secret and leave the value blank.
    const keyInput = screen.getByLabelText('secret key') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'NEW_KEY' } });

    // The status marker must flip to "not stored" once the key changes.
    await waitFor(() =>
      expect(screen.getByTestId('dev-server-secret-status').textContent).not.toContain('set'),
    );

    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(screen.getByTestId('dev-server-error')).toBeInTheDocument());
    expect(screen.getByTestId('dev-server-error').textContent).toMatch(/Enter a value/);
    // No dangling reference saved.
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
  });

  it('re-marks a secret as stored when its key is renamed back to an existing stored key', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-value')).toBeInTheDocument());
    const keyInput = screen.getByLabelText('secret key') as HTMLInputElement;
    // Rename away, then back to the stored key.
    fireEvent.change(keyInput, { target: { value: 'NEW_KEY' } });
    fireEvent.change(keyInput, { target: { value: 'STRIPE_KEY' } });
    await waitFor(() =>
      expect(screen.getByTestId('dev-server-secret-status').textContent).toContain('set'),
    );
    // Saving with a blank value is allowed again (stored value kept).
    fireEvent.click(screen.getByTestId('dev-server-save'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
  });

  it('blocks save when a new secret reference has a blank value', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-add')).toBeInTheDocument());

    // Add a new secret row with a key but no value.
    fireEvent.click(screen.getByTestId('dev-server-secret-add'));
    const keyInputs = screen.getAllByLabelText('secret key') as HTMLInputElement[];
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'NEW_SECRET' } });

    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(screen.getByTestId('dev-server-error')).toBeInTheDocument());
    expect(screen.getByTestId('dev-server-error').textContent).toMatch(/Enter a value/);
    // Neither the config PATCH nor the secrets PUT should fire — no dangling ref.
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
  });

  it('blocks saving when the project secrets fail to load (no clobbering full-replace PUT)', async () => {
    (api.getProjectSecrets as any).mockRejectedValueOnce(new Error('network down'));
    render(<DevServerSection projects={[project]} />);

    // The load error is surfaced, not swallowed to an empty list.
    await waitFor(() => expect(screen.getByTestId('dev-server-error')).toBeInTheDocument());
    expect(screen.getByTestId('dev-server-error').textContent).toMatch(/Could not load/);

    // Save is disabled, and even forcing the handler makes no write calls.
    const saveBtn = screen.getByTestId('dev-server-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.click(saveBtn);
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('re-enables saving after a successful secrets reload', async () => {
    (api.getProjectSecrets as any)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ secrets: [{ key: 'STRIPE_KEY', kind: 'secret' }] });
    render(<DevServerSection projects={[project]} />);
    await waitFor(() =>
      expect((screen.getByTestId('dev-server-save') as HTMLButtonElement).disabled).toBe(true),
    );

    fireEvent.click(screen.getByTestId('dev-server-reload'));
    await waitFor(() =>
      expect((screen.getByTestId('dev-server-save') as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(screen.getByTestId('dev-server-save'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
  });

  it('rolls back written secrets when the config PATCH fails after the secrets PUT', async () => {
    (api.updateProject as any).mockRejectedValueOnce(new Error('boom'));
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-secret-value')).toBeInTheDocument());

    // Add a brand-new secret with a typed value, then save.
    fireEvent.click(screen.getByTestId('dev-server-secret-add'));
    const keyInputs = screen.getAllByLabelText('secret key') as HTMLInputElement[];
    const valueInputs = screen.getAllByLabelText('secret value') as HTMLInputElement[];
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'NEW_TOKEN' } });
    fireEvent.change(valueInputs[valueInputs.length - 1], { target: { value: 'tok_123' } });

    fireEvent.click(screen.getByTestId('dev-server-save'));

    // Error surfaced, and the secrets store is compensated.
    await waitFor(() => expect(screen.getByTestId('dev-server-error')).toBeInTheDocument());
    // First PUT writes the new secret; second PUT restores the pre-save snapshot.
    await waitFor(() => expect(api.putProjectSecrets).toHaveBeenCalledTimes(2));
    const [, rollbackPayload] = (api.putProjectSecrets as any).mock.calls[1];
    // The just-written NEW_TOKEN is dropped; the pre-existing STRIPE_KEY is kept (masked).
    expect(rollbackPayload).toEqual([{ key: 'STRIPE_KEY', value: SECRET_MASK, kind: 'secret' }]);
    expect(rollbackPayload.some((s: any) => s.key === 'NEW_TOKEN')).toBe(false);
  });

  it('does not roll back secrets when nothing new was written', async () => {
    (api.updateProject as any).mockRejectedValueOnce(new Error('boom'));
    render(<DevServerSection projects={[project]} />);
    await waitFor(() =>
      expect((screen.getByTestId('dev-server-start-command') as HTMLInputElement).value).toBe(
        'pnpm dev',
      ),
    );
    // Config-only edit (no secret typed) → PATCH fails → no secrets PUT at all.
    fireEvent.change(screen.getByTestId('dev-server-start-command'), {
      target: { value: 'pnpm start' },
    });
    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(screen.getByTestId('dev-server-error')).toBeInTheDocument());
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
  });

  it('blocks save and shows a validation error for an invalid port', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-port-row')).toBeInTheDocument());

    const portInput = screen.getByLabelText('internal port') as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: '70000' } });
    fireEvent.click(screen.getByTestId('dev-server-save'));

    await waitFor(() => expect(screen.getByTestId('dev-server-error')).toBeInTheDocument());
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.putProjectSecrets).not.toHaveBeenCalled();
  });

  it('keeps only one primary port when a second is selected', async () => {
    render(<DevServerSection projects={[project]} />);
    await waitFor(() => expect(screen.getByTestId('dev-server-port-add')).toBeInTheDocument());

    // Add a second port and mark it primary.
    fireEvent.click(screen.getByTestId('dev-server-port-add'));
    const rows = screen.getAllByTestId('dev-server-port-row');
    const secondRow = rows[1];
    fireEvent.change(secondRow.querySelector('input[type="number"]')!, {
      target: { value: '4000' },
    });
    fireEvent.change(secondRow.querySelector('input[type="text"]')!, { target: { value: 'api' } });
    const primaryRadios = screen.getAllByLabelText('primary port') as HTMLInputElement[];
    fireEvent.click(primaryRadios[1]);

    fireEvent.click(screen.getByTestId('dev-server-save'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(1));
    const [, body] = (api.updateProject as any).mock.calls[0];
    const primaries = body.prEnv.devServer.portMap.filter((p: any) => p.primary === true);
    expect(primaries).toEqual([{ internalPort: 4000, label: 'api', primary: true }]);
  });

  it('references the MASK sentinel constant shared with the store', () => {
    expect(SECRET_MASK).toBe('••••••••');
  });
});
