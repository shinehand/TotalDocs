# Rendering Status

## Scope
- Project: `ChromeHWP`
- Baseline samples:
`/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/goyeopje.hwp`
`/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/incheon-2a.hwpx`

## Supported Now
- HWP:
  - Body text extraction from `BodyText/Section*`
  - Table extraction with cell span/size and border fill mapping
  - Basic `DocInfo` style mapping (`FACE_NAME`, `CHAR_SHAPE`, `PARA_SHAPE`)
  - Paragraph line segment safety mapping (line-height and min-height bounds)
- HWPX:
  - Section parsing and page split
  - Header/footer/page number block rendering
  - Page border fill/style application
  - Core image block rendering with position offsets
  - Table structure rendering for major layout sections

## Known Gaps
- HWP:
  - Non-text control objects (shape/anchor-heavy cases) are still limited
  - Some table geometry remains heuristic for edge merge/layout cases
  - Advanced text metrics (ratio/letter spacing/relative size) not fully mapped
- HWPX:
  - Complex object anchoring (`wrap`, `relativeTo`, `z-order`, etc.) is partial
  - Some table flatten/linearize behavior is heuristic-driven
  - Font fallback for mixed Hangul/Latin/numeric runs can still drift

## Regression Rule
- Use this command for minimum smoke verification:
  - `node /Users/shinehandmac/Github/ChromeHWP/scripts/verify_samples.mjs`
- Minimum pass criteria:
  - `goyeopje.hwp`: `3 페이지` + major form keywords present
  - `incheon-2a.hwpx`: `5 페이지` + first-page core phrases present

## Playwright Session Rule
- Always run `close-all` before verification.
- Always use one fixed session name: `verify-current`.
- Do not keep stale verification sessions open after checks.
