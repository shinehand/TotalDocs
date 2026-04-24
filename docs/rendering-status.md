# Rendering Status

## Scope
- Project: `TotalDocs`
- Official parser/rendering path as of 2026-04-22:
  - `js/hwp-parser.js`
  - `js/hwp-parser-hwp5-records.js`
  - `js/hwp-parser-hwpx.js`
  - `js/hwp-parser-hwp5-container.js`
  - `js/hwp-renderer.js`
- The former external WASM bundle is not TotalDocs's reference engine and is not part of the active runtime path.

## Baseline Samples
`/Users/shinehandmac/Downloads/고엽제등록신청서.hwp`
`/Users/shinehandmac/Downloads/231229 고엽제후유(의)증환자 등 등록신청서 일체(2024.1.1. 기준).hwp`
`/Users/shinehandmac/Downloads/결석계.hwp`
`/Users/shinehandmac/Downloads/(첨부)정정_공고문_신축다세대잔여세대선착순일반매각.hwp`
`/Users/shinehandmac/Downloads/(공고문)인천가정2A-.hwpx`

## Supported Now
- HWP:
  - Body text extraction from `BodyText/Section*`
  - Table extraction with cell span/size and border fill mapping
  - Basic `DocInfo` style mapping (`FACE_NAME`, `CHAR_SHAPE`, `PARA_SHAPE`, `TAB_DEF`, `NUMBERING`, `BULLET`, `STYLE`)
  - Paragraph line segment safety mapping
  - `styleId`-based paragraph/run defaults and basic numbering/bullet prefix rendering
- HWPX:
  - Section parsing and page split
  - Header/footer/page number block rendering
  - Page border fill/style application
  - Core image block rendering with position offsets
  - Table structure rendering for major layout sections
  - Character shadow parsing from `charPr/shadow`

## Regression Rule
- Renderer fixes must not hard-code document names, file names, page numbers, sample-specific coordinates, or sample text.
- A fix is acceptable only when it is derived from HWP/HWPX records and applies as a reusable layout rule.
- Minimum smoke verification:
  - `node --check js/hwp-parser.js`
  - `node --check js/hwp-parser-hwp5-records.js`
  - `node --check js/hwp-parser-hwpx.js`
  - `node --check js/hwp-parser-hwp5-container.js`
  - `node --check js/hwp-renderer.js`
  - `node --check js/parser.worker.js`
  - `node scripts/verify_samples.mjs`
  - `node scripts/check_fidelity_guard.mjs`
  - `FIDELITY_REQUIRE_VISUAL_AUDIT=1 node scripts/check_fidelity_guard.mjs` before claiming Hancom visual-fidelity progress
- Current smoke criteria:
  - each sample must load through `hwpUrl`
  - each sample must expose page/section status
  - each sample must be scrollable from first page to last page without runtime errors
  - first rendered page geometry must match parser diagnostics (`HWPUNIT / 75px`) so page-size clamps cannot regress
  - Hancom Viewer page-count oracle must match for known baseline documents
  - strict visual guard must fail on stale Hancom page-audit artifacts, `mismatch`, `capture-error`, or `capture-review`
  - `FIDELITY_VISUAL_MAX_AGE_HOURS` controls the maximum accepted Hancom page-audit age in strict mode; default is 24 hours
  - the generated report must be written to `output/playwright/verify-samples-report.json`

## 2026-04-22 Direction Reset
- Completed:
  - Removed the former WASM bridge from the viewer load path.
  - Removed the generated WASM bundle files from `lib/`.
  - Deleted the external-engine migration plan because that is no longer the project direction.
  - Kept TotalDocs's split JS parser modules as the official implementation path.
  - Updated README and this status file to make clear that the external WASM path is not the reference engine.
  - Updated `scripts/verify_samples.mjs` so smoke verification can detect DOM-rendered `.hwp-page` output instead of requiring Canvas pages.
- Verification to run after this reset:
  - JS syntax checks for the parser/renderer modules.
  - `node scripts/verify_samples.mjs` against the JS parser/DOM renderer path.
  - Focused visual review of `incheon-2a.hwpx` page 2 and pages 12-18.
- Remaining work:
  - Improve HWP/HWPX layout fidelity for object anchoring, repeat headers, long split cells, and nested table continuation.
  - Add automated screenshot/perceptual regression thresholds for the page 2 split-cell overlap class.
  - Keep parser-module split behavior under regression checks in both direct viewer loading and worker parsing paths.

## 2026-04-22 WASM Redesign Plan
- Plan document:
  - `docs/totaldocs-wasm-redesign-plan-2026-04-22.md`
- Decision:
  - WASM remains allowed as a TotalDocs-owned implementation detail.
  - The source of truth remains the HWP/HWPX specs, TotalDocs's own model, and Hancom Viewer visual comparison.
  - Generated WASM binaries must not become the design authority.
- Resume date:
  - 2026-04-24
