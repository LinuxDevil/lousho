import { test, expect, type Page } from '@playwright/test';

/**
 * S3: full-stack smoke test against the real, BUILT `lousho studio`
 * (see playwright.config.ts's `webServer` - it runs the same
 * `dist-server/index.cjs` production entry `lousho studio --prod` spawns,
 * serving the pre-built client too). This is the guard against regressions
 * across the whole stack: the canvas/graph editor, the Save/PUT-agent
 * round trip, the mock provider's tool-call heuristic, the real
 * human-in-the-loop approval-gate pause/resume machinery
 * (`AgentExecutor`/`RunManager`/`FileApprovalStore`), and the WebSocket
 * chat stream all have to actually work together for this to pass - not
 * just "the page loads".
 *
 * Flow: create an agent from the "Support bot" template (trigger -> llm ->
 * tool -> output) -> retarget its tool node at `demo-approval` (a
 * server-local, always-`needsApproval` tool added in `server/buildAgent.ts`
 * specifically so this flow is reachable through the real UI - see that
 * file's doc comment; none of the core SDK's spec-resolvable built-in
 * tools set `needsApproval`, the same reason
 * `server/__tests__/approvalFlow.test.ts` has to construct a
 * `ToolDescriptor` by hand instead) -> check the agent is saved in the
 * server workspace -> send a chat
 * message that mentions the tool (the mock provider's tool-call heuristic:
 * it calls any registered tool whose name appears in the last user message
 * - see `src/providers/mock.ts`) -> the run pauses awaiting approval ->
 * approve via the Chat tab's inline approval card
 * (`ApprovalCard`/`ChatPanel.tsx`, the same component and endpoint
 * the Approve button uses) -> the run resumes and completes.
 *
 * Agents live in the server workspace (`HttpAgentStore` over `PUT /agents`),
 * and Chat sends the canvas's current spec with each message
 * - so this test chats on the freshly created agent straight
 * away, with no Run first.
 */
const API = {};

/**
 * A builder URL that survives the unknown-id fallback to `#/agents`: the first
 * saved agent's canvas tab, or the unsaved default's when none are saved yet.
 */
async function builderHash(page: Page): Promise<string> {
  const res = await page.request.get('/agents', API);
  const ids = ((await res.json()) as { id: string }[]).map((a) => a.id);
  return `#/w/${await launchWorkspaceId(page)}/agents/${ids[0] ?? 'untitled-agent'}/canvas`;
}

/** The launch workspace id for '#/w/<ws>/…' hash assertions (W04b). */
async function launchWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get('/workspace', API);
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function selectLocalTool(page: Page, name: string) {
  await page.locator('#node-tool-form').selectOption({ label: 'Registry' });
  const nameInput = page.locator('#node-tool-registry');
  await expect(nameInput).toBeVisible();
  await nameInput.fill(name);
  await expect(nameInput).toHaveValue(name);
}

test('create an agent, hit an approval gate via chat, approve it, and complete the run', async ({ page }) => {
  const agentId = `e2e-approval-agent-${Date.now()}`;

  // The builder lives at `#/agents/:id/canvas`.
  await page.goto(`/${await builderHash(page)}`);
  await expect(page.locator('.app')).toBeVisible();

  // --- Create an agent from the "Support bot" template (trigger -> llm ->
  // tool -> output; its tool node starts pointed at 'http') ---
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(agentId);
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // --- Retarget the tool node at the local, always-needsApproval
  // 'demo-approval' tool, and save ---
  const toolNode = page.locator('[data-node-kind="tool"]');
  await expect(toolNode).toBeVisible();
  await toolNode.click();

  await selectLocalTool(page, 'demo-approval');

  // The new agent is a file in the server workspace, not a
  // browser-only entry.
  await expect
    .poll(async () => {
      const res = await page.request.get('/agents');
      return ((await res.json()) as { id: string }[]).map((a) => a.id);
    })
    .toContain(agentId);

  // --- Chat (no Run first - chat on a new agent works, and
  // sends the canvas's current spec): send a message mentioning the tool,
  // hitting the approval gate --- send a message mentioning the tool, hitting the approval gate ---
  const chatInput = page.locator('.chat-input');
  await expect(chatInput).toBeVisible();
  await chatInput.fill('Please call demo-approval to look something up for me.');
  await page.locator('.btn-send').click();

  const approvalCard = page.locator('.chat-approval-card');
  await expect(approvalCard).toBeVisible({ timeout: 15_000 });
  await expect(approvalCard).toContainText('demo-approval');

  // --- Approve via the chat's inline approval card ---
  await approvalCard.getByRole('button', { name: 'Approve', exact: true }).click();

  // --- The run resumes and completes: the approval card is gone, the input
  // is re-enabled, and the final assistant turn is in the transcript. ---
  await expect(approvalCard).toHaveCount(0, { timeout: 15_000 });
  await expect(chatInput).toBeEnabled();
  await expect(page.locator('.chat-msg.agent').last()).toBeVisible();
});

