# Document Parser Research Report

Date: 2026-04-24
Project: TotalDocs

## Executive Decision

TotalDocs should become a multi-format document parser/viewer, but HWP/HWPX fidelity must remain the first battlefield.

The correct direction is:

1. Keep the current TotalDocs-owned HWP/HWPX parser as the official path.
2. Do not depend on an external binary engine as the reference implementation.
3. Introduce one canonical document model that every parser emits.
4. Separate parsing, layout, rendering, diagnostics, and exporting.
5. Add other document formats in tiers, starting with formats that have simple text or ZIP/XML structure.

The current HWP/HWPX issue is not simply "file parsing failed." Representative samples open and page counts can match. The remaining failures are layout fidelity failures caused by incomplete use of parsed layout fields, especially table pagination, large cell continuation, nested tables, object anchoring, line segment positioning, and paragraph metrics.

## Source Basis

Primary and local sources checked:

- Hancom official HWP/OWPML format page: https://www.hancom.com/support/downloadCenter/hwpOwpml
- Hancom HWP/HWPX local analysis: `docs/hwp-spec-analysis/`
- Local parser research note: `/Users/shinehandmac/Github/hk/docs/hwp_parser_research.md`
- Microsoft Compound File Binary Format: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b
- Microsoft Word Binary File Format: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/8818694f-788d-4a1b-84ae-f6af18b8dffa
- ECMA-376 Office Open XML: https://ecma-international.org/publications-and-standards/standards/ecma-376/
- Microsoft Open XML SDK overview: https://learn.microsoft.com/en-us/office/open-xml/open-xml-sdk
- PDF ISO 32000-2 resource: https://pdfa.org/resource/iso-32000-2/
- PDF.js: https://mozilla.github.io/pdf.js/
- OASIS OpenDocument: https://www.oasis-open.org/tc-opendocument/
- ODF 1.4 approval: https://www.oasis-open.org/2025/12/03/oasis-approves-open-document-format-odf-v1-4-standard-marking-20-years-of-interoperable-document-innovation/
- CommonMark: https://commonmark.org/
- GitHub Flavored Markdown: https://github.github.com/gfm/
- RFC 4180 CSV: https://www.rfc-editor.org/rfc/rfc4180
- WHATWG HTML parsing: https://html.spec.whatwg.org/multipage/parsing.html
- WHATWG Encoding: https://encoding.spec.whatwg.org/
- W3C EPUB 3.3: https://www.w3.org/TR/epub-33/

## Current TotalDocs Parser State

Active parser path:

- `js/hwp-parser.js`
  - Format detection by signature and extension.
  - Routes HWPX, OWPML, and HWP5 to specialized parser extensions.
  - Current supported public formats are `.hwp`, `.hwpx`, `.owpml`.
- `js/hwp-parser-hwpx.js`
  - Opens HWPX as ZIP with `JSZip`.
  - Validates package mimetype when present.
  - Reads `Contents/section*.xml`, header data, resources, page style, page numbering, tables, images, and object layout.
- `js/hwp-parser-hwp5-container.js`
  - Reads OLE/CFB storage, FAT, mini FAT, directory entries, and streams.
- `js/hwp-parser-hwp5-records.js`
  - Handles HWP record stream attempts, raw deflate, paragraph text, char shapes, line segments, table info, cells, controls, and block construction.
- `js/hwp-renderer.js`
  - Renders the parsed document model into DOM pages, paragraphs, tables, images, objects, and diagnostics.
- `js/parser.worker.js`
  - Worker entry point for parser execution.

Important observation:

- Current pagination uses weight estimates in `HwpParser._paginate` and `_splitTableBlock`.
- HWPX line segment parsing currently reduces line segment data to height metrics.
- HWPX table metrics currently estimate row weights from text length, explicit height, and nested table counts.
- This explains why page counts can match while page 2 or later pages still overlap: the renderer lacks a stable page layout tree with visible windows and exact positioned boxes.

## HWP/HWPX Accuracy Direction

### Confirmed Correct Direction

The local HWP parser research is aligned with the right direction:

