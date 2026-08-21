# ADR 0002: Supervise Pi at Session granularity

- Status: Accepted
- Date: 2026-08-21

## Context

Pi's `switch_session` tears down the current agent run. A Workspace-owned Pi process therefore
makes navigation destructive: opening Session B can abort a running Session A, and a restart has no
stable way to recover the previously selected file. Users also need independent work in multiple
Sessions from the same or different Workspaces.

## Decision

- Every hot Session owns at most one `pi --mode rpc` child process, launched with that Session's
  canonical file and Workspace cwd. A dormant historical Session owns no process.
- Selecting a Session in the browser is only a view change. It never sends Pi `switch_session` or
  `new_session`, and it never stops another Session.
- The supervisor activates Sessions lazily and bounds the hot runtime pool. Running, waiting-for-UI,
  transitioning, unpersisted, or otherwise reserved runtimes cannot be evicted.
- Idle persisted runtimes may become dormant and can later reopen the same JSONL file. Crash retry
  budgets, lifecycle generation, replay, and control ownership are isolated per Session.
- Fork and clone are identity transitions of the current process. A successful transition rekeys
  that runtime to the child file; the parent remains a persisted dormant Session that can be opened
  independently.
- Workspace-scoped reservations serialize only identity-sensitive creation, transition, and
  deletion windows. They do not prohibit ordinary concurrent Sessions in one Workspace.

## Consequences

Session A can continue generating while the user views or controls B. Capacity is deliberately
bounded rather than spawning every historical Session. Process stop, crash cleanup, restart, and
shutdown need lifecycle barriers so two children never own the same Session during a race.

## Rejected alternatives

- One Pi process per Workspace: navigation aborts work and conflates independent Sessions.
- One permanent process per historical Session: unbounded resource use.
- A single global Pi process: cannot preserve cwd-specific settings, tools, and concurrency.

## Verification

`session-supervisor.test.ts`, `pi-process.integration.test.ts`, and
`session-ws-bridge.test.ts` exercise concurrent same-Workspace Sessions, capacity, crash recovery,
process-group cleanup, fork/clone rekey, and shutdown races. Packaged browser tests verify that a
background Session settles while another Session is selected.
