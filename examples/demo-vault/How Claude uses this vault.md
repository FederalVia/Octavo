---
tags: [meta, ai]
region: stem
---
# How Claude uses this vault

When you connect Claude through MCP (see the project README), this vault becomes Claude's long-term memory:

- At the start of a conversation Claude reads the vault overview and searches for relevant notes.
- It saves decisions, facts and preferences into the right folder, e.g. people in `People/`.
- It keeps a short log of each session in the journal (see [[2026-11-06]]).
- It links new notes to existing ones with `[[wikilinks]]` so the brain keeps growing.

Related: [[Second Brain]], [[Octavo]].