- HWP 5.x:
  - Open as OLE/CFB.
  - Read `FileHeader`, `DocInfo`, `BodyText/SectionN`, `BinData`, `PrvText`, and `PrvImage`.
  - Apply raw deflate when the file header says streams are compressed.
  - Walk records by `TagID`, `Level`, `Size`.
  - Decode progressively into an internal model.
- HWPX/OWPML:
  - Open as ZIP/XML package.
  - Read package metadata, `Contents/header.xml`, `Contents/section*.xml`, manifest, and binary resources.
  - Use namespace-aware XML traversal.
  - Preserve raw attributes and convert only into a separate normalized layout model.

The strategy is not to copy application internals. The strategy is to implement from public format documents and use Hancom Viewer only as the visual oracle.

### What Must Change For Layout Fidelity

The next HWP/HWPX work must target layout data preservation before visual tweaks.

1. Preserve full line segment records
   - HWP: keep every parsed `PARA_LINE_SEG` field, not only derived height.
   - HWPX: keep all `lineseg` attributes such as vertical position, text position, vertical size, text height, baseline, spacing, and raw attribute map.
   - Current code only derives `lineHeightPx` and `layoutHeightPx` for HWPX.

2. Preserve table pagination fields
   - Table page break policy.
   - Repeat header rows.
   - Row and cell split behavior.
   - Row height and cell height in source units.
   - Table-level `inMargin` and cell-level margin.
   - Nested table boundaries.
   - Caption direction and spacing.

3. Build a layout tree before DOM rendering
   - Parser output should be a canonical document model.
   - Layout engine should produce pages and positioned boxes.
   - Renderer should only draw the layout tree.
   - Diagnostics should compare parser model, layout tree, and DOM result.

4. Add focused diagnostics for `incheon-2a.hwpx`
   - Dump section/page definition.
   - Dump page 2 candidate tables.
   - Dump each table row/cell with source row, cell span, size, content height, line segments, nested tables, object anchors, and computed visible window.
   - Do not hard-code file name or page number in renderer logic. The diagnostic command may target a sample, but the layout rule must stay generic.

### Why Page 2 Still Overlaps

The overlap is most likely a layout tree problem:

- Tables are sliced by row weight, not by exact source line segment windows.
- A large cell that continues across pages needs `split_start`, `visible_length`, and continuation box data.
- Nested tables need clipping and continuation inside the parent cell's visible range.
- Repeat headers must be inserted by layout rule, not by DOM guesswork.
- Object anchoring must be resolved against page, column, paragraph, or cell coordinate space before rendering.

Therefore, the next fix should not be another CSS-only correction. It should be a diagnostic plus layout model change.

## Multi-Format Parser Feasibility

Legend:

- Easy: can be implemented directly in the browser with current-style JS.
- Medium: feasible, but needs careful model and test coverage.
- Hard: possible, but should not be the first implementation unless the scope is text extraction only.
- Very hard: layout fidelity is effectively an engine-level project.

