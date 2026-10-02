-- Add the two business-work events without replacing unrelated sync changes.
-- CREATE OR REPLACE preserves the existing function's ownership and grants.
do $migration$
declare
  function_sql text;
  old_tail constant text := '''expressway_end'', ''point_mark''';
  new_tail constant text := '''expressway_end'', ''point_mark'', ''work_start'', ''work_end''';
  occurrence_count integer;
begin
  function_sql := pg_get_functiondef(
    'tracklog_private.apply_tracklog_sync_mutation(uuid,text,jsonb)'::regprocedure
  );
  if position(new_tail in function_sql) > 0 then
    occurrence_count := (length(function_sql) - length(replace(function_sql, new_tail, ''))) / length(new_tail);
    if occurrence_count <> 2 then
      raise exception 'Other work event allowlists are incomplete';
    end if;
    return;
  end if;
  occurrence_count := (length(function_sql) - length(replace(function_sql, old_tail, ''))) / length(old_tail);
  if occurrence_count <> 2 then
    raise exception 'Unexpected sync event allowlists; review before adding other work';
  end if;
  execute replace(function_sql, old_tail, new_tail);
end;
$migration$;
