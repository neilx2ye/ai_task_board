-- Web-triggered Bridge self-update: the owner picks a target version in the
-- console; the board stores it as the desired Bridge version. Bridges read it
-- from the configuration exchange response and, only when the device opted in
-- (AI_TASK_BOARD_ALLOW_REMOTE_UPDATE), download that exact release from the
-- npm registry and restart onto it. The board never ships code itself.

alter table public.ai_connection_bridge_settings
  add column if not exists desired_bridge_version text;

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_desired_version_shape;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_desired_version_shape
  check (
    desired_bridge_version is null
    or octet_length(desired_bridge_version) between 1 and 50
  );

comment on column public.ai_connection_bridge_settings.desired_bridge_version is
  'Owner-requested Bridge self-update target version; cleared automatically once the Bridge reports a satisfying bridge_version in session sync.';
