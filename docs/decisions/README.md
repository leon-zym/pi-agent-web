# Architecture decision records

ADRs record decisions that change identity, process ownership, protocol ordering, destructive
operations, or major UI performance strategy. Current contracts remain in the parent documentation;
an ADR explains why the contract exists and which alternatives were rejected.

| ADR | Decision |
|---|---|
| [0001](0001-pi-native-identity.md) | Pi-native Session and Workspace identity |
| [0002](0002-session-runtime-pool.md) | Session-scoped, bounded Pi runtime pool |
| [0003](0003-session-channel-control-and-recovery.md) | Multiplexed control, ordering, replay, and recovery |
| [0004](0004-recoverable-session-deletion.md) | Fenced, identity-bound recoverable deletion |
| [0005](0005-conversation-rendering.md) | Multi-Session publication and measured renderer decision |
| [0006](0006-ui-ux-design-system-and-reading-stream.md) | UI/UX design system, reading stream orchestration, and client lifecycle invariants |
| [0007](0007-versioned-pi-host-and-gateway-negotiation.md) | Versioned Pi host adapter, runtime selection, and Gateway hello negotiation |
| [0008](0008-authoritative-epoch-aware-live-session-resync.md) | Authoritative epoch-aware live Session resync and snapshot waterlines |
| [0009](0009-authoritative-hot-runtime-inventory-and-browser-reconciliation.md) | Authoritative hot Runtime inventory and Browser reconciliation |
| [0010](0010-epoch-scoped-attachment-references-and-payload-budgets.md) | Epoch-scoped attachment references and payload budgets |

New ADRs use: Status, Date, Context, Decision, Consequences, Rejected alternatives, Verification.
Accepted ADRs are amended or superseded by a later ADR; do not silently reverse them in a handoff or
temporary note.
