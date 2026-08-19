import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const ownerContext = { role: "owner" as const, userId, workspaceId };

const domainMocks = vi.hoisted(() => ({
  createProjectOnBridges: vi.fn(),
  deleteProjectOnBridges: vi.fn(),
  updateProjectOnBridges: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  ownerContextForRequest: vi.fn(),
}));

vi.mock("@/lib/domain/projects", () => ({
  createProjectOnBridges: domainMocks.createProjectOnBridges,
  deleteProjectOnBridges: domainMocks.deleteProjectOnBridges,
  updateProjectOnBridges: domainMocks.updateProjectOnBridges,
}));
vi.mock("@/lib/http/user-route", () => ({
  ownerContextForRequest: authMocks.ownerContextForRequest,
}));

import {
  DELETE as deleteProject,
  PATCH as updateProject,
  POST as createProject,
} from "@/app/api/user/projects/route";
import { AppError } from "@/lib/domain/errors";

function jsonRequest(
  pathname: string,
  body: unknown,
  options: { headers?: Record<string, string>; method?: string } = {},
) {
  return new Request(`http://localhost${pathname}`, {
    method: options.method ?? "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  name: "Main app",
  working_directory: "/srv/main",
  connection_ids: [connectionId],
};

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.ownerContextForRequest.mockResolvedValue(ownerContext);
  domainMocks.createProjectOnBridges.mockResolvedValue({
    results: [
      {
        connection_id: connectionId,
        connection_name: "Laptop",
        status: "submitted",
      },
    ],
  });
  domainMocks.updateProjectOnBridges.mockResolvedValue({
    results: [
      {
        connection_id: connectionId,
        connection_name: "Laptop",
        status: "submitted",
      },
    ],
  });
  domainMocks.deleteProjectOnBridges.mockResolvedValue({
    results: [
      {
        connection_id: connectionId,
        connection_name: "Laptop",
        status: "submitted",
      },
    ],
    deleted_directory_rows: 1,
    detached_sessions: 2,
  });
});

describe("owner project creation API", () => {
  it("dispatches the validated input through the owner-only data layer", async () => {
    const request = jsonRequest("/api/user/projects", validBody, {
      headers: { "Idempotency-Key": " web/projects/1 " },
    });
    const response = await createProject(request);

    expect(response.status).toBe(200);
    expect(authMocks.ownerContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.createProjectOnBridges).toHaveBeenCalledWith(
      ownerContext,
      validBody,
      "web/projects/1",
    );
    expect(await response.json()).toEqual({
      data: {
        results: [
          expect.objectContaining({
            connection_id: connectionId,
            status: "submitted",
          }),
        ],
      },
    });
  });

  it("requires an idempotency key", async () => {
    const response = await createProject(
      jsonRequest("/api/user/projects", validBody),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.createProjectOnBridges).not.toHaveBeenCalled();
  });

  it("rejects relative paths and empty connection lists", async () => {
    for (const body of [
      { ...validBody, working_directory: "srv/main" },
      { ...validBody, connection_ids: [] },
    ]) {
      const response = await createProject(
        jsonRequest("/api/user/projects", body, {
          headers: { "Idempotency-Key": "web/projects/invalid" },
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(domainMocks.createProjectOnBridges).not.toHaveBeenCalled();
  });

  it("maps non-owner access to 403", async () => {
    authMocks.ownerContextForRequest.mockRejectedValue(
      new AppError("FORBIDDEN", "Workspace owner access is required"),
    );

    const response = await createProject(
      jsonRequest("/api/user/projects", validBody, {
        headers: { "Idempotency-Key": "web/projects/forbidden" },
      }),
    );

    expect(response.status).toBe(403);
    expect(domainMocks.createProjectOnBridges).not.toHaveBeenCalled();
  });
});

const validUpdateBody = {
  working_directory: "/srv/main",
  name: "Main app renamed",
  new_working_directory: "/srv/main-app",
};

describe("owner project update API", () => {
  it("dispatches the validated update through the owner-only data layer", async () => {
    const request = jsonRequest("/api/user/projects", validUpdateBody, {
      headers: { "Idempotency-Key": " web/projects/update " },
    });
    const response = await updateProject(request);

    expect(response.status).toBe(200);
    expect(authMocks.ownerContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.updateProjectOnBridges).toHaveBeenCalledWith(
      ownerContext,
      validUpdateBody,
      "web/projects/update",
    );
    expect(await response.json()).toEqual({
      data: {
        results: [
          expect.objectContaining({
            connection_id: connectionId,
            status: "submitted",
          }),
        ],
      },
    });
  });

  it("requires an idempotency key", async () => {
    const response = await updateProject(
      jsonRequest("/api/user/projects", validUpdateBody),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.updateProjectOnBridges).not.toHaveBeenCalled();
  });

  it("rejects relative paths and empty names", async () => {
    for (const body of [
      { ...validUpdateBody, working_directory: "srv/main" },
      { ...validUpdateBody, new_working_directory: "srv/main-app" },
      { ...validUpdateBody, name: "  " },
    ]) {
      const response = await updateProject(
        jsonRequest("/api/user/projects", body, {
          headers: { "Idempotency-Key": "web/projects/update" },
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(domainMocks.updateProjectOnBridges).not.toHaveBeenCalled();
  });

  it("maps non-owner access to 403", async () => {
    authMocks.ownerContextForRequest.mockRejectedValue(
      new AppError("FORBIDDEN", "Workspace owner access is required"),
    );

    const response = await updateProject(
      jsonRequest("/api/user/projects", validUpdateBody, {
        headers: { "Idempotency-Key": "web/projects/update" },
      }),
    );

    expect(response.status).toBe(403);
    expect(domainMocks.updateProjectOnBridges).not.toHaveBeenCalled();
  });
});

const validDeleteBody = {
  working_directory: "/srv/main",
};

describe("owner project deletion API", () => {
  it("dispatches the validated deletion through the owner-only data layer", async () => {
    const request = jsonRequest(
      "/api/user/projects",
      validDeleteBody,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": " web/projects/delete " },
      },
    );
    const response = await deleteProject(request);

    expect(response.status).toBe(200);
    expect(authMocks.ownerContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.deleteProjectOnBridges).toHaveBeenCalledWith(
      ownerContext,
      validDeleteBody,
      "web/projects/delete",
    );
    expect(await response.json()).toEqual({
      data: {
        results: [
          expect.objectContaining({
            connection_id: connectionId,
            status: "submitted",
          }),
        ],
        deleted_directory_rows: 1,
        detached_sessions: 2,
      },
    });
  });

  it("requires an idempotency key", async () => {
    const response = await deleteProject(
      jsonRequest("/api/user/projects", validDeleteBody, {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.deleteProjectOnBridges).not.toHaveBeenCalled();
  });

  it("rejects relative paths", async () => {
    const response = await deleteProject(
      jsonRequest(
        "/api/user/projects",
        { working_directory: "srv/main" },
        {
          method: "DELETE",
          headers: { "Idempotency-Key": "web/projects/delete" },
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.deleteProjectOnBridges).not.toHaveBeenCalled();
  });

  it("maps non-owner access to 403", async () => {
    authMocks.ownerContextForRequest.mockRejectedValue(
      new AppError("FORBIDDEN", "Workspace owner access is required"),
    );

    const response = await deleteProject(
      jsonRequest("/api/user/projects", validDeleteBody, {
        method: "DELETE",
        headers: { "Idempotency-Key": "web/projects/delete" },
      }),
    );

    expect(response.status).toBe(403);
    expect(domainMocks.deleteProjectOnBridges).not.toHaveBeenCalled();
  });
});
