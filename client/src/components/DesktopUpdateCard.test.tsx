import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import DesktopUpdateCard from './DesktopUpdateCard';
import DesktopUpdateHint from './DesktopUpdateHint';

const DOWNLOAD_URL = 'https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0-arm64.dmg';

describe('DesktopUpdateCard', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('links the download and explains the Rosetta case', () => {
    window.electronAPI = { isElectron: true, arch: 'arm64', runningUnderArm64Translation: true };
    const { getByTestId, getByRole } = render(
      <DesktopUpdateCard serverVersion="1.5.0" clientVersion="1.4.2" downloadUrl={DOWNLOAD_URL} />,
    );
    expect(getByTestId('update-rosetta-hint').textContent).toMatch(/Rosetta/);
    expect(getByRole('link', { name: /Download 1\.5\.0/ })).toHaveAttribute('href', DOWNLOAD_URL);
  });

  it('stays quiet about Rosetta on a native build', () => {
    window.electronAPI = { isElectron: true, arch: 'arm64', runningUnderArm64Translation: false };
    const { queryByTestId } = render(
      <DesktopUpdateCard serverVersion="1.5.0" clientVersion="1.4.2" downloadUrl={DOWNLOAD_URL} />,
    );
    expect(queryByTestId('update-rosetta-hint')).toBeNull();
  });
});

describe('DesktopUpdateHint', () => {
  afterEach(cleanup);

  it('points at Settings from the sidebar and at General inside Settings', () => {
    const { getByTestId, rerender } = render(
      <DesktopUpdateHint target="Settings" version="1.5.0" onDismiss={() => {}} />,
    );
    expect(getByTestId('desktop-update-hint').textContent).toMatch(/1\.5\.0.*Open Settings/);
    rerender(<DesktopUpdateHint target="General" version="1.5.0" onDismiss={() => {}} />);
    expect(getByTestId('desktop-update-hint').textContent).toMatch(/Choose General/);
  });
});
