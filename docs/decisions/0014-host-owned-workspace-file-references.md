# ADR 0014: Host-owned Workspace file references

- Status: Accepted
- Date: 2026-08-31

## Context

The Browser inserted discovered `@path` values into prompt text. Pi RPC accepts only prompt text and
inline images, so the interaction included content unreliably and owned no security boundary.
Splitting preview from a later path read also left symlink and replacement races before capture.

## Decision

1. The Gateway owns Workspace file expansion; the selected path stays a display label. Pi receives
   captured bytes and never reopens the path, and agent tools keep their own policy boundary.
2. Search returns bounded metadata; its ceilings and ingress semantics live in
   [Protocol](../protocol.md) and `packages/protocol/src/workspace-file-reference.ts`. VCS,
   dependency, and Pi directories stay untraversed, control or bidirectional-format paths stay
   uncapturable, and generated directories stay discoverable and flagged.
3. Classification distinguishes UTF-8 text, image signatures, binary data, and unavailable entries;
   reported fields are those of `WorkspaceFileMetadataDto` and `WorkspaceFileSearchDto`.
4. Large files, images, binary content, hidden and ignored paths, generated output, credential
   filename or content patterns, and unavailable ignore policy require confirmation. Credential
   previews are withheld, and blocked or unavailable entries stay visible.
5. Git ignore policy uses bounded `git check-ignore` with fixed arguments and candidate paths on
   standard input. A Workspace without Git or an ignore file has no ignore policy; an unevaluable
   declared policy yields `policy_unknown` and requires confirmation.
6. Capture requires the path, the previewed identity, and a boolean confirmation. The Gateway
   resolves the canonical Workspace and target, rejects escape, opens the file with no-follow
   semantics, compares device, inode, size, and nanosecond modification identity across bounded
   reads, then stats the selected path again. Symlink swap, replacement, disappearance, short read,
   or classification change fails closed.
7. Per-file capture ceilings and the per-Session reference count and captured-byte total live in
   `packages/protocol/src/workspace-file-reference.ts`. Binary content uses a base64 envelope,
   images use Pi's inline image field, and downstream command and image ceilings still apply.
8. Captured references, in-flight work, warnings, and draft updates are partitioned by Session
   handle; cancellation and component identity suppress stale completions, and rekey moves the
   owning composer snapshot atomically.
9. Captured bytes live only in Browser composer memory until submission; the expanded user message
   becomes native Pi JSONL. No file index, content cache, or second durable store is introduced.

## Consequences

The user sees the class and amount of content that will enter context, and risky content requires a
second action. A file changed after preview is rejected rather than silently substituted. The
Browser may temporarily hold the declared captured-content budget per active Session, and native Pi
JSONL keeps history self-contained; binary data gets a smaller ceiling and an encoding label.

## Rejected alternatives

- **Let Pi reopen the selected path**: RPC mode expands no CLI `@file`, and split preview/read
  cannot close replacement races.
- **Return content during search**: exposes sensitive or ignored content before confirmation and
  multiplies filesystem work across fuzzy queries.
- **Persist a Workspace file index or content cache**: creates another authority beside the live
  filesystem and native Pi JSONL.
- **Silently exclude hidden, ignored, or generated files**: valid projects need those inputs, and an
  unexplained empty result is worse than a visible decision.
- **Send general binary files as images or decoded text**: both change semantics; base64 preserves
  bytes and makes their context cost visible.
