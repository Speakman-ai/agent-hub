import { describe, it, expect, beforeAll, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from '../test/helpers.js';

// Linking a replay to a bug ticket would fire the AI investigation (which shells
// out to an engine); stub it so these tests never spawn a CLI.
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: vi.fn(),
}));

const META = { type: 4, timestamp: 1000, data: { href: 'https://app.example/checkout' } };
const SNAPSHOT = { type: 2, timestamp: 1001, data: { node: {} } };

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function newProjectId(): Promise<string> {
  return (await createProject()).id as string;
}

/** Ingest an anonymous capture and attribute it to `projectId` via the
 *  ticket-link flow, returning the replay id. */
async function seedProjectReplay(projectId: string): Promise<string> {
  const ingest = await request
    .post('/api/replays')
    .send({ events: [META, SNAPSHOT], meta: { trigger: 'error' } })
    .expect(201);
  const replayId = ingest.body.replayId as string;
  const ticket = await request
    .post(`/api/projects/${projectId}/support-tickets`)
    .send({ type: 'bug', severity: 'high', subject: 'Broken', body: 'It broke' })
    .expect(201);
  await request
    .post(`/api/projects/${projectId}/replays/${replayId}/link`)
    .send({ supportTicketId: ticket.body.id })
    .expect(200);
  return replayId;
}

