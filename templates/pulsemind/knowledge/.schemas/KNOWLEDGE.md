# Knowledge Wiki Schema

This directory defines the structure and conventions for the LLM-compiled wiki.

## Directory Structure

```
raw/          — Immutable source materials (Markdown). LLM reads but never modifies.
wiki/         — LLM-maintained structured knowledge pages.
  index.md    — Page-level catalog with one-line summaries.
  log.md      — Append-only chronological operation log.
  sources/    — Per-source distilled summaries.
  entities/   — Entity pages (people, products, organizations).
  concepts/   — Concept pages.
  syntheses/  — Cross-source synthesis articles.
.schemas/     — This schema directory.
```

## Frontmatter Convention

```yaml
---
title: "Page Title"
type: source | entity | concept | synthesis | index
status: active | stale | disputed | archived
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/example.md
tags: [tag1, tag2]
---
```

## Workflow

1. **Ingest**: New raw files → read → write source summary → update entities/concepts → index.md
2. **Lint**: Periodic health check → fix contradictions, stale content, orphan pages, broken links
3. **Query**: Read index.md → locate pages → synthesize answer → cite [[wikilinks]]

## Rules

- raw/ is never modified — it is ground truth.
- Contradictions between sources are marked as `disputed`, never silently smoothed.
- Every wiki claim must trace back to a source via `sources:` frontmatter.
- Pages interlink via [[wikilinks]].