- First tasks:
  - Stabilize the JS parser/DOM renderer verification baseline.
  - Reproduce `incheon-2a.hwpx` page 2 overlap in the official JS path.
  - Define the canonical layout model needed by both JS and future WASM layout.
  - Decide the owned `engine/` scaffold and build commands.

## 2026-04-24 Parser Research Report
- Report document:
  - `docs/document-parser-research-report-2026-04-24.md`
- Decision:
  - HWP/HWPX remains the primary fidelity target.
  - Multi-format parsing should be added through one canonical document model, not by wiring unrelated parsers straight into the renderer.
  - TXT, Markdown, CSV/TSV, and HTML are the safest first non-HWP parser targets.
  - DOCX, ODT, EPUB, XLSX, and PPTX are feasible through ZIP/XML package readers.
  - PDF should use a PDF.js adapter first.
  - Binary DOC is possible, but should start as CFB probing and text extraction, not full layout reproduction.
- Next parser work:
  - Preserve complete HWPX line segment and table pagination source fields.
  - Add focused diagnostics for the page/table overlap class.
  - Draft `CanonicalDocument` and `LayoutTree` schemas before adding many new formats.

## 2026-04-24 Owned WASM Progress
- Completed:
  - Added `engine/` as a TotalDocs-owned Rust/WASM layout prototype.
  - Added `js/hwp-layout-adapter.js` so the browser can load `lib/generated/totaldocs_engine.wasm` and request a layout tree without replacing the JS renderer.
  - Preserved HWPX `lineseg` raw attributes (`textpos`, `vertpos`, `vertsize`, `textheight`, `baseline`, `spacing`, `horzpos`, `horzsize`, `flags`) on parsed paragraph blocks.
  - Preserved HWPX table pagination/layout source fields including `pageBreak`, `repeatHeader`, object position metadata, cell sizes, cell spans, margins, and `subList` text dimensions.
  - Added JS-path diagnostics from the parsed document model so verification no longer depends on a removed external WASM diagnostic API.
- Build and smoke commands:
  - `scripts/build_totaldocs_engine.sh`
  - `node scripts/test_totaldocs_engine.mjs`
- Latest verification:
  - `node scripts/verify_samples.mjs` loads all five baseline documents through the JS parser/DOM renderer.
  - `incheon-2a.hwpx` first improved from 11 pages to 13 pages after raw row-height preservation.
  - The first long-cell continuation pass rendered 20 pages versus Hancom Viewer's 18-page oracle.
  - HWPX page budget calibration now renders `incheon-2a.hwpx` as 18 pages, matching the Hancom Viewer oracle.
  - Focused page 2 DOM overlap probe returned no overlap candidates and `output/playwright/qa-snapshots/incheon-2a-page2-after-budget.png` captures the verified page.
- Remaining work:
  - Compare `output/playwright/incheon-2a-layout-fixture.json` against the parsed TotalDocs continuation chunks and Hancom Viewer page captures for pages 14-18.
  - Keep refining table split rules using preserved `pageBreak`, repeat header rows, raw row/cell heights, and long-cell continuation windows.
  - Add a side-by-side diagnostic mode that compares JS layout, WASM layout, and Hancom Viewer screenshots.
  - Keep the WASM path disabled as a renderer replacement until it improves overlap cases without regressing normal document loading.

## 2026-04-24 HWPX Page Budget Calibration
- Completed:
  - Changed HWPX parsing to use section page style through `_paginateSectionBlocks()` instead of the fixed 46-weight fallback.
  - Added an HWPX-specific page budget conversion of `2250 HWPUNIT / weight`; HWP keeps the existing `1500 HWPUNIT / weight` conversion.
  - Verified `incheon-2a.hwpx` moved from TotalDocs 20 pages to 18 pages, matching the Hancom Viewer 18-page oracle.
  - Verified page 2 visually and with a DOM overlap probe: rendered pages `18`, status `2 / 18 쪽`, overlap candidates `0`.
- Verification:
  - `node --check js/hwp-parser.js`
  - `node --check js/hwp-parser-hwp5-records.js`
  - `node --check js/hwp-parser-hwpx.js`
  - `node --check js/hwp-parser-hwp5-container.js`
  - `node --check js/hwp-renderer.js`
  - `node --check js/parser.worker.js`
  - `cargo test --manifest-path engine/Cargo.toml`
  - `node scripts/test_totaldocs_engine.mjs`
  - `node scripts/dump_hwpx_layout_fixture.mjs`
  - `node scripts/verify_samples.mjs`
- Verification status:
  - `node scripts/verify_samples.mjs` now exits successfully.
  - All five baseline documents match the Hancom Viewer page-count oracle:
    `goyeopje.hwp` 2 vs 2, `goyeopje-full-2024.hwp` 11 vs 11,
    `gyeolseokgye.hwp` 1 vs 1, `attachment-sale-notice.hwp` 4 vs 4,
    and `incheon-2a.hwpx` 18 vs 18.
