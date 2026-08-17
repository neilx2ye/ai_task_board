import { describe, expect, it } from "vitest";

import {
  createSubtasksSchema,
  heartbeatClaimSchema,
  registerSessionSchema,
  reportCurrentTaskSchema,
  reportProgressSchema,
  reportSessionActivitySchema,
  syncSessionsSchema,
} from "@/lib/validation/ai";
import { artifactReferenceSchema } from "@/lib/validation/common";
import {
  createTaskSchema,
  createTurnPlanStepSchema,
  planningNotesQuerySchema,
  updateTaskSchema,
  updateTurnPlanStepSchema,
  upsertPlanningNotesSchema,
} from "@/lib/validation/user";

const taskId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

describe("AI command validation", () => {
  it("normalizes session text and supplies an empty capabilities list", () => {
    const parsed = registerSessionSchema.parse({
      name: "  Claude Research  ",
      platform: " claude ",
    });

    expect(parsed).toEqual({
      name: "Claude Research",
      platform: "claude",
      capabilities: [],
    });
  });

  it("normalizes a complete Bridge thread inventory", () => {
    const parsed = syncSessionsSchema.parse({
      bridge_version: "  0.2.0  ",
      threads: [
        {
          external_conversation_ref: "  thread-1  ",
          name: "  Main repository  ",
          working_directory: "  /srv/main  ",
        },
      ],
    });

    expect(parsed).toEqual({
      bridge_version: "0.2.0",
      threads: [
        {
          archived: false,
          capabilities: [],
          external_conversation_ref: "thread-1",
          name: "Main repository",
          platform: "codex",
          working_directory: "/srv/main",
        },
      ],
    });
    expect(
      syncSessionsSchema.parse({ bridge_version: "0.2.0", threads: [] }),
    ).toMatchObject({ threads: [] });
  });

  it("rejects duplicate local thread references in one snapshot", () => {
    expect(
      syncSessionsSchema.safeParse({
        bridge_version: "0.2.0",
        threads: [
          { external_conversation_ref: "same", name: "First" },
          { external_conversation_ref: "same", name: "Second" },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a provider-neutral quota snapshot in Bridge inventory", () => {
    const parsed = syncSessionsSchema.parse({
      bridge_version: "1.2.0",
      threads: [],
      quota: {
        provider: "codex",
        status: "ok",
        message: null,
        account: null,
        plan: "pro",
        fetched_at: "2026-08-17T00:00:00.000Z",
        buckets: [
          {
            id: "primary",
            label: "5 小时",
            remaining_percent: 62.5,
            used_percent: 37.5,
            limit: null,
            used: null,
            remaining: null,
            resets_at: "2026-08-17T04:00:00.000Z",
            unlimited: false,
            description: null,
          },
        ],
        credits: null,
      },
    });
    expect(parsed.quota?.buckets[0]?.remaining_percent).toBe(62.5);
  });

  it("normalizes an App Server model catalog and rejects duplicate models", () => {
    const model = {
      id: " custom-fast ",
      model: " provider/custom-fast ",
      display_name: " Custom Fast ",
      default_reasoning_effort: " balanced ",
      supported_reasoning_efforts: [
        { reasoning_effort: " quick ", description: " Fast response " },
        { reasoning_effort: " balanced ", description: null },
      ],
      input_modalities: [" text ", " image "],
      is_default: true,
    };
    const parsed = syncSessionsSchema.parse({
      bridge_version: "0.10.0",
      model_catalog: [model],
      threads: [],
    });

    expect(parsed.model_catalog).toEqual([{
      id: "custom-fast",
      model: "provider/custom-fast",
      display_name: "Custom Fast",
      description: null,
      default_reasoning_effort: "balanced",
      supported_reasoning_efforts: [
        { reasoning_effort: "quick", description: "Fast response" },
        { reasoning_effort: "balanced", description: null },
      ],
      input_modalities: ["text", "image"],
      is_default: true,
    }]);
    expect(
      syncSessionsSchema.safeParse({
        bridge_version: "0.10.0",
        model_catalog: [model, { ...model, id: "duplicate-id" }],
        threads: [],
      }).success,
    ).toBe(false);
  });

  it("rejects unrecognized fields instead of silently accepting workspace scope", () => {
    const result = reportCurrentTaskSchema.safeParse({
      title: "Already running",
      external_task_ref: "external-42",
      workspace_id: taskId,
    });

    expect(result.success).toBe(false);
  });

  it.each([-1, 101, 2.5])("rejects invalid progress estimate %s", (percent) => {
    const result = reportProgressSchema.safeParse({
      task_id: taskId,
      claim_token: "claim_secret",
      progress_note: "Working",
      progress_percent_estimate: percent,
    });

    expect(result.success).toBe(false);
  });

  it("requires a task claim when heartbeating a lease", () => {
    expect(
      heartbeatClaimSchema.safeParse({
        task_id: taskId,
        claim_token: "claim_secret",
        lease_seconds: 600,
      }).success,
    ).toBe(true);
    expect(heartbeatClaimSchema.safeParse({}).success).toBe(false);
  });

  it("accepts Harness summaries but rejects missing summary content", () => {
    expect(
      reportSessionActivitySchema.parse({
        task_id: taskId,
        claim_token: "claim_secret",
        kind: "reasoning",
        content: "Checked the failing tests",
        external_ref: "codex:item:reasoning-1",
      }),
    ).toMatchObject({ kind: "reasoning", data: {} });
    expect(
      reportSessionActivitySchema.safeParse({
        task_id: taskId,
        claim_token: "claim_secret",
        kind: "reasoning",
        external_ref: "codex:item:reasoning-2",
      }).success,
    ).toBe(false);
  });

  it("preserves streamed delta whitespace while trimming completed and legacy content", () => {
    const activity = {
      task_id: taskId,
      claim_token: "claim_secret",
      kind: "assistant_message" as const,
      external_ref: "codex:item:message-1",
    };
    const deltaData = {
      protocol: "codex-app-server/v1",
      phase: "delta",
    };

    expect(
      reportSessionActivitySchema.parse({
        ...activity,
        content: "Hello ",
        data: deltaData,
      }).content,
    ).toBe("Hello ");
    expect(
      reportSessionActivitySchema.parse({
        ...activity,
        content: " \n  ",
        data: deltaData,
      }).content,
    ).toBe(" \n  ");
    expect(
      reportSessionActivitySchema.parse({
        ...activity,
        content: "  completed answer  ",
        data: { ...deltaData, phase: "completed" },
      }).content,
    ).toBe("completed answer");
    expect(
      reportSessionActivitySchema.parse({
        ...activity,
        content: "  legacy answer  ",
      }).content,
    ).toBe("legacy answer");
    expect(
      reportSessionActivitySchema.safeParse({
        ...activity,
        content: "",
        data: deltaData,
      }).success,
    ).toBe(false);
    expect(
      reportSessionActivitySchema.safeParse({
        ...activity,
        content: " ".repeat(100_001),
        data: deltaData,
      }).success,
    ).toBe(false);
  });

  it("accepts a complete subtask batch with client-reference dependencies", () => {
    const parsed = createSubtasksSchema.parse({
      task_id: taskId,
      claim_token: "claim_secret",
      subtasks: [
        { client_ref: "collect", title: "Collect competitors" },
        {
          client_ref: "compare",
          title: "Compare pricing",
          depends_on: ["collect"],
        },
      ],
    });

    expect(parsed.subtasks[0]).toMatchObject({
      client_ref: "collect",
      depends_on: [],
      priority: 0,
      required_capabilities: [],
    });
    expect(parsed.subtasks[1].depends_on).toEqual(["collect"]);
  });

  it.each([
    [
      "duplicate client refs",
      [
        { client_ref: "same", title: "One" },
        { client_ref: "same", title: "Two" },
      ],
    ],
    [
      "unknown dependency refs",
      [{ client_ref: "one", title: "One", depends_on: ["missing"] }],
    ],
    [
      "self dependencies",
      [{ client_ref: "one", title: "One", depends_on: ["one"] }],
    ],
  ])("rejects %s before calling the database", (_label, subtasks) => {
    const result = createSubtasksSchema.safeParse({
      task_id: taskId,
      claim_token: "claim_secret",
      subtasks,
    });

    expect(result.success).toBe(false);
  });

  it("requires exactly one valid artifact location", () => {
    expect(
      artifactReferenceSchema.safeParse({
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 128,
      }).success,
    ).toBe(false);

    expect(
      artifactReferenceSchema.parse({
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 128,
        storage_path: `${taskId}/${taskId}/${artifactId}-report.pdf`,
      }),
    ).toMatchObject({ name: "report.pdf", size: 128 });

    expect(
      artifactReferenceSchema.safeParse({
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 128,
        storage_path: `${taskId}/${taskId}/report.pdf`,
      }).success,
    ).toBe(false);

    expect(
      artifactReferenceSchema.safeParse({
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 128,
        storage_path: `${taskId}/${taskId}/${artifactId}-report.pdf`,
        external_url: "https://example.com/report.pdf",
      }).success,
    ).toBe(false);
  });
});

describe("user command validation", () => {
  it("requires a target session and applies safe defaults", () => {
    const parsed = createTaskSchema.parse({
      title: "  Draft the report  ",
      assigned_session_id: sessionId,
    });

    expect(parsed).toEqual({
      title: "Draft the report",
      assigned_session_id: sessionId,
      priority: 0,
      required_capabilities: [],
    });
    expect(createTaskSchema.safeParse({ title: "Unassigned" }).success).toBe(false);
  });

  it("requires at least one editable field", () => {
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(updateTaskSchema.safeParse({ priority: 8 }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ assigned_session_id: null }).success).toBe(
      false,
    );
  });
});

describe("planning workspace validation", () => {
  it("accepts planning note upserts within limits", () => {
    const parsed = upsertPlanningNotesSchema.parse({
      connection_id: sessionId,
      directory_ref: " configured:main ",
      content: "一些想法",
    });

    expect(parsed.directory_ref).toBe("configured:main");
    expect(
      upsertPlanningNotesSchema.safeParse({
        connection_id: sessionId,
        directory_ref: " ",
        content: "",
      }).success,
    ).toBe(false);
  });

  it("requires connection and directory in planning note queries", () => {
    expect(
      planningNotesQuerySchema.safeParse({
        connection_id: sessionId,
        directory_ref: "path:/repo",
      }).success,
    ).toBe(true);
    expect(
      planningNotesQuerySchema.safeParse({ directory_ref: "path:/repo" })
        .success,
    ).toBe(false);
  });

  it("validates turn plan step drafts", () => {
    expect(createTurnPlanStepSchema.safeParse({ content: "第一步" }).success)
      .toBe(true);
    expect(createTurnPlanStepSchema.safeParse({ content: "  " }).success).toBe(
      false,
    );
    expect(
      createTurnPlanStepSchema.safeParse({
        content: "x",
        model: "gpt-5.6-sol",
        reasoning_effort: "max",
      }).success,
    ).toBe(true);
    expect(
      createTurnPlanStepSchema.safeParse({ content: "x", position: 1 }).success,
    ).toBe(false);
  });

  it("requires at least one turn plan patch field", () => {
    expect(updateTurnPlanStepSchema.safeParse({}).success).toBe(false);
    expect(updateTurnPlanStepSchema.safeParse({ position: 2048 }).success).toBe(
      true,
    );
    expect(
      updateTurnPlanStepSchema.safeParse({ position: 1.5 }).success,
    ).toBe(false);
  });
});
