-- Cache the latest provider quota snapshot per Bridge connection.
-- Bridges fetch quota from their local provider runtime, normalize it into a
-- provider-neutral JSON snapshot, and include it in session inventory sync.
-- Provider credentials never leave the device and are never stored here.

alter table public.ai_connection_bridge_settings
  add column if not exists quota jsonb,
  add column if not exists quota_updated_at timestamptz;

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_quota_shape;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_quota_shape
  check (
    quota is null
    or (
      jsonb_typeof(quota) = 'object'
      and pg_column_size(quota) <= 32768
    )
  );

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_quota_timestamp;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_quota_timestamp
  check (
    (quota is null and quota_updated_at is null)
    or (quota is not null and quota_updated_at is not null)
  );

comment on column public.ai_connection_bridge_settings.quota is
  'Latest provider quota snapshot reported by this connection Bridge; normalized JSON without provider credentials.';

comment on column public.ai_connection_bridge_settings.quota_updated_at is
  'Time at which the Bridge last successfully reported quota.';
