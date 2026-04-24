# HWP/HWPX Fidelity Recovery Plan

Date: 2026-04-24
Scope: Hancom Viewer parity for HWP/HWPX rendering

## Executive Decision

TotalDocs must stop treating the current DOM flow renderer as the fidelity path.

The current implementation can load documents and match page counts, but it cannot reliably match Hancom Viewer because pagination, table splitting, line layout, object anchoring, and typography are decided by browser DOM flow and heuristics.

The recovery path is:

1. Freeze the current DOM renderer as the legacy fallback.
2. Preserve HWP/HWPX source layout data losslessly.
3. Define a `CanonicalDocument` model.
4. Build a deterministic `LayoutTree`.
5. Render the `LayoutTree` with absolute page boxes.
6. Promote the new path only when Hancom page audit improves without structural regressions.

## Meeting Findings

### 1. Renderer Architecture

- Current rendering is DOM flow reconstruction, not Hancom-style fixed layout.
- `.hwp-page` page size can now match, but paragraphs, tables, and objects still flow through CSS.
- Global CSS line-height, paragraph margins, table defaults, and row min-height alter source metrics.
- DOM measurement after rendering is used for object placement, so early flow errors cascade into later anchor errors.

Conclusion: DOM flow patches cannot be the long-term fidelity path.

### 2. HWPX Parser Coverage

- `header.xml` and `section*.xml` are parsed only partially.
- Unknown controls are often dropped instead of preserved as opaque raw blocks.
- `pagePr`, `margin`, `linesegarray`, `paraPr`, `charPr`, `tbl`, `tc`, `subList`, and object layout fields are not preserved or applied fully.
- Page gutter, page border area policy, grid/column settings, cell zones, captions, object rendering transforms, field/bookmark/equation/OLE/text art and many shared shape-object properties are incomplete.

Conclusion: parser output must become lossless enough to explain layout, even before all controls are rendered.

### 3. Table Pagination

- Page count parity was achieved by weight calibration, not by Hancom-equivalent table layout.
- HWPX table chunks are split before knowing remaining page height.
- Repeat headers are parsed but not applied in every split path.
- Rowspan cell heights are concentrated on starting rows instead of being distributed through occupied rows.
- Long-cell continuation uses paragraph-count heuristics instead of source line windows.

Conclusion: table pagination must become remaining-height based and occupancy-grid based.

### 4. Typography

- Font diagnostics are currently weak; sample reports show empty font inventories.
- Renderer bypasses the existing font substitution module.
- HWPX fontface metadata such as TTF/HFT type is not preserved.
- Global CSS line-height and renderer minimum-line-height corrections override source `lineseg` metrics.

Conclusion: typography must be measured and reported before visual parity can be trusted.

### 5. Testing

- Structural guardrails are useful but insufficient.
- Visual audit must be run from fresh same-build artifacts.
- `mismatch`, `capture-error`, and `capture-review` must fail strict fidelity runs.
- `review` pages should be tracked as known debt with diff thresholds.

Conclusion: visual mismatch must become a first-class failing signal when working on fidelity.

## Recovery Plan

### Phase 0: Stop The Bleeding

Goal: prevent new heuristic debt.

Tasks:
- Freeze current DOM renderer behavior as `legacy`.
- Stop adding sample-text-specific layout rewrites.
- Make strict visual audit fail on `mismatch`, `capture-error`, and `capture-review`.
- Add stale-artifact protection between `verify_samples` and page-audit reports.
- Keep current page-count and DOM geometry gates.

Exit criteria:
- `node scripts/verify_samples.mjs` passes.
- `FIDELITY_REQUIRE_VISUAL_AUDIT=1 node scripts/check_fidelity_guard.mjs` fails when known visual mismatches exist.
- Reports clearly distinguish structural pass from visual failure.

### Phase 1: Lossless Canonical Document Model

Goal: parser output must preserve every layout-relevant source field.

Tasks:
- Add `CanonicalDocument` schema for sections, pages, paragraphs, runs, line segments, tables, rows, cells, objects, resources, and unknown controls.
- Preserve `rawPagePr`, `rawMargin`, `rawSecPr`, `rawParaPr`, `rawCharPr`, `rawTable`, `rawRow`, `rawCell`, and `rawObject`.
- Preserve HWPX fontface as `{ lang, id, face, type }`.
- Preserve unknown HWPX controls as opaque blocks with raw element name, attributes, text, and child summaries.
- Add a canonical model dump script for targeted samples.

