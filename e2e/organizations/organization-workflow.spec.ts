/**
 * Organization acceptance flow, end to end through the web client:
 *
 * Server selection → explicit organizations → one project linked to two organizations, one
 * project left independent → customizable agents (rename the Assistant, add one from
 * scratch, add one from an optional template, restrict one to a project subset) → the
 * restricted agent's own capability is denied out-of-scope reads, dispatch and admin APIs →
 * project-agent dispatch with status → persistent Computer defaults and per-chat override →
 * a restricted member sees no unauthorized data → unlink, archive, Hub restart without
 * resurrection.
 *
 * No real agent CLI runs: the Hub's CLIs point at fake-agent-cli.sh (see hub-server.ts).
 * Run with `npm run test:e2e:organizations`.
 */
import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { API_BASE, HubServer } from './hub-server.js';

const PASSWORD = 'e2e-correct-horse-battery';
const OWNER = 'owner@e2e.test';
const MEMBER = 'member@e2e.test';
const PROJECTS = {
  shared: { id: 'storefront', name: 'Shared Storefront', agent: 'Storefront Dev' },
  restricted: { id: 'ledger', name: 'Restricted Ledger', agent: 'Ledger Dev' },
  independent: { id: 'tools', name: 'Independent Tools', agent: 'Tools Dev' },
} as const;

const hub = new HubServer();
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

