# Domain Docs

This repository uses a single-context domain-doc layout.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- Relevant ADRs under `docs/adr/`.

If these files do not exist, proceed silently. Domain-modeling skills create them lazily when terminology or decisions are resolved.

## File structure

/
├── CONTEXT.md
├── docs/adr/
└── src/

## Use the glossary's vocabulary

Use terms as defined in `CONTEXT.md`. Avoid synonyms that the glossary explicitly rejects. If a needed concept is absent, reconsider the terminology or note the gap for domain modeling.

## Flag ADR conflicts

Explicitly surface output that contradicts an existing ADR rather than silently overriding it.
