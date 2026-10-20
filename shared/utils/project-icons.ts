/** Every project is shown with the folder icon. */
export const DEFAULT_PROJECT_ICON = 'Folder';

export function resolveProjectIcon(_icon?: string | null): string {
  return DEFAULT_PROJECT_ICON;
}
