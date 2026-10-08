/**
 * Participant names for Google Chat conversations that have no display name.
 *
 * DMs and group chats come back from `spaces.list` with an empty displayName,
 * so the only way to tell them apart is who is in them. Names come from
 * `spaces.members.list`, which (under user auth) fills `member.displayName`
 * for members of the space.
 *
 * Membership of a DM never changes and group chats rarely do, so results are
 * cached per Hub user and space, but only once every membership page has
 * been read. Each request resolves at most `budget`
 * uncached spaces so a first load of a large account can't burn the Chat API
 * read quota; the rest stay unresolved (null) and fill in on later loads.
 */

export interface MemberLike {
  member?: { name?: string | null; displayName?: string | null; type?: string | null } | null;
}

/**
 * Every membership of a space. `complete` is false when the caller stopped
 * paging early (page cap); partial results are returned but never cached.
 */
export type ListMembers = (
  spaceName: string,
) => Promise<{ members: MemberLike[]; complete: boolean }>;

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const cache = new Map<string, { names: string[]; at: number }>();

export function clearChatParticipantCache(): void {
  cache.clear();
}

/** Other human members' names, excluding the caller (`users/{googleSub}`). */
export function participantNames(members: MemberLike[], selfUserName: string | null): string[] {
  const names: string[] = [];
  for (const m of members) {
    const member = m.member;
    if (!member || member.type === 'BOT') continue;
    if (selfUserName && member.name === selfUserName) continue;
    const name = (member.displayName || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Resolve participants for `spaceNames`. Returns a map containing every space
 * that resolved (from cache or a fresh lookup); spaces left out were over
 * budget or failed and should be treated as unresolved.
 */
export async function resolveChatParticipants(opts: {
  userId: string;
  selfUserName: string | null;
  spaceNames: string[];
  listMembers: ListMembers;
  budget?: number;
  concurrency?: number;
  now?: number;
}): Promise<Map<string, string[]>> {
  const now = opts.now ?? Date.now();
  const budget = opts.budget ?? 50;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const out = new Map<string, string[]>();
  const todo: string[] = [];

  for (const spaceName of opts.spaceNames) {
    const hit = cache.get(`${opts.userId}|${spaceName}`);
    if (hit && now - hit.at < TTL_MS) out.set(spaceName, hit.names);
    else if (todo.length < budget) todo.push(spaceName);
  }

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const spaceName = todo[next++];
      try {
        const { members, complete } = await opts.listMembers(spaceName);
        const names = participantNames(members, opts.selfUserName);
        if (complete) {
          if (cache.size >= MAX_ENTRIES) cache.clear();
          cache.set(`${opts.userId}|${spaceName}`, { names, at: now });
        }
        out.set(spaceName, names);
      } catch {
        // Leave unresolved; the conversation falls back to its id label.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return out;
}
