# HWP Priority Fidelity Workboard

Date: 2026-04-25
Owner: Team 4, HWP workboard
Scope: HWP-first visual fidelity recovery for ChromeHWP/TotalDocs

## Operating Decision

HWP fidelity takes priority over HWPX until the baseline HWP samples can pass a fresh Hancom visual audit with strict guard evidence.
HWPX remains a regression target, but it must not pull parser, renderer, or LayoutTree work away from the HWP 5 binary path when the same engineering slot can improve `attachment-sale-notice.hwp`.

Primary sample:

1. `attachment-sale-notice.hwp`
   - Source: `/Users/shinehandmac/Downloads/(첨부)정정_공고문_신축다세대잔여세대선착순일반매각.hwp`
   - Current oracle: 4 Hancom pages, 4 TotalDocs pages
   - First audit focus: page 1 header/title/table vertical placement, logo/image anchoring, first-page table row heights, nested schedule table heights
   - Hotspot signals: repeated header rows, split cells, merged cells, large cells, one picture on page 1, one picture on page 4

Secondary HWP samples:

1. `goyeopje.hwp` for compact two-page table and merged-cell regression coverage
2. `goyeopje-full-2024.hwp` for long HWP table continuation across 11 pages
3. `gyeolseokgye.hwp` for one-page dense table and repeated-header sanity coverage

HWPX hold-line sample:

1. `incheon-2a.hwpx` remains a guardrail for page-count and long-table regressions, but it is not the top fidelity driver for this board.

## Non-Negotiable Guardrails

- Do not hard-code document names, file names, page numbers, sample text, or fixed coordinates in parser or layout logic.
- Do not claim HWP fidelity progress from page-count parity alone.
- Do not compare against stale screenshots or stale Hancom audit artifacts.
- Do not discard unknown HWP records or object payloads silently.
- Do not use browser DOM flow as the source of truth for final HWP placement in the LayoutTree path.
- Every change must keep the current HWP/HWPX baseline samples loadable, scrollable, and page-count checked.

## Phase 0: Fresh Hancom Audit And Strict Baseline

Goal: establish current, same-build visual evidence before layout changes.

### Checklist

- [ ] Regenerate TotalDocs screenshots from a clean local build for all baseline samples.
- [ ] Capture fresh Hancom Viewer screenshots for `attachment-sale-notice.hwp` pages 1-4.
- [ ] Record the exact source file path, modified time, viewer version if available, capture timestamp, and commit/working-tree hash for every audit artifact.
- [ ] Create a side-by-side audit note for `attachment-sale-notice.hwp` page 1 covering header y-position, title y-position, first table top, logo/image bounds, table row heights, border thickness, and text baseline drift.
- [ ] Mark each page as `match`, `review`, `mismatch`, `capture-error`, or `stale`.
- [ ] Treat `review`, `mismatch`, `capture-error`, and `stale` as blocking in strict HWP fidelity mode unless a temporary allowlist entry includes owner, reason, expiry date, and target phase.
- [ ] Keep page-count oracle checks enabled for all five current baseline documents.
- [ ] Add a page-level audit summary that clearly separates structural pass from visual pass.

### Completion Conditions

- `attachment-sale-notice.hwp` has fresh Hancom and TotalDocs page images for all 4 pages from the same source file.
- Page 1 has an explicit visual-diff note identifying the top three fidelity gaps.
- Strict guard fails when any fresh HWP page is `mismatch`, `capture-error`, `capture-review`, or stale.
- Existing smoke verification still reports all baseline samples as loadable and page-count checked.

## Phase 1: HWP Parser Raw Preservation

Goal: preserve enough HWP 5 binary source data to explain Hancom layout before any renderer heuristic runs.

### Checklist

