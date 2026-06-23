/** Agent record as returned by project agent list routes. */
export interface AgentWire {
  id: string;
  projectId?: string;
  name: string;
  engine?: string;
  model?: string;
  [key: string]: unknown;
}
