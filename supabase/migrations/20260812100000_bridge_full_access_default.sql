-- Allow a Bridge to report an explicit full-access execution profile without
-- weakening the proven runtime lease and sequence-fencing state machine.

alter table public.ai_connection_bridge_settings
  drop constraint if exists
    ai_connection_bridge_settings_constraint_permission_mode_check;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_constraint_permission_mode_check
  check (
    constraint_permission_mode in (
      'safe', 'inherit', 'danger-full-access'
    )
  );

-- Keep the 0.8 exchange implementation intact behind a private name. Its
-- older internal RPC chain only understands safe/inherit, so the public
-- wrapper temporarily presents danger-full-access as inherit and restores the
-- original value only after that chain accepts this runtime generation and
-- report sequence.
alter function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) rename to _exchange_ai_connection_bridge_config_v5;

revoke all on function public._exchange_ai_connection_bridge_config_v5(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated, service_role;

create function public.exchange_ai_connection_bridge_config(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_runtime_instance_id uuid,
  p_report_sequence bigint,
  p_lease_seconds integer,
  p_release_runtime boolean,
  p_applied_version integer,
  p_effective jsonb,
  p_constraints jsonb,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_forward_constraints jsonb;
  v_previous_runtime uuid;
  v_previous_sequence bigint;
  v_should_apply boolean;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );

  if p_constraints is null
     or jsonb_typeof(p_constraints) <> 'object'
     or jsonb_typeof(p_constraints -> 'permission_mode') <> 'string'
     or p_constraints ->> 'permission_mode' not in (
       'safe', 'inherit', 'danger-full-access'
     ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  v_forward_constraints := case
    when jsonb_typeof(p_constraints) = 'object'
      and p_constraints ->> 'permission_mode' = 'danger-full-access'
    then jsonb_set(
      p_constraints,
      '{permission_mode}',
      '"inherit"'::jsonb,
      false
    )
    else p_constraints
  end;

  -- Match the lock order used by every earlier exchange wrapper and retain the
  -- row lock through both the legacy state transition and the value restore.
  select settings.active_runtime_instance_id,
         settings.active_runtime_last_sequence
  into v_previous_runtime, v_previous_sequence
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
  for update;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  perform public._exchange_ai_connection_bridge_config_v5(
    p_workspace_id, p_connection_id, p_api_token_hash,
    p_runtime_instance_id, p_report_sequence, p_lease_seconds,
    p_release_runtime, p_applied_version, p_effective,
    v_forward_constraints, p_error
  );

  v_should_apply := not p_release_runtime and (
    v_previous_runtime is distinct from p_runtime_instance_id
    or p_report_sequence > coalesce(v_previous_sequence, 0)
  ) and exists (
    select 1
    from public.ai_connection_bridge_settings settings
    where settings.workspace_id = p_workspace_id
      and settings.connection_id = p_connection_id
      and settings.active_runtime_instance_id = p_runtime_instance_id
      and settings.active_runtime_last_sequence = p_report_sequence
  );

  if v_should_apply then
    update public.ai_connection_bridge_settings
    set constraint_permission_mode = p_constraints ->> 'permission_mode'
    where workspace_id = p_workspace_id
      and connection_id = p_connection_id;
  end if;

  return public._bridge_configuration_payload(p_connection_id);
end;
$$;

comment on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) is
  'Exchanges one runtime-fenced Bridge status and preserves an explicit danger-full-access permission profile after compatibility validation.';

revoke all on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) to service_role;
