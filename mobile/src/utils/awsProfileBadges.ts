/**
 * Suffix markers for a profile row on the read-only mobile AWS screen: which
 * profile `aws` resolves to without `--profile`, and which one unattended
 * background collection runs as. Both come from the resolved (`effective*`)
 * envelope fields, so a stale designation shows no marker at all.
 */
export function awsProfileBadges(
  name: string,
  opts: { defaultProfile?: string; monitoringProfile?: string } = {},
): string {
  const marks: string[] = [];
  if (name && name === opts.defaultProfile) marks.push('default');
  if (name && name === opts.monitoringProfile) marks.push('monitoring');
  return marks.length ? `  ·  ${marks.join(' · ')}` : '';
}
