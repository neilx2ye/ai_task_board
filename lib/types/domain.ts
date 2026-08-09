import type {
  AIConnectionRow,
  AISessionRow,
  ArtifactRow,
  Json,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
} from "@/lib/types/database";

export type AIAuthContext = {
  connectionId: string;
  workspaceId: string;
  tokenHash: string;
};

export type AISessionContext = AIAuthContext & {
  sessionId: string;
};

export type ClaimedTask = Pick<
  TaskRow,
  | "id"
  | "title"
  | "description"
  | "acceptance_criteria"
  | "priority"
  | "required_capabilities"
  | "parent_task_id"
  | "root_task_id"
  | "status"
  | "lease_expires_at"
> & { claim_token: string };

export type TaskDetails = {
  task: TaskRow;
  parent: TaskRow | null;
  children: TaskRow[];
  descendants: TaskRow[];
  dependencies: TaskRow[];
  messages: TaskMessageRow[];
  events: TaskEventRow[];
  artifacts: ArtifactRow[];
};

export type TaskUpdates = {
  task_id: string;
  events: TaskEventRow[];
  messages: TaskMessageRow[];
  artifacts: ArtifactRow[];
  next_cursor: number;
};

export type ConnectionTokenResult = {
  connection: Omit<AIConnectionRow, "api_token_hash">;
  token: string;
};

export type RpcObject = Record<string, Json | undefined>;

export type SessionRegistrationResult = {
  session: AISessionRow;
};
