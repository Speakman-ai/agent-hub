/** Project record as returned by GET /api/projects. */
export interface ProjectWire {
  id: string;
  name: string;
  cwd: string;
  color?: string;
  ownerUserId?: string | null;
  visibility?: string;
  gitHost?: string;
  [key: string]: unknown;
}
