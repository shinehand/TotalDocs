# TotalDocs WASM Redesign Plan

Date: 2026-04-22
Resume date: 2026-04-24

## Decision

WASM is allowed, but only as a TotalDocs-owned implementation detail.

The project must not depend on an external engine as the reference implementation. The source of truth is:

1. HWP/HWPX official format documents in `docs/hwp-spec/`
2. Local analysis documents in `docs/hwp-spec-analysis/`
3. TotalDocs's own canonical document model
4. Hancom Viewer visual comparison as the layout oracle

Generated WASM binaries are build artifacts. They are not the design authority.

## Goals

1. Keep TotalDocs's parser and layout rules under our control.
2. Use WASM for parts that need speed, isolation, or deterministic layout behavior.
3. Avoid a binary-only dependency where layout bugs must be fixed outside TotalDocs.
4. Make the JS path and WASM path comparable during migration.
5. Preserve the current browser-only deployment goal.

## Non-Goals

1. Do not restore the removed external WASM bridge.
2. Do not make a generated `lib/*.wasm` file the only place where parser or layout behavior exists.
3. Do not hard-code sample document names, page numbers, text, or coordinates.
4. Do not rewrite every parser feature in WASM before the document model is stabilized.

## Proposed Architecture

### 1. Canonical Model First

TotalDocs needs one internal model that both JS and WASM can consume.

Initial model boundary:

- `Document`
- `Section`
- `PageDef`
- `Paragraph`
- `Run`
- `LineSeg`
- `Table`
- `Row`
- `Cell`
- `ShapeObject`
- `Picture`
- `HeaderFooter`
- `PageNumber`

The model must preserve raw identifiers and layout fields such as:

- `charPrIDRef`
- `paraPrIDRef`
- `styleIDRef`
- `LineSeg.vertical_pos`
- `LineSeg.height`
- table `inMargin`
- cell margin
- row height
- row split/page break flags
- `RepeatHeader`
- object size/position/wrap/z-order

### 2. WASM As Layout Core First

The first useful WASM target should be layout and pagination, not full parsing.

Reason:

- JS already opens HWP/HWPX files.
- Current biggest defects are page flow, table split, long cell continuation, and object placement.
- Rewriting binary/XML parsing first would delay visible layout improvements.

Initial WASM input:

```text
CanonicalDocument JSON or compact binary model
```

Initial WASM output:

```text
LayoutTree
- pages
- positioned paragraphs
- positioned runs
- table boxes
- cell boxes
- object boxes
- diagnostics
```

DOM rendering can remain in JS until the layout tree is reliable.

### 3. JS Renderer Compatibility Layer

`js/hwp-renderer.js` should be able to render either:

1. current parsed document blocks, or
2. a WASM-generated layout tree

This lets us compare:

- JS layout result
- WASM layout result
- Hancom Viewer capture

without replacing the whole app in one step.

### 4. Source Layout

Recommended repository structure:

```text
engine/
  Cargo.toml
  src/
    lib.rs
    model/
    layout/
    pagination/
    table/
    text/
    wasm_api.rs
  tests/
  fixtures/

js/
  hwp-layout-adapter.js
  hwp-renderer.js

lib/
  generated/
    totaldocs_engine.js
    totaldocs_engine_bg.wasm
```

Rules:

- `engine/` source is committed.
- generated WASM files are reproducible from `engine/`.
- generated files must name TotalDocs, not a generic external engine name.
- build steps must be documented.

## Migration Phases

### Phase 0: Baseline Reset

Target: 2026-04-24

Tasks:

1. Confirm the JS parser/DOM renderer path is the only active runtime path.
2. Run `node scripts/verify_samples.mjs` and record current page-count mismatches.
3. Reproduce `incheon-2a.hwpx` page 2 overlap in the JS path.
4. Identify the exact parsed data needed for page 2:
   - section/page definition
   - table row/cell structure
   - cell split/page break flags
   - `LineSeg.vertical_pos`
   - nested tables
5. Add a focused diagnostic dump for the problematic page/table.

Exit criteria:

- Current JS layout failures are documented.
- The page 2 overlap has a small reproducible diagnostic input.

### Phase 1: Canonical Layout Model

Tasks:

1. Define a stable JSON schema for the layout-relevant document model.
2. Add model export from `HwpParser`.
3. Add snapshot fixtures for known documents.
4. Make diagnostics independent from any WASM-specific API.

Exit criteria:

- `scripts/verify_samples.mjs` can collect page/table/object diagnostics from the JS model.
- The model contains enough data to explain `incheon-2a.hwpx` page 2.

### Phase 2: WASM Layout Prototype

Tasks:

1. Create `engine/` with a minimal Rust/WASM package owned by TotalDocs.
2. Implement only:
   - units conversion
   - page area calculation
   - paragraph block placement
   - table row/cell box placement
   - long cell continuation diagnostics
3. Build a tiny JS adapter that calls the WASM layout function.

Exit criteria:

- WASM can accept one canonical model fixture and return a layout tree.
- Layout output can be inspected without replacing the viewer.

### Phase 3: Table Pagination

Tasks:

1. Implement row split rules.
2. Implement repeat header rows.
3. Implement long cell continuation windows.
4. Implement nested table continuation.
5. Add tests for `incheon-2a.hwpx` page 2 and pages 12-18 sequence.

Exit criteria:

- WASM layout tree improves the known HWPX table continuation cases.
- No document-specific branching is introduced.

### Phase 4: Object Anchoring

Tasks:

1. Implement picture/shape `relativeTo` handling.
2. Implement text wrap and z-order policy.
3. Implement table-cell anchored object placement.
4. Compare against Hancom Viewer captures.

Exit criteria:

- HWPX object overlap and position drift are measurable and reduced.

### Phase 5: Runtime Switch

Tasks:

1. Add feature flag:
   - JS layout
   - WASM layout
   - side-by-side diagnostics
2. Keep JS fallback until WASM passes minimum layout criteria.
3. Update QA to test both modes when enabled.

Exit criteria:

- WASM layout can be enabled without losing document load reliability.

## Verification Plan

Minimum checks:

```bash
node --check js/hwp-parser.js
node --check js/hwp-parser-hwp5-records.js
node --check js/hwp-parser-hwpx.js
node --check js/hwp-parser-hwp5-container.js
node --check js/hwp-renderer.js
node --check js/parser.worker.js
node scripts/verify_samples.mjs
```

When `engine/` exists:

```bash
cargo test --manifest-path engine/Cargo.toml
cargo build --manifest-path engine/Cargo.toml --release --target wasm32-unknown-unknown
```

Visual checks:

```bash
node scripts/capture_hancom_page_audit.mjs
python3 scripts/build_hancom_page_audit.py
```

## First Tasks For 2026-04-24

1. Fix the current JS-path verification baseline after external WASM removal.
2. Add JS diagnostics for page/table layout data.
3. Reproduce `incheon-2a.hwpx` page 2 overlap in the official JS path.
4. Draft the canonical model schema for HWPX tables and line segments.
5. Decide the exact `engine/` scaffold and build command.

## Open Questions

1. Should the first WASM input be JSON for readability or a compact binary format for speed?
2. Should DOM rendering remain primary, or should Canvas rendering return later after layout stabilizes?
3. Which diagnostics must be shown in the UI versus stored only in reports?
4. Should generated WASM artifacts be committed, or built only during release?
