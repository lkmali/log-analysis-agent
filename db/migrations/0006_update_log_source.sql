-- =============================================================================
-- Edit an existing log source's settings from the dashboard (owners/admins).
-- Region and AWS credentials pick the connector and are not editable here;
-- to move a log group, add it again under the new region/credentials.
-- Changing what is pulled (mode / filter) drops a half-read page token, because a
-- CloudWatch nextToken is only valid for the filter it was issued with.
-- =============================================================================

create or replace function app.update_log_source(
  source_id uuid, p_service_name text, p_environment text, p_ingest_mode public.ingest_mode,
  p_filter_pattern text, p_pii_scan boolean, p_poll_interval_seconds integer, p_enabled boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  org uuid;
  old_mode public.ingest_mode;
  old_filter text;
  new_filter text := nullif(trim(p_filter_pattern), '');
begin
  select organization_id, ingest_mode, filter_pattern into org, old_mode, old_filter
    from public.log_sources where id = source_id;
  if org is null or not app.has_org_role(org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'log source not found or not permitted' using errcode = '42501';
  end if;

  update public.log_sources set
    service_name          = nullif(trim(p_service_name), ''),
    environment           = nullif(trim(p_environment), ''),
    ingest_mode           = p_ingest_mode,
    filter_pattern        = new_filter,
    pii_scan              = p_pii_scan,
    poll_interval_seconds = p_poll_interval_seconds,
    enabled               = p_enabled,
    last_error            = case when p_enabled then last_error else null end
  where id = source_id;

  if old_mode is distinct from p_ingest_mode or old_filter is distinct from new_filter then
    update private.cloudwatch_checkpoints set next_token = null, updated_at = now() where log_source_id = source_id;
  end if;

  perform app.write_audit(org, 'log_source.updated', 'log_source', source_id::text,
    jsonb_build_object('ingestMode', p_ingest_mode, 'filterPattern', new_filter, 'piiScan', p_pii_scan,
                       'pollIntervalSeconds', p_poll_interval_seconds, 'enabled', p_enabled));
end;
$$;

revoke execute on function app.update_log_source(uuid, text, text, public.ingest_mode, text, boolean, integer, boolean) from public;
grant execute on function app.update_log_source(uuid, text, text, public.ingest_mode, text, boolean, integer, boolean) to sre_app;
