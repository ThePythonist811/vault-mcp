-- Allow recording direct writes (delete/move) in the proposals history.
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('create', 'replace', 'edit', 'append', 'delete', 'move'));
