-- Per-runtime Bridge capability version.
--
-- A unified device connection hosts four runtime kinds under one
-- ai_connections row, but each runtime reports its own suffixed version
-- (Codex 1.7.1, Kimi 1.7.1-kimi.1, Antigravity 1.7.1-antigravity.2,
-- Claude 1.7.1-claude.1). The connection-level ai_connections.bridge_version
-- column can only keep the last writer's value, so the platform-scoped
-- settings rows now retain each runtime's reported version.

alter table public.ai_connection_bridge_settings
  add column if not exists bridge_version text;

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_bridge_version_shape,
  add constraint ai_connection_bridge_settings_bridge_version_shape
    check (
      bridge_version is null
      or length(btrim(bridge_version)) between 1 and 100
    );

comment on column public.ai_connection_bridge_settings.bridge_version is
  'Capability version last reported by this runtime kind; a unified device connection keeps one value per kind instead of the single last-writer value on ai_connections.bridge_version.';

-- Backfill single-runtime connections from the legacy connection-level value.
-- Unified connections stay empty and fill in from each runtime's next session
-- sync (typically within seconds), avoiding a guess about which runtime wrote
-- the shared column last.
update public.ai_connection_bridge_settings settings
set bridge_version = connection.bridge_version
from public.ai_connections connection
where settings.workspace_id = connection.workspace_id
  and settings.connection_id = connection.id
  and settings.platform = public._canonical_bridge_platform(connection.platform)
  and lower(btrim(connection.platform)) not in ('all', 'unified')
  and lower(btrim(connection.platform)) <> '统一设备 bridge'
  and connection.bridge_version is not null;
