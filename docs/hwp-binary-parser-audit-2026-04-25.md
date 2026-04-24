# HWP Binary Parser Audit - 2026-04-25

Owner: Team 1 - HWP official spec/parser audit

Scope:

- Source spec: `/Users/shinehandmac/Downloads/한글문서파일형식_5.0_revision1.3.pdf`
- Parser path audited:
  - `js/hwp-parser.js`
  - `js/hwp-parser-hwp5-records.js`
  - Read-only context from `js/hwp-parser-hwp5-container.js` and `js/hwp-parser-hwpx.js` where HWP5 path calls shared helpers
- No code changes in this audit.

## Executive Verdict

The current HWP5 parser is a display-oriented extractor, not a lossless HWP binary model. It preserves enough structure to load `attachment-sale-notice.hwp` as 4 pages, but it drops or normalizes several layout-critical records before a source-driven layout engine can reason about them.

For `attachment-sale-notice.hwp`, the highest visual-mismatch risk is table geometry and row height handling, followed by section/page frame interpretation, paragraph line metrics, and picture/object anchoring. Current diagnostics show the sample has 14 tables, 49 merged cells, 8 tall cells, 14 repeated-header table signals, 14 page-break table signals, and 2 pictures. That makes table/cell preservation the first parser priority even though the page count currently matches Hancom Viewer.

## Priority Order For Fidelity Recovery

| Priority | Area | Why It Matters For `attachment-sale-notice.hwp` | Current Risk |
|---|---|---|---|
| P0 | `TABLE` cell/list geometry | 14 tables, merged cells, tall cells, page 1/2/3 table stack, nested schedule heights | Cell offsets and row metrics are not proven against the official list-header + cell-property layout; repeated header and valid-zone styling are not source-complete |
| P0 | `BorderFill` resolution for tables/cells | Table borders/backgrounds drive perceived row height, grid density, and visual alignment | Border/fill is partially parsed, but side-border byte layout, image fills, diagonals, and zone overrides remain unsafe |
| P0 | `PageDef`/`SectionDef` | Page 1 header/title/table vertical placement depends on page frame, header/footer frame, and section visibility | Page size/margins are preserved, but section attributes, page border/fill, columns, and first-page visibility are mostly ignored or inferred from the wrong record |
| P1 | `PARA_LINE_SEG` and paragraph metrics | Table-cell baseline and title/header drift accumulate into visible mismatch | Raw line segments are attached, but actual line top/baseline/x/width are reduced to clamped aggregate height |
| P1 | `GSO`/ShapeObject picture anchoring | Page 1 logo/image and page 4 picture must land in the right local frame | Object common fields are normalized, but picture crop/effects/bin references and transform matrices are not preserved losslessly |
| P1 | `PARA_HEADER`/`TEXT`/`CHAR_SHAPE` | Text width, line breaking, bullet/number alignment, and table-cell overflow depend on these | Basic runs render, but control-character positions, char-shape positions, range tags, track merge, and many char-shape attrs are lost or normalized |
| P2 | `CTRL_HEADER`/`CTRL_DATA` | Header/footer, page controls, fields, bookmarks, and object dispatch need stable raw ordering | Only selected controls dispatch; most payloads/subtrees are skipped without an inspectable opaque node |
| P2 | DocInfo raw preservation | Compatibility/layout switches and unknown DocInfo records can alter layout | Known style tables are parsed, but unsupported DocInfo records are not retained as raw records |

## Current HWP5 Flow

`HwpParser.parse()` detects OLE HWP5, then `_parseHwp5()` calls `_parseBodyText()`. The container path reads `FileHeader`, parses `DocInfo`, loads `BinData`, discovers `BodyText/Section*`, then `_extractSectionParas()` chooses the best decompressed record attempt by text score. `_parseHwpBlockRange()` emits legacy renderer blocks and `_parseHwp5()` paginates them with `_paginateSectionBlocks()`.

Important consequence: once records become renderer blocks, most HWP record identity is gone. The active return shape is `{ meta, pages }`, not a raw-preserving document tree. This is acceptable for smoke loading, but not enough to explain Hancom visual layout.

## Official PDF Anchors Checked

The audit cross-checked these HWP 5.0 revision 1.3 areas:

- Storage structure: `FileHeader`, `DocInfo`, `BodyText/Section*`, `BinData`
- Record header: `TagID`, `Level`, `Size`, extended size
- DocInfo records: document properties, ID mappings, bin data, face names, border fill, char shape, tab, numbering, bullet, para shape, style, compatibility records, track/memo records
- Body records: `PARA_HEADER`, `PARA_TEXT`, `PARA_CHAR_SHAPE`, `PARA_LINE_SEG`, `PARA_RANGE_TAG`, `CTRL_HEADER`, `LIST_HEADER`, `CTRL_DATA`
- Object records: table, shape component, picture, OLE, equation, container, chart/video data
- Section records: `secd`, `PAGE_DEF`, `FOOTNOTE_SHAPE`, `PAGE_BORDER_FILL`, header/footer/page controls

