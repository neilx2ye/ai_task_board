-- Cache the self-reported device identity per Bridge connection.
-- Each Bridge persists a locally generated stable device id and reports it,
-- together with its hostname label, inside session inventory sync. The board
-- groups connections by device id so a Web-created project directory can be
-- pushed to every Bridge running on the same device.

alter table public.ai_connection_bridge_settings
  add column if not exists device_id text,
  add column if not exists device_label text;

alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_device_shape;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_device_shape
  check (
    (device_id is null and device_label is null)
    or (
      device_id is not null
      and octet_length(device_id) between 1 and 100
      and device_label is not null
      and octet_length(device_label) between 1 and 255
    )
  );

comment on column public.ai_connection_bridge_settings.device_id is
  'Stable self-generated device identifier reported by this connection Bridge; groups Bridges that run on the same device.';

comment on column public.ai_connection_bridge_settings.device_label is
  'Human-readable device label (hostname) reported alongside the device id.';