- [ ] Preserve raw `DocInfo` mappings for `FACE_NAME`, `CHAR_SHAPE`, `PARA_SHAPE`, `TAB_DEF`, `NUMBERING`, `BULLET`, `STYLE`, `BORDER_FILL`, and `BIN_DATA`.
- [ ] Preserve section/page records with original page size, margins, header/footer zones, gutter policy, page borders, columns, and section break flags.
- [ ] Preserve paragraph records with raw header flags, control mask, para shape id, style id, char shape ranges, line segment records, range tags, and control character positions.
- [ ] Preserve table records with raw split policy, repeated-header bit, row size array, cell span, cell address, cell margin, border fill id, protected size flags, valid zones, captions, and nested control order.
- [ ] Preserve object records with control id, shape common properties, anchor mode, z-order, wrap mode, overlap policy, crop, transform, outside margin, caption, binary resource reference, and unparsed payload bytes.
- [ ] Preserve unsupported or unknown records as opaque nodes with tag id, level, size, stream, offset, parent context, and byte reference.
- [ ] Add a targeted canonical dump for `attachment-sale-notice.hwp` that includes counts for paragraphs, tables, cells, line segments, objects, binary resources, and unknown records.
- [ ] Verify HWP parser raw preservation before adding any new HWPX preservation tasks not needed by shared infrastructure.

### Completion Conditions

- `attachment-sale-notice.hwp` can be exported to a stable raw-preserving canonical JSON fixture.
- No layout-relevant field currently used by the HWP renderer is lost during export.
- Unknown HWP records are counted and inspectable instead of dropped.
- The canonical dump identifies page 1 table, image, paragraph, and line-segment source records needed for the next phases.

## Phase 2: HWP Table Engine

Goal: make HWP table geometry deterministic and source-driven, starting with page 1 of `attachment-sale-notice.hwp`.

### Checklist

- [ ] Build table layout input from preserved HWP row size arrays, cell spans, cell margins, border fill ids, and paragraph content metrics.
- [ ] Compute an occupancy grid for every table before rendering so merged cells, row spans, nested tables, and split cells are represented explicitly.
- [ ] Calculate row heights in HWP units using source row size, cell content line windows, cell margins, border widths, and minimum-size policy.
- [ ] Distribute rowspan height across occupied rows instead of assigning all height to the starting row.
- [ ] Apply repeated header rows only when the source repeated-header bit and split policy require it.
- [ ] Split tables using remaining page height for the first fragment and full body height for following fragments.
- [ ] Preserve continuation metadata for cells crossing page fragments, including repeated borders, suppressed duplicated text, and nested-table clipping.
- [ ] Add a focused overlap detector for table cells, floating objects, and page header/body boundaries.
- [ ] Compare page 1 table top, row heights, and nested schedule table height against the fresh Hancom audit before moving to HWPX table refinements.

### Completion Conditions

- `attachment-sale-notice.hwp` still renders as 4 pages.
- Page 1 first table top and row-height drift are measurably closer to Hancom than the Phase 0 baseline.
- No table-cell overlap, duplicated continuation text, or missing repeated-header regression appears in the three secondary HWP samples.
- `incheon-2a.hwpx` remains page-count stable as a hold-line guard, but HWP improvement is the promotion criterion for this phase.

## Phase 3: Paragraph, Line Layout, Font, And Char Shape

Goal: reduce cumulative text-flow drift inside HWP paragraphs and table cells.

### Checklist

- [ ] Use preserved HWP `PARA_LINE_SEG` values for line top, baseline, text height, line height, horizontal start, and horizontal size wherever available.
- [ ] Fall back to measured text metrics only when line-segment data is absent or malformed, and emit a diagnostic for every fallback.
- [ ] Apply paragraph shape fields including alignment, line spacing type/value, margins, indent, heading/list information, tab definition, keep-with-next, widow/orphan policy if available, and border/fill interaction.
- [ ] Apply char shape fields including font face by language, font size, bold, italic, underline, strike, text color, shade color, spacing, scale, offset, shadow, outline, emboss, and superscript/subscript.
- [ ] Route HWP font selection through the shared font substitution module instead of ad hoc CSS font strings.
- [ ] Add font inventory diagnostics for every sample: source font ids, resolved CSS family, missing fonts, fallback family, and pages affected.
- [ ] Remove global CSS line-height assumptions from the HWP LayoutTree path.
- [ ] Add page-level drift metrics for title baseline, table-cell first baseline, and paragraph block height on `attachment-sale-notice.hwp` page 1.

### Completion Conditions

- HWP sample reports show non-empty font and char-shape inventories.
- `attachment-sale-notice.hwp` page 1 title/header text and first table text baselines move closer to Hancom captures.
- Paragraph heights in page 1 tables are derived from source line and char shape data, not from browser default line-height.
- Secondary HWP samples do not regress in page count or obvious text clipping.