/** `inner` is drawn whole inside `outer` (not clipped by its overflow). */
async function expectInside(inner: ReturnType<Page['locator']>, outer: ReturnType<Page['locator']>) {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  expect(a && b).toBeTruthy();
  expect(a!.width).toBeGreaterThan(0);
  expect(a!.x).toBeGreaterThanOrEqual(b!.x - 0.5);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + b!.width + 0.5);
}

/**
 * R2: with a tool approval pending, the wide builder toolbar still links to the
 * run's trace (icon-only once the bar is short) and keeps the MOCK badge next to
 * the inline approval, at 1280 and at 1024 wide.
 */
test.fixme('a pending approval keeps "Open trace" and the MOCK badge in the toolbar at 1280 and 1024 wide (product bug: with the sidebar the toolbar is under 1180px, .topbar-left shrinks to ~74px and clips the trace link and the agent name)', async ({ page }) => {
  const agentId = `e2e-pending-trace-${Date.now()}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${await builderHash(page)}`);
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(agentId);
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('[data-node-kind="tool"]').click();
  await selectLocalTool(page, 'demo-approval');
  await page.locator('.chat-input').fill('Please call demo-approval to look something up for me.');
  await page.locator('.btn-send').click();

  const toolbar = page.locator('.topbar-builder');
  await expect(toolbar.locator('.approval-card-inline')).toBeVisible({ timeout: 15_000 });
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const trace = toolbar.getByRole('link', { name: 'Open trace', exact: true });
    await expect(trace).toBeVisible();
    await expect(trace).toHaveAttribute('href', /^#\/traces\/[^/]+$/);
    await expectInside(trace, toolbar.locator('.topbar-left'));
    const mock = toolbar.locator('.topbar-center .mock-badge');
    await expect(mock).toHaveText('MOCK');
    await expectInside(mock, toolbar.locator('.topbar-center'));
  }
});

/** F5: the builder lives at `#/agents/:id/canvas`; the hash names the open agent. */
async function createAgent(page: Page, id: string) {
  if ((await page.locator('.rail-new').count()) === 0) await page.goto(`/${await builderHash(page)}`);
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(id);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.crumbs b')).toHaveText(id);
}

