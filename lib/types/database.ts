export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type TaskStatus =
  | "inbox"
  | "ready"
  | "claimed"
  | "running"
  | "waiting_user"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type MemberRole = "owner" | "member";
export type ActorType = "user" | "ai" | "system";
export type SessionStatus = "online" | "busy" | "waiting" | "offline";

type Relationship = {
  foreignKeyName: string;
  columns: string[];
  isOneToOne: boolean;
  referencedRelation: string;
  referencedColumns: string[];
};

type TableDefinition<
  Row,
  Insert,
  Update = Partial<Row>,
  Relationships extends Relationship[] = [],
> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: Relationships;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type WorkspaceInsert = {
  id?: string;
  name: string;
  created_at?: string;
  updated_at?: string;
};

export type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
};

export type WorkspaceMemberInsert = {
  workspace_id: string;
  user_id: string;
  role?: MemberRole;
  created_at?: string;
};

export type AIConnectionRow = {
  id: string;
  workspace_id: string;
  name: string;
  platform: string;
  api_token_hash: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

export type AIConnectionInsert = {
  id?: string;
  workspace_id: string;
  name: string;
  platform: string;
  api_token_hash: string;
  created_by_user_id?: string | null;
  last_used_at?: string | null;
  created_at?: string;
  revoked_at?: string | null;
};

export type AISessionRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  name: string;
  platform: string;
  model: string | null;
  external_conversation_ref: string | null;
  capabilities: string[];
  status: SessionStatus;
  current_task_id: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type AISessionInsert = {
  id?: string;
  workspace_id: string;
  connection_id: string;
  name: string;
  platform: string;
  model?: string | null;
  external_conversation_ref?: string | null;
  capabilities?: string[];
  status?: SessionStatus;
  current_task_id?: string | null;
  last_seen_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type TaskRow = {
  id: string;
  workspace_id: string;
  parent_task_id: string | null;
  root_task_id: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  status: TaskStatus;
  priority: number;
  position: number | null;
  assigned_session_id: string | null;
  claimed_by_session_id: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  required_capabilities: string[];
  external_source: string | null;
  external_task_ref: string | null;
  external_conversation_ref: string | null;
  progress_note: string | null;
  progress_percent_estimate: number | null;
  result_summary: string | null;
  result_json: Json | null;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

/** Secret-bearing database shape. Never return this type from an HTTP API. */
export type TaskDatabaseRow = TaskRow & {
  claim_token_hash: string | null;
};

export type TaskInsert = {
  id?: string;
  workspace_id: string;
  parent_task_id?: string | null;
  root_task_id: string;
  title: string;
  description?: string | null;
  acceptance_criteria?: string | null;
  status?: TaskStatus;
  priority?: number;
  position?: number | null;
  assigned_session_id?: string | null;
  claimed_by_session_id?: string | null;
  claim_token_hash?: string | null;
  claimed_at?: string | null;
  lease_expires_at?: string | null;
  required_capabilities?: string[];
  external_source?: string | null;
  external_task_ref?: string | null;
  external_conversation_ref?: string | null;
  progress_note?: string | null;
  progress_percent_estimate?: number | null;
  result_summary?: string | null;
  result_json?: Json | null;
  created_by_type: ActorType;
  created_by_id?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
};

export type TaskDependencyRow = {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
};

export type TaskDependencyInsert = {
  task_id: string;
  depends_on_task_id: string;
  created_at?: string;
};

export type TaskMessageRow = {
  id: string;
  workspace_id: string;
  task_id: string;
  sender_type: ActorType;
  sender_id: string | null;
  content: string;
  reply_to_message_id: string | null;
  requires_response: boolean;
  read_at: string | null;
  created_at: string;
};

export type TaskMessageInsert = {
  id?: string;
  workspace_id: string;
  task_id: string;
  sender_type: ActorType;
  sender_id?: string | null;
  content: string;
  reply_to_message_id?: string | null;
  requires_response?: boolean;
  read_at?: string | null;
  created_at?: string;
};

export type TaskEventRow = {
  id: number;
  workspace_id: string;
  task_id: string;
  type: string;
  actor_type: ActorType;
  actor_id: string | null;
  data: Json;
  created_at: string;
};

export type TaskEventInsert = {
  id?: never;
  workspace_id: string;
  task_id: string;
  type: string;
  actor_type: ActorType;
  actor_id?: string | null;
  data?: Json;
  created_at?: string;
};

export type ArtifactRow = {
  id: string;
  workspace_id: string;
  task_id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path: string | null;
  external_url: string | null;
  created_by_session_id: string | null;
  created_at: string;
};

export type ArtifactInsert = {
  id?: string;
  workspace_id: string;
  task_id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path?: string | null;
  external_url?: string | null;
  created_by_session_id?: string | null;
  created_at?: string;
};

export type IdempotencyRecordRow = {
  workspace_id: string;
  actor_key: string;
  idempotency_key: string;
  operation: string;
  request_hash: string;
  response_json: Json | null;
  created_at: string;
  expires_at: string;
};

export type IdempotencyRecordInsert = {
  workspace_id: string;
  actor_key: string;
  idempotency_key: string;
  operation: string;
  request_hash: string;
  response_json?: Json | null;
  created_at?: string;
  expires_at?: string;
};

export type TaskRpcPayload = TaskRow & {
  structured_progress: {
    completed_leaves: number;
    total_leaves: number;
  };
};

export type PublicAIConnectionRow = Omit<AIConnectionRow, "api_token_hash">;

type TaskResponse = { task: TaskRpcPayload };
type NullableTaskResponse = { task: TaskRpcPayload | null };
type SessionResponse = { session: AISessionRow };
type SubtasksResponse = {
  parent_task: TaskRpcPayload;
  subtasks: TaskRpcPayload[];
};
type MessageResponse = {
  task: TaskRpcPayload;
  message: TaskMessageRow;
};
type CompleteResponse = {
  task: TaskRpcPayload;
  message_id: string | null;
  artifacts: ArtifactRow[];
};
type CompleteAndClaimNextResponse = CompleteResponse & {
  next_task: TaskRpcPayload | null;
};
type ConnectionResponse = { connection: PublicAIConnectionRow };
type ArtifactResponse = { artifact: ArtifactRow };

type IdempotencyArgs = {
  p_idempotency_key: string;
  p_request_hash: string;
};

type AIConnectionArgs = {
  p_workspace_id: string;
  p_connection_id: string;
  p_api_token_hash: string;
};

type AISessionArgs = AIConnectionArgs & {
  p_session_id: string;
};

type UserArgs = {
  p_workspace_id: string;
  p_user_id: string;
};

type UserTaskCommandArgs = UserArgs &
  IdempotencyArgs & {
    p_task_id: string;
    p_reason: string | null;
  };

export interface Database {
  public: {
    Tables: {
      workspaces: TableDefinition<
        WorkspaceRow,
        WorkspaceInsert,
        Partial<WorkspaceRow>,
        []
      >;
      workspace_members: TableDefinition<
        WorkspaceMemberRow,
        WorkspaceMemberInsert,
        Partial<WorkspaceMemberRow>,
        [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ]
      >;
      ai_connections: TableDefinition<
        AIConnectionRow,
        AIConnectionInsert,
        Partial<AIConnectionRow>,
        [
          {
            foreignKeyName: "ai_connections_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_connections_created_by_user_id_fkey";
            columns: ["created_by_user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ]
      >;
      ai_sessions: TableDefinition<
        AISessionRow,
        AISessionInsert,
        Partial<AISessionRow>,
        [
          {
            foreignKeyName: "ai_sessions_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_sessions_connection_fk";
            columns: ["workspace_id", "connection_id"];
            isOneToOne: false;
            referencedRelation: "ai_connections";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "ai_sessions_current_task_fk";
            columns: ["workspace_id", "current_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["workspace_id", "id"];
          },
        ]
      >;
      tasks: TableDefinition<
        TaskDatabaseRow,
        TaskInsert,
        Partial<TaskDatabaseRow>,
        [
          {
            foreignKeyName: "tasks_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_parent_fk";
            columns: ["workspace_id", "parent_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "tasks_root_fk";
            columns: ["workspace_id", "root_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "tasks_assigned_session_fk";
            columns: ["workspace_id", "assigned_session_id"];
            isOneToOne: false;
            referencedRelation: "ai_sessions";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "tasks_claimed_session_fk";
            columns: ["workspace_id", "claimed_by_session_id"];
            isOneToOne: false;
            referencedRelation: "ai_sessions";
            referencedColumns: ["workspace_id", "id"];
          },
        ]
      >;
      task_dependencies: TableDefinition<
        TaskDependencyRow,
        TaskDependencyInsert,
        Partial<TaskDependencyRow>,
        [
          {
            foreignKeyName: "task_dependencies_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_dependencies_depends_on_task_id_fkey";
            columns: ["depends_on_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ]
      >;
      task_messages: TableDefinition<
        TaskMessageRow,
        TaskMessageInsert,
        Partial<TaskMessageRow>,
        [
          {
            foreignKeyName: "task_messages_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_messages_task_fk";
            columns: ["workspace_id", "task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "task_messages_reply_fk";
            columns: ["workspace_id", "reply_to_message_id"];
            isOneToOne: false;
            referencedRelation: "task_messages";
            referencedColumns: ["workspace_id", "id"];
          },
        ]
      >;
      task_events: TableDefinition<
        TaskEventRow,
        TaskEventInsert,
        Omit<Partial<TaskEventRow>, "id"> & { id?: never },
        [
          {
            foreignKeyName: "task_events_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_events_task_fk";
            columns: ["workspace_id", "task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["workspace_id", "id"];
          },
        ]
      >;
      artifacts: TableDefinition<
        ArtifactRow,
        ArtifactInsert,
        Partial<ArtifactRow>,
        [
          {
            foreignKeyName: "artifacts_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "artifacts_task_fk";
            columns: ["workspace_id", "task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "artifacts_session_fk";
            columns: ["workspace_id", "created_by_session_id"];
            isOneToOne: false;
            referencedRelation: "ai_sessions";
            referencedColumns: ["workspace_id", "id"];
          },
        ]
      >;
      idempotency_records: TableDefinition<
        IdempotencyRecordRow,
        IdempotencyRecordInsert,
        Partial<IdempotencyRecordRow>,
        [
          {
            foreignKeyName: "idempotency_records_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ]
      >;
    };
    Views: Record<string, never>;
    Functions: {
      register_ai_session: {
        Args: AIConnectionArgs &
          IdempotencyArgs & {
            p_name: string;
            p_platform: string;
            p_model: string | null;
            p_external_conversation_ref: string | null;
            p_capabilities: string[];
          };
        Returns: SessionResponse;
      };
      report_current_task: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_title: string;
            p_description: string | null;
            p_acceptance_criteria: string | null;
            p_external_source: string | null;
            p_external_task_ref: string;
            p_external_conversation_ref: string | null;
            p_priority: number;
            p_progress_note: string | null;
            p_progress_percent_estimate: number | null;
            p_required_capabilities: string[];
            p_claim_token_hash: string;
            p_lease_seconds: number;
          };
        Returns: TaskResponse;
      };
      claim_next_task: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_claim_token_hash: string;
            p_lease_seconds: number;
          };
        Returns: NullableTaskResponse;
      };
      claim_task: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_lease_seconds: number;
          };
        Returns: TaskResponse;
      };
      create_subtasks: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_parent_task_id: string;
            p_claim_token_hash: string;
            p_subtasks: Json;
          };
        Returns: SubtasksResponse;
      };
      heartbeat_claim: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_lease_seconds: number;
          };
        Returns: TaskResponse;
      };
      heartbeat_ai_session: {
        Args: AISessionArgs & IdempotencyArgs;
        Returns: SessionResponse;
      };
      request_user_input: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_question: string;
          };
        Returns: MessageResponse;
      };
      complete_task_and_claim_next: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_result_summary: string | null;
            p_result_json: Json | null;
            p_message_content: string | null;
            p_artifacts: Json;
            p_next_claim_token_hash: string;
            p_lease_seconds: number;
          };
        Returns: CompleteAndClaimNextResponse;
      };
      report_progress: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_progress_note: string;
            p_progress_percent_estimate: number | null;
          };
        Returns: TaskResponse;
      };
      post_task_message: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_content: string;
            p_reply_to_message_id: string | null;
          };
        Returns: MessageResponse;
      };
      complete_task: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_result_summary: string | null;
            p_result_json: Json | null;
            p_message_content: string | null;
            p_artifacts: Json;
          };
        Returns: CompleteResponse;
      };
      fail_task: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_reason: string;
            p_result_json: Json | null;
          };
        Returns: TaskResponse;
      };
      release_task: {
        Args: AISessionArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_claim_token_hash: string;
            p_reason: string | null;
          };
        Returns: TaskResponse;
      };
      create_user_task: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_parent_task_id: string | null;
            p_title: string;
            p_description: string | null;
            p_acceptance_criteria: string | null;
            p_priority: number;
            p_position: number | null;
            p_assigned_session_id: string | null;
            p_required_capabilities: string[];
          };
        Returns: TaskResponse;
      };
      update_user_task: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_patch: Json;
          };
        Returns: TaskResponse;
      };
      create_user_subtasks: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_parent_task_id: string;
            p_subtasks: Json;
          };
        Returns: SubtasksResponse;
      };
      post_user_task_message: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_content: string;
            p_reply_to_message_id: string | null;
          };
        Returns: MessageResponse;
      };
      reply_to_task: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_content: string;
            p_reply_to_message_id: string | null;
          };
        Returns: MessageResponse;
      };
      release_task_by_user: {
        Args: UserTaskCommandArgs;
        Returns: TaskResponse;
      };
      cancel_task: {
        Args: UserTaskCommandArgs;
        Returns: TaskResponse;
      };
      reopen_task: {
        Args: UserTaskCommandArgs;
        Returns: TaskResponse;
      };
      create_user_artifact: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_task_id: string;
            p_artifact_id: string;
            p_name: string;
            p_mime_type: string;
            p_size: number;
            p_storage_path: string;
          };
        Returns: ArtifactResponse;
      };
      create_ai_connection: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_connection_id: string;
            p_name: string;
            p_platform: string;
            p_token_hash: string;
          };
        Returns: ConnectionResponse;
      };
      revoke_ai_connection: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_connection_id: string;
            p_reason: string | null;
          };
        Returns: ConnectionResponse;
      };
      rotate_ai_connection: {
        Args: UserArgs &
          IdempotencyArgs & {
            p_connection_id: string;
            p_token_hash: string;
          };
        Returns: ConnectionResponse;
      };
    };
    Enums: {
      task_status: TaskStatus;
      workspace_role: MemberRole;
      actor_type: ActorType;
      ai_session_status: SessionStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}