async function api(
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
) {
  return request.fetch(`${API_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    data,
  });
}

async function json(response: Awaited<ReturnType<typeof api>>) {
  expect(response.ok(), `${response.url()} → ${response.status()}`).toBeTruthy();
  return response.json();
}

/** Owner via first-run setup, a Server member, three projects, one with a members-only ACL. */
async function seed(request: APIRequestContext) {
  const cwds = hub.prepare(Object.values(PROJECTS).map((p) => p.id));
  await hub.start();
  const setup = await json(
    await request.post(`${API_BASE}/api/auth/setup`, {
      data: { email: OWNER, password: PASSWORD },
    }),
  );
  tokens.owner = setup.token;
  users.owner = setup.user.id;
  await json(await api(request, tokens.owner, 'POST', '/api/setup/complete'));
  const member = await json(
    await api(request, tokens.owner, 'POST', '/api/auth/users', {
      email: MEMBER,
      password: PASSWORD,
      role: 'User',
    }),
  );
  users.member = member.user.id;
  tokens.member = (
    await json(
      await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: MEMBER, password: PASSWORD },
      }),
    )
  ).token;
  // Each user's own (fake) engine login; the fake CLI never sends it anywhere.
  for (const who of ['owner', 'member'])
    await json(
      await api(request, tokens[who], 'PUT', '/api/auth/me/claude-auth', {
        anthropicApiKey: `sk-ant-e2e-${who}`,
      }),
    );
  for (const project of Object.values(PROJECTS)) {
    await json(
      await api(request, tokens.owner, 'POST', '/api/projects', {
        id: project.id,
        name: project.name,
        cwd: cwds[project.id],
      }),
    );
    await json(
      await api(request, tokens.owner, 'POST', '/api/agents', {
        id: `${project.id}-dev`,
        projectId: project.id,
        name: project.agent,
        engine: 'claude-code',
      }),
    );
  }
  // Project access is the existing per-project ACL: the member is assigned to the shared and
  // independent projects; the ledger stays limited to the owner.
  for (const [project, userId] of [
    [PROJECTS.restricted.id, users.owner],
    [PROJECTS.shared.id, users.member],
    [PROJECTS.independent.id, users.member],
  ])
    await json(
      await api(request, tokens.owner, 'POST', `/api/projects/${project}/members`, { userId }),
    );
}

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('textbox').first().fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Organizations', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function openOrganizations(page: Page) {
  await page.getByRole('button', { name: 'Organizations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Organizations', level: 2 })).toBeVisible();
}

function organizationsSection(page: Page): Locator {
  return page.getByRole('region', { name: 'Organizations' });
}

async function selectOrganization(page: Page, name: string) {
  const picker = page.getByRole('navigation', { name: 'Choose organization' });
  await picker.getByRole('button', { name, exact: true }).click();
  await expect(organizationsSection(page).getByRole('heading', { name, level: 3 })).toBeVisible();
}

async function organizationId(request: APIRequestContext, token: string, name: string) {
  const { organizations } = await json(await api(request, token, 'GET', '/api/organizations'));
  const match = organizations.find((o: { name: string }) => o.name === name);
  expect(match, `organization ${name}`).toBeTruthy();
  return match.id as string;
}

async function rosterAgent(request: APIRequestContext, orgId: string, name: string) {
  const { agents } = await json(
    await api(request, tokens.owner, 'GET', `/api/organizations/${orgId}/agents`),
  );
  return agents.find((a: { name: string }) => a.name === name) as {
    id: string;
    isAssistant?: boolean;
    computerToolEnabled?: boolean;
    organizationScope: { tools: string[]; projects: unknown; archivedAt?: string | null };
  };
}

function agentRows(page: Page): Locator {
  return organizationsSection(page).locator(
    '[data-testid^="organization-agent-"]:not([data-testid*="computer"])',
  );
}

async function sendChat(page: Page, text: string) {
  // Organization chats are Consult-mode sessions. The composer remounts once the session
  // loads, so wait for that before typing or the text is lost.
  const input = page.getByPlaceholder(/^Consult on Agent Hub/);
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

async function newSignedInPage(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await seed(request);
});

test.afterAll(async () => {
  await hub.dispose();
});

test('organization workflow from Server selection to archive and restart', async ({
  page,
  request,
  browser,
}) => {
  await test.step('sign in and confirm the selected Server', async () => {
    // In a browser the Server is the origin you sign in to (the switcher is Electron-only);
    // the session is bound to that Server's partition.
    await signIn(page, OWNER);
    const servers = await json(await api(request, tokens.owner, 'GET', '/api/servers'));
    expect(servers.map((s: { id: string }) => s.id)).toEqual(['default']);
    // The legacy connection API still answers with the same ID for older clients.
    const legacy = await json(await api(request, tokens.owner, 'GET', '/api/orgs'));
    expect(legacy.map((s: { id: string }) => s.id)).toEqual(['default']);
    const me = await json(await api(request, tokens.owner, 'GET', '/api/auth/me'));
    expect(me.orgId).toBe('default');
    await expect(page.getByRole('button', { name: 'Server', exact: true })).toBeVisible();
  });

  await test.step('create two organizations explicitly; no organization exists before', async () => {
    await openOrganizations(page);
    await expect(page.getByText('No organizations yet.')).toBeVisible();
    const section = organizationsSection(page);
    for (const name of ['Northwind', 'Contoso']) {
      await section.getByLabel('New organization name').fill(name);
      await section.getByRole('button', { name: 'Create organization' }).click();
      await expect(
        page.getByRole('navigation', { name: 'Choose organization' }).getByRole('button', {
          name,
          exact: true,
        }),
      ).toBeVisible();
    }
  });

  await test.step('link the shared project to both, leave the independent project alone', async () => {
    for (const [name, linked] of [
      ['Northwind', [PROJECTS.shared.name, PROJECTS.restricted.name]],
      ['Contoso', [PROJECTS.shared.name]],
    ] as const) {
      await selectOrganization(page, name);
      const section = organizationsSection(page);
      for (const project of linked)
        await section.getByRole('checkbox', { name: project, exact: true }).check();
      await section.getByRole('button', { name: 'Save project links' }).click();
      await expect(
        section.getByRole('checkbox', { name: PROJECTS.shared.name, exact: true }),
      ).toBeChecked();
      await expect(
        section.getByRole('checkbox', { name: PROJECTS.independent.name, exact: true }),
      ).not.toBeChecked();
    }
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const contoso = await organizationId(request, tokens.owner, 'Contoso');
    const ids = async (orgId: string) =>
      (
        await json(await api(request, tokens.owner, 'GET', `/api/organizations/${orgId}/projects`))
      ).projects
        .map((p: { id: string }) => p.id)
        .sort();
    expect(await ids(northwind)).toEqual([PROJECTS.restricted.id, PROJECTS.shared.id]);
    expect(await ids(contoso)).toEqual([PROJECTS.shared.id]);
    // Linking is not a move: the project keeps its ID and stays a normal project.
    const projects = await json(await api(request, tokens.owner, 'GET', '/api/projects'));
    expect(projects.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(Object.values(PROJECTS).map((p) => p.id)),
    );
  });

  await test.step('each organization starts with exactly one Assistant, Computer on', async () => {
    for (const name of ['Contoso', 'Northwind']) {
      await selectOrganization(page, name);
      await expect(agentRows(page)).toHaveCount(1);
      const row = agentRows(page).first();
      await expect(row).toContainText('Organization Assistant');
      await expect(row).toContainText('Assistant');
      await expect(row).toContainText('Computer on by default');
    }
  });

  await test.step('rename the Assistant without changing its identity', async () => {
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const before = await rosterAgent(request, northwind, 'Organization Assistant');
    const section = organizationsSection(page);
    await section.getByRole('button', { name: 'Edit Organization Assistant' }).click();
    const editor = section.getByRole('form', { name: 'Edit Organization Assistant' });
    await editor.getByLabel('Agent name').fill('Chief of Staff');
    await editor.getByRole('button', { name: 'Save agent' }).click();
    await expect(section.getByRole('button', { name: 'Chat with Chief of Staff' })).toBeVisible();
    const after = await rosterAgent(request, northwind, 'Chief of Staff');
    expect(after.id).toBe(before.id);
    expect(after.isAssistant).toBe(true);
  });

  await test.step('add a custom agent from scratch, restricted to the shared project', async () => {
    const section = organizationsSection(page);
    await section.getByRole('button', { name: 'Add agent' }).click();
    await section.getByRole('button', { name: 'Start from scratch' }).click();
    const editor = section.getByRole('form', { name: 'New agent' });
    await editor.getByLabel('Agent name').fill('Release Tracker');
    await editor.getByLabel('Instructions').fill('Track storefront releases.');
    await editor.getByLabel('Dispatch project agents').check();
    await editor.getByLabel('Selected projects').check();
    await editor.getByLabel(PROJECTS.shared.name, { exact: true }).check();
    await editor.getByRole('button', { name: 'Create agent' }).click();
    const row = agentRows(page).filter({ hasText: 'Release Tracker' });
    await expect(row).toContainText('No Computer');
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const agent = await rosterAgent(request, northwind, 'Release Tracker');
    expect(agent.organizationScope.projects).toEqual([PROJECTS.shared.id]);
    expect(agent.organizationScope.tools.sort()).toEqual(['dispatch', 'projects:read']);
    expect(agent.computerToolEnabled ?? false).toBe(false);
  });

  await test.step('add an optional Finance template agent; it grants no extra tools', async () => {
    const section = organizationsSection(page);
    await section.getByRole('button', { name: 'Add agent' }).click();
    await section.getByRole('button', { name: 'Use Finance template' }).click();
    const editor = section.getByRole('form', { name: 'New agent' });
    await expect(editor.getByLabel('Agent name')).toHaveValue('Finance');
    await expect(editor.getByLabel('Instructions')).toHaveValue(/budgets/);
    await editor.getByRole('button', { name: 'Create agent' }).click();
    const row = agentRows(page).filter({ hasText: 'from Finance template' });
    await expect(row).toContainText('No Computer');
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const finance = await rosterAgent(request, northwind, 'Finance');
    expect(finance.organizationScope.tools).toEqual(['projects:read']);
    await expect(agentRows(page)).toHaveCount(3);
  });

  await test.step('dispatch a project agent from the portfolio and follow its status', async () => {
    const portfolio = page.getByRole('region', { name: 'Organization portfolio' });
    await portfolio.getByRole('button', { name: 'Refresh portfolio' }).click();
    await expect(portfolio.getByRole('listitem', { name: PROJECTS.shared.name })).toBeVisible();
    await expect(portfolio.getByRole('listitem', { name: PROJECTS.restricted.name })).toBeVisible();
    await expect(portfolio.getByText(PROJECTS.independent.name)).toHaveCount(0);

    const form = portfolio.getByRole('form', { name: 'Dispatch a project agent' });
    // The restricted agent only offers its own project subset.
    await form.getByLabel('Organization agent').selectOption({ label: 'Release Tracker' });
    await expect(form.getByLabel('Target project').locator('option')).toHaveText([
      'Choose a project',
      PROJECTS.shared.name,
    ]);
    await form.getByLabel('Organization agent').selectOption({ label: 'Chief of Staff' });
    await form.getByLabel('Target project').selectOption({ label: PROJECTS.shared.name });
    await form.getByLabel('Target agent').selectOption({ label: PROJECTS.shared.agent });
    await form.getByLabel('Task for the project agent').fill('Summarize open storefront cards');
    await form.getByRole('button', { name: 'Dispatch' }).click();

    const dispatch = portfolio.getByRole('listitem', {
      name: 'Dispatch Summarize open storefront cards',
    });
    await expect(dispatch).toBeVisible();
    await expect(async () => {
      await portfolio.getByRole('button', { name: 'Refresh portfolio' }).click();
      await expect(dispatch).toContainText('Completed', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(dispatch).toContainText(PROJECTS.shared.agent);
    await expect(dispatch.getByRole('button', { name: 'Open target session' })).toBeVisible();

    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const { dispatches } = await json(
      await api(request, tokens.owner, 'GET', `/api/organizations/${northwind}/dispatches`),
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      status: 'accepted',
      projectId: PROJECTS.shared.id,
      agentId: `${PROJECTS.shared.id}-dev`,
      actingUserId: users.owner,
    });
    // The target is a normal session owned by the project, readable as its own record.
    const result = await api(request, tokens.owner, 'GET', dispatches[0].resultPath);
    expect(result.status()).toBe(200);
  });

  await test.step("the restricted agent's own capability is denied outside its scope", async () => {
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    await organizationsSection(page)
      .getByRole('button', { name: 'Chat with Release Tracker' })
      .click();
    await sendChat(
      page,
      `E2E-PROBE org=${northwind} in=${PROJECTS.shared.id} out=${PROJECTS.restricted.id} agent=${PROJECTS.restricted.id}-dev`,
    );
    await expect(
      page.getByText(
        'E2E probe: in-scope read 200; out-of-scope read 404; out-of-scope dispatch 404; server admin 403.',
      ),
    ).toBeVisible({ timeout: 60_000 });
    // Release Tracker has no Computer tool.
    const bar = page.getByTestId('organization-computer-bar');
    await expect(bar).toHaveAttribute('data-state', 'not-permitted');
  });

  await test.step('Computer: Assistant on by default, custom agent off, per-chat override kept', async () => {
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const chatIds = async () =>
      (
        await json(
          await api(request, tokens.owner, 'GET', `/api/organizations/${northwind}/sessions`),
        )
      ).sessions.map((c: { id: string }) => c.id) as string[];
    const before = new Set(await chatIds());

    await openOrganizations(page);
    await selectOrganization(page, 'Northwind');
    await organizationsSection(page)
      .getByRole('button', { name: 'Chat with Chief of Staff' })
      .click();
    const bar = page.getByTestId('organization-computer-bar');
    await expect(bar.getByTestId('organization-computer-owner')).toHaveText(
      `Chief of Staff in Northwind · private to ${OWNER}`,
    );
    // No desktop backend runs here: the Computer is on but unavailable, and chat still works.
    await expect(bar).toHaveAttribute('data-state', /^(ready|unavailable)$/);
    await expect(bar.getByTestId('organization-computer-source')).toHaveText('Agent default');
    await bar.getByRole('button', { name: 'Turn off for this chat' }).click();
    await expect(bar).toHaveAttribute('data-state', 'off');
    await expect(bar.getByTestId('organization-computer-source')).toHaveText('This chat');
    const chat = (await chatIds()).find((id) => !before.has(id));
    expect(chat, 'new Assistant chat').toBeTruthy();

    // A custom agent gets Computer only when an admin adds the tool, and starts off.
    await openOrganizations(page);
    await selectOrganization(page, 'Northwind');
    let section = organizationsSection(page);
    await section.getByRole('button', { name: 'Edit Finance' }).click();
    const editor = section.getByRole('form', { name: 'Edit Finance' });
    await editor.getByLabel('Computer', { exact: true }).check();
    await expect(editor.getByLabel('Computer on by default in new chats')).not.toBeChecked();
    await editor.getByRole('button', { name: 'Save agent' }).click();
    await expect(agentRows(page).filter({ hasText: 'Finance' })).toContainText(
      'Computer off by default',
    );
    await section.getByRole('button', { name: 'Chat with Finance' }).click();
    await expect(bar).toHaveAttribute('data-state', 'off');
    await expect(bar.getByTestId('organization-computer-source')).toHaveText('Agent default');
    await expect(bar.getByTestId('organization-computer-owner')).toHaveText(
      `Finance in Northwind · private to ${OWNER}`,
    );

    // Reopening the Assistant chat from history keeps its own override.
    await openOrganizations(page);
    await selectOrganization(page, 'Northwind');
    section = organizationsSection(page);
    await section
      .getByTestId(`organization-chat-${chat}`)
      .getByRole('button', { name: 'Open Chief of Staff' })
      .click();
    await expect(bar.getByTestId('organization-computer-owner')).toHaveText(
      `Chief of Staff in Northwind · private to ${OWNER}`,
    );
    await expect(bar).toHaveAttribute('data-state', 'off');
    await expect(bar.getByTestId('organization-computer-source')).toHaveText('This chat');
    await bar.getByRole('button', { name: 'Use agent default (On)' }).click();
    await expect(bar).toHaveAttribute('data-state', /^(ready|unavailable)$/);
  });

  await test.step('add a Server member to one organization as Member', async () => {
    await openOrganizations(page);
    await selectOrganization(page, 'Northwind');
    const section = organizationsSection(page);
    await section.getByLabel('Server member').selectOption({ label: MEMBER });
    await section.getByLabel('New member role').selectOption('Member');
    await section.getByRole('button', { name: 'Add member' }).click();
    await expect(section.getByLabel(`Role for ${MEMBER}`)).toHaveValue('Member');
  });

  await test.step('a restricted member sees no unauthorized data', async () => {
    const memberPage = await newSignedInPage(browser, MEMBER);
    // Shared and independent projects are visible, the members-only ledger is not.
    const visible = await json(await api(request, tokens.member, 'GET', '/api/projects'));
    expect(visible.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROJECTS.shared.id, PROJECTS.independent.id].sort(),
    );
    await expect(memberPage.getByText(PROJECTS.restricted.name)).toHaveCount(0);

    await openOrganizations(memberPage);
    const picker = memberPage.getByRole('navigation', { name: 'Choose organization' });
    await expect(picker.getByRole('button')).toHaveText(['Northwind']);
    await selectOrganization(memberPage, 'Northwind');
    const section = organizationsSection(memberPage);
    await expect(section.getByText('Read only.')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Add agent' })).toHaveCount(0);
    const portfolio = memberPage.getByRole('region', { name: 'Organization portfolio' });
    await expect(portfolio.getByRole('listitem', { name: PROJECTS.shared.name })).toBeVisible();
    await expect(memberPage.getByText(PROJECTS.restricted.name)).toHaveCount(0);
    // Other users' dispatches and chats are not listed.
    await expect(portfolio.getByText('Nothing dispatched yet.')).toBeVisible();

    // The member's own Assistant chat reaches only what the member can access.
    const northwind = await organizationId(request, tokens.member, 'Northwind');
    await section.getByRole('button', { name: 'Chat with Chief of Staff' }).click();
    await sendChat(
      memberPage,
      `E2E-PROBE org=${northwind} in=${PROJECTS.shared.id} out=${PROJECTS.restricted.id} agent=${PROJECTS.restricted.id}-dev`,
    );
    await expect(
      memberPage.getByText(
        'E2E probe: in-scope read 200; out-of-scope read 404; out-of-scope dispatch 404; server admin 403.',
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(memberPage.getByTestId('organization-computer-owner')).toHaveText(
      `Chief of Staff in Northwind · private to ${MEMBER}`,
    );

    // Direct API reads fail closed without revealing whether the target exists.
    const contoso = await organizationId(request, tokens.owner, 'Contoso');
    const denied = [
      `/api/organizations/${contoso}`,
      `/api/organizations/${contoso}/agents`,
      `/api/organizations/${northwind}/context/projects/${PROJECTS.restricted.id}/cards`,
      `/api/projects/${PROJECTS.restricted.id}`,
    ];
    for (const path of denied) {
      const response = await api(request, tokens.member, 'GET', path);
      expect([403, 404], `${path} → ${response.status()}`).toContain(response.status());
    }
    const managed = await api(
      request,
      tokens.member,
      'POST',
      `/api/organizations/${northwind}/agents`,
      {
        name: 'Self-promoted CEO',
        templateId: 'ceo',
      },
    );
    expect(managed.status()).toBe(403);
    const { organizations } = await json(
      await api(request, tokens.member, 'GET', '/api/organizations'),
    );
    expect(organizations.map((o: { name: string }) => o.name)).toEqual(['Northwind']);
    await memberPage.context().close();
  });

  await test.step('unlink from one organization without touching the project or the other', async () => {
    await openOrganizations(page);
    await selectOrganization(page, 'Northwind');
    const section = organizationsSection(page);
    await section.getByRole('checkbox', { name: PROJECTS.shared.name, exact: true }).uncheck();
    await section.getByRole('button', { name: 'Save project links' }).click();
    const northwind = await organizationId(request, tokens.owner, 'Northwind');
    const contoso = await organizationId(request, tokens.owner, 'Contoso');
    await expect(async () => {
      const { projects } = await json(
        await api(request, tokens.owner, 'GET', `/api/organizations/${northwind}/projects`),
      );
      expect(projects.map((p: { id: string }) => p.id)).toEqual([PROJECTS.restricted.id]);
    }).toPass({ timeout: 10_000 });
    const { projects: contosoProjects } = await json(
      await api(request, tokens.owner, 'GET', `/api/organizations/${contoso}/projects`),
    );
    expect(contosoProjects.map((p: { id: string }) => p.id)).toEqual([PROJECTS.shared.id]);
    const project = await json(
      await api(request, tokens.owner, 'GET', `/api/projects/${PROJECTS.shared.id}`),
    );
    expect(project).toMatchObject({ id: PROJECTS.shared.id, name: PROJECTS.shared.name });
    // The accepted dispatch session stays with its owner after the unlink.
    const sessions = await json(
      await api(request, tokens.owner, 'GET', `/api/agents/${PROJECTS.shared.id}-dev/sessions`),
    );
    expect(sessions.length).toBeGreaterThan(0);
  });

  await test.step('archive a custom agent and the Contoso Assistant', async () => {
    let section = organizationsSection(page);
    await section.getByRole('button', { name: 'Edit Release Tracker' }).click();
    const editor = section.getByRole('form', { name: 'Edit Release Tracker' });
    await editor.getByRole('button', { name: 'Archive agent' }).click();
    await editor.getByRole('button', { name: 'Confirm archive of Release Tracker' }).click();
    await expect(section.getByRole('button', { name: 'Restore Release Tracker' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Chat with Release Tracker' })).toHaveCount(0);

    await selectOrganization(page, 'Contoso');
    section = organizationsSection(page);
    await section.getByRole('button', { name: 'Edit Organization Assistant' }).click();
    const assistant = section.getByRole('form', { name: 'Edit Organization Assistant' });
    await assistant.getByRole('button', { name: 'Archive agent' }).click();
    await assistant
      .getByRole('button', { name: 'Confirm archive of Organization Assistant' })
      .click();
    await expect(section.getByText('No active agents.')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Add agent' })).toBeVisible();
  });

  await test.step('restart the Hub: nothing archived comes back', async () => {
    await hub.restart();
    await page.reload();
    await openOrganizations(page);
    await selectOrganization(page, 'Contoso');
    let section = organizationsSection(page);
    await expect(section.getByText('No active agents.')).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Restore Organization Assistant' }),
    ).toBeVisible();

    await selectOrganization(page, 'Northwind');
    section = organizationsSection(page);
    await expect(section.getByRole('button', { name: 'Restore Release Tracker' })).toBeVisible();
    await expect(agentRows(page)).toHaveCount(2);
    await expect(section.getByRole('button', { name: 'Chat with Chief of Staff' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Chat with Finance' })).toBeVisible();
    // The archived agent's chat stays in its owner's history, read-only.
    await expect(section.getByText('Release Tracker (history only)')).toBeVisible();
  });

  await test.step('archive an organization; projects and the other organization remain', async () => {
    await selectOrganization(page, 'Contoso');
    const section = organizationsSection(page);
    await section.getByRole('button', { name: 'Archive organization' }).click();
    await section.getByRole('button', { name: 'Confirm archive' }).click();
    const picker = page.getByRole('navigation', { name: 'Choose organization' });
    await expect(picker.getByRole('button')).toHaveText(['Northwind']);
    const projects = await json(await api(request, tokens.owner, 'GET', '/api/projects'));
    expect(projects.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(Object.values(PROJECTS).map((p) => p.id)),
    );
    const independent = await json(
      await api(
        request,
        tokens.owner,
        'GET',
        `/api/agents/${PROJECTS.independent.id}-dev/sessions`,
      ),
    );
    expect(Array.isArray(independent)).toBe(true);
  });
});