describe('replay-playlists routes', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/replay-playlists').expect(404);
    await request
      .post('/api/projects/does-not-exist/replay-playlists')
      .send({ name: 'x' })
      .expect(404);
  });

  it('creates, lists, fetches, renames, and deletes a playlist', async () => {
    const projectId = await newProjectId();

    // Create
    const created = await request
      .post(`/api/projects/${projectId}/replay-playlists`)
      .send({ name: '  Checkout repros  ', description: 'flaky checkout' })
      .expect(201);
    expect(created.body).toMatchObject({
      projectId,
      name: 'Checkout repros', // trimmed
      description: 'flaky checkout',
      itemCount: 0,
      extendedRetention: false,
      retainedUntil: null,
    });
    const playlistId = created.body.id as string;

    // List
    const list = await request.get(`/api/projects/${projectId}/replay-playlists`).expect(200);
    expect(list.body.playlists).toHaveLength(1);
    expect(list.body.playlists[0].id).toBe(playlistId);

    // Get one (with empty items)
    const one = await request
      .get(`/api/projects/${projectId}/replay-playlists/${playlistId}`)
      .expect(200);
    expect(one.body.items).toEqual([]);

    // Rename
    const renamed = await request
      .patch(`/api/projects/${projectId}/replay-playlists/${playlistId}`)
      .send({ name: 'Renamed list' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed list');
    expect(renamed.body.description).toBe('flaky checkout'); // untouched

    // Delete
    await request.delete(`/api/projects/${projectId}/replay-playlists/${playlistId}`).expect(204);
    await request.get(`/api/projects/${projectId}/replay-playlists/${playlistId}`).expect(404);
  });

  it('rejects an empty name on create', async () => {
    const projectId = await newProjectId();
    await request
      .post(`/api/projects/${projectId}/replay-playlists`)
      .send({ name: '   ' })
      .expect(400);
  });

  it('adds/removes members and is idempotent on re-add', async () => {
    const projectId = await newProjectId();
    const replayId = await seedProjectReplay(projectId);
    const playlistId = (
      await request
        .post(`/api/projects/${projectId}/replay-playlists`)
        .send({ name: 'List' })
        .expect(201)
    ).body.id as string;

    // Add
    const added = await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/items`)
      .send({ replayId })
      .expect(201);
    expect(added.body.added).toBe(true);
    expect(added.body.itemCount).toBe(1);
    expect(added.body.items[0].replayId).toBe(replayId);

    // Re-add is a 200 no-op (still one item)
    const readd = await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/items`)
      .send({ replayId })
      .expect(200);
    expect(readd.body.added).toBe(false);
    expect(readd.body.itemCount).toBe(1);

    // Remove
    await request
      .delete(`/api/projects/${projectId}/replay-playlists/${playlistId}/items/${replayId}`)
      .expect(204);
    // Removing again 404s
    await request
      .delete(`/api/projects/${projectId}/replay-playlists/${playlistId}/items/${replayId}`)
      .expect(404);
  });

  it('masks a cross-project / unattributed capture as 404 on add', async () => {
    const projectA = await newProjectId();
    const projectB = await newProjectId();
    const replayInB = await seedProjectReplay(projectB);
    const playlistInA = (
      await request
        .post(`/api/projects/${projectA}/replay-playlists`)
        .send({ name: 'A list' })
        .expect(201)
    ).body.id as string;

    // A capture owned by another project cannot be smuggled in.
    await request
      .post(`/api/projects/${projectA}/replay-playlists/${playlistInA}/items`)
      .send({ replayId: replayInB })
      .expect(404);
    // Missing replayId is a 400.
    await request
      .post(`/api/projects/${projectA}/replay-playlists/${playlistInA}/items`)
      .send({})
      .expect(400);
  });

  it('flags a whole playlist for extended retention and fans it out to members', async () => {
    const projectId = await newProjectId();
    const replayId = await seedProjectReplay(projectId);
    const playlistId = (
      await request
        .post(`/api/projects/${projectId}/replay-playlists`)
        .send({ name: 'Keepers' })
        .expect(201)
    ).body.id as string;
    await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/items`)
      .send({ replayId })
      .expect(201);

    // Member starts on the default window.
    const before = await request.get(`/api/replays/${replayId}`).expect(200);
    expect(before.body.retainedUntil).toBeNull();

    // Flag the playlist → both the playlist and the member get retained_until.
    const flagged = await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/retention`)
      .send({ extend: true })
      .expect(200);
    expect(flagged.body.extendedRetention).toBe(true);
    expect(flagged.body.retainedUntil).not.toBeNull();

    const memberAfter = await request.get(`/api/replays/${replayId}`).expect(200);
    expect(memberAfter.body.retainedUntil).toBe(flagged.body.retainedUntil);

    // Clearing the playlist flag clears the playlist-level flag; the member keeps
    // its own retained_until (may be pinned independently).
    const cleared = await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/retention`)
      .send({ extend: false })
      .expect(200);
    expect(cleared.body.extendedRetention).toBe(false);
    expect(cleared.body.retainedUntil).toBeNull();
    const memberStill = await request.get(`/api/replays/${replayId}`).expect(200);
    expect(memberStill.body.retainedUntil).toBe(flagged.body.retainedUntil);
  });

  it('inherits the flag when adding a member to an already-flagged playlist', async () => {
    const projectId = await newProjectId();
    const playlistId = (
      await request
        .post(`/api/projects/${projectId}/replay-playlists`)
        .send({ name: 'Pre-flagged' })
        .expect(201)
    ).body.id as string;
    // Flag while empty.
    const flagged = await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/retention`)
      .send({ extend: true })
      .expect(200);

    // Now add a member — it should inherit the retained_until.
    const replayId = await seedProjectReplay(projectId);
    await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/items`)
      .send({ replayId })
      .expect(201);
    const member = await request.get(`/api/replays/${replayId}`).expect(200);
    expect(member.body.retainedUntil).toBe(flagged.body.retainedUntil);
  });

  it('rejects a non-boolean retention body', async () => {
    const projectId = await newProjectId();
    const playlistId = (
      await request
        .post(`/api/projects/${projectId}/replay-playlists`)
        .send({ name: 'x' })
        .expect(201)
    ).body.id as string;
    await request
      .post(`/api/projects/${projectId}/replay-playlists/${playlistId}/retention`)
      .send({ extend: 'yes' })
      .expect(400);
  });
});
