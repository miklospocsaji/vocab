-- The build loop (add-build-loop design, "Ledger").

-- Approvals are for a proposal or a design; still one open approval per work item, whatever its kind.
ALTER TABLE approvals ADD COLUMN kind text NOT NULL DEFAULT 'proposal' CHECK (kind IN ('proposal', 'design'));

-- How many times the build loop sent the change back to Design.
ALTER TABLE work_items ADD COLUMN design_flaws integer NOT NULL DEFAULT 0 CHECK (design_flaws >= 0);

-- Build attempts: the plan task, the artifact store prefix of their input and outputs, the
-- classifier's label and the gates result. All null outside the build loop.
ALTER TABLE attempts ADD COLUMN task_id text;
ALTER TABLE attempts ADD COLUMN store_prefix text;
ALTER TABLE attempts ADD COLUMN classification jsonb;
ALTER TABLE attempts ADD COLUMN gates jsonb;

-- The plan's tasks. A re-plan supersedes the unfinished rows and inserts the new ones; done rows stay.
CREATE TABLE tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id bigint NOT NULL REFERENCES work_items (id),
  task_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  title text NOT NULL,
  depends_on jsonb NOT NULL DEFAULT '[]',
  files jsonb NOT NULL DEFAULT '[]',
  scenarios jsonb NOT NULL DEFAULT '[]',
  tests jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('pending', 'done', 'superseded')),
  done_commit text,
  plan_attempt_id bigint NOT NULL REFERENCES attempts (id),
  -- A done task has its commit; no other has one.
  CHECK ((status = 'done') = (done_commit IS NOT NULL))
);

CREATE UNIQUE INDEX tasks_one_live_idx ON tasks (work_item_id, task_id) WHERE status <> 'superseded';
