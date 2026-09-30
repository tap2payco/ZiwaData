-- Schema for the early-warning and verified-record app.
-- Applied automatically by docker-entrypoint-initdb.d the first time the volume is created.
-- Plain Postgres: nothing here is Supabase-specific, so the same file runs on Supabase unchanged.
--
-- THE ONE RULE THAT SHAPES THIS FILE
-- A reading's hash is SHA-256(prevHash + canonicalJson(body)) — see src/core/hashchain.ts. If the bytes we
-- feed back into that function differ by even one character, every later hash in the farm's chain fails to
-- verify and the lender screen reports a break that never happened.
-- So the record body is stored as TEXT holding the EXACT canonical JSON the client hashed, never as jsonb:
-- jsonb re-orders keys and re-formats numbers (5.0 and 5 are the same jsonb value, different JSON text).
-- The typed columns beside it are derived copies for querying and indexing ONLY. body_json is the truth.

-- ---------------------------------------------------------------------------------------------
-- Readings: the farm's hash chain
-- ---------------------------------------------------------------------------------------------
CREATE TABLE readings (
  id          text        PRIMARY KEY,
  farm_id     text        NOT NULL,
  seq         integer     NOT NULL CHECK (seq >= 1),
  cage_id     text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('do','temp','ph','temp_deep','feed','mortality','incident')),
  unit        text        NOT NULL,
  ts          timestamptz NOT NULL,
  source      text        NOT NULL CHECK (source IN ('manual','sensor','satellite')),
  via         text                 CHECK (via IN ('app','sms','attestation')),
  device_id   text,
  attested    boolean     NOT NULL DEFAULT false,
  demo        boolean     NOT NULL,

  -- A measurement carries a number; an incident carries a type string. Exactly one, never both.
  value_num   double precision,
  value_text  text,

  hash        char(64)    NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  prev_hash   char(64)    NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),

  -- The exact bytes that were hashed. Never rebuild this from the columns above.
  body_json   text        NOT NULL,

  received_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT readings_value_one_of CHECK (num_nonnulls(value_num, value_text) = 1),
  -- Two phones writing the same farm cannot both claim a position in the chain. The server refuses the
  -- second one and the app keeps it in the outbox: see "Two phones for one farm" in the README.
  CONSTRAINT readings_farm_seq_unique UNIQUE (farm_id, seq)
);

-- Sync reads the whole chain for a farm in order; the score and charts read by time.
CREATE INDEX readings_farm_seq_idx ON readings (farm_id, seq);
CREATE INDEX readings_farm_ts_idx  ON readings (farm_id, ts DESC);
CREATE INDEX readings_farm_kind_ts_idx ON readings (farm_id, kind, ts DESC);

-- ---------------------------------------------------------------------------------------------
-- Checkpoints: the server's record of each farm's chain head over time
-- ---------------------------------------------------------------------------------------------
-- NOT an independent anchor yet: the server that stores these also stores the records.
-- Task 5's outside anchor is still open.
CREATE TABLE checkpoints (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at   timestamptz NOT NULL,
  farm_id       text        NOT NULL,
  head_hash     char(64)    NOT NULL,
  head_seq      integer     NOT NULL,
  count         integer     NOT NULL,
  chain_ok      boolean     NOT NULL,
  broken_at_seq integer
);
CREATE INDEX checkpoints_farm_idx ON checkpoints (farm_id, id DESC);

-- ---------------------------------------------------------------------------------------------
-- Settings: one row, the demo has no sign-in
-- ---------------------------------------------------------------------------------------------
-- When sign-in lands (Task 5) this becomes per-account and the phone number moves with it.
CREATE TABLE settings (
  only_row  boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  phone     text,
  sms_lang  text NOT NULL DEFAULT 'sw' CHECK (sms_lang IN ('sw','en'))
);
INSERT INTO settings (only_row) VALUES (true);

-- ---------------------------------------------------------------------------------------------
-- SMS log, with Beem delivery reports
-- ---------------------------------------------------------------------------------------------
-- Never holds a phone number or a message body, only the state. Keep it that way.
CREATE TABLE sms_log (
  id               text        PRIMARY KEY,          -- our own requestId; makes /api/sms/send idempotent
  -- Insertion order. The demo runs on a fixed clock, so many rows share the same `at`: ordering by `at`
  -- alone would be non-deterministic. Every ordered read uses this instead.
  ins              bigint      GENERATED ALWAYS AS IDENTITY,
  at               timestamptz NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('test','alert','inbound_reply')),
  state            text        NOT NULL CHECK (state IN ('queued','sent','failed','dry_run')),
  lang             text        NOT NULL CHECK (lang IN ('sw','en')),
  chars            integer     NOT NULL,
  alert_id         text,
  error            text,
  -- Beem's own request_id from the send response: the only handle for asking about delivery.
  beem_request_id  text,
  -- NULL means no report has arrived. NULL is not "delivered".
  delivery_state   text        CHECK (delivery_state IN ('pending','delivered','failed','unknown')),
  delivery_raw     text,
  delivery_at      timestamptz,
  delivery_via     text        CHECK (delivery_via IN ('callback','poll')),

  CONSTRAINT sms_log_delivery_together CHECK (
    (delivery_state IS NULL AND delivery_at IS NULL AND delivery_via IS NULL)
    OR (delivery_state IS NOT NULL AND delivery_at IS NOT NULL AND delivery_via IS NOT NULL)
  )
);
-- The delivery-report callback matches on this.
CREATE INDEX sms_log_beem_request_idx ON sms_log (beem_request_id) WHERE beem_request_id IS NOT NULL;
CREATE INDEX sms_log_ins_idx ON sms_log (ins DESC);

-- ---------------------------------------------------------------------------------------------
-- Inbound SMS drafts, waiting to be pulled into a farm's chain
-- ---------------------------------------------------------------------------------------------
-- jsonb is safe here: a draft has no hash yet. It is hashed only when the app appends it to the chain.
CREATE TABLE inbox (
  id          text        PRIMARY KEY,
  -- Insertion order, for the same reason as sms_log.ins.
  ins         bigint      GENERATED ALWAYS AS IDENTITY,
  received_at timestamptz NOT NULL,
  draft       jsonb       NOT NULL
);
CREATE INDEX inbox_ins_idx ON inbox (ins);

-- ---------------------------------------------------------------------------------------------
-- Delivery reports we could not match to a message we sent
-- ---------------------------------------------------------------------------------------------
-- Kept so the gap is visible instead of silently dropped.
CREATE TABLE unmatched_dlr (
  id     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at     timestamptz NOT NULL,
  dlr_id text,
  raw    text        NOT NULL
);
