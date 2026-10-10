import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import UpdateAvailableModal from './UpdateAvailableModal';

const DOWNLOAD_URL = 'https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0-arm64.dmg';

describe('UpdateAvailableModal', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('explains the Apple Silicon download when the Intel build runs under Rosetta', () => {
    window.electronAPI = { isElectron: true, arch: 'arm64', runningUnderArm64Translation: true };
    const { getByTestId, getByRole } = render(
      <UpdateAvailableModal
        serverVersion="1.5.0"
        clientVersion="1.4.2"
        downloadUrl={DOWNLOAD_URL}
        onDismiss={() => {}}
      />,
    );
    expect(getByTestId('update-rosetta-hint').textContent).toMatch(/Rosetta/);
    expect(getByRole('link', { name: /Download/ })).toHaveAttribute('href', DOWNLOAD_URL);
  });

  it('stays quiet about Rosetta on a native build', () => {
    window.electronAPI = { isElectron: true, arch: 'arm64', runningUnderArm64Translation: false };
    const { queryByTestId } = render(
      <UpdateAvailableModal
        serverVersion="1.5.0"
        clientVersion="1.4.2"
        downloadUrl={DOWNLOAD_URL}
        onDismiss={() => {}}
      />,
    );
    expect(queryByTestId('update-rosetta-hint')).toBeNull();
  });
});
