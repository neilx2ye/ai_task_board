export const TASKS_QUERY_KEY = ["tasks"] as const;
export const taskQueryKey = (taskId: string) =>
  [...TASKS_QUERY_KEY, taskId] as const;

export const SESSIONS_QUERY_KEY = ["sessions"] as const;
export const sessionQueryKey = (sessionId: string) =>
  [...SESSIONS_QUERY_KEY, sessionId] as const;

export const BRIDGE_DIRECTORIES_QUERY_KEY = ["bridge-directories"] as const;

export const planningNotesQueryKey = (
  connectionId: string,
  directoryRef: string,
) => ["planning-notes", connectionId, directoryRef] as const;

export const turnPlansQueryKey = (sessionId: string) =>
  ["turn-plans", sessionId] as const;
