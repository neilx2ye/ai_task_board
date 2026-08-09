import { expect, test, type Page } from "@playwright/test";

const e2eEmail = process.env.E2E_USER_EMAIL?.trim();
const e2ePassword = process.env.E2E_USER_PASSWORD?.trim();

type JsonObject = Record<string, unknown>;
type JsonResponse = {
  json(): Promise<unknown>;
  ok(): boolean;
  status(): number;
  url(): string;
};

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be an array`);
  return value;
}

function stringValue(value: JsonObject, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) {
    throw new Error(`Expected ${key} to be a non-empty string`);
  }
  return result;
}

async function responseData(response: JsonResponse, label: string): Promise<JsonObject> {
  const payload = objectValue(await response.json(), `${label} response`);
  expect(
    response.ok(),
    `${label} failed with HTTP ${response.status()} at ${response.url()}`,
  ).toBe(true);
  return objectValue(payload.data, `${label} response.data`);
}

function flowKey(runId: string, step: string): string {
  return `e2e/full-flow/${runId}/${step}`;
}

async function aiPost(
  page: Page,
  input: {
    token: string;
    sessionId?: string;
    path: string;
    body: unknown;
    idempotencyKey: string;
  },
): Promise<JsonObject> {
  const response = await page.request.post(input.path, {
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Idempotency-Key": input.idempotencyKey,
      ...(input.sessionId ? { "X-AI-Session-ID": input.sessionId } : {}),
    },
    data: input.body,
  });
  return responseData(response, input.path);
}

async function aiGetTask(
  page: Page,
  token: string,
  sessionId: string,
  taskId: string,
): Promise<JsonObject> {
  const response = await page.request.get(`/api/ai/tasks/${taskId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-AI-Session-ID": sessionId,
    },
  });
  return responseData(response, `GET task ${taskId}`);
}

async function userGetTask(page: Page, taskId: string): Promise<JsonObject> {
  const response = await page.request.get(`/api/user/tasks/${taskId}`);
  return responseData(response, `GET user task ${taskId}`);
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(e2eEmail!);
  await page.getByLabel("密码").fill(e2ePassword!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "AI 会话" })).toBeVisible();
}

