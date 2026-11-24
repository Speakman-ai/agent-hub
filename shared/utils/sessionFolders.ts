/** Wire shape of `GET /api/agents/:agentId/session-folders`. */
export interface SessionFolderWire {
  id: string;
  agentId: string;
  name: string;
  position: number;
  createdAt: string;
}

export interface SessionFolderListingWire {
  folders: SessionFolderWire[];
  /** sessionId → folderId for the caller's filed sessions. */
  assignments: Record<string, string>;
}

export interface SessionFolderGroup<T> {
  folder: SessionFolderWire;
  sessions: T[];
}

export interface GroupedSessions<T> {
  folders: SessionFolderGroup<T>[];
  unfiled: T[];
}

/**
 * Splits an agent's (already ordered) session list into the caller's folders
 * plus the unfiled rest. Every folder is returned even when empty, in folder
 * order; sessions keep their incoming order inside each group. A filing that
 * points at a missing folder leaves the session unfiled.
 */
export function groupSessionsByFolder<T extends { id: string }>(
  sessions: T[],
  listing: SessionFolderListingWire | null | undefined,
): GroupedSessions<T> {
  if (!listing || listing.folders.length === 0) return { folders: [], unfiled: sessions };
  const groups = new Map<string, SessionFolderGroup<T>>();
  for (const folder of [...listing.folders].sort((a, b) => a.position - b.position)) {
    groups.set(folder.id, { folder, sessions: [] });
  }
  const unfiled: T[] = [];
  for (const s of sessions) {
    const group = groups.get(listing.assignments[s.id] ?? '');
    if (group) group.sessions.push(s);
    else unfiled.push(s);
  }
  return { folders: [...groups.values()], unfiled };
}

/** Returns a copy of the listing with `sessionId` filed into `folderId` (null unfiles). */
export function withSessionFolder(
  listing: SessionFolderListingWire,
  sessionId: string,
  folderId: string | null,
): SessionFolderListingWire {
  const assignments = { ...listing.assignments };
  if (folderId) assignments[sessionId] = folderId;
  else delete assignments[sessionId];
  return { ...listing, assignments };
}

/** Returns a copy of the listing without `folderId`; its sessions become unfiled. */
export function withoutSessionFolder(
  listing: SessionFolderListingWire,
  folderId: string,
): SessionFolderListingWire {
  const assignments: Record<string, string> = {};
  for (const [sid, fid] of Object.entries(listing.assignments)) {
    if (fid !== folderId) assignments[sid] = fid;
  }
  return { folders: listing.folders.filter((f) => f.id !== folderId), assignments };
}
