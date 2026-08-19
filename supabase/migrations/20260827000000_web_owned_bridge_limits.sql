-- Make the Web configuration the single owner of thread and concurrent-turn
-- limits, and default fresh installations to uploading titles and enabling
-- Codex history sync. Devices no longer impose their own *_MAX_THREADS or
-- *_MAX_CONCURRENT_TURNS ceilings; the fixed Board-side 1..500 / 1..32 ranges
-- are the only limits.
--
-- History sync is implemented by Codex only. A global column default of true
-- makes Codex rows start enabled, while the BEFORE INSERT trigger pins
-- non-Codex rows back to false so their inert sync field cannot produce a
-- permanent desired/effective mismatch in the Web UI.

alter table public.ai_connection_bridge_settings
  alter column desired_include_thread_titles set default true,
  alter column desired_sync_history set default true;

create or replace function public._default_bridge_sync_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.platform is distinct from 'codex' then
    new.desired_sync_history := false;
  end if;
  return new;
end;
$$;

revoke all on function public._default_bridge_sync_history()
from public, anon, authenticated;

drop trigger if exists ai_connection_bridge_settings_default_sync_history
on public.ai_connection_bridge_settings;
create trigger ai_connection_bridge_settings_default_sync_history
before insert on public.ai_connection_bridge_settings
for each row execute function public._default_bridge_sync_history();

-- Existing rows are only backfilled when the Owner has not yet modified them
-- (version still 1), preserving deliberate opt-outs on live installations.
update public.ai_connection_bridge_settings
set desired_include_thread_titles = true,
    updated_at = clock_timestamp()
where version = 1
  and desired_include_thread_titles = false;

update public.ai_connection_bridge_settings
set desired_sync_history = true,
    updated_at = clock_timestamp()
where version = 1
  and platform = 'codex'
  and desired_sync_history = false;

update public.ai_connection_bridge_settings
set desired_sync_history = false,
    updated_at = clock_timestamp()
where platform is distinct from 'codex'
  and desired_sync_history = true;
