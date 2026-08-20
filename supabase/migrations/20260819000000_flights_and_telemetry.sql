-- Supabase is a hot cache for the public site: write-only from the tool,
-- read-only for the anonymous web client. It is not the flight record (that
-- is the local SQLite file) and not a backup (the free tier has no backup
-- retention). No raw spots table here: raw spots over a long flight would
-- crowd the 500 MB free tier; raw lives in SQLite and in git.

create table flights (
    flight_id    text primary key,
    callsign     text not null,
    channel      integer not null,
    band         text not null,
    launch_utc   timestamptz,
    launch_lat   double precision,
    launch_lon   double precision,
    status       text not null default 'live' check (status in ('live', 'closed')),
    close_reason text
);

create table telemetry (
    flight_id        text not null references flights (flight_id),
    utc              timestamptz not null,
    grid6            text not null,
    lat              double precision not null,
    lon              double precision not null,
    altitude_m       integer not null,
    speed_kt         integer not null,
    voltage_v        double precision not null,
    temperature_c    integer not null,
    gps_valid        boolean not null,
    rx_station_count integer not null,
    matcher_name     text not null,
    matcher_version  integer not null,
    primary key (flight_id, utc)
);

-- RLS: anon gets SELECT only. There are deliberately no insert/update/delete
-- policies; writes happen exclusively through the service role key, which
-- bypasses RLS.
alter table flights enable row level security;
alter table telemetry enable row level security;

create policy "anon can read flights"
    on flights for select
    to anon
    using (true);

create policy "anon can read telemetry"
    on telemetry for select
    to anon
    using (true);