## Detailed Audit

### DocInfo

Preserved now:

- `DOCUMENT_PROPERTIES`, `ID_MAPPINGS`, `BIN_DATA`, `FACE_NAME`, `BORDER_FILL`, `CHAR_SHAPE`, `TAB_DEF`, `NUMBERING`, `BULLET`, `PARA_SHAPE`, and `STYLE` are parsed into compact maps.
- `BinData` refs are linked to binary image streams for picture rendering.
- ID mapping counts are read into `idMappings.byName`.

Lost or abbreviated:

- Unsupported DocInfo records are skipped rather than retained: `DOC_DATA`, `DISTRIBUTE_DOC_DATA`, `COMPATIBLE_DOCUMENT`, `LAYOUT_COMPATIBILITY`, `TRACKCHANGE`, `MEMO_SHAPE`, `FORBIDDEN_CHAR`, `TRACK_CHANGE`, and `TRACK_CHANGE_AUTHOR`.
- Parsed records are not stored with raw bytes, source order, tag id, level, and stream offset.
- `ID_MAPPINGS` counts are not used as a hard validation or diagnostic against actual parsed record counts.
- Layout compatibility flags are not surfaced, even though they can alter line/table layout behavior.

Risk for `attachment-sale-notice.hwp`:

- Medium to high. The sample is HWP 5.1.1.0, beyond the PDF's 5.0 baseline. Any version-tail fields or compatibility switches currently disappear before diagnostics can explain layout drift.

Required preservation:

- Keep every DocInfo record as `{ tagId, level, size, streamOffset, rawBytes, parsed }`.
- Treat parsed maps as indexes over raw records, not replacements for raw records.
- Add diagnostics for ID mapping count mismatch, unknown DocInfo tags, and version-tail bytes.

### PARA_HEADER / PARA_TEXT / PARA_CHAR_SHAPE / PARA_LINE_SEG

Preserved now:

- `PARA_HEADER` keeps raw and masked character count, control mask, para shape id, style id, split flags, char-shape count, range-tag count, line-align count, and instance id in the emitted paragraph block.
- `PARA_TEXT` decodes visible UTF-16 text and records basic inline/extended control positions.
- `PARA_CHAR_SHAPE` ranges are parsed into `{ start, charShapeId }`.
- `PARA_LINE_SEG` records are parsed and attached to `rawLayout.lineSegs`.

Lost or abbreviated:

- `PARA_HEADER` is accepted at 18 bytes even though the official structure is 24 bytes. The track-merge field at the tail is not preserved.
- `breakType` is stored as `splitFlags`, but section/page/column break semantics are not modeled as first-class layout events.
- `PARA_RANGE_TAG` is not parsed or preserved.
- Extended control characters occupy 8 WCHAR slots in the official text model, but the decoded text removes them. This can desynchronize char-shape run positions after controls.
- `PARA_LINE_SEG` is reduced to average line height and total layout height. Baseline, horizontal position, segment width, line flags, and first/last segment semantics are not used for line boxes.
- Line metrics are clamped and filtered, including special handling for object-control offsets. That helps page-count smoke tests but hides the source line boxes needed for pixel fidelity.

Risk for `attachment-sale-notice.hwp`:

- High. Page 1 title/header drift and table-cell baseline drift are likely affected by aggregate line metrics and browser text flow replacing HWP line boxes.

Required preservation:

- Preserve `PARA_HEADER`, `PARA_TEXT`, `PARA_CHAR_SHAPE`, `PARA_LINE_SEG`, and `PARA_RANGE_TAG` as sibling records inside a paragraph cluster.
- Maintain both HWP character positions and decoded-render text positions.
- Use line segment top, baseline, text height, segment width, and flags as inspectable layout inputs, even if the legacy renderer keeps its current heuristic path.

### CTRL_HEADER / CTRL_DATA

Preserved now:

- `CTRL_HEADER` tag 71 is read, the 4-byte control id is decoded, and the nearest recorded extended control receives `controlId`, `controlKind`, record level, size, and raw hex preview.
- Selected controls dispatch: `tbl `, `gso `, `head`, `foot`, and `secd`.
- Header/footer blocks keep an even/odd scope derived from a small attr subset.

Lost or abbreviated:

