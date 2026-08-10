"use client";

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import { createPendingIdempotencyTracker } from "@/hooks/pending-idempotency";
import type {
  BridgeAppliedConfiguration,
  BridgeConfiguration as BridgeConfigurationDto,
  BridgeConfigurationConstraints as BridgeConfigurationConstraintsDto,
  BridgeConfigurationResponse as BridgeConfigurationResponseDto,
  BridgeDesiredConfiguration,
} from "@/lib/types/database";

export type BridgeDesiredConfig = BridgeDesiredConfiguration;
export type BridgeConfigConstraints = BridgeConfigurationConstraintsDto;
export type BridgeAppliedConfig = BridgeAppliedConfiguration;
export type BridgeConfiguration = BridgeConfigurationDto;
export type BridgeConfigurationResponse = BridgeConfigurationResponseDto;

export type UpdateBridgeConfigurationInput = BridgeDesiredConfig & {
  expected_version: number;
};

export type BridgeConfigSyncState =
  | "upgrade-required"
  | "offline"
  | "waiting"
  | "error"
  | "remote-disabled"
  | "applied"
  | "constrained";

export function supportsBridgeSettings(connection: {
  bridge_version: string | null;
  platform: string;
}): boolean {
  return (
    connection.bridge_version !== null ||
    connection.platform.toLowerCase().includes("codex")
  );
}

export function bridgeDesiredConfigsEqual(
  left: BridgeDesiredConfig,
  right: BridgeDesiredConfig,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.include_thread_titles === right.include_thread_titles &&
    left.max_threads === right.max_threads &&
    left.max_concurrent_turns === right.max_concurrent_turns &&
    (left.sync_history ?? false) === (right.sync_history ?? false) &&
    (left.history_turn_limit ?? 50) === (right.history_turn_limit ?? 50)
  );
}

/** Remote desired/applied exchange was introduced by the 0.3 Bridge line. */
export function bridgeSupportsRemoteConfiguration(
  bridgeVersion: string | null,
): boolean {
  if (!bridgeVersion) return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(bridgeVersion.trim());
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  return (
    version[0] > 0 ||
    (version[0] === 0 && version[1] > 3) ||
    (version[0] === 0 && version[1] === 3 && version[2] >= 0)
  );
}

/** Thread history import was added after the initial 0.3 remote-config API. */
export function bridgeSupportsHistorySync(
  bridgeVersion: string | null,
): boolean {
  if (!bridgeVersion) return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(bridgeVersion.trim());
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  return (
    version[0] > 0 ||
    (version[0] === 0 && version[1] > 4) ||
    (version[0] === 0 && version[1] === 4 && version[2] >= 0)
  );
}

/** Never reports an old/unreported Bridge as applied, even if stale data exists. */
export function bridgeConfigSyncState(
  configuration: BridgeConfiguration,
  bridgeVersion: string | null,
): BridgeConfigSyncState {
  if (!bridgeSupportsRemoteConfiguration(bridgeVersion)) {
    return "upgrade-required";
  }
  if (!configuration.runtime.online) return "offline";
  if (!configuration.applied) return "waiting";
  if (!configuration.applied.constraints.remote_configuration_enabled) {
    return "remote-disabled";
  }
  if (
    configuration.applied.version !== configuration.version ||
    configuration.applied.effective === null
  ) {
    return configuration.applied.error ? "error" : "waiting";
  }
  if (!bridgeDesiredConfigsEqual(
    configuration.desired,
    configuration.applied.effective,
  )) {
    // A successful clamp/title restriction may be returned in `error` as an
    // explanatory warning; the authoritative signal is the matching version
    // plus a complete effective configuration.
    return "constrained";
  }
  return configuration.applied.error ? "error" : "applied";
}

export function bridgeConfigKey(connectionId: string) {
  return ["connections", connectionId, "bridge-config"] as const;
}

/**
 * Stable serialization for the logical PATCH request. The hook retains the
 * resulting idempotency key until that exact update is confirmed.
 */
export function bridgeConfigMutationFingerprint(
  connectionId: string,
  input: UpdateBridgeConfigurationInput,
): string {
  return [
    connectionId,
    input.expected_version,
    input.enabled ? 1 : 0,
    input.include_thread_titles ? 1 : 0,
    input.max_threads,
    input.max_concurrent_turns,
    input.sync_history ? 1 : 0,
    input.history_turn_limit,
  ].join("\0");
}

export function useBridgeConfig(connectionId: string, enabled: boolean) {
  return useQuery({
    queryKey: bridgeConfigKey(connectionId),
    queryFn: () =>
      apiFetch<BridgeConfigurationResponse>(
        `/api/user/connections/${encodeURIComponent(connectionId)}/bridge-config`,
      ),
    enabled,
    // While the dialog is open, surface Bridge acknowledgements without a
    // manual refresh. Closing the dialog disables both fetch and polling.
    refetchInterval: enabled ? 10_000 : false,
  });
}

export function useUpdateBridgeConfig(connectionId: string) {
  const queryClient = useQueryClient();
  const idempotency = useRef<
    ReturnType<typeof createPendingIdempotencyTracker> | undefined
  >(undefined);
  const requestKeys = useRef(
    new WeakMap<
      UpdateBridgeConfigurationInput,
      { fingerprint: string; key: string }
    >(),
  );
  idempotency.current ??= createPendingIdempotencyTracker();

  return useMutation({
    mutationFn: (input: UpdateBridgeConfigurationInput) => {
      const fingerprint = bridgeConfigMutationFingerprint(connectionId, input);
      const idempotencyKey = idempotency.current!.keyFor(fingerprint);
      requestKeys.current.set(input, { fingerprint, key: idempotencyKey });

      return apiFetch<BridgeConfigurationResponse>(
        `/api/user/connections/${encodeURIComponent(connectionId)}/bridge-config`,
        {
          method: "PATCH",
          json: input,
          idempotencyKey,
        },
      );
    },
    onSuccess: (result, input) => {
      const request = requestKeys.current.get(input);
      if (request) {
        idempotency.current!.confirm(request.fingerprint, request.key);
      }
      queryClient.setQueryData(bridgeConfigKey(connectionId), result);
    },
    onSettled: (_result, _error, input) => {
      requestKeys.current.delete(input);
    },
  });
}
