alter table public.ai_sessions
  add column if not exists sync_process_details boolean not null default true;

comment on column public.ai_sessions.sync_process_details is
  'When false, only assistant replies and the separate structured user-input flow are synchronized; process activities and reasoning history are suppressed.';