- `CTRL_DATA` parameter sets are not parsed or preserved.
- Unsupported controls are skipped by subtree level, without an opaque node in output.
- Control subtree source order is not retained once converted into legacy blocks.
- Caption lists are not parsed from object controls.
- Fields, bookmarks, hyperlinks, hidden comments, index marks, auto numbers, new numbers, and many page controls are not inspectable.

Risk for `attachment-sale-notice.hwp`:

- Medium. Current diagnostics only show tables and pictures, but the same loss path blocks page-control and field fidelity for HWP samples generally.

Required preservation:

- Emit raw control nodes for every `CTRL_HEADER`, including all child records up to the subtree boundary.
- Parse known controls into normalized fields while retaining `rawSubtree`.
- Preserve `CTRL_DATA` as raw parameter-set bytes until a full parameter-set parser exists.

### TABLE

Preserved now:

- The table control path parses object common layout, table attr, row/column counts, cell spacing, default cell padding, split policy, repeat-header bit, row-size/count array, table border fill id, valid zones, and cell records.
- Cells preserve paragraph count, list flags, row/column address, row/column span, width, height, padding, border fill id, paragraphs, and resolved cell border style.
- Nested tables and nested `gso` controls inside cells are dispatched.
- The emitted table block keeps `columnWidths`, `rowHeights`, `rawLayout.validZones`, and `rawTailBytes`.

Loss or danger points:

- The official table cell list is `LIST_HEADER` plus a 26-byte cell property block. The current `_parseTableCell()` assumes an extra 2-byte field before the list attr. Because the sample still renders, this must be byte-dumped before declaring it wrong, but it is a top audit risk: a 2-byte offset error would corrupt cell address, span, width, height, padding, and border fill id.
- Table `Row Size`/row count array semantics are not documented in parser diagnostics. Current layout row heights are derived from cell heights and rowspan distribution, not from a raw table-grid model.
- There is no explicit occupancy grid for merged cells. Rows hold only their starting cells.
- Table-level `borderFillId` is retained but not resolved as a fallback style for cells in parser output.
- Valid-zone border/fill overrides are parsed but not applied to cell styles.
- Repeat header is reduced to a boolean and `numHeaderRows` is fixed to 1.
- HWP table blocks do not set `sourceFormat: 'hwp'`, and the shared table-slicing helper repeats header rows only for `sourceFormat === 'hwpx'`.
- Table captions are not preserved.
- Raw table/control bytes are not retained.

Risk for `attachment-sale-notice.hwp`:

- Critical. The current mismatch target explicitly names first-page table row heights and nested schedule table heights. The sample has 14 repeated-header/page-break table signals, 49 merged cells, and 8 tall cells.

Required preservation:

- Add a canonical table dump that shows raw table info bytes, parsed fields, every cell's raw header bytes, address/span/size/padding/border, valid zones, and nested record order.
- Build a parser-level occupancy grid before layout.
- Keep `table.rawLayout` complete enough to compare against the official PDF tables 74-80 without renderer heuristics.
- Resolve table-level border fill and valid zones into inspectable effective cell styles, while preserving original refs.

### GSO / ShapeObject / Picture

Preserved now:

- Object common attr, offsets, width/height, z-order, outer margins, instance id, description, inline flag, relative anchors, wrap mode, text flow, size refs, and numbering category are normalized.
- Picture objects can resolve a binary image and emit an image block.
- Equations preserve script text, color, font size, parsed tail text, and baseline.
- OLE/chart/video controls become labeled placeholder blocks.
- Text boxes collect child paragraph records.
- Generic shapes can become placeholders with approximate line/fill color.

Lost or abbreviated:

- Object common raw bytes and tail offset are not retained.
- Captions are ignored.
- Shape component parsing does not preserve group depth, local file version, initial/current size, flip flags, rotation, rotation center, or full rendering matrix sequence.
- Generic line/rectangle/ellipse/arc/polygon/curve detail records are not parsed or preserved.
- Picture parsing does not preserve crop rectangle, inner margin, picture info, border transparency, effects, additional picture properties, or raw payload.
- Picture bin id detection uses candidates and falls back to binary stream order. That can hide wrong endian/offset parsing in simple samples.
- Container/group objects are not modeled as ordered child object trees.

Risk for `attachment-sale-notice.hwp`:

- High for page 1 logo/image anchoring and page 4 picture placement, lower than tables because only 2 pictures are detected.

Required preservation:

- Preserve every object as raw object common + raw child records, even when the legacy renderer emits only an image or placeholder.
- Parse picture payload into explicit border, crop, inner margin, bin item id, effect summary, and unknown tail bytes.
- Preserve shape component matrices byte-for-byte before attempting transform rendering.