| Format | Structure | Feasibility | Recommended parser approach | First practical scope | Main risks |
|---|---|---:|---|---|---|
| TXT | Byte stream plus charset | Easy | BOM sniffing, UTF-8 default, `TextDecoder`, optional CP949 fallback | Plain text pages and search | Encoding detection, large files |
| Markdown / MD | Plain text, CommonMark or GFM | Easy to medium | CommonMark/GFM parser to AST, sanitize raw HTML | Render headings, lists, tables, code, links | Dialect differences, XSS through raw HTML |
| CSV / TSV | Delimited text, RFC 4180-style CSV | Easy to medium | Streaming delimiter parser; quote/escape state machine | Table preview, search, export | Dialects, embedded newlines, formula injection |
| HTML / HTM | WHATWG HTML DOM | Medium | `DOMParser`, sanitizer, restricted CSS/resource policy | Safe document view and text extraction | Scripts, remote resources, browser quirks |
| EPUB | OCF ZIP container with XHTML/CSS/resources | Medium | ZIP read, `container.xml`, OPF, spine/nav, XHTML render | Reflowable book reader and text extraction | DRM, fixed-layout EPUB, CSS/font handling |
| DOCX | OOXML OPC ZIP plus WordprocessingML | Medium to hard | ZIP/XML parser, relationships, styles, numbering, media | Text, headings, lists, tables, images | Style inheritance, tracked changes, anchors |
| XLSX | OOXML OPC ZIP plus SpreadsheetML | Medium to hard | ZIP/XML parser, workbook, sheets, shared strings, styles | Sheet grid, merged cells, formulas as text | Formula calculation, dates, hidden sheets |
| PPTX | OOXML OPC ZIP plus PresentationML | Hard | ZIP/XML parser, slide layouts, masters, themes, media | Slide thumbnails or absolute HTML/SVG view | Master inheritance, transforms, animation |
| ODT | ODF ZIP/XML | Medium | ZIP/XML parser, `content.xml`, `styles.xml`, manifest | Text, styles, tables, images | Style/page inheritance, embedded objects |
| ODS / ODP | ODF ZIP/XML | Medium to hard | Reuse ODF package reader; add spreadsheet/presentation models | Grid or slide outline first | Formula dialects, slide geometry |
| PDF | ISO 32000 object graph and content streams | Hard to very hard | Use PDF.js as parser/renderer adapter first | Render pages, text layer, metadata | Text order, table recovery, scanned PDFs/OCR |
| DOC | CFB/OLE plus Word Binary Format | Very hard | CFB reader plus `[MS-DOC]` parser; text extraction first | Text, paragraphs, basic tables | File Information Block, piece table, fields, old variants |
| RTF | Text control words and nested groups | Medium to hard | Tokenizer plus group stack and destination handling | Text and basic inline formatting | Charset escapes, embedded objects, malformed files |
| HWP | OLE/CFB plus HWP 5 records | Already in progress, hard | Continue TotalDocs parser, preserve raw records and typed fields | Fidelity diagnostics and layout model | Controls, tables, objects, distributed/security policies |
| HWPX / OWPML | ZIP/XML package | Already in progress, medium to hard | Continue TotalDocs parser, preserve raw XML attrs and layout fields | Exact table/object/page layout | Line segments, table continuation, anchors |

## Recommended Implementation Tiers

### Tier 0: Parser Platform

Build the platform before adding many formats.

Proposed plain-script structure:

```text
js/document-format-detector.js
js/document-model.js
js/document-parser.js
js/parsers/text-parser.js
js/parsers/markdown-parser.js
js/parsers/html-parser.js
js/parsers/csv-parser.js
js/parsers/ooxml-package.js
js/parsers/docx-parser.js
js/parsers/odf-package.js
js/parsers/odt-parser.js
js/parsers/epub-parser.js
js/parsers/pdf-adapter.js
js/parsers/doc-binary-probe.js
```

This should not replace HWP/HWPX immediately. HWP/HWPX should be adapted into the same canonical model after the model is defined.

### Tier 1: Quick Wins

Add formats that are low-risk and useful:

1. TXT
2. Markdown
3. CSV/TSV
4. HTML

These are browser-friendly and provide immediate value without disturbing HWP/HWPX.

### Tier 2: ZIP/XML Office Formats

Add package-based formats:

1. DOCX
2. ODT
3. EPUB
4. XLSX
5. PPTX
6. ODS/ODP later by reusing ODF infrastructure

These all fit the same architecture: ZIP reader, manifest/relationship reader, XML parser, resource map, canonical document model.

### Tier 3: PDF

PDF should use PDF.js first.

TotalDocs should not start by writing a full PDF engine. PDF is a rendered document format with an object graph, fonts, content streams, xrefs, and many historical edge cases. A practical first scope is:

- page rendering through PDF.js
- text layer extraction
- metadata
- search
- thumbnails
- later: table/structure recovery as best effort

### Tier 4: Binary Legacy Office

DOC, XLS, and PPT should be treated as later-stage parser work.

DOC can be added, but the correct first scope is:

- CFB detection
- stream inventory
- Word `File Information Block` probe
- text extraction through piece table
- basic paragraph/table metadata

Full DOC layout fidelity is not a near-term target.

## Canonical Document Model

Minimum shared model:

