/**
 * The desktop layer reaches both backends through one installer, and the
 * Firecracker desktop rootfs starts the display the runtime talks to. These
 * are build-time artifacts with no runtime caller in the test suite, so drift
 * between them and the TypeScript constants would only show up in a booted
 * guest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { DESKTOP_DISPLAY, DESKTOP_SCREEN, DESKTOP_VNC_PORT } from './desktop-runtime.js';
import { DESKTOP_GUEST_BOOT_ARG } from './firecracker-desktop-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(here, 'image', 'install-desktop.sh');
const containerDockerfile = path.join(here, 'image', 'Dockerfile');
const fcBuild = path.join(here, '..', 'session-env', 'firecracker', 'build');
const guestDesktopDockerfile = path.join(fcBuild, 'Dockerfile.guest-desktop');
const buildScript = path.join(fcBuild, 'build-guest-artifacts.sh');
const systemdDir = path.join(here, '..', 'session-env', 'firecracker', 'guest', 'systemd');

const read = (p: string) => readFileSync(p, 'utf8');

function desktopUnits(): string[] {
  const m = read(buildScript).match(/DESKTOP_UNITS=\(([^)]*)\)/);
  expect(m, 'build-guest-artifacts.sh must declare DESKTOP_UNITS').toBeTruthy();
  return m![1]!.split(/\s+/).filter(Boolean);
}

function execStart(unit: string): string {
  const line = read(path.join(systemdDir, unit))
    .split('\n')
    .find((l) => l.startsWith('ExecStart='));
  expect(line, `${unit} needs an ExecStart`).toBeTruthy();
  return line!.slice('ExecStart='.length);
}

describe('install-desktop.sh', () => {
  it('installs every tool the computer tool drives', () => {
    const src = read(installer);
    for (const pkg of ['xvfb', 'openbox', 'xdotool', 'scrot', 'x11vnc', 'chromium']) {
      expect(src).toMatch(new RegExp(`\\b${pkg}\\b`));
    }
  });

  it('refuses to run without a known target, before touching apt', () => {
    for (const args of [[], ['--target', 'laptop']]) {
      const res = spawnSync('bash', [installer, ...args], { encoding: 'utf8' });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('--target must be container or vm');
    }
  });

  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', installer]).status).toBe(0);
  });
});

describe('desktop images share the installer', () => {
  it('the container image runs it with --target container and installs no desktop packages itself', () => {
    const src = read(containerDockerfile);
    expect(src).toContain(
      'COPY server/desktop/image/install-desktop.sh /opt/agent-hub-desktop/install-desktop.sh',
    );
    expect(src).toContain('install-desktop.sh --target container');
    const instructions = src
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    expect(instructions).not.toMatch(/\b(xvfb|openbox|xdotool|scrot)\b/);
  });

  it('the Firecracker desktop guest layers it on the session guest with --target vm', () => {
    const src = read(guestDesktopDockerfile);
    expect(src).toMatch(/ARG BASE_IMAGE=agent-hub\/fc-guest:latest\nFROM \$\{BASE_IMAGE\}/);
    expect(src).toContain('COPY install-desktop.sh ');
    expect(src).toContain('install-desktop.sh --target vm');
  });
});

describe('build-guest-artifacts.sh desktop variant', () => {
  const src = read(buildScript);

  it('builds the desktop image from the session guest image and the shared installer', () => {
    expect(src).toContain(
      'DESKTOP_INSTALLER="${REPO_ROOT}/server/desktop/image/install-desktop.sh"',
    );
    expect(src).toContain('"${DESKTOP_INSTALLER}" "${DESKTOP_CTX}/install-desktop.sh"');
    expect(src).toContain('"${SCRIPT_DIR}/Dockerfile.guest-desktop" "${DESKTOP_CTX}/Dockerfile"');
    expect(src).toContain('--build-arg "BASE_IMAGE=agent-hub/fc-guest:latest"');
  });

  it('writes rootfs-desktop.ext4 from the desktop image and rootfs.ext4 from the session one', () => {
    expect(src).toContain('assemble_rootfs agent-hub/fc-guest:latest rootfs.ext4 session');
    expect(src).toContain(
      'assemble_rootfs agent-hub/fc-guest-desktop:latest rootfs-desktop.ext4 desktop',
    );
  });

  it('installs and enables every desktop unit, and each one exists', () => {
    const units = desktopUnits();
    expect(units).toEqual([
      'agent-hub-desktop-display.service',
      'agent-hub-desktop-wm.service',
      'agent-hub-desktop-vnc.service',
    ]);
    for (const unit of units) expect(existsSync(path.join(systemdDir, unit))).toBe(true);
    expect(src).toContain('enable_unit "${unit}" multi-user.target');
  });

  it('rejects an unknown variant and is valid bash', () => {
    expect(spawnSync('bash', ['-n', buildScript]).status).toBe(0);
    const res = spawnSync('bash', [buildScript, '--variant', 'gpu'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--variant must be session, desktop or all');
  });
});

describe('desktop guest systemd units', () => {
  it('only start on desktop computers and run as the workspace user', () => {
    for (const unit of desktopUnits()) {
      const src = read(path.join(systemdDir, unit));
      expect(src).toContain(`ConditionKernelCommandLine=${DESKTOP_GUEST_BOOT_ARG}`);
      expect(src).toContain('User=runner');
      expect(src).toContain('WantedBy=multi-user.target');
    }
  });

  it('starts Xvfb on the display and screen size the runtime assumes', () => {
    const cmd = execStart('agent-hub-desktop-display.service');
    expect(cmd).toContain(
      `Xvfb ${DESKTOP_DISPLAY} -screen 0 ${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height}x24`,
    );
    expect(cmd).toContain('-nolisten tcp');
    const unit = read(path.join(systemdDir, 'agent-hub-desktop-display.service'));
    expect(unit).toContain('After=agent-hub-desktop-home.service');
  });

  it('serves VNC for that display on the port mapDisplayPort reports', () => {
    const cmd = execStart('agent-hub-desktop-vnc.service');
    expect(cmd).toContain(`-display ${DESKTOP_DISPLAY}`);
    expect(cmd).toContain(`-rfbport ${DESKTOP_VNC_PORT}`);
    // The Hub reaches it by guest IP, so it must not be loopback-only.
    expect(cmd).not.toContain('-localhost');
    expect(read(path.join(systemdDir, 'agent-hub-desktop-vnc.service'))).toContain(
      'BindsTo=agent-hub-desktop-display.service',
    );
  });

  it('runs the window manager on the same display', () => {
    const unit = read(path.join(systemdDir, 'agent-hub-desktop-wm.service'));
    expect(unit).toContain(`Environment=DISPLAY=${DESKTOP_DISPLAY}`);
    expect(execStart('agent-hub-desktop-wm.service')).toContain('openbox');
  });
});
