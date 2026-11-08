-- The ledger in the cloud (add-cloud-proposal-run design, data model).

-- The execution that created the work item; null for a local run. One work item per issue:
-- Intake writes the row before the branch, so a concurrent loser fails before creating anything.
ALTER TABLE work_items ADD COLUMN execution_arn text;
DROP INDEX work_items_issue_number_idx;
ALTER TABLE work_items ADD CONSTRAINT work_items_issue_number_key UNIQUE (issue_number);

-- The role's validated result, on a succeeded attempt only. S3 takes over in M3 (ADR 0003).
ALTER TABLE attempts ADD COLUMN result jsonb;
ALTER TABLE attempts ADD CONSTRAINT attempts_result_succeeded CHECK (result IS NULL OR outcome = 'succeeded');

-- Owner approvals with the Step Functions task token that resumes the execution.
CREATE TABLE approvals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id bigint NOT NULL REFERENCES work_items (id),
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  task_token text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text,
  -- Open: unresolved. Closed: resolved, by someone.
  CHECK (
    (state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (state = 'closed' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX approvals_one_open_idx ON approvals (work_item_id) WHERE state = 'open';