- Next priority:
  - Keep page-count parity while improving visual fidelity, starting with
    `attachment-sale-notice.hwp` page 1 header/table vertical placement and
    `incheon-2a.hwpx` pages 14-18 long table continuation.

## 2026-04-24 HWP Parser Recovery
- Completed:
  - Corrected HWP `DocInfo` indexing for zero-based `FACE_NAME`, `CHAR_SHAPE`, `PARA_SHAPE`, `TAB_DEF`, `NUMBERING`, `BULLET`, and `STYLE` references while keeping one-based `BinData` and `BorderFill` references.
  - Corrected HWP `BorderFill` parsing to the official border structure: border flags, five 6-byte border records, and fill flags with color/gradation/image payload order.
  - Corrected HWP table parsing for split policy, repeated header bit, signed cell padding, row cell counts, and valid zone count/size compatibility.
  - Excluded inline table/drawing/equation line segments from text paragraph line-height summaries so embedded controls do not inflate paragraph height.
  - Restored HWP page dimensions from the original page style instead of clamping wide pages to 860px.
  - Rendered inline overlapping `gso` images in table cells as anchored images, reducing title/logo row height inflation.
  - Added table-paragraph hanging-indent compensation so negative text indent no longer clips bullets or first characters.
  - Skipped zero-layout, control-only HWP paragraphs during rendering so section/table placeholders do not push visible content downward.
  - Removed generic table wrapper and inline image margins inside HWP pages, improving `attachment-sale-notice.hwp` page 1 header/title vertical placement without sample-specific coordinates.
- Verified:
  - `node --check js/hwp-parser.js`
  - `node --check js/hwp-parser-hwp5-records.js`
  - `node --check js/hwp-parser-hwpx.js`
  - `node --check js/hwp-renderer.js`
  - `node scripts/verify_samples.mjs`
- Remaining:
  - Header/title start position is closer, but first-page HWP table row heights and nested schedule table heights still need safer format-driven compression before pixel-level parity with Hancom Viewer.
  - Need a reusable visual overlap detector for table cells, floating controls, and page header/body interactions.

## 2026-04-25 HWP-First Priority Reset
- Decision:
  - HWP visual fidelity now takes priority over HWPX visual refinement.
  - HWPX remains a regression guard, especially `incheon-2a.hwpx` page count and long-table stability, but HWP parser/layout work should lead the next implementation cycle.
- Primary HWP target:
  - `attachment-sale-notice.hwp`
  - Current structural status: 4 TotalDocs pages vs 4 Hancom pages, first-page geometry matches diagnostics.
  - Current visual status: not acceptable for fidelity claims; strict visual guard still blocks stale/mismatching audit evidence.
- Immediate HWP work order:
  - Regenerate fresh Hancom visual audit before claiming any visual improvement.
  - Build raw-preserving HWP canonical/table diagnostics before adding more renderer heuristics.
  - Fix HWP table geometry first: row heights, cell margins, repeated headers, split policy, nested table clipping, and rowspan distribution.
  - Fix HWP paragraph/line/font drift after source table geometry is measurable.
  - Move HWP object anchoring and final page assembly toward LayoutTree/absolute boxes instead of DOM flow.
- New planning artifact:
  - `docs/hwp-priority-workboard-2026-04-25.md`

## 2026-04-25 HWP Source-Height Table Pass
- Completed:
  - Marked HWP table blocks with `sourceFormat: "hwp"` so HWP-only rendering rules no longer leak into HWPX tables.
  - Added exact HWPUNIT-to-pixel helpers and row/cell source-height diagnostics to the renderer.
  - Applied HWP source row heights to table rows instead of the older capped heuristic height path.
  - Reduced HWP table paragraph/content minimum-height and inter-paragraph margin so CSS defaults do not inflate source-sized rows.
  - Relaxed strict content clipping after webview review because the first notice title row was being clipped; current pass records source dimensions while preserving readable content.
- Verified:
  - `node --check js/hwp-parser-hwp5-records.js`
  - `node --check js/hwp-renderer.js`
  - `node scripts/dump_hwp_table_metrics.mjs output/playwright/served-inputs/attachment-sale-notice.hwp --compact`
  - `node scripts/verify_samples.mjs`
  - `node scripts/check_fidelity_guard.mjs`
  - Webview smoke check for `attachment-sale-notice.hwp`: 4 rendered pages and 22 HWP-tagged tables.
- Remaining:
  - Strict visual audit still intentionally blocks fidelity claims until a fresh Hancom audit replaces stale/mismatching evidence.
  - HWP header/footer slot layout, inline GSO anchoring, LineSeg baseline placement, nested table height distribution, and exact border-box cell fitting still need dedicated passes.
  - The long-term fix remains a CanonicalDocument/LayoutTree assembly path; the current DOM renderer changes are guard-railed recovery steps, not the final layout engine.

## Playwright Session Rule
- Always run `close-all` before verification.
- Always use one fixed session name: `verify-current`.
- Do not keep stale verification sessions open after checks.
