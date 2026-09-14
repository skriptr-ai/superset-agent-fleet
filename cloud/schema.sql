-- The cloud's memory, in Postgres. Applied once to the fleet's Supabase project.
--
-- Every write the functions make is one call to a function below, so each is atomic and one
-- round trip: a push stamps its events with a sequence that only grows, trims the backlog,
-- applies any pins the machine carried up, and answers with the pins it should hold. The
-- service role key is the only caller; nothing here is reachable with the anon key.

create table if not exists fleet_hosts (
  name        text primary key,
  -- The label of the key that first reported this machine; no other key may report it. One
  -- developer's key reports all of that developer's machines under the same label.
  label       text,
  -- The developer whose restaurant this machine's sessions fill, as the key map says.
  owner       text,
  snapshot    jsonb not null default '{}'::jsonb,
  seq         bigint not null default 0,
  seen_at     timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table fleet_hosts add column if not exists label text;
alter table fleet_hosts add column if not exists owner text;

create table if not exists fleet_events (
  host     text not null references fleet_hosts(name) on delete cascade,
  seq      bigint not null,
  payload  jsonb not null,
  primary key (host, seq)
);

create table if not exists fleet_pins (
  id text primary key
);

create table if not exists fleet_watchers (
  id       text primary key,
  seen_at  timestamptz not null default now()
);

create table if not exists fleet_kv (
  key         text primary key,
  value       jsonb not null,
  expires_at  timestamptz
);

alter table fleet_hosts    enable row level security;
alter table fleet_events   enable row level security;
alter table fleet_pins     enable row level security;
alter table fleet_watchers enable row level security;
alter table fleet_kv       enable row level security;

-- How many events are kept per machine; matches the host server's own backlog.
create or replace function fleet_history() returns int language sql immutable as $$ select 1500 $$;

-- A page open on the world counts as watching for this long after its last tick.
create or replace function fleet_watch_ttl() returns interval language sql immutable as $$ select interval '15 seconds' $$;

/*
  Take in what a machine pushed. Returns the pins it should hold and how many pages are open.
    p_label      the label its key was issued to; bound to the host on first report
    p_owner      the developer the key map names for that label; taken as said, every time
    p_snapshot   its latest world without events (ignored on a heartbeat)
    p_events     the events new since its last push
    p_pins       its own pins, adopted only the first time it reports
    p_changes    [{id, pinned}] pins made on its own page since the last push
*/
drop function if exists fleet_push(text, jsonb, jsonb, jsonb, boolean, jsonb);
drop function if exists fleet_push(text, text, jsonb, jsonb, jsonb, boolean, jsonb);
create or replace function fleet_push(
  p_host      text,
  p_label     text,
  p_owner     text,
  p_snapshot  jsonb,
  p_events    jsonb,
  p_pins      jsonb,
  p_heartbeat boolean,
  p_changes   jsonb
) returns jsonb language plpgsql as $$
declare
  v_known   boolean;
  v_label   text;
  v_first   bigint;
  v_count   int := coalesce(jsonb_array_length(p_events), 0);
  v_change  jsonb;
  v_pins    jsonb;
  v_watch   int;
begin
  -- A host is bound to the key that first reported it; a key may report as many hosts as its
  -- developer has machines, but never as a host another developer's key already reported.
  select true, label into v_known, v_label from fleet_hosts where name = p_host;
  v_known := coalesce(v_known, false);
  if v_known and v_label is not null and v_label <> p_label then
    raise exception 'key_bound_elsewhere';
  end if;

  for v_change in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    if jsonb_typeof(v_change->'id') = 'string' and (v_change->>'id') <> '' then
      if coalesce((v_change->>'pinned')::boolean, true) then
        insert into fleet_pins(id) values (v_change->>'id') on conflict do nothing;
      else
        delete from fleet_pins where id = v_change->>'id';
      end if;
    end if;
  end loop;

  if p_heartbeat and v_known then
    update fleet_hosts set seen_at = now(), label = coalesce(label, p_label), owner = p_owner
      where name = p_host;
  else
    if not v_known then
      insert into fleet_pins(id)
        select value from jsonb_array_elements_text(coalesce(p_pins, '[]'::jsonb))
        on conflict do nothing;
    end if;
    insert into fleet_hosts(name, label, owner, snapshot, seen_at, updated_at)
      values (p_host, p_label, p_owner, coalesce(p_snapshot, '{}'::jsonb) - 'events', now(), now())
      on conflict (name) do update
        set snapshot = excluded.snapshot, label = coalesce(fleet_hosts.label, excluded.label),
            owner = excluded.owner, seen_at = now(), updated_at = now();
    if v_count > 0 then
      update fleet_hosts set seq = seq + v_count where name = p_host returning seq - v_count into v_first;
      insert into fleet_events(host, seq, payload)
        select p_host, v_first + ordinality,
               -- Event ids are per-server counters that start over when a host restarts, so
               -- they are re-stamped with the sequence: the page keys its memory on them.
               value || jsonb_build_object('id', p_host || ':' || (v_first + ordinality))
        from jsonb_array_elements(p_events) with ordinality;
      delete from fleet_events
        where host = p_host and seq <= v_first + v_count - fleet_history();
    end if;
  end if;

  delete from fleet_watchers where seen_at < now() - fleet_watch_ttl();
  select count(*) into v_watch from fleet_watchers;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_pins from fleet_pins;
  return jsonb_build_object('pins', v_pins, 'watchers', v_watch);
end $$;

/*
  Every machine's latest word, for the page: one row per host with its snapshot, sequence,
  when it was last heard from, and the events newer than what the caller last saw for it
  (p_since is {host: seq}; a host missing from it gets the whole backlog).
*/
create or replace function fleet_read(p_since jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pins', (select coalesce(jsonb_agg(id), '[]'::jsonb) from fleet_pins),
    'hosts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', h.name,
        'owner', h.owner,
        'snapshot', h.snapshot,
        'seq', h.seq,
        'seenAt', (extract(epoch from h.seen_at) * 1000)::bigint,
        'events', coalesce((
          select jsonb_agg(e.payload order by e.seq)
          from fleet_events e
          where e.host = h.name
            and e.seq > coalesce((p_since->>h.name)::bigint, 0)
        ), '[]'::jsonb)
      ) order by h.name)
      from fleet_hosts h
    ), '[]'::jsonb)
  )
