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
- Current smoke criteria:
  - each sample must load through `hwpUrl`
  - each sample must expose page/section status
  - each sample must be scrollable from first page to last page without runtime errors
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
  - Re-implement the `incheon-2a.hwpx` page 2 overlap fix in TotalDocs's own parser/renderer path if it still reproduces there.
  - Improve HWPX layout fidelity for object anchoring, repeat headers, long split cells, and nested table continuation.
  - Add screenshot/perceptual regression coverage for the page 2 split-cell overlap case.
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
  - The first long-cell continuation pass now renders 20 pages versus Hancom Viewer's 18-page oracle.
  - Remaining mismatch confirms the direction is right, but continuation windows and repeated-header height still need tighter calibration.
- Remaining work:
  - Compare `output/playwright/incheon-2a-layout-fixture.json` against the parsed TotalDocs continuation chunks and Hancom Viewer page captures.
  - Tune continuation windows so `incheon-2a.hwpx` lands on the 18-page oracle without reintroducing page-2 overlap.
  - Replace the remaining table split heuristic with rules that use preserved `pageBreak`, repeat header rows, raw row/cell heights, and long-cell continuation windows.
  - Add a side-by-side diagnostic mode that compares JS layout, WASM layout, and Hancom Viewer screenshots.
  - Keep the WASM path disabled as a renderer replacement until it improves overlap cases without regressing normal document loading.

## Playwright Session Rule
- Always run `close-all` before verification.
- Always use one fixed session name: `verify-current`.
- Do not keep stale verification sessions open after checks.
