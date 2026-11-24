-- =============================================================================
-- Scan counters per log source, shown on the Log sources page.
--   fetched  = events CloudWatch returned (after the filter pattern)
--   new      = fetched events not seen before (overlap/resume duplicates removed)
--   errors   = new events the parser classified as error/fatal → incidents
--   skipped  = new - errors (matched the filter but not an error, e.g. level=info)
-- Totals are cumulative; last_poll_* describe the most recent successful poll.
-- =============================================================================

alter table public.log_sources
  add column events_fetched_total   bigint  not null default 0,
  add column events_new_total       bigint  not null default 0,
  add column errors_detected_total  bigint  not null default 0,
  add column polls_total            bigint  not null default 0,
  add column last_poll_fetched      integer,
  add column last_poll_new          integer,
  add column last_poll_errors       integer,
  add column last_poll_pages        integer,
  add column last_poll_window_start timestamptz,
  add column last_poll_window_end   timestamptz;