### BorderFill

Preserved now:

- `BORDER_FILL` records become border flags, side/diagonal border summaries, fill color, gradient, fill type, pattern color, and pattern type.
- Parsed cell border styles are attached through cell `borderFillId`.

Loss or danger points:

- The official PDF lists `lineType[4]`, `lineWidth[4]`, `lineColor[4]`, then diagonal type/width/color. The parser currently reads five 6-byte border records. This must be verified against real bytes because it can swap side widths/colors and corrupt diagonal data.
- Border flags are kept numerically, but diagonal slash/backslash semantics are not decoded.
- Image fill metadata is skipped rather than preserved with bin references.
- Gradient positions, additional fill properties, and unknown fill tails are not retained.
- `CharShapeBorderFill ID` is not surfaced from char shape parsing, so text background/border is lost.
- Table valid zones can reference different border fills but are not resolved into effective cell styles.

Risk for `attachment-sale-notice.hwp`:

- Critical. Dense grid/table documents are visually dominated by borders, fills, and cell background behavior. A border byte-layout error can make the page look close in count but wrong in density.

Required preservation:

- Byte-dump several `BORDER_FILL` records from `attachment-sale-notice.hwp` and compare both interpretations: array layout from the PDF versus interleaved 6-byte records.
- Preserve raw fill payload and unknown tails for every border fill.
- Resolve effective table/cell/zone border fill refs for diagnostics.

### PageDef / SectionDef

Preserved now:

- The parser scans `secd` children and uses `PAGE_DEF` to create page width, height, and margins.
- Header/footer margin fields are stored in page style.
- Page number position metadata is parsed from tag 76 when present.
- Header/footer content blocks are collected and filtered by basic even/odd scope.

Lost or unsafe:

- The `secd` control body itself is not parsed. Section attr, column gap, vertical/horizontal grid, default tab stop, numbering shape id, page number start, figure/table/equation starts, and representative language are lost.
- `PAGE_DEF` flags are not exposed as orientation/gutter policy.
- First-page header/footer/page-number visibility is inferred from `PAGE_DEF` flags bits 8-10, but the official PDF puts section visibility in `SectionDef.attr`, while `PAGE_DEF` flags define orientation and binding method.
- `PAGE_BORDER_FILL`, `FOOTNOTE_SHAPE`, `COLUMN_DEF`, master-page/batang-page data, and section-level page border/background refs are not preserved.
- Only the current compact `pageStyle` survives into pagination; there is no raw section record tree.

Risk for `attachment-sale-notice.hwp`:

- High. The known visual focus includes page 1 header/title/table vertical placement. If the page frame, header/footer frame, or first-page visibility source is wrong, every body element can drift even when table internals are correct.

Required preservation:

- Parse and preserve `secd` body separately from child `PAGE_DEF`.
- Keep `PAGE_DEF`, `PAGE_BORDER_FILL`, footnote/endnote shape, columns, and master-page records as raw children under section metadata.
- Add diagnostics that show page content box in HWPUNIT: paper, margins, header/footer, gutter, body box, and source record for every value.

## Cross-Cutting Preservation Gaps

- Unknown records are skipped, not counted.
- Raw bytes are usually lost after parsing.
- Record stream offsets are not surfaced.
- Version-tail fields are not preserved as tail bytes.
- Parser diagnostics report final blocks, not original record clusters.
- Pagination consumes heuristic block weights instead of source page/line/table boxes.

## Recommended Next Parser Work

1. Add a read-only HWP canonical dump path for `attachment-sale-notice.hwp` that emits DocInfo records, section records, paragraph clusters, table trees, object trees, and unknown records with raw byte spans.
2. Before changing rendering, verify table cell offset assumptions and `BORDER_FILL` byte layout against the official PDF and the sample bytes.
3. Promote parser diagnostics from page-level counts to record-level evidence: tables/cells/line segments/objects must link back to tag id, level, stream, and byte offset.
4. Preserve SectionDef/PageDef/PageBorderFill as raw section metadata and report the computed page body box.
5. Only after raw preservation is stable, let layout work consume table occupancy grids, line segments, and object anchors.

## Acceptance Criteria For This Audit Area

- `attachment-sale-notice.hwp` can produce a stable canonical parser dump without changing renderer output.
- Every parsed table cell can be traced back to raw list-header bytes and raw 26-byte cell-property bytes.
- Every `BorderFill` record keeps raw payload and reports which interpretation was used.
- Every section reports both `secd` attrs and `PAGE_DEF` attrs with their official source meaning.
- Unknown HWP records are counted and visible instead of silently disappearing.
