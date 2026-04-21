/** Strip common ANSI SGR sequences (colors) from CLI output for stable parsing. */
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_PATTERN, '');
}