async function createTaskFromBoard(
  page: Page,
  title: string,
  options: {
    description?: string;
    acceptanceCriteria?: string;
    requiredCapabilities?: string[];
  } = {},
): Promise<string> {
  await page.goto("/board");
  await page.getByRole("button", { name: /预留任务/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建任务" });
  await dialog.getByLabel("标题").fill(title);
  await dialog
    .getByLabel("说明")
    .fill(options.description ?? "Playwright hosted-project attachment test");
  if (options.acceptanceCriteria) {
    await dialog.getByLabel("验收条件").fill(options.acceptanceCriteria);
  }
  if (options.requiredCapabilities?.length) {
    await dialog.getByLabel("所需能力").fill(options.requiredCapabilities.join(", "));
  }
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/user/tasks",
  );
  await dialog.getByRole("button", { name: "预留任务" }).click();
  const createdTask = await responseData(await createResponsePromise, "create task");
  await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
  return stringValue(createdTask, "id");
}

async function createConnectionToken(page: Page, name: string): Promise<string> {
  await page.goto("/connections");
  await page.getByRole("button", { name: "新建连接" }).first().click();
  const createDialog = page.getByRole("dialog", { name: "新建 AI 连接" });
  await createDialog.getByLabel("名称").fill(name);
  await createDialog.getByRole("button", { name: "创建并生成令牌" }).click();

  const tokenDialog = page.getByRole("dialog", { name: "连接令牌（仅显示一次）" });
  await expect(tokenDialog).toBeVisible({ timeout: 15_000 });
  const token = (await tokenDialog.locator("code").textContent())?.trim() ?? "";
  expect(token).toMatch(/^atb_[A-Za-z0-9_-]{43}$/);
  await tokenDialog.getByRole("button", { name: "关闭并丢弃显示" }).click();
  await expect(tokenDialog).toBeHidden();
  return token;
}

async function createLiveSession(page: Page, label: string): Promise<{
  token: string;
  sessionId: string;
}> {
  const token = await createConnectionToken(page, `E2E ${label} connection`);
  const registration = await aiPost(page, {
    token,
    path: "/api/ai/sessions/register",
    body: {
      name: `E2E ${label} session`,
      platform: "playwright",
      external_conversation_ref: `e2e:${label}:${Date.now()}`,
      capabilities: [],
    },
    idempotencyKey: `e2e/${label}/register/${Date.now()}`,
  });
  return {
    token,
    sessionId: stringValue(objectValue(registration.session, "session"), "id"),
  };
}

test("shows an actionable startup screen", async ({ page }) => {
  await page.goto("/login");

  const loginHeading = page.getByRole("heading", { name: "AI Task Board" });
  const notConfiguredHeading = page.getByRole("heading", {
    name: "尚未配置 Supabase",
  });
  await expect(loginHeading.or(notConfiguredHeading)).toBeVisible();

  if (await loginHeading.isVisible()) {
    await expect(page.getByRole("heading", { name: "AI Task Board" })).toBeVisible();
    await expect(page.getByLabel("邮箱")).toBeVisible();
    await expect(page.getByLabel("密码")).toBeVisible();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
  } else {
    await expect(page.getByRole("heading", { name: "尚未配置 Supabase" })).toBeVisible();
    await expect(page.getByText("NEXT_PUBLIC_SUPABASE_URL", { exact: true })).toBeVisible();
    await expect(
      page.getByText("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", { exact: true }),
    ).toBeVisible();
  }
});

test("creates a task, survives refresh, and appears in a second browser via Realtime", async ({
  browser,
}) => {
  test.skip(
    !e2eEmail || !e2ePassword,
    "Set E2E_USER_EMAIL/E2E_USER_PASSWORD and point the app at a hosted test project",
  );

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();

  try {
    await Promise.all([signIn(firstPage), signIn(secondPage)]);
    await createLiveSession(firstPage, `realtime-${Date.now()}`);
    await secondPage.goto("/board");
    const title = `E2E realtime ${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await createTaskFromBoard(firstPage, title, {
      description: "Playwright hosted-project smoke test",
      acceptanceCriteria: "Visible after refresh and in another browser",
    });

    await expect(firstPage.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(secondPage.getByText(title, { exact: true })).toBeVisible({ timeout: 20_000 });

    await firstPage.reload();
    await expect(firstPage.getByText(title, { exact: true })).toBeVisible({ timeout: 15_000 });
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test("shows a connection token once and revokes the connection", async ({ page }) => {
  test.skip(
    !e2eEmail || !e2ePassword,
    "Set E2E_USER_EMAIL/E2E_USER_PASSWORD and point the app at a hosted test project",
  );

  await signIn(page);
  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "AI 连接" })).toBeVisible();

  const connectionName = `E2E connection ${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await page.getByRole("button", { name: "新建连接" }).first().click();
  const createDialog = page.getByRole("dialog", { name: "新建 AI 连接" });
  await createDialog.getByLabel("名称").fill(connectionName);
  await createDialog.getByRole("button", { name: "创建并生成令牌" }).click();

  const tokenDialog = page.getByRole("dialog", { name: "连接令牌（仅显示一次）" });
  await expect(tokenDialog).toBeVisible({ timeout: 15_000 });
  const token = (await tokenDialog.locator("code").textContent())?.trim() ?? "";
  expect(token).toMatch(/^atb_[A-Za-z0-9_-]{43}$/);
  await tokenDialog.getByRole("button", { name: "关闭并丢弃显示" }).click();

  await expect(tokenDialog).toBeHidden();
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);

  const connectionCard = page
    .getByText(connectionName, { exact: true })
    .locator("xpath=ancestor::*[@data-slot='card'][1]");
  await connectionCard.getByRole("button", { name: "撤销", exact: true }).click();
  const revokeDialog = page.getByRole("dialog", { name: "撤销该连接？" });
  await revokeDialog.getByRole("button", { name: "确认撤销", exact: true }).click();

  // 撤销成功后整张连接卡立即消失（mutation 会同步移除缓存项并 invalidate）。
  await expect(page.getByText(connectionName, { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByText("已撤销", { exact: true })).toHaveCount(0);
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);

  // 刷新后被撤销的连接依然不出现——服务端数据同样被前端防御性过滤。
  await page.reload();
  await expect(page.getByRole("heading", { name: "AI 连接" })).toBeVisible();
  await expect(page.getByText(connectionName, { exact: true })).toHaveCount(0);
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);

  const revokedRequest = await page.request.post("/api/ai/sessions/register", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": `e2e/revoked/${Date.now()}`,
    },
    data: {
      name: "Must not register",
      platform: "e2e",
      capabilities: [],
    },
  });
  expect(revokedRequest.status()).toBe(401);
  expect(await revokedRequest.json()).toMatchObject({
    error: { code: "AUTHENTICATION_REQUIRED" },
  });
});

