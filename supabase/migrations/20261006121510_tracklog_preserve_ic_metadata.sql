-- Protect IC evidence when an older client rebases its revision but still sends
-- stale/incomplete extras. Applies to v1 and v2 writes without changing RPCs,
-- operational columns, non-IC extras, existing rows, RLS or table permissions.
-- Keep the rules aligned with src/domain/icMetadata.ts.
create or replace function tracklog_private.preserve_tracklog_ic_metadata()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_old jsonb := old.extras;
  v_incoming jsonb := case when jsonb_typeof(new.extras) = 'object' then new.extras else '{}'::jsonb end;
  v_result jsonb;
  v_old_name text;
  v_next_name text;
  v_old_manual boolean;
  v_next_manual boolean;
  v_old_estimated boolean;
  v_next_estimated boolean;
  v_old_confirmed boolean;
  v_next_confirmed boolean;
  v_keep_old boolean := false;
  v_old_version numeric := 0;
  v_next_version numeric := 0;
  v_times timestamptz[] := array_fill('epoch'::timestamptz, array[8]);
  v_time_inputs text[];
  v_history jsonb := '[]'::jsonb;
  v_candidates jsonb;
  v_item jsonb;
  v_key text;
  v_i integer;
  v_fields constant text[] := array[
    'icName', 'icNameEstimate', 'icNameEstimateHistory', 'icDistanceM', 'icResolveStatus', 'icResolveAlgorithmVersion',
    'icResolvedManually', 'icResolveManualUpdatedAt', 'icResolveManualClearedAt',
    'icResolveGeoSource', 'icResolveGeoOffsetSeconds', 'icResolveRetryCount',
    'icResolveNextRetryAt', 'icResolveLastAttemptAt', 'icResolveError',
    'icNameSearchSourceId', 'icNameSearchAddressUpdated'
  ];
