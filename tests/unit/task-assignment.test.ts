import { describe, expect, it } from "vitest";

import {
  isSessionSelectLocked,
  resolveAssignedSessionPatch,
  sessionOptionsForStatus,
  type AssignmentContext,
  type AssignmentInput,
  type AssignmentPatch,
} from "@/hooks/task-assignment";
import type { TaskStatus } from "@/lib/types/database";

type Case = AssignmentInput & {
  name: string;
  expected: AssignmentPatch;
};

const base: AssignmentInput = {
  isEdit: true,
  status: "ready",
  hasChildren: false,
  original: null,
  selected: null,
};

const CASES: Case[] = [
  {
    ...base,
    name: "新建：未指派也包含（发送 null）",
    isEdit: false,
    status: "inbox",
    expected: { include: true, value: null },
  },
  {
    ...base,
    name: "新建：包含所选会话",
    isEdit: false,
    status: "inbox",
    selected: "s-1",
    expected: { include: true, value: "s-1" },
  },
  {
    ...base,
    name: "编辑 ready：未变化时省略",
    original: "s-1",
    selected: "s-1",
    expected: { include: false },
  },
  {
    ...base,
    name: "编辑 ready：改派时包含新值",
    original: "s-1",
    selected: "s-2",
    expected: { include: true, value: "s-2" },
  },
  {
    ...base,
    name: "编辑 ready：解除指派发送 null",
    original: "s-1",
    selected: null,
    expected: { include: true, value: null },
  },
  {
    ...base,
    name: "编辑 inbox：从无到有包含新值",
    status: "inbox",
    selected: "s-1",
    expected: { include: true, value: "s-1" },
  },
  {
    ...base,
    name: "编辑 claimed：无论如何省略",
    status: "claimed",
    original: "s-1",
    selected: "s-2",
    expected: { include: false },
  },
  {
    ...base,
    name: "编辑 running：即使解除也省略",
    status: "running",
    original: "s-1",
    selected: null,
    expected: { include: false },
  },
  {
    ...base,
    name: "编辑 waiting_user：保持原值省略",
    status: "waiting_user",
    original: "s-1",
    selected: "s-1",
    expected: { include: false },
  },
  {
    ...base,
    name: "编辑 waiting_user：解除为 null 时发送 null",
    status: "waiting_user",
    original: "s-1",
    selected: null,
    expected: { include: true, value: null },
  },
  {
    ...base,
    name: "编辑 waiting_user：改派他人在防御层同样省略",
    status: "waiting_user",
    original: "s-1",
    selected: "s-2",
    expected: { include: false },
  },
  {
    ...base,
    name: "编辑 waiting_user：原本未指派则不可新指派",
    status: "waiting_user",
    selected: "s-1",
    expected: { include: false },
  },
  // 聚合父规则（优先于 claimed/running）
  {
    ...base,
    name: "聚合 ready：原指派为空时无法新指派（省略）",
    hasChildren: true,
    selected: "s-1",
    expected: { include: false },
  },
  {
    ...base,
    name: "聚合 running：原指派为空时同样无法新指派",
    status: "running",
    hasChildren: true,
    selected: "s-1",
    expected: { include: false },
  },
  {
    ...base,
    name: "聚合 ready：保持历史异常指派时省略",
    hasChildren: true,
    original: "s-1",
    selected: "s-1",
    expected: { include: false },
  },
  {
    ...base,
    name: "聚合 running：解除历史异常指派发送 null",
    status: "running",
    hasChildren: true,
    original: "s-1",
    selected: null,
    expected: { include: true, value: null },
  },
  {
    ...base,
    name: "聚合 running：改派他人在防御层省略",
    status: "running",
    hasChildren: true,
    original: "s-1",
    selected: "s-2",
    expected: { include: false },
  },
];

describe("resolveAssignedSessionPatch", () => {
  it.each(CASES)("$name", (testCase) => {
    const input: AssignmentInput = {
      isEdit: testCase.isEdit,
      status: testCase.status,
      hasChildren: testCase.hasChildren,
      original: testCase.original,
      selected: testCase.selected,
    };
    expect(resolveAssignedSessionPatch(input)).toEqual(testCase.expected);
  });
});

describe("isSessionSelectLocked", () => {
  const lockBase: AssignmentContext = {
    isEdit: true,
    status: "ready",
    hasChildren: false,
    original: null,
  };

  it.each([
    {
      name: "claimed 锁定",
      input: { ...lockBase, status: "claimed" as TaskStatus },
      expected: true,
    },
    {
      name: "running 锁定",
      input: { ...lockBase, status: "running" as TaskStatus },
      expected: true,
    },
    {
      name: "waiting_user 不锁定（可解除）",
      input: {
        ...lockBase,
        status: "waiting_user" as TaskStatus,
        original: "s-1",
      },
      expected: false,
    },
    {
      name: "ready 不锁定",
      input: lockBase,
      expected: false,
    },
    {
      name: "新建不锁定",
      input: { ...lockBase, isEdit: false, status: "claimed" as TaskStatus },
      expected: false,
    },
    {
      name: "聚合父原指派为空：锁定（即使 running）",
      input: {
        ...lockBase,
        status: "running" as TaskStatus,
        hasChildren: true,
      },
      expected: true,
    },
    {
      name: "聚合父有历史指派：不锁定，允许清空（即使 running）",
      input: {
        ...lockBase,
        status: "running" as TaskStatus,
        hasChildren: true,
        original: "s-1",
      },
      expected: false,
    },
    {
      name: "聚合 ready 有历史指派：不锁定",
      input: { ...lockBase, hasChildren: true, original: "s-1" },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(isSessionSelectLocked(input)).toBe(expected);
  });
});

describe("sessionOptionsForStatus", () => {
  const optBase: AssignmentContext = {
    isEdit: true,
    status: "ready",
    hasChildren: false,
    original: null,
  };

  it("waiting_user 仅允许当前指派与解除", () => {
    expect(
      sessionOptionsForStatus({
        ...optBase,
        status: "waiting_user",
        original: "s-1",
      }),
    ).toEqual(["s-1", null]);
    expect(
      sessionOptionsForStatus({ ...optBase, status: "waiting_user" }),
    ).toEqual([null]);
  });

  it("聚合父仅允许当前指派与清空（状态无关）", () => {
    expect(
      sessionOptionsForStatus({
        ...optBase,
        status: "running",
        hasChildren: true,
        original: "s-1",
      }),
    ).toEqual(["s-1", null]);
    expect(sessionOptionsForStatus({ ...optBase, hasChildren: true })).toEqual([
      null,
    ]);
  });

  it("其他状态不限制选项", () => {
    expect(sessionOptionsForStatus({ ...optBase, original: "s-1" })).toBeNull();
    expect(
      sessionOptionsForStatus({ ...optBase, isEdit: false, hasChildren: true }),
    ).toBeNull();
  });
});
