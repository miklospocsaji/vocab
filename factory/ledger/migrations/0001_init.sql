-- The factory ledger, first cut (add-local-proposal-run design.md, ADR 0003).

CREATE TABLE work_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_number integer NOT NULL,
  change_id text NOT NULL,
  branch text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_items_change_id_key UNIQUE (change_id)
);

CREATE INDEX work_items_issue_number_idx ON work_items (issue_number);

CREATE TABLE attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id bigint NOT NULL REFERENCES work_items (id),
  state text NOT NULL,
  role text NOT NULL,
  n integer NOT NULL CHECK (n >= 1),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'failed')),
  failure_reason text,
  -- What the SDK's init message reported (ADR 0006); null until it arrives.
  auth_mode text CHECK (auth_mode IN ('api-key', 'subscription')),
  -- The SDK's estimate from the result message, in USD; tokens stay in messages so it can be recomputed.
  cost_usd_estimate numeric,
  UNIQUE (work_item_id, state, n),
  -- Open: no end, no outcome. Closed: an outcome, and a failure reason exactly when it failed.
  CHECK (
    (ended_at IS NULL AND outcome IS NULL AND failure_reason IS NULL)
    OR (ended_at IS NOT NULL AND outcome = 'succeeded' AND failure_reason IS NULL)
    OR (ended_at IS NOT NULL AND outcome = 'failed' AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX attempts_open_idx ON attempts (work_item_id, role) WHERE ended_at IS NULL;

CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id bigint NOT NULL REFERENCES attempts (id),
  seq integer NOT NULL CHECK (seq >= 1),
  type text NOT NULL,
  -- Null for messages without usage. A result message's usage is the session total.
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_creation_tokens integer,
  raw jsonb NOT NULL,
  UNIQUE (attempt_id, seq)
);

CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id bigint NOT NULL REFERENCES work_items (id),
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX events_work_item_id_idx ON events (work_item_id, at);
