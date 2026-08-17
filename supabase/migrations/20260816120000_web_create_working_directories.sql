-- Allow an optional per-entry create_if_missing flag in managed Bridge
-- working-directory lists. The flag authorizes the device to create the
-- absolute path while applying a Web-desired list; entries without it keep
-- the previous fail-closed behavior of rejecting paths that do not exist.

create or replace function public._bridge_working_directories_are_valid(
  p_directories jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_directory jsonb;
begin
  if p_directories is null
     or jsonb_typeof(p_directories) <> 'array'
     or jsonb_array_length(p_directories) not between 1 and 100 then
    return false;
  end if;

  for v_directory in
    select value from jsonb_array_elements(p_directories)
  loop
    if jsonb_typeof(v_directory) <> 'object'
       or (select count(*) from jsonb_object_keys(v_directory))
          not between 3 and 4
       or exists (
         select 1
         from jsonb_object_keys(v_directory) field_name
         where field_name not in (
           'directory_key', 'name', 'working_directory', 'create_if_missing'
         )
       )
       or jsonb_typeof(v_directory -> 'directory_key') <> 'string'
       or jsonb_typeof(v_directory -> 'name') <> 'string'
       or jsonb_typeof(v_directory -> 'working_directory') <> 'string'
       or (
         v_directory ? 'create_if_missing'
         and jsonb_typeof(v_directory -> 'create_if_missing') <> 'boolean'
       )
       or v_directory ->> 'directory_key'
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
       or length(v_directory ->> 'name') not between 1 and 200
       or v_directory ->> 'name' <> btrim(v_directory ->> 'name')
       or length(v_directory ->> 'working_directory') not between 1 and 4096
       or v_directory ->> 'working_directory'
          <> btrim(v_directory ->> 'working_directory') then
      return false;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_directories) as directory(value)
    group by value ->> 'directory_key'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(p_directories) as directory(value)
    group by value ->> 'working_directory'
    having count(*) > 1
  ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

comment on function public._bridge_working_directories_are_valid(jsonb) is
  'Validates managed Bridge working-directory entries; an optional boolean create_if_missing authorizes the device to create a missing absolute path.';

revoke all on function public._bridge_working_directories_are_valid(jsonb)
from public, anon, authenticated;
grant execute on function public._bridge_working_directories_are_valid(jsonb)
to service_role;
