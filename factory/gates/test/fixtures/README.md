# Gate fixtures

`workspace/` is a minimal copy of the repository's layout: one app package (`app/demo`), one factory
package whose test needs the ledger, and one OpenSpec change (`add-demo`) with three scenarios.
The other folders are overlays copied on top of it by `test/helpers/worktree.ts`, which also links
the repository's pinned tools into the copy's `node_modules`. `report/` and `coverage/` serve the
Vitest report and coverage tests. Some files here are broken on purpose; the repository's own
typecheck, lint and tests skip this folder.
