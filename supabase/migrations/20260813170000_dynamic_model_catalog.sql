-- Cache the visible Codex App Server model catalog per Bridge connection.
-- The catalog contains display metadata only; provider credentials remain local.

alter table public.ai_connection_bridge_settings
  add column if not exists model_catalog jsonb,
  add column if not exists model_catalog_updated_at timestamptz;

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_model_catalog_shape;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_model_catalog_shape
  check (
    model_catalog is null
    or case
      when jsonb_typeof(model_catalog) = 'array' then
        jsonb_array_length(model_catalog) <= 500
        and pg_column_size(model_catalog) <= 1048576
      else false
    end
  );

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_model_catalog_timestamp;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_model_catalog_timestamp
  check (
    (model_catalog is null and model_catalog_updated_at is null)
    or (model_catalog is not null and model_catalog_updated_at is not null)
  );

comment on column public.ai_connection_bridge_settings.model_catalog is
  'Latest visible model/list catalog reported by this connection Codex App Server; contains no provider secrets.';

comment on column public.ai_connection_bridge_settings.model_catalog_updated_at is
  'Time at which the Bridge last successfully reported model_catalog.';
