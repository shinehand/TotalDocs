# Rendering Status

## Scope
- Project: `ChromeHWP`
- Baseline samples:
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
  - Paragraph line segment safety mapping (line-height and min-height bounds)
  - `styleId`-based paragraph/run defaults and basic numbering/bullet prefix rendering
- HWPX:
  - Section parsing and page split
  - Header/footer/page number block rendering
  - Page border fill/style application
  - Core image block rendering with position offsets
  - Table structure rendering for major layout sections
  - Character shadow rendering from `charPr/shadow`, including `DROP` vs `CONTINUOUS`, color, and `offsetX/offsetY`

## Known Gaps
- HWP:
  - Non-text control objects (shape/anchor-heavy cases) are still limited
  - Some table geometry remains heuristic for edge merge/layout cases
  - Advanced text metrics (ratio/letter spacing/relative size) not fully mapped
  - Numbering/bullet exact format fidelity and continuation still need more real-sample validation
- HWPX:
  - Complex object anchoring (`wrap`, `relativeTo`, `z-order`, etc.) is partial
  - Some table flatten/linearize behavior is heuristic-driven
  - Font fallback for mixed Hangul/Latin/numeric runs can still drift

## Regression Rule
- Renderer fidelity fixes must not hard-code document names, file names, page numbers, or sample-specific coordinates. A fix is acceptable only when it is derived from HWP/HWPX records and applies as a reusable layout rule.
- Use this command for minimum smoke verification:
  - `node scripts/verify_samples.mjs`
- Current smoke criteria:
  - each sample must load through `hwpUrl`
  - each sample must expose page/section status
  - each sample must be scrollable from first page to last page without runtime errors
  - the generated report must be written to `output/playwright/verify-samples-report.json`
- Legacy page-count baselines from the pre-engine viewer are no longer authoritative.
  - Hancom Viewer oracle counts confirmed on 2026-04-19:
    - `goyeopje.hwp`: `2쪽`
    - `goyeopje-full-2024.hwp`: `11쪽`
    - `gyeolseokgye.hwp`: `1쪽`
    - `attachment-sale-notice.hwp`: `4쪽`
    - `incheon-2a.hwpx`: `18쪽`
  - ChromeHWP now matches the Hancom Viewer page-count baseline for all five downloaded QA documents.
  - Full-page visual audit now captures every page of the five downloaded QA documents:
    - total: `5 documents / 36 pages`
    - command 1: `node scripts/capture_hancom_page_audit.mjs`
    - command 2: `python3 scripts/build_hancom_page_audit.py`
    - report: `/Users/shinehandmac/Github/ChromeHWP/output/hancom-oracle/page-audit/hancom-page-audit-report.html`
  - Full-page audit status is not yet "identical to Hancom Viewer"; remaining high-priority pages are `goyeopje-full-2024.hwp` page 9, plus `attachment-sale-notice.hwp` page 1.
  - Most residual page-audit diffs are currently caused by top-origin drift, font raster/weight differences, line-height accumulation, and table stroke density rather than page-count failure.
  - `incheon-2a.hwpx` was fixed by preserving fixed CellBreak row height, including blank vertical extent, during table continuation pagination.
  - `incheon-2a.hwpx` title shadow now preserves HWPX `charPr/shadow` offsets and renders `CONTINUOUS` as a filled offset shadow.
  - `HY헤드라인M` was remapped to `dotum-Regular.ttf` after Hancom Viewer comparison trials.
  - HWPX non-inline pictures inside table cells now honor `horzRelTo="COLUMN"` against the cell boundary, not the padded text area.
  - HWPX text/control offsets now advance control markers as 8 UTF-16 units in stream order, keeping `charPrIDRef` boundaries aligned after floating pictures.
  - TAC tables no longer shrink row heights below their content-derived row sum when stored object height is smaller; this rule is now shared by layout and page measurement.
  - `incheon-2a.hwpx` page 2 now honors HWPX cell continuation windows where `LineSeg.vertical_pos` resets inside one large cell; the page starts with the `[무주택세대구성원]` boxed section instead of resurrecting the previous nested-table tail.
  - Partial table nested-control clipping now treats same-row `split_end_content_limit` as a visible length after `split_start_content_offset`, preventing non-vpos fallback paths from comparing against an inverted end boundary.
  - Nested tables now render `Table.caption` using the same direction and spacing rules as top-level tables, including TAC top-caption flow where the table body must move below the caption.
  - Current visual residuals for `incheon-2a.hwpx` page 2 are mostly small top-origin drift, accumulated line-height risk on later pages, and border/text weight differences; the major page-flow mismatch has been fixed.
  - Page 2 comparison capture: `/Users/shinehandmac/Github/ChromeHWP/output/hancom-oracle/incheon-page-probe/incheon-p2-side-by-side-vpos3.png`
  - Latest Hancom comparison after the font, image-anchor, HWPX offset, continuous-shadow, and TAC measurement fixes:
    - `goyeopje.hwp`: visiblePageDiff `10.856`, titleDiff `10.350`
    - `goyeopje-full-2024.hwp`: visiblePageDiff `18.053`, titleDiff `20.679`
    - `gyeolseokgye.hwp`: visiblePageDiff `15.668`, titleDiff `12.574`
    - `attachment-sale-notice.hwp`: visiblePageDiff `30.773`, titleDiff `32.788`
    - `incheon-2a.hwpx`: visiblePageDiff `29.208`, titleDiff `26.707`

