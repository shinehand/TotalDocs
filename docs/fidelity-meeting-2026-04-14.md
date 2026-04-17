# HWP Fidelity Meeting

Date: 2026-04-14
Scope: official format PDFs in `/Users/shinehandmac/Downloads` + sample HWP/HWPX files in Downloads

## Participants

- Planning 1: HWP 5.0 binary spec review
- Planning 2: HWPML / distributed-doc spec review
- Planning 3: equation / chart spec review
- Dev 1: parser coverage review
- Dev 2: renderer coverage review
- Dev 3: worker drift review
- Dev 4: runtime / save-export flow review
- QA 1: sample benchmark review
- QA 2: regression coverage review

## Agreed Findings

- Current viewer already handles the broad flow of `HWP/HWPX -> parse -> block model -> DOM render`, but it still trades fidelity for readability in several places.
- The official specs show that fidelity-critical data is concentrated in:
  - section/page definition
  - paragraph and character shape
  - table cell metrics and repeat/break behavior
  - drawing/picture/OLE common object properties
  - distributed-document decryption
- The current parser keeps only a subset of those fields, and the renderer approximates layout with CSS rather than an exact composition engine.
- The codebase also contains parser duplication between `js/hwp-parser.js` and `js/parser.worker.js`, which raises drift risk for HWP fixes.

## Immediate Risks

- HWPX table flattening / linearization heuristics preserve readability but can destroy original structure.
- Character styling currently keeps only a reduced subset of the spec, so source documents with shading, strikeout, shadow, and richer underline settings cannot match the original closely.
- Pagination is largely heuristic. It is sufficient for browsing but not for exact page-for-page fidelity.
- The repository regression script currently forces Playwright session handling through `PLAYWRIGHT_CLI_SESSION`, which does not reliably open the named session.

## Implementation Order

1. Remove or disable source-distorting HWPX table flattening behavior so original table structure is preserved by default.
2. Preserve and render more character-style fields that materially affect appearance.
3. Repair the local regression path so the baseline checks can be rerun consistently.
4. Revisit pagination using richer HWP/HWPX layout metadata after the above is stable.
5. Treat equation/chart as a separate fidelity track:
   - equations need real template/layout support for common constructs
   - charts need object-tree preservation first, not screenshot-style placeholders

## Validation Notes

- Downloaded samples are already mirrored into `output/playwright/inputs/` for browser automation.
- Hash check confirmed these pairs are byte-identical:
  - Downloads attachment notice HWP == `output/playwright/inputs/attachment-sale-notice.hwp`
  - Downloads goyeopje HWP == `output/playwright/inputs/goyeopje-full-2024.hwp`
  - Downloads gyeolseokgye HWP == `output/playwright/inputs/gyeolseokgye.hwp`
  - Downloads incheon HWPX == `output/playwright/inputs/incheon-2a.hwpx`

## First Development Slice

- Preserve HWPX tables instead of flattening them into paragraph flow.
- Add richer run styling support for HWP/HWPX text rendering.
- Fix Playwright session invocation in repo-side verification scripts.