begin
  -- A deliberate event type conversion must not carry an entrance name into
  -- an exit or another event type. This trigger only protects the same event.
  if old.type is distinct from new.type
    or old.trip_id is distinct from new.trip_id
    or (nullif(btrim(old.extras ->> 'expresswaySessionId'), '') is not null
      and nullif(btrim(new.extras ->> 'expresswaySessionId'), '') is not null
      and old.extras ->> 'expresswaySessionId' is distinct from new.extras ->> 'expresswaySessionId')
    or new.type not in ('expressway', 'expressway_start', 'expressway_end')
    or jsonb_typeof(v_old) is distinct from 'object' then
    return new;
  end if;
  v_result := v_incoming;
  v_old_name := case when jsonb_typeof(v_old -> 'icName') = 'string' then nullif(btrim(v_old ->> 'icName'), '') end;
  v_next_name := case when jsonb_typeof(v_incoming -> 'icName') = 'string' then nullif(btrim(v_incoming ->> 'icName'), '') end;
  v_old_manual := coalesce(v_old -> 'icResolvedManually' = 'true'::jsonb, false) and v_old_name is not null;
  v_next_manual := coalesce(v_incoming -> 'icResolvedManually' = 'true'::jsonb, false) and v_next_name is not null;
  -- Older APKs retain the visible estimate suffix but omit the evidence object.
  -- A resolved transport status must not promote those candidates to confirmed.
  v_old_estimated := (coalesce(v_old_name ~ '[（(]推定(候補)?[）)]', false)
    or coalesce(jsonb_typeof(v_old -> 'icNameEstimate') = 'object'
      and jsonb_typeof(v_old #> '{icNameEstimate,displayName}') = 'string'
      and nullif(btrim(v_old #>> '{icNameEstimate,displayName}'), '') is not null
      and (v_old_name is null or btrim(v_old #>> '{icNameEstimate,displayName}') = v_old_name), false))
    and not coalesce(v_old -> 'icResolvedManually' = 'true'::jsonb, false);
  v_next_estimated := (coalesce(v_next_name ~ '[（(]推定(候補)?[）)]', false)
    or coalesce(jsonb_typeof(v_incoming -> 'icNameEstimate') = 'object'
      and jsonb_typeof(v_incoming #> '{icNameEstimate,displayName}') = 'string'
      and nullif(btrim(v_incoming #>> '{icNameEstimate,displayName}'), '') is not null
      and (v_next_name is null or btrim(v_incoming #>> '{icNameEstimate,displayName}') = v_next_name), false))
    and not coalesce(v_incoming -> 'icResolvedManually' = 'true'::jsonb, false);
  v_old_confirmed := v_old_name is not null and not v_old_estimated
    and (v_old_manual or v_old ->> 'icResolveStatus' is null or v_old ->> 'icResolveStatus' = 'resolved');
  v_next_confirmed := v_next_name is not null and not v_next_estimated
    and (v_next_manual or v_incoming ->> 'icResolveStatus' is null or v_incoming ->> 'icResolveStatus' = 'resolved');

  -- Invalid legacy metadata must never prevent recording or synchronization.
  v_time_inputs := array[
    v_incoming ->> 'icResolveManualClearedAt', v_old ->> 'icResolveManualUpdatedAt',
    v_incoming ->> 'icResolveManualUpdatedAt', v_old ->> 'icResolveManualClearedAt',
    v_old ->> 'icResolveLastAttemptAt', v_incoming ->> 'icResolveLastAttemptAt',
    v_old #>> '{icNameEstimate,estimatedAt}', v_incoming #>> '{icNameEstimate,estimatedAt}'
  ];
  for v_i in 1..8 loop
    begin
      if v_time_inputs[v_i] ~ '^\d{4}-\d{2}-\d{2}T' then
        v_times[v_i] := coalesce(v_time_inputs[v_i]::timestamptz, 'epoch'::timestamptz);
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      v_times[v_i] := 'epoch'::timestamptz;
    end;
  end loop;
  begin
    v_old_version := coalesce((v_old ->> 'icResolveAlgorithmVersion')::numeric, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    v_old_version := 0;
  end;
  begin
    v_next_version := coalesce((v_incoming ->> 'icResolveAlgorithmVersion')::numeric, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    v_next_version := 0;
  end;

  if v_old_manual then
    if v_next_manual then
      v_keep_old := v_times[3] < v_times[2] or (v_times[3] = v_times[2] and v_next_name is distinct from v_old_name);
    else
      v_keep_old := not (v_times[1] > 'epoch'::timestamptz and v_times[1] >= v_times[2]);
    end if;
  elsif v_next_manual and v_times[4] > 'epoch'::timestamptz and v_times[4] >= v_times[3] then
    v_keep_old := true;
  elsif v_old_confirmed then
    v_keep_old := not v_next_confirmed or (not v_next_manual and (
      v_next_version < v_old_version
      or (v_times[5] > 'epoch'::timestamptz and v_times[6] > 'epoch'::timestamptz and v_times[5] > v_times[6])
    ));
  elsif v_old_estimated and v_next_estimated then
    v_keep_old := v_times[7] > v_times[8];
  end if;

  if v_keep_old then
    foreach v_key in array v_fields loop
      v_result := v_result - v_key;
      if v_old ? v_key then v_result := v_result || jsonb_build_object(v_key, v_old -> v_key); end if;
    end loop;
  elsif v_old_name is not null and v_next_name is null then
    foreach v_key in array array['icName', 'icDistanceM', 'icResolveGeoSource', 'icResolveGeoOffsetSeconds'] loop
      if v_old ? v_key then v_result := v_result || jsonb_build_object(v_key, v_old -> v_key); end if;
    end loop;
  end if;
  if (v_result -> 'icNameEstimate' is null or v_result -> 'icNameEstimate' = 'null'::jsonb)
    and v_old -> 'icNameEstimate' is not null then
    v_result := v_result || jsonb_build_object('icNameEstimate', v_old -> 'icNameEstimate');
  end if;
  if not v_keep_old and v_incoming ->> 'icResolveStatus' in ('pending', 'failed') and v_times[5] > v_times[6] then
    foreach v_key in array array['icResolveStatus', 'icResolveAlgorithmVersion', 'icResolveRetryCount',
      'icResolveNextRetryAt', 'icResolveLastAttemptAt', 'icResolveError'] loop
      v_result := v_result - v_key;
      if v_old ? v_key then v_result := v_result || jsonb_build_object(v_key, v_old -> v_key); end if;
    end loop;
  end if;

  v_candidates := (case when jsonb_typeof(v_old -> 'icNameEstimateHistory') = 'array' then v_old -> 'icNameEstimateHistory' else '[]'::jsonb end)
    || (case when jsonb_typeof(v_incoming -> 'icNameEstimateHistory') = 'array' then v_incoming -> 'icNameEstimateHistory' else '[]'::jsonb end);
  if jsonb_typeof(v_old -> 'icNameEstimate') = 'object' and v_result -> 'icNameEstimate' is distinct from v_old -> 'icNameEstimate' then
    v_candidates := v_candidates || jsonb_build_array(v_old -> 'icNameEstimate');
  end if;
  for v_item in select value from jsonb_array_elements(v_candidates) loop
    if jsonb_typeof(v_item) = 'object' and not exists (
      select 1 from jsonb_array_elements(v_history) prior where prior.value = v_item
    ) then
      v_history := v_history || jsonb_build_array(v_item);
    end if;
  end loop;
  if jsonb_array_length(v_history) > 8 then
    select jsonb_agg(item.value order by item.position) into v_history
    from jsonb_array_elements(v_history) with ordinality item(value, position)
    where item.position = 1 or item.position > jsonb_array_length(v_history) - 7;
  end if;
  if jsonb_array_length(v_history) > 0 then v_result := v_result || jsonb_build_object('icNameEstimateHistory', v_history); end if;
  if v_times[4] > v_times[1] then
    v_result := v_result || jsonb_build_object('icResolveManualClearedAt', v_old -> 'icResolveManualClearedAt');
  end if;
  if v_result <> '{}'::jsonb then new.extras := v_result; end if;
  return new;
end;
$$;

revoke all on function tracklog_private.preserve_tracklog_ic_metadata() from public, anon, authenticated;

-- Runs before the existing sync sequence and report invalidation triggers.
create or replace trigger tracklog_preserve_ic_metadata
before update of extras on public.trip_events
for each row execute function tracklog_private.preserve_tracklog_ic_metadata();