test('selecting an agent updates the URL, a reload restores it, an unknown id falls back to #/agents', async ({ page }) => {
  const first = `e2e-url-a-${Date.now()}`;
  const second = `e2e-url-b-${Date.now()}`;
  await page.goto('/');
  await expect(page.locator('.app')).toBeVisible();

  await createAgent(page, first);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${first}/canvas$`));
  await createAgent(page, second);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));

  await page.locator('.agent-card-main', { hasText: first }).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${first}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(first);

  await page.reload();
  await expect(page.locator('.crumbs b')).toHaveText(first);
  await expect(page.locator('.agent-card.selected')).toContainText(first);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${first}/canvas$`));

  // The legacy `#/agents/:id` URL still opens the builder, redirected to its canvas tab.
  await page.goto(`/#/agents/${second}`);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(second);

  // Unknown id: no error screen; falls back to the agents list at #/agents.
  await page.goto('/#/agents/no-such-agent');
  await expect(page).toHaveURL(/#\/w\/[^/]+\/agents$/);
  await expect(page.locator('.agent-list-screen')).toBeVisible();

  // From the list an agent link opens its overview, whose Canvas tab opens the builder; Agents -> Traces -> Agents lands back on the list.
  await page.getByRole('link', { name: second, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/overview$`));
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('link', { name: 'Canvas' }).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(second);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Traces' }).click();
  await expect(page).toHaveURL(/#\/traces$/);
  await nav.getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page).toHaveURL(/#\/agents$/);
});

test('unsaved changes ask before switching agents or leaving Agents; cancelling keeps the URL', async ({ page }) => {
  const first = `e2e-dirty-a-${Date.now()}`;
  const second = `e2e-dirty-b-${Date.now()}`;
  await page.goto('/');
  await createAgent(page, first);
  await createAgent(page, second);

  // Fail autosave for the open agent so its edit stays unsaved.
  await page.route(`**/agents/${second}`, (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: 'no' }) : route.continue(),
  );
  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: 'Tool', exact: true }).click();
  await expect(page.locator('.dirty-dot').first()).toBeVisible();

  const dialogs: string[] = [];
  page.once('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Traces' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain(second);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.canvas-wrap')).toBeVisible();

  await page.getByRole('tab', { name: 'Agents' }).click();
  page.once('dialog', (d) => void d.dismiss());
  await page.locator('.agent-card-main', { hasText: first }).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(second);

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Traces' }).click();
  await expect(page).toHaveURL(/#\/traces$/);
  await expect(page.locator('.canvas-wrap')).toHaveCount(0);
});

test('a chat run shows a collapsed Setup line above the messages that expands to its detail', async ({ page }) => {
  const id = `e2e-setup-${Date.now()}`;
  const placeholder = 'JIRA_BASE_URL';
  await page.request.put(`/settings/secrets/${placeholder}`, { data: { value: 'https://e2e.invalid' } });
  await page.goto('/');
  await createAgent(page, id);

  await page.locator('.chat-input').fill('Hello there');
  await page.locator('.btn-send').click();

  const setup = page.locator('.chat-run-setup');
  await expect(setup).toBeVisible({ timeout: 15_000 });
  await expect(setup.locator('summary')).toHaveText(/^Setup · /);
  const above = await setup.evaluate((el) => {
    const list = document.querySelector('.chat-panel [role="log"]');
    return list !== null && Boolean(el.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(above).toBe(true);

  await setup.locator('summary').click();
  await expect(setup.locator('p')).toContainText('is missing its');
  await page.request.delete(`/settings/secrets/${placeholder}`);
});

test('deleting an agent confirms in the in-app dialog, Cancel keeps it and confirming removes it', async ({ page }) => {
  const id = `e2e-delete-${Date.now()}`;
  const browserDialogs: string[] = [];
  page.on('dialog', (d) => {
    browserDialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto('/');
  await createAgent(page, id);
  const savedIds = async () => ((await (await page.request.get('/agents')).json()) as { id: string }[]).map((a) => a.id);
  await expect.poll(savedIds).toContain(id);

  await page.getByRole('button', { name: `Delete ${id}`, exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: `Delete agent '${id}'?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await savedIds()).toContain(id);

  await page.getByRole('button', { name: `Delete ${id}`, exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete agent', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(savedIds).not.toContain(id);
  await expect(page.getByRole('button', { name: `Delete ${id}`, exact: true })).toHaveCount(0);
  expect(browserDialogs).toEqual([]);
});

test('Run with no typed input marks the chat "Run started" and adds no "Run the agent." bubble', async ({ page }) => {
  const id = `e2e-run-${Date.now()}`;
  await page.goto('/');
  await createAgent(page, id);

  await page.getByRole('button', { name: 'Run', exact: true }).click();

  const marker = page.locator('.chat-msg .chat-run-label', { hasText: 'Run started' });
  await expect(marker).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.chat-msg.user').getByText('Run the agent.')).toHaveCount(0);
  await expect(page.locator('.chat-msg.agent').last()).toBeVisible({ timeout: 15_000 });
});

test('Profile Connectors lists the connectors and an unconnected one offers Connect, with no outside requests besides fonts', async ({ page }) => {
  const outside: string[] = [];
  await page.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1',
    (route) => {
      outside.push(new URL(route.request().url()).hostname);
      return route.abort();
    },
  );
  await page.goto('/#/profile/connectors');

  await expect(page.getByRole('link', { name: 'Connectors', exact: true })).toBeVisible();
  const github = page.locator('.profile-row', { hasText: 'GitHub' }).first();
  await expect(github).toBeVisible();
  await expect(github.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(github.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  expect(outside.filter((host) => !/^fonts\.(googleapis|gstatic)\.com$/.test(host))).toEqual([]);
});
