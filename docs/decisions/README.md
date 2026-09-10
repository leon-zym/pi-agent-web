# Architecture decision records

An ADR records why a contract exists and which alternatives were rejected. Current behavior is defined by
[Architecture](../architecture.md), [Protocol](../protocol.md), [UI and UX](../ui-ux.md), and
[Design](../design.md); an ADR does not compete with them.

## Admission

A decision needs an ADR when it sets a cross-module responsibility boundary, creates or changes an interface
or seam, constrains durable data compatibility, chooses between hard-to-reverse technical options, or
imposes a long-term engineering constraint. A single feature request or a local implementation detail stays
in the Issue or pull request that delivers it.

## Record structure

`Status`, `Date`, `Context`, `Decision`, `Consequences`, `Rejected alternatives`. Verification evidence
belongs to tests and Issues, so no ADR carries a verification section.

## Status

`Status` reports the effect of a decision and nothing else; whether the tracking Issue is open does not
change it. Supersession and amendment links agree in both directions: a record that amends an earlier
decision names it, and the earlier decision names the amendment. An accepted decision is reversed only by a
later ADR, never by a handoff note.

| ADR | Decision | Status | Superseded by |
| --- | --- | --- | --- |
| [0001](0001-pi-native-identity.md) | Pi-native Session and Workspace identity | Accepted | |
| [0002](0002-session-runtime-pool.md) | Session-scoped, bounded Pi runtime pool | Accepted | |
| [0003](0003-session-channel-control-and-recovery.md) | Multiplexed control, ordering, replay, and recovery | Partly superseded | 0008, 0015 |
| [0004](0004-recoverable-session-deletion.md) | Fenced, identity-bound recoverable deletion | Accepted | |
| [0005](0005-conversation-rendering.md) | Multi-Session publication and measured renderer decision | Accepted | |
| [0006](0006-ui-ux-design-system-and-reading-stream.md) | UI/UX design system, reading stream orchestration, and client lifecycle invariants | Accepted | |
| [0007](0007-versioned-pi-host-and-gateway-negotiation.md) | Versioned Pi host adapter, runtime selection, and Gateway hello negotiation | Partly superseded | 0013, 0015 |
| [0008](0008-authoritative-epoch-aware-live-session-resync.md) | Authoritative epoch-aware live Session resync and snapshot waterlines | Accepted | |
| [0009](0009-authoritative-hot-runtime-inventory-and-browser-reconciliation.md) | Authoritative hot Runtime inventory and Browser reconciliation | Accepted | |
| [0010](0010-epoch-scoped-attachment-references-and-payload-budgets.md) | Epoch-scoped attachment references and payload budgets | Partly superseded | 0013, 0015 |
| [0011](0011-epoch-scoped-typed-content-references.md) | Epoch-scoped typed content references for UTF-8 text and JSON | Partly superseded | 0013, 0015 |
| [0012](0012-schema-backed-boundary-decoders.md) | Schema-backed Pi and product boundary decoders | Superseded | 0013 |
| [0013](0013-canonical-gateway-and-explicit-boundaries.md) | One canonical Gateway protocol and explicit boundary guards | Partly superseded | 0015 |
| [0014](0014-host-owned-workspace-file-references.md) | Host-owned Workspace file capture, policy, and prompt expansion | Accepted | |
| [0015](0015-atomic-gateway-1-4-fenced-session-takeover.md) | Atomic Gateway 1.4 fenced Session takeover contract | Accepted | |