Exit criteria:
- `incheon-2a.hwpx` can be dumped into a stable canonical JSON fixture.
- No source layout field currently used by renderer is lost during model export.
- Unknown controls are counted and reported, not silently discarded.

### Phase 2: Deterministic LayoutTree Prototype

Goal: move pagination and placement decisions out of DOM.

Tasks:
- Extend `engine/` or JS prototype from flat block input to hierarchical canonical input.
- Produce `LayoutTree` with pages, content area, paragraph boxes, line boxes, table boxes, row boxes, cell boxes, object boxes, fragments, and diagnostics.
- Use HWPUNIT as source unit and a single px conversion boundary.
- Render `LayoutTree` as absolute-positioned page children, not normal document flow.

Exit criteria:
- One HWPX fixture can produce inspectable page boxes without using browser reflow.
- LayoutTree and legacy DOM can be shown side by side.

### Phase 3: Table Engine

Goal: fix the largest visual divergence class.

Tasks:
- Compute logical row heights in source units, distributing rowspan heights across occupied rows.
- Split tables using remaining page height for the first chunk and full page height for later chunks.
- Always budget repeated header rows when `repeatHeader` applies.
- Implement occupancy-grid slicing so cells crossing chunk boundaries get continuation metadata.
- Implement long-cell continuation with `lineSeg` windows, not paragraph count alone.
- Add nested table clipping and continuation.

Exit criteria:
- `incheon-2a.hwpx` pages 14-18 improve against Hancom page audit.
- Page count remains 18.
- No table overlap regressions on the five baseline documents.

### Phase 4: Typography And Line Layout

Goal: reduce cumulative text-flow drift.

Tasks:
- Add font histogram diagnostics to `verify_samples`.
- Use `FontSubstitution.resolveFont()` and `fontFamilyWithFallback()` in the renderer.
- Preserve and apply fontface type/language metadata.
- Remove or weaken global `.hwp-page *` line-height overrides for LayoutTree rendering.
- Apply `lineseg` baseline, text height, horizontal segment, char spacing, and scaleX at line-box level.

Exit criteria:
- Reports show non-empty font inventory for HWP/HWPX samples.
- Title/header text metrics move closer to Hancom captures.
- Line height drift is measurable per page.

### Phase 5: Object Anchoring

Goal: match picture/table/shape placement.

Tasks:
- Resolve object anchors before rendering: page, paper, column, paragraph, and cell.
- Apply z-order, allow-overlap, wrap mode, outMargin, caption, crop, and transform metadata.
- Put page/paper objects in a page overlay layer.
- Put paragraph/cell objects in the correct local coordinate space.

Exit criteria:
- Object-heavy pages no longer depend on post-render DOM measurements for placement.
- Hancom audit diff improves on pages with floating tables/pictures.

### Phase 6: Promotion

Goal: make the new path the default only when it is safer than legacy.

Tasks:
- Add feature flags: `legacy-dom`, `layout-tree`, `side-by-side`.
- Run strict structural and visual audits on both paths.
- Promote `layout-tree` per format or per feature class only after it beats legacy.

Exit criteria:
- No known baseline document regresses structurally.
- Visual audit has fewer `mismatch/capture-review` pages than legacy.
- The fallback path remains available.

## Immediate Next Actions

1. Tighten strict visual guard behavior.
2. Add canonical model export scaffolding and schema documentation.
3. Add HWPX raw layout preservation for page, paragraph, char, table, cell, object, and unknown controls.
4. Build targeted canonical fixtures for `incheon-2a.hwpx`.
5. Start table engine work with rowspan distribution and repeat-header chunking.

## Non-Negotiable Rules

- Do not hard-code document names, page numbers, text, or coordinates in layout rules.
- Do not claim fidelity from page-count parity alone.
- Do not discard unknown HWP/HWPX controls silently.
- Do not let stale Hancom audit artifacts pass as current evidence.
- Every layout fix must include structural verification and visual audit evidence.
