# Documentation map

Tracked documentation describes the product as it exists today. This page is the authoritative
navigation and ownership map: it names the single owner of each fact and the entry point for every
other page.

## Ownership

| Document | Owns | Does not own |
| --- | --- | --- |
| [README.md](../README.md) | Project purpose, product boundary summary, screenshots, shortest install and development path, repository map, documentation navigation | Architecture, protocol, or verification detail |
| [README.zh-CN.md](../README.zh-CN.md) | The Chinese projection of `README.md` | Facts that `README.md` does not state |
| [AGENTS.md](../AGENTS.md) | Rules that change agent edits, toolchain requirements, the change-to-document matrix, delivery gates | Architecture, protocol, or product detail; command reference |
| [SECURITY.md](../SECURITY.md) | Supported versions, private vulnerability reporting, the threat boundary | Local access-control mechanics, runtime authentication steps |
| [docs/architecture.md](architecture.md) | Identity, state ownership, concurrency, recovery, resource boundaries | Wire-level protocol shape, visual rules, verification commands |
| [docs/protocol.md](protocol.md) | Pi RPC boundary, runtime resolution, REST surface, WebSocket negotiation, publication and failure semantics | Numeric budgets, ownership rules, user-visible behavior |
| [docs/ui-ux.md](ui-ux.md) | User-visible behavior and state, composer interaction semantics, accessibility behavior, i18n copy ownership, acceptance triggers | Visual tokens, the visual acceptance matrix, state ownership |
| [docs/design.md](design.md) | Visual language, semantic tokens, typography and density, shell composition, overlays and motion, contrast and focus visuals, visual acceptance matrix | Interaction behavior, component state ownership |
| [docs/development.md](development.md) | Environment, root commands, repository scripts, verification layers, CI checks, packaging, release gates | Product behavior, benchmark measurement semantics |
| [docs/benchmark.md](benchmark.md) | Valid performance evidence, comparison and admission rules, run entry points, artifact location, Issue ownership | Historical measurements, CI workflow wiring |
| [docs/decisions/README.md](decisions/README.md) | ADR index, admission criteria, record structure, status and supersession fields | Current contracts |
| `docs/decisions/NNNN-*.md` | The context, decision, consequences, and rejected alternatives of one past decision | Current implementation status |
| `docs/evidence/**` | Frozen non-authoritative historical evidence | Current contracts and measurement definitions |

## Projection rules

- One fact has one owner. Every other document keeps the smallest projection it needs and links to
  that owner.
- Numeric constants, field enumerations, and guard values live in code. Cite the owning path instead
  of copying values.
- Delivery status, backlogs, and process plans live in GitHub Issues and pull requests, never in
  tracked documentation.
- Long-term reasons live in `docs/decisions/`. Current contracts state behavior without repeating
  the rationale.
- `docs/evidence/` holds archived evidence. Archived files stop changing, and no current contract
  depends on them.
- `docs/notes/` and `tmp/` hold ignored working material and carry no product authority.
- A new tracked document is a cost. It needs an ownership row here and a fact no other document
  owns.

## Writing rules

Apply these questions before adding or keeping a paragraph:

- If this fact changes, does exactly one file need to change? If not, it has the wrong owner.
- Must a reader still find this after the current iteration ends? If not, it belongs to an
  Issue or pull request.
- Can 30 seconds of reading the code answer this? If yes, delete the text and cite the code path.

Then write the paragraph as if it were reference material:

- One judgement per sentence. Prefer a short declarative sentence over a clause-chained one.
- Use affirmative statements for positive behavior; reserve negation for prohibited actions and
  security boundaries.
- Tracked documentation is English and uses plain punctuation: no en or em dashes. Every local link
  must resolve.
- Contract adjectives such as `canonical`, `authoritative`, or `bounded` appear where they introduce
  a constraint or separate two states, not as decoration.
- State no document's own purpose, and narrate no author decisions. The ownership table above
  declares responsibility once.
- Leave no paragraph that only reports a removal, a move, or a change of mind.

## Change path

1. A fact changed: find its owner in the table, then update that document.
2. A tracked document is added, renamed, or deleted: update the table in the same change.
3. A long-term decision is made: add an ADR and update `docs/decisions/README.md`.
4. Delivery status changed: update the GitHub Issue.
