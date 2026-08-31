# ADR 0014: Host-owned Workspace file references

- Status: Accepted
- Date: 2026-08-31

## Context

The Browser offered bounded Workspace path discovery and inserted `@path` into prompt text. Pi's CLI
can preprocess `@file` arguments, but RPC mode explicitly rejects those CLI arguments and accepts
only prompt text plus inline images. The old Browser interaction therefore neither included file
content reliably nor owned the security boundary it appeared to promise.

A path-only design also cannot show the context cost or distinguish ordinary source from a large,
binary, generated, ignored, hidden, or credential-like file. If metadata were checked by the Host
but Pi later reopened the path, a symlink or inode replacement could change the content after the
user's decision.

## Decision

1. The Gateway owns expansion of files selected through the Workspace mention surface. The selected
   path remains a display label. Pi receives captured bytes; file-reference expansion does not ask
   Pi RPC to reopen that path. Ordinary agent tools retain their separate policy boundary.
2. Search is a bounded metadata operation: at most 50 results, 300 directories, a 200-character
   query, 16 KiB of classification input per candidate, a 2 KiB ordinary-text preview, and four
   concurrent operations. `.git`, `node_modules`, and `.pi` are not traversed. Paths containing
   control or bidirectional-format characters are not capturable. Generated directories remain
   discoverable and are flagged rather than silently hidden.
3. Classification distinguishes UTF-8 text, supported image signatures, binary data, and unavailable
   entries. It reports byte size, an estimated token count for text or base64 where meaningful,
   canonical file identity, preview truncation, discovery truncation, and policy state.
4. Large files above 64 KiB, images, binary content, hidden and ignored paths, generated output,
   credential filename or content patterns, and unavailable ignore policy require explicit
   confirmation. Credential-pattern content is inspected locally but its preview is not returned.
   Blocked and unavailable entries remain visible.
5. Git ignore policy uses bounded `git check-ignore` with fixed arguments and candidate paths on
   standard input. A Workspace without Git or an ignore file has no ignore policy. If a declared
   policy cannot be evaluated, the result is `policy_unknown` and requires confirmation.
6. Capture requires the path, previewed identity, and a boolean confirmation. The Gateway resolves
   the canonical Workspace and selected target, rejects escape, opens the resolved file with
   no-follow semantics, and compares device, inode, size, and nanosecond modification identity before
   and after bounded reads. It then resolves and stats the selected path again. Symlink swap,
   replacement, disappearance, short read, or classification change fails closed.
7. Per-file capture ceilings are 256 KiB UTF-8 text, 64 KiB binary, and 1.5 MiB raw supported image.
   Binary content uses an explicit base64 file envelope. Images use Pi's inline image field. A
   Session composer retains at most eight file references and 512 KiB of captured text or base64;
   combined command and image ceilings still apply.
8. Captured references, in-flight work, warnings, and draft updates are partitioned by Session
   handle. Browser request cancellation and component identity suppress stale query and capture
   completions. Canonical Session rekey moves the owning composer snapshot atomically.
9. Captured bytes live only in Browser composer memory until submission. After submission, the
   expanded user message is ordinary native Pi JSONL. No file index, content cache, or second durable
   Workspace store is introduced.

## Consequences

The user can see what class and amount of content will enter context, and risky content requires an
explicit second action. A file changed after preview is rejected instead of silently substituted.
RPC behavior now matches the file mention affordance.

The Browser may temporarily retain up to the declared captured-content budget per active Session.
The user message stored by Pi contains the expanded file envelope, so native history remains
self-contained and truthful. General binary data is less context-efficient than text and is therefore
given a smaller ceiling and an explicit encoding label.

Git is optional for Workspaces without ignore policy. A declared policy that cannot be evaluated
adds friction through confirmation rather than silently treating ignored files as ordinary source.

## Rejected alternatives

- Let Pi reopen the selected path: RPC mode does not own CLI `@file` preprocessing, and a split
  preview/read design cannot close replacement races.
- Return content during search: this would expose sensitive or ignored content before confirmation
  and multiply filesystem work across fuzzy queries.
- Persist a Workspace file index or content cache: it would create another authority beside the live
  filesystem and native Pi JSONL.
- Silently exclude every hidden, ignored, or generated file: valid projects sometimes require those
  inputs, and the user needs a visible, auditable decision rather than an unexplained empty result.
- Send general binary files as images or decoded text: either changes semantics. Explicit base64
  preserves bytes and makes its context cost visible.

## Verification

- Protocol tests prove captured representation budgets fit downstream command and image ceilings.
- Server tests cover ordinary and risky classification, credential-preview suppression, Git ignore,
  large text, binary, image, traversal, outside and swapped symlinks, inode replacement, broken
  links, result and directory budgets, cancellation, confirmation, and exact capture.
- Native route integration verifies search metadata and capture over the authenticated REST shape.
- UI tests cover mention triggers, Host envelope serialization, Session-scoped composer state, rekey,
  and submission cleanup.
- Packaged Browser coverage verifies keyboard selection, sensitive-file confirmation, captured prompt
  bytes, stale-identity failure, draft preservation, narrow layout, both product locales, and both
  themes.
