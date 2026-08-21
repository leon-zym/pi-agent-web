# ADR 0004: Fence and preserve Session deletion

- Status: Accepted
- Date: 2026-08-21

## Context

Deleting a Pi JSONL file is a durable and potentially destructive operation. A browser selection,
native UUID, or earlier catalog snapshot cannot prove that the file at a path is still the intended
Session. Concurrent activation, fork/clone, child creation, symlink replacement, and file swaps can
otherwise delete the wrong history.

## Decision

- Session deletion requires the current controller's exact generation and fencing token. It is
  rejected for active, unpersisted, stale, or otherwise reserved runtimes.
- The supervisor reserves the Session and Workspace identity window against activation,
  transition, creation, shutdown, and concurrent deletion. The catalog is force-refreshed inside
  the reservation and Sessions with children are rejected.
- Before moving the file, the gateway verifies the canonical path-derived handle, Header native
  id, canonical Header cwd, regular-file status, and file descriptor identity. The identity is
  checked again across the move boundary.
- Deletion is a same-filesystem atomic rename into a private recoverable trash area with metadata.
  Cross-device copy-and-unlink is rejected. A failed rollback remains quarantined rather than
  overwriting either source or destination.
- Removing a Workspace preference never deletes Pi history.

## Consequences

The current product guarantees a recoverable file move, not a complete restore/purge user
experience. Trash retention and recovery tooling are separate product work. Deletion may fail
closed when identity or filesystem guarantees cannot be established.

## Rejected alternatives

- Direct `unlink`: needlessly irreversible and unsafe under races.
- UUID-only or path-string-only checks: do not bind the request to the current file contents.
- Cross-device copy then unlink: loses atomicity and creates partial-failure ambiguity.

## Verification

`recoverable-session-trash.test.ts`, `native-routes.test.ts`, and
`session-supervisor.test.ts` cover Header/path/inode swaps, symlinks, children, active runtimes,
transitions, deletion reservations, shutdown, rollback, and cross-device failure.