## 2026-04-19 End-of-Day QA
- Engine source update:
  - HWPX large-cell continuation windows now support multi-window selection derived from `LineSeg.vertical_pos` reset boundaries.
  - Partial table rendering now anchors visible split paragraphs to stored vpos coordinates instead of stacking them purely by rendered order.
  - Nested table clipping in split cells uses the effective split window bounds to avoid resurrecting previous/next continuation content.
  - The current approach remains data-driven; no document names, page numbers, or sample text are used as layout conditions.
- Rebuilt web bundle:
  - `RUSTC=/Users/shinehandmac/.cargo/bin/rustc /Users/shinehandmac/.cargo/bin/cargo build --release --target wasm32-unknown-unknown --lib`
  - `/Users/shinehandmac/.cargo/bin/wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/rhwp.wasm`
  - Copied generated artifacts into `/Users/shinehandmac/Github/ChromeHWP/lib/hwp.js`, `/Users/shinehandmac/Github/ChromeHWP/lib/hwp_bg.wasm`, and `/Users/shinehandmac/Github/ChromeHWP/lib/hwp.d.ts`.
- Tests run:
  - `cargo test --lib split_line_ranges_can_span_multiple_vpos_windows --quiet`: passed.
  - `node scripts/verify_samples.mjs`: passed for the five representative documents.
  - Page-count result: `goyeopje.hwp 2/2`, `goyeopje-full-2024.hwp 11/11`, `gyeolseokgye.hwp 1/1`, `attachment-sale-notice.hwp 4/4`, `incheon-2a.hwpx 18/18`.
- Remaining risk:
  - `incheon-2a.hwpx` pages 15-16 still require visual flow correction against Hancom Viewer.
  - The likely remaining fault is the interaction between page-like vpos windows and nested table partial rendering, especially where a nested table begins near the end of one vpos window and continues onto the next page.
  - Next work should compare pages 12-16 as a sequence, not page 15 alone, because one page's consumed vpos range determines the next page's start.
- Current search status:
  - document keyword search now uses rendered page text layout as a fallback path
  - spaced title text such as `등 록 신 청 서` is also matched by whitespace-insensitive page search
  - audited samples on 2026-04-18 returned keyword hits successfully
- Detailed audit notes:
  - `/Users/shinehandmac/Github/ChromeHWP/docs/fidelity-audit-2026-04-17.md`

## Playwright Session Rule
- Always run `close-all` before verification.
- Always use one fixed session name: `verify-current`.
- Do not keep stale verification sessions open after checks.
