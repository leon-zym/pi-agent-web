# ADR 0001: Use Pi-native Session and Workspace identity

- Status: Accepted
- Date: 2026-08-21

## Context

Pi already persists conversations as append-only JSONL files. Maintaining a second Web-owned
Workspace/Session registry made discovery, custom Session directories, restart recovery, and
identity checks disagree with Pi. A Pi Session header UUID is not a sufficient global identity,
and the encoded default directory name is only a storage convention.

## Decision

- A persisted Session is identified by the canonical real path of its JSONL file. The browser uses
  an opaque `sessionHandle` derived from that path and never receives a path-derived routing key.
- The JSONL Header `id` is a native Session identifier used to verify that the resolved file and Pi
  runtime agree. It is not treated as globally unique across files.
- A Workspace is projected from the canonical real path of Header `cwd`. A `workspaceHandle` is an
  opaque route identifier for that path.
- `WorkspacePreferences` stores only discovery and presentation hints such as path, pinning,
	display name, and last-opened time. It never replaces, rewrites, or deletes Pi history. Absolute
	default/global/environment directories remain independently discoverable; project-only settings
	and any Agent/Session directory interpreted relative to the child cwd require a known Workspace
	path and are re-discovered when that path is added again.
- A newly created Session may use a temporary handle before Pi exposes its file. The gateway emits
  `session_rekeyed` once the canonical file identity is known.
- Default, environment, global-settings, and project-settings Session layouts are resolved with
  Pi's child-process cwd semantics. Header `cwd`, not a directory name, decides ownership.

## Consequences

Existing Pi history appears without import or duplication. Symlinks, relative configuration, and
custom direct Session directories require canonicalization and Header verification. A missing
Workspace remains visible as unavailable when a preference or native history still refers to it.

## Rejected alternatives

- A Web-owned Workspace/Session database: duplicates durable truth and can drift from Pi.
- Header UUID as the Session key: does not bind the key to a particular JSONL file.
- Encoded directory name as Workspace identity: collisions and custom layouts make it unreliable.

## Verification

`session-layout-resolver.test.ts`, `native-session-catalog.test.ts`,
`workspace-preferences.test.ts`, and `native-routes.test.ts` cover layout precedence, canonical
identity, preference-only Workspaces, corrupt data, and native projections.
