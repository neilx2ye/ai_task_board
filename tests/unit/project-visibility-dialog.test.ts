// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectVisibilityDialog,
  type ProjectEditInput,
} from "@/components/project-visibility-dialog";
import type { SessionProjectGroup } from "@/lib/domain/session-directory-groups";

const projects: SessionProjectGroup[] = [
  {
    id: "path:/workspace/app",
    name: "主应用",
    workingDirectory: "/workspace/app",
    sessionCount: 3,
    runningTaskCount: 2,
    unviewedCompletedCount: 1,
  },
  {
    id: "unassigned",
    name: "未归类",
    workingDirectory: null,
    sessionCount: 1,
    runningTaskCount: 0,
    unviewedCompletedCount: 0,
  },
];

function renderDialog({
  onUpdate = vi.fn(),
  onToggle = vi.fn(),
  onToggleRemoved = vi.fn(),
  removedProjectIds = new Set<string>(),
}: {
  onUpdate?: (
    project: SessionProjectGroup,
    input: ProjectEditInput,
  ) => Promise<void>;
  onToggle?: (projectId: string, hidden: boolean) => void;
  onToggleRemoved?: (projectId: string, removed: boolean) => void;
  removedProjectIds?: ReadonlySet<string>;
} = {}) {
  return render(
    createElement(ProjectVisibilityDialog, {
      projects,
      hiddenProjectIds: new Set<string>(),
      removedProjectIds,
      onToggle,
      onToggleRemoved,
      onUpdate,
      open: true,
      onOpenChange: vi.fn(),
    }),
  );
}

describe("project management dialog", () => {
  it("renders edit and visibility controls for every project", () => {
    renderDialog();

    expect(
      screen.getByRole("heading", { name: "管理项目" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "编辑项目「主应用」" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "隐藏项目「主应用」" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "删除项目「主应用」" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "编辑项目「未归类」" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
  });

  it("submits the edited name and absolute path", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onUpdate });

    fireEvent.click(
      screen.getByRole("button", { name: "编辑项目「主应用」" }),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "重命名应用" },
    });
    fireEvent.change(screen.getByLabelText("项目路径（绝对路径）"), {
      target: { value: "/workspace/renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(projects[0], {
        name: "重命名应用",
        workingDirectory: "/workspace/renamed",
      });
    });
  });

  it("rejects a blank name and a relative path without submitting", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onUpdate });

    fireEvent.click(
      screen.getByRole("button", { name: "编辑项目「主应用」" }),
    );
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "请输入项目名称",
    );

    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "重命名应用" },
    });
    fireEvent.change(screen.getByLabelText("项目路径（绝对路径）"), {
      target: { value: "workspace/renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "项目路径必须是绝对路径",
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("removes a project from the manage list without touching the real project", () => {
    const onToggleRemoved = vi.fn();
    renderDialog({ onToggleRemoved });

    fireEvent.click(
      screen.getByRole("button", { name: "删除项目「主应用」" }),
    );
    expect(onToggleRemoved).toHaveBeenCalledWith("path:/workspace/app", true);
  });

  it("lists removed projects with a restore action", () => {
    const onToggleRemoved = vi.fn();
    renderDialog({
      onToggleRemoved,
      removedProjectIds: new Set(["path:/workspace/app"]),
    });

    expect(
      screen.queryByRole("button", { name: "编辑项目「主应用」" }),
    ).toBeNull();
    expect(screen.getByLabelText("已删除的项目")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "恢复项目「主应用」" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "恢复项目「主应用」" }),
    );
    expect(onToggleRemoved).toHaveBeenCalledWith("path:/workspace/app", false);
  });
});
