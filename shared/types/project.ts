/** Project record as returned by GET /api/projects. */
export interface ProjectWire {
  id: string;
  name: string;
  cwd: string;
  color?: string;
  icon?: string | null;
  ownerUserId?: string | null;
  visibility?: string;
  gitHost?: string;
  /** Whether the per-project Infrastructure monitoring module is visible. */
  infraEnabled?: boolean;
  [key: string]: unknown;
}