```text
Document
  meta
  source
  styles
  resources
  sections[]
  diagnostics

Section
  pageDef
  blocks[]

Block
  paragraph | table | image | shape | equation | chart | slide | sheet | html | pdfPage

Paragraph
  runs[]
  paraStyleRef
  rawLayout

Run
  text
  charStyleRef
  raw

Table
  rows[]
  rawLayout

Cell
  row
  col
  rowSpan
  colSpan
  blocks[]
  rawLayout

LayoutTree
  pages[]
  boxes[]
  diagnostics
```

Rules:

- Keep raw source data beside normalized data.
- Never let renderer-specific CSS values overwrite source units.
- Preserve unknown records, unknown XML attributes, and unsupported objects as opaque data.
- Make diagnostics independent from WASM-specific naming.
- Every format parser should emit enough metadata for error handling and feature reporting.

## Security Policy

Parsers must never execute document code.

Format-specific rules:

- DOCM/XLSM/PPTM: parse package and show macro presence, but never execute `vbaProject.bin`.
- PDF: JavaScript actions, launch actions, embedded files, and remote fetches should be blocked or surfaced as unsupported.
- HTML/Markdown/EPUB: sanitize scripts, event handlers, inline dangerous URLs, and remote resources.
- HWP/HWPX: password, DRM, distributed restrictions, and protected documents must be detected and reported. Do not bypass restrictions.
- CSV: protect against formula injection when exporting or copying table content.

## Reported Parser Availability

Directly practical now:

- `.txt`
- `.md`, `.markdown`
- `.csv`, `.tsv`
- `.html`, `.htm`
- `.epub`
- `.docx`
- `.odt`

Practical with staged scope:

- `.xlsx`
- `.pptx`
- `.ods`
- `.odp`
- `.rtf`
- `.pdf` through PDF.js

Possible but not first priority:

- `.doc`
- `.xls`
- `.ppt`

Already active and should remain priority:

- `.hwp`
- `.hwpx`
- `.owpml`
- `.hwt`
- `.hwtx`

## Apply To TotalDocs

Immediate code direction:

1. Keep HWP/HWPX parser split.
2. Add canonical model design before adding many new format parsers.
3. Add HWPX layout diagnostics for page/table/cell/line segment source fields.
4. Replace weight-only pagination with layout tree computation.
5. Add text/markdown/csv parsers only after the model boundary is agreed.
6. Add DOCX/ODT/EPUB package readers after TXT/Markdown/CSV prove the model.
7. Use PDF.js for PDF, not a homegrown PDF renderer.
8. Treat DOC binary as a later text-extraction project.

First implementation sequence:

```text
Phase A: HWP/HWPX layout diagnostics
Phase B: CanonicalDocument schema
Phase C: TXT/Markdown/CSV parsers
Phase D: DOCX/ODT/EPUB package parsers
Phase E: PDF.js adapter
Phase F: DOC binary probe and text extraction
```

## Next Work Items

1. Add `CanonicalDocument` schema document.
2. Add HWPX page/table diagnostic dump for the page 2 overlap class.
3. Preserve complete HWPX `lineseg` raw attributes and expose them in diagnostics.
4. Preserve HWP table page break, repeat header, row split, cell split, and nested table continuation signals.
5. Create `DocumentFormatDetector` design that can recognize CFB, ZIP/OPC, ZIP/ODF, ZIP/EPUB, PDF, XML, HTML, Markdown, CSV, and plain text.
6. Decide the first non-HWP parser scope: recommended order is TXT, Markdown, CSV.
7. Keep full visual validation against Hancom Viewer for HWP/HWPX.

## Bottom Line

Yes, DOC, DOCX, PDF, TXT, Markdown, and many other document formats can be parsed in TotalDocs.

But they should not all be implemented with the same depth at the same time. The reliable path is:

```text
detect format
  -> read container
  -> parse source structure
  -> emit CanonicalDocument
  -> compute LayoutTree when needed
  -> render/export
  -> collect diagnostics
```

For HWP/HWPX, the parser direction is already correct. The next necessary improvement is to stop treating layout as a direct DOM rendering side effect and make layout a first-class, testable output.