## Phase 4: Object Anchoring And LayoutTree Transition

Goal: move HWP placement decisions out of DOM flow while fixing image/table/object anchoring.

### Checklist

- [ ] Define the HWP subset of `LayoutTree`: page boxes, content area, paragraph boxes, line boxes, table fragments, row boxes, cell boxes, object boxes, and diagnostics.
- [ ] Convert preserved HWP source units to pixels only at the LayoutTree boundary.
- [ ] Render LayoutTree pages with absolute-positioned children instead of normal DOM document flow.
- [ ] Keep the current DOM renderer as `legacy-dom` fallback while the HWP LayoutTree path matures.
- [ ] Resolve HWP object anchors before rendering: page, paper, column, paragraph, cell, and inline.
- [ ] Apply object z-order, allow-overlap, wrap mode, outside margin, crop, transform, caption, and binary image bounds from preserved records.
- [ ] Put page/paper anchored objects into page overlay layers and paragraph/cell anchored objects into their local coordinate space.
- [ ] Add a side-by-side diagnostic view for `legacy-dom` versus `layout-tree` on `attachment-sale-notice.hwp` page 1.
- [ ] Prohibit post-render DOM measurements from changing LayoutTree object positions.

### Completion Conditions

- `attachment-sale-notice.hwp` page 1 can render through the HWP LayoutTree path with inspectable page, table, paragraph, line, and object boxes.
- The page 1 logo/image anchor and first table placement no longer depend on post-render DOM measurement.
- LayoutTree and legacy DOM can be compared side by side without replacing the stable fallback.
- LayoutTree output is at least visually no worse than legacy DOM on `attachment-sale-notice.hwp` page 1 before expanding to all HWP pages.

## Phase 5: Strict Promotion And Regression Guard

Goal: promote HWP fidelity changes only when they beat the existing path under fresh visual and structural evidence.

### Checklist

- [ ] Require syntax checks for the active parser, renderer, worker, and layout modules changed by the phase.
- [ ] Require `node scripts/verify_samples.mjs` or its successor to load all baseline documents and write a current report.
- [ ] Require strict visual mode for HWP work: stale artifacts, `mismatch`, `capture-error`, and `capture-review` fail the run.
- [ ] Require `attachment-sale-notice.hwp` page 1 to show explicit improvement or no regression before any HWPX-first work is accepted.
- [ ] Keep HWPX `incheon-2a.hwpx` page count and major overlap guards as hold-line checks.
- [ ] Add per-phase evidence links to screenshots, canonical dumps, layout dumps, and guard reports.
- [ ] Promote `layout-tree` only per sample or feature class until all primary and secondary HWP samples are safer than `legacy-dom`.
- [ ] Keep rollback simple: feature flags must allow `legacy-dom`, `layout-tree`, and `side-by-side`.

### Completion Conditions

- `attachment-sale-notice.hwp` passes structural checks and has a fresh visual audit showing fewer blocking mismatches than Phase 0.
- All secondary HWP samples remain loadable, scrollable, and page-count stable.
- Strict guard fails correctly on stale or visually failing artifacts and passes only with fresh acceptable evidence.
- The HWP LayoutTree path has an explicit promotion record naming the covered sample pages, supported features, known gaps, and fallback path.

## Execution Order

1. Finish Phase 0 before touching renderer behavior.
2. Complete the HWP canonical dump in Phase 1 before adding new layout rules.
3. Attack the `attachment-sale-notice.hwp` page 1 table stack in Phase 2.
4. Correct paragraph, line, font, and char-shape drift in Phase 3 only after source table geometry is trustworthy.
5. Move object placement and page assembly to LayoutTree in Phase 4.
6. Promote only through Phase 5 strict evidence.

## Definition Of Done For This Board

- HWP is demonstrably ahead of the current baseline on `attachment-sale-notice.hwp`, especially page 1.
- HWP parser output preserves raw layout-critical records needed by LayoutTree.
- HWP tables, paragraphs, line layout, fonts, char shapes, and object anchors have concrete diagnostics and guard evidence.
- LayoutTree exists as the fidelity path while legacy DOM remains a fallback.
- HWPX regressions are guarded, but HWP remains the first optimization target.
