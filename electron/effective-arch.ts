/**
 * The CPU architecture the renderer should use when picking a DMG.
 *
 * `process.arch` reports the architecture of the *running binary*, so an
 * Intel build launched on an Apple Silicon Mac says `x64` even though the
 * machine is arm64. The update prompt then keeps offering the Intel DMG and
 * the user never escapes Rosetta. Electron exposes
 * `app.runningUnderARM64Translation` for exactly this case; when it's set the
 * effective architecture is arm64.
 */
export function resolveEffectiveArch(
  processArch: string,
  runningUnderArm64Translation: boolean | undefined,
): string {
  return runningUnderArm64Translation ? 'arm64' : processArch;
}
