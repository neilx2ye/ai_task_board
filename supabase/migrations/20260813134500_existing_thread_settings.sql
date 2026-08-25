-- Allow Web management commands for an existing Codex Thread to carry the
-- same model and reasoning overrides already supported during Thread create.
-- The Bridge applies these settings through thread/resume before acknowledging
-- the command, so failed local changes remain visible as failed audit rows.

alter table public.ai_thread_commands
  drop constraint if exists ai_thread_commands_create_settings_only;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_thread_commands_manage_settings_only'
      and conrelid = 'public.ai_thread_commands'::regclass
  ) then
    alter table public.ai_thread_commands
      add constraint ai_thread_commands_manage_settings_only check (
        action in ('create', 'rename')
        or (model is null and reasoning_effort is null)
      );
  end if;
end;
$$;

create or replace function public.enqueue_ai_thread_command_with_settings(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_session_id uuid,
  p_action text,
  p_name text,
  p_directory_key text,
  p_model text,
  p_reasoning_effort text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_model text := nullif(btrim(p_model), '');
  v_reasoning_effort text := nullif(btrim(p_reasoning_effort), '');
begin
  if p_action in ('create', 'rename') then
    if (v_model is not null and length(v_model) > 200)
       or (
         v_reasoning_effort is not null
         and length(v_reasoning_effort) > 50
       ) then
      perform public._raise('INVALID_THREAD_COMMAND');
    end if;
  elsif v_model is not null or v_reasoning_effort is not null then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  -- The nested function authenticates the Owner, performs idempotency, checks
  -- the target Session and validates the optional create directory key. A
  -- failure below rolls the entire nested enqueue back with this transaction.
  v_result := public.enqueue_ai_thread_command_with_directory(
    p_workspace_id, p_user_id, p_command_id, p_connection_id,
    p_session_id, p_action, p_name, p_directory_key,
    p_idempotency_key, p_request_hash
  );

  if p_action in ('create', 'rename') then
    update public.ai_thread_commands command
    set model = v_model,
        reasoning_effort = v_reasoning_effort
    where command.workspace_id = p_workspace_id
      and command.connection_id = p_connection_id
      and command.id = p_command_id;
  end if;

  return jsonb_build_object(
    'command', public._thread_command_payload(p_command_id)
  );
end;
$$;

comment on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text
) is
  'Queues create or existing-Thread management with optional Codex model and reasoning settings.';

revoke all on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text
) to service_role;
