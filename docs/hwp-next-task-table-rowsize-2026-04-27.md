# Next HWP Parser Task: `HWPTAG_TABLE` row-size preservation and table-grid input

Date: 2026-04-27
Owner: parser fidelity audit
Scope: `attachment-sale-notice.hwp` first, all HWP tables second

## Verdict

The single highest-value parser/layout task after verification fixes is to repair HWP table row-metric preservation at the parser boundary:

1. parse and preserve the official `rowSize[rowCount]` array from `HWPTAG_TABLE`
2. stop treating that slot as `rowCellCounts`
3. feed the preserved row-size array into table-grid / row-height / split decisions before DOM heuristics

This is the best next task because current HWP fidelity priority is page-1 table geometry on `attachment-sale-notice.hwp`, and the active parser is discarding the source row-height array that should drive exactly that layout.

## Evidence

### 1. Current workboard priority already says HWP table geometry is next

- `docs/hwp-priority-workboard-2026-04-25.md`
  - Phase 1 checklist explicitly requires preserving the HWP table `row size array`
  - Phase 2 starts with `Build table layout input from preserved HWP row size arrays`
  - Primary target is `attachment-sale-notice.hwp` page-1 table top and row heights

### 2. Official spec says the field is `rowSize`, not row cell count

- `docs/hwp-spec-analysis/hwp-5.0-revision1.3.md`
  - table record field list: `rowSize[rowCount]` = `2 * rowCount` bytes
  - marked as layout-direct and mandatory to preserve

### 3. Current parser reads that array as `rowCellCounts`

Hotspot:

- `js/hwp-parser-hwp5-records.js:1848-1875`
- `js/hwp-parser-hwp5-records.js:2436-2448`

Current behavior:

- `_parseTableInfo()` reads `rowCount` 16-bit values after the default cell padding
- stores them as `rowCellCounts`
- `_buildTableBlock()` forwards them as `rowCellCounts`
- parser never exposes a preserved HWP `rowSize` array

### 4. Sample evidence shows the parsed values behave like cell counts, not row heights

From `node scripts/dump_hwp_table_metrics.mjs output/playwright/inputs/attachment-sale-notice.hwp`:

- one 13x7 table reports
  - `rowHeights`: `[1915, 1915, ...]`
  - `rowCellCounts`: `[6, 7, 5, 6, 6, 6, 5, 6, 6, 7, 6, 6, 5]`
- those `rowCellCounts` sum to `77`, exactly the table `cellCount`
- that makes them useful as row occupancy/cell-start counts, but not as the preserved spec `rowSize` array required for source-driven row height

### 5. Current row-height synthesis is heuristic

Hotspots:

- `js/hwp-parser-hwp5-records.js:2410-2419`
- `js/hwp-parser-hwp5-records.js:2062-2075`

Current behavior:

- `rowHeights` are derived from cell heights distributed across rowspan
- table pagination weight is then derived from that synthetic `rowHeights`
- no preserved HWP row-size array participates in HWP table splitting or row-height decisions

## Why this beats other parser tasks right now

This outranks section/page, line-seg, and object work for the next slice because:

1. the workboard's primary mismatch is HWP table vertical geometry
2. the parser is missing a spec-defined table field that directly controls row heights
3. the missing field contaminates later table split and repeat-header behavior
4. the fix can be scoped to HWP table parsing and diagnostics without touching verification-pipeline code

## Next implementation slice

1. Byte-audit several `HWPTAG_TABLE` bodies from `attachment-sale-notice.hwp`
   - confirm exact offsets for `rowSize[]`, `borderFillId`, and zone info on this parser path
2. Preserve both views during transition
   - `rowSizes`: raw spec array in source units
   - `rowCellStartCounts` or similarly named diagnostic if the current derived counts are still useful
3. Update table diagnostics / dump script to print both arrays distinctly
4. Change HWP table row-height input to prefer preserved `rowSizes` before synthetic cell-height distribution
5. Re-check `attachment-sale-notice.hwp`, `goyeopje.hwp`, and `goyeopje-full-2024.hwp` for page-count stability and row-height plausibility

## Guardrails

- do not hard-code sample-specific values
- do not touch verification guard logic in this slice
- do not claim visual parity from page-count parity
- preserve old diagnostic names only as compatibility aliases if needed, but make the semantic split explicit

## Minimum validation for the implementation slice

- `node --check js/hwp-parser-hwp5-records.js`
- `node scripts/dump_hwp_table_metrics.mjs output/playwright/inputs/attachment-sale-notice.hwp`
- `node scripts/verify_samples.mjs`

## This audit's conclusion

If only one parser/layout task is taken next, take `HWPTAG_TABLE rowSize preservation + row-height/table-grid hookup` first. It is the clearest spec-backed gap sitting directly on the current HWP fidelity target.