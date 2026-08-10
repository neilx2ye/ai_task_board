type BoardErrorLike = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
};

/**
 * A restarted bridge cannot recover the old raw claim token. It must wait for
 * that lease to expire, then claim the same session-reserved task again.
 */
export function isSessionActiveClaimConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as BoardErrorLike;
  return (
    candidate.status === 409 &&
    candidate.code === "INVALID_STATE_TRANSITION" &&
    typeof candidate.message === "string" &&
    candidate.message === "The AI session already has an active task"
  );
}

export function nextClaimAction(input: {
  hasTask: boolean;
  stopping: boolean;
}): "stop" | "idle" | "execute" {
  if (input.stopping) return "stop";
  return input.hasTask ? "execute" : "idle";
}
