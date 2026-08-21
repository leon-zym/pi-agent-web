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

New ADRs use: Status, Date, Context, Decision, Consequences, Rejected alternatives, Verification.
Accepted ADRs are amended or superseded by a later ADR; do not silently reverse them in a handoff or
temporary note.
