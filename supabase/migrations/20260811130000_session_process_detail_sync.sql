alter table public.ai_sessions
  add column if not exists sync_process_details boolean not null default true;

comment on column public.ai_sessions.sync_process_details is
  'Legacy rolling-upgrade field; current applications always synchronize assistant replies only and ignore this value.';