$$;

-- A page is looking: say so, so machines know to poll at full speed.
create or replace function fleet_watch(p_id text) returns void language sql as $$
  insert into fleet_watchers(id, seen_at) values (p_id, now())
    on conflict (id) do update set seen_at = now();
$$;

-- A session put behind the bar by hand, or taken back out. Returns whether anything changed
-- and the set as it now stands.
create or replace function fleet_pin(p_id text, p_on boolean) returns jsonb language plpgsql as $$
declare
  v_changed int;
  v_pins jsonb;
begin
  if p_on then
    insert into fleet_pins(id) values (p_id) on conflict do nothing;
  else
    delete from fleet_pins where id = p_id;
  end if;
  get diagnostics v_changed = row_count;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_pins from fleet_pins;
  return jsonb_build_object('changed', v_changed > 0, 'pins', v_pins);
end $$;

-- A small kept value with a life: the forecast, so met.no is not asked once per viewer.
create or replace function fleet_kv_get(p_key text) returns jsonb language sql stable as $$
  select value from fleet_kv where key = p_key and (expires_at is null or expires_at > now());
$$;

create or replace function fleet_kv_set(p_key text, p_value jsonb, p_ttl_seconds int) returns void language sql as $$
  insert into fleet_kv(key, value, expires_at)
    values (p_key, p_value, case when p_ttl_seconds is null then null else now() + make_interval(secs => p_ttl_seconds) end)
    on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at;
$$;

-- Nothing here is for the anon role: the functions are called with the service role only.
revoke execute on all functions in schema public from anon, authenticated;