test("uploads a private attachment and requests an authorized download URL", async ({ page }) => {
  test.skip(
    !e2eEmail || !e2ePassword,
    "Set E2E_USER_EMAIL/E2E_USER_PASSWORD and point the app at a hosted test project",
  );

  await signIn(page);
  await createLiveSession(page, `attachment-${Date.now()}`);
  const taskTitle = `E2E attachment ${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createTaskFromBoard(page, taskTitle);
  await page.getByText(taskTitle, { exact: true }).click();
  await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();

  const fileName = `e2e-${Date.now()}.txt`;
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from("private Playwright artifact"),
  });
  await expect(page.getByText(fileName, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "上传", exact: true }).click();

  const artifactItem = page.getByRole("listitem").filter({ hasText: fileName });
  await expect(artifactItem).toBeVisible({ timeout: 15_000 });
  await expect(artifactItem).toContainText("text/plain");

  await page.evaluate(() => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: () => ({
        location: {
          set href(url: string) {
            (window as Window & { __e2eOpenedUrl?: string }).__e2eOpenedUrl = url;
          },
        },
        close: () => undefined,
      }),
    });
  });
  const downloadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/api\/user\/artifacts\/[^/]+\/download$/.test(new URL(response.url()).pathname),
  );
  await artifactItem.getByRole("button", { name: "下载", exact: true }).click();
  const downloadResponse = await downloadResponsePromise;
  expect(downloadResponse.status()).toBe(200);
  const downloadBody = (await downloadResponse.json()) as {
    data?: { url?: string; expires_in?: number };
  };
  expect(downloadBody.data?.expires_in).toBe(60);
  expect(downloadBody.data?.url).toContain("/storage/v1/object/sign/task-artifacts/");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __e2eOpenedUrl?: string }).__e2eOpenedUrl ?? "",
      ),
    )
    .toBe(downloadBody.data?.url);
});

test("runs a five-step AI workflow through decomposition, cross-browser reply, and completion", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !e2eEmail || !e2ePassword,
    "Set E2E_USER_EMAIL/E2E_USER_PASSWORD and point the app at a hosted test project",
  );

  const controlContext = await browser.newContext();
  const replyContext = await browser.newContext();
  const controlPage = await controlContext.newPage();
  const replyPage = await replyContext.newPage();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requiredCapability = `e2e-full-flow-${runId}`;
  const rootTitle = `E2E full workflow ${runId}`;
  const connectionName = `E2E full-flow connection ${runId}`;
  const question = `E2E ${runId}: which audience should the final report target?`;
  const answer = `E2E ${runId}: target the engineering leadership team.`;
  const artifactName = `e2e-full-flow-${runId}.json`;
  const artifactUrl = `https://example.invalid/e2e/${runId}/${artifactName}`;

  try {
    await Promise.all([signIn(controlPage), signIn(replyPage)]);

    // The browser creates the only credential used by the simulated AI. Its raw
    // value is read from the one-time dialog and never persisted by the test.
    const connectionToken = await createConnectionToken(controlPage, connectionName);
    const registration = await aiPost(controlPage, {
      token: connectionToken,
      path: "/api/ai/sessions/register",
      body: {
        name: `Playwright Agent ${runId}`,
        platform: "playwright",
        model: "deterministic-e2e",
        external_conversation_ref: `playwright-full-flow:${runId}`,
        capabilities: [requiredCapability],
      },
      idempotencyKey: flowKey(runId, "register-session"),
    });
    const sessionId = stringValue(
      objectValue(registration.session, "registration.session"),
      "id",
    );

    const rootTaskId = await createTaskFromBoard(controlPage, rootTitle, {
      description: "Playwright end-to-end dependency and user-question workflow",
      acceptanceCriteria: "All five dependent leaves complete after a user reply",
      requiredCapabilities: [requiredCapability],
    });

    const rootClaim = await aiPost(controlPage, {
      token: connectionToken,
      sessionId,
      path: "/api/ai/tasks/claim",
      body: { task_id: rootTaskId, lease_seconds: 900 },
      idempotencyKey: flowKey(runId, "claim-root"),
    });
    const claimedRoot = objectValue(rootClaim.task, "root claim task");
    expect(claimedRoot.status).toBe("claimed");
    const rootClaimToken = stringValue(claimedRoot, "claim_token");

    const leafTitles = [
      `Collect sources ${runId}`,
      `Normalize evidence ${runId}`,
      `Compare alternatives ${runId}`,
      `Draft findings ${runId}`,
      `Finalize report ${runId}`,
    ];
    const split = await aiPost(controlPage, {
      token: connectionToken,
      sessionId,
      path: "/api/ai/tasks/create-subtasks",
      body: {
        task_id: rootTaskId,
        claim_token: rootClaimToken,
        subtasks: leafTitles.map((title, index) => ({
          client_ref: `step-${index + 1}`,
          title,
          description: `E2E dependency step ${index + 1}`,
          acceptance_criteria: `Step ${index + 1} is completed in order`,
          priority: 100 - index,
          position: index,
          required_capabilities: [requiredCapability],
          depends_on: index === 0 ? [] : [`step-${index}`],
        })),
      },
      idempotencyKey: flowKey(runId, "split-root"),
    });
    const leaves = arrayValue(split.subtasks, "split.subtasks").map((task, index) =>
      objectValue(task, `split.subtasks[${index}]`),
    );
    expect(leaves).toHaveLength(5);
    expect(leaves.map((task) => task.status)).toEqual([
      "ready",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
    ]);
    const leafIds = leaves.map((task) => stringValue(task, "id"));
    const completionMessages = leafTitles.map(
      (_title, index) => `E2E ${runId}: completed dependency step ${index + 1}.`,
    );

    const claimLeaf = async (index: number, step: string): Promise<JsonObject> => {
      const beforeClaim = await aiGetTask(
        controlPage,
        connectionToken,
        sessionId,
        leafIds[index],
      );
      expect(objectValue(beforeClaim.task, `leaf ${index + 1} before claim`).status).toBe(
        "ready",
      );
      const claim = await aiPost(controlPage, {
        token: connectionToken,
        sessionId,
        path: "/api/ai/tasks/claim",
        body: { task_id: leafIds[index], lease_seconds: 900 },
        idempotencyKey: flowKey(runId, step),
      });
      const task = objectValue(claim.task, `leaf ${index + 1} claim`);
      expect(task).toMatchObject({ id: leafIds[index], status: "claimed" });
      return task;
    };

    // Complete four leaves individually. A successful next claim plus the
    // pre-claim status assertion proves each dependency was unblocked in order.
    for (let index = 0; index < 4; index += 1) {
      const claimedLeaf = await claimLeaf(index, `claim-leaf-${index + 1}`);
      const completion = await aiPost(controlPage, {
        token: connectionToken,
        sessionId,
        path: "/api/ai/tasks/complete",
        body: {
          task_id: leafIds[index],
          claim_token: stringValue(claimedLeaf, "claim_token"),
          result_summary: `Dependency step ${index + 1} completed`,
          result_json: { e2e_run_id: runId, step: index + 1 },
          message: completionMessages[index],
          artifacts: [],
        },
        idempotencyKey: flowKey(runId, `complete-leaf-${index + 1}`),
      });
      expect(objectValue(completion.task, `leaf ${index + 1} completion`).status).toBe(
        "completed",
      );
    }

    const finalClaim = await claimLeaf(4, "claim-leaf-5-before-question");
    const waiting = await aiPost(controlPage, {
      token: connectionToken,
      sessionId,
      path: "/api/ai/tasks/request-user-input",
      body: {
        task_id: leafIds[4],
        claim_token: stringValue(finalClaim, "claim_token"),
        question,
      },
      idempotencyKey: flowKey(runId, "request-user-input"),
    });
    expect(objectValue(waiting.task, "waiting leaf").status).toBe("waiting_user");

    const waitingRoot = await userGetTask(replyPage, rootTaskId);
    expect(objectValue(waitingRoot.task, "waiting root").status).toBe("waiting_user");

    // A separately authenticated browser opens the waiting ROOT detail and
    // replies there. The detail view aggregates descendant messages, locates
    // the pending leaf question, and routes the reply to the leaf that owns
    // it — the POST must hit the leaf reply endpoint, not the root's.
    await replyPage.goto(`/tasks/${rootTaskId}`);
    await expect(replyPage.getByRole("heading", { name: rootTitle })).toBeVisible();
    await expect(replyPage.getByText(question, { exact: true })).toBeVisible();
    // The descendant hint names the waiting leaf and links to it.
    const descendantLink = replyPage.getByRole("link", {
      name: `「${leafTitles[4]}」`,
    });
    await expect(descendantLink).toBeVisible();
    await expect(descendantLink).toHaveAttribute("href", `/tasks/${leafIds[4]}`);
    await replyPage.getByLabel("回复 AI 的问题").fill(answer);
    const replyResponsePromise = replyPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/user/tasks/${leafIds[4]}/reply`,
    );
    await replyPage.getByRole("button", { name: "回复并恢复任务" }).click();
    const replyResult = await responseData(await replyResponsePromise, "reply to final leaf");
    expect(objectValue(replyResult.task, "replied leaf").status).toBe("ready");
    await expect(replyPage.getByText(answer, { exact: true })).toBeVisible({ timeout: 15_000 });

    const reclaimedFinal = await claimLeaf(4, "reclaim-leaf-5-after-reply");
    const finalCompletion = await aiPost(controlPage, {
      token: connectionToken,
      sessionId,
      path: "/api/ai/tasks/complete",
      body: {
        task_id: leafIds[4],
        claim_token: stringValue(reclaimedFinal, "claim_token"),
        result_summary: "Final report completed after user confirmation",
        result_json: { e2e_run_id: runId, step: 5, audience: "engineering leadership" },
        message: completionMessages[4],
        artifacts: [
          {
            name: artifactName,
            mime_type: "application/json",
            size: 128,
            external_url: artifactUrl,
          },
        ],
      },
      idempotencyKey: flowKey(runId, "complete-leaf-5"),
    });
    expect(objectValue(finalCompletion.task, "final completion task").status).toBe(
      "completed",
    );

    // The user detail endpoint deliberately aggregates descendant activity for
    // a root task. Assert the complete tree and all three activity collections.
    const finalDetails = await userGetTask(controlPage, rootTaskId);
    expect(objectValue(finalDetails.task, "final root").status).toBe("completed");
    const children = arrayValue(finalDetails.children, "final root children").map(
      (task, index) => objectValue(task, `final root child ${index}`),
    );
    const descendants = arrayValue(finalDetails.descendants, "final root descendants").map(
      (task, index) => objectValue(task, `final root descendant ${index}`),
    );
    expect(children).toHaveLength(5);
    expect(descendants).toHaveLength(5);
    expect(descendants.map((task) => task.id).sort()).toEqual([...leafIds].sort());
    expect(descendants.every((task) => task.status === "completed")).toBe(true);

    const messages = arrayValue(finalDetails.messages, "aggregated messages").map(
      (message, index) => objectValue(message, `aggregated message ${index}`),
    );
    const messageContents = messages.map((message) => stringValue(message, "content"));
    expect(messageContents).toEqual(
      expect.arrayContaining([...completionMessages, question, answer]),
    );

    const events = arrayValue(finalDetails.events, "aggregated events").map((event, index) =>
      objectValue(event, `aggregated event ${index}`),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task_split",
        "task_claimed",
        "user_input_requested",
        "user_replied",
        "task_completed",
      ]),
    );

    const artifacts = arrayValue(finalDetails.artifacts, "aggregated artifacts").map(
      (artifact, index) => objectValue(artifact, `aggregated artifact ${index}`),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      task_id: leafIds[4],
      name: artifactName,
      mime_type: "application/json",
      size: 128,
      external_url: artifactUrl,
    });

    // The board computes recursive leaf progress from the full flat task list.
    await controlPage.goto("/board");
    const rootCard = controlPage
      .getByText(rootTitle, { exact: true })
      .locator("xpath=ancestor::*[@data-slot='card'][1]");
    await expect(rootCard).toBeVisible({ timeout: 15_000 });
    await expect(rootCard.getByText("已完成", { exact: true })).toBeVisible();
    const leafProgress = rootCard.getByRole("progressbar", {
      name: "叶子任务完成进度",
    });
    await expect(leafProgress).toHaveAttribute("aria-valuenow", "5");
    await expect(leafProgress).toHaveAttribute("aria-valuemax", "5");
    await expect(rootCard.getByText("5 / 5", { exact: true })).toBeVisible();

    // The root detail view also renders descendant messages, events and files.
    await controlPage.goto(`/tasks/${rootTaskId}`);
    await expect(controlPage.getByRole("heading", { name: rootTitle })).toBeVisible();
    await expect(controlPage.getByText(question, { exact: true })).toBeVisible();
    await expect(controlPage.getByText(answer, { exact: true })).toBeVisible();
    await expect(controlPage.getByText(artifactName, { exact: true })).toBeVisible();
    await expect(controlPage.getByText("用户已回复", { exact: true })).toBeVisible();
  } finally {
    await Promise.all([controlContext.close(), replyContext.close()]);
  }
});
