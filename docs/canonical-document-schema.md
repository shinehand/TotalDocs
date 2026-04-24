# CanonicalDocument Schema Draft

Date: 2026-04-24
Owner: Team 1, CanonicalDocument design
Scope: HWP 5.0 binary records and HWPML/HWPX XML packages

## 1. Purpose

`CanonicalDocument` is the lossless document model between HWP/HWPX parsers and the future `LayoutTree`.
It must preserve the fields that Hancom-style layout depends on before any DOM, CSS, or browser reflow decision is made.

The current DOM flow renderer can display many samples, but it cannot reliably reproduce fixed HWP/HWPX layout because page geometry, line segments, table pagination, object anchoring, and font metrics are mixed with CSS heuristics. `CanonicalDocument` separates these concerns:

1. Parser output: source-ordered, source-unit, raw-preserving `CanonicalDocument`.
2. Layout engine output: fixed-position `LayoutTree` with page, line, table, cell, and object fragments.
3. Renderer output: DOM/canvas/SVG projection of `LayoutTree`, never the source of layout truth.

## 2. Source Basis

This draft follows the local official-spec analysis set:

| Area | HWP 5.0 basis | HWPML/HWPX basis |
|---|---|---|
| Document info | `Document Properties`, `ID Mappings`, `DocInfo` records | `HEAD`, `DOCSETTING`, `MAPPINGTABLE`, `TAIL` |
| Sections/pages | `SectionDef`, `PageDef`, `PageBorderFill`, `ColumnsDef` | `SECDEF`, `PAGEDEF`, `PAGEMARGIN`, `PAGEBORDERFILL`, `COLDEF` |
| Paragraphs | `PARA_HEADER`, `PARA_TEXT`, `PARA_CHAR_SHAPE`, `PARA_LINE_SEG`, `PARA_RANGE_TAG` | `P`, `TEXT`, `CHAR`, `PARASHAPE`, `CHARSHAPE`, `STYLE` |
| Tables | `HWPTAG_TABLE`, row size array, cell list headers, zone info | `TABLE`, `ROW`, `CELL`, `CELLMARGIN`, `CELLZONELIST` |
| Objects | object common properties, `ShapeObject`, `ShapeComponent`, picture/OLE/equation/textart records | `SHAPEOBJECT`, `SIZE`, `POSITION`, `OUTSIDEMARGIN`, `CAPTION`, object-specific elements |
| Unknowns | unknown tag bodies and polymorphic `CTRL_HEADER` payloads | unknown elements, attributes, and unsupported controls |

## 3. Non-Negotiable Principles

1. Preserve source order. Paragraph text, inline controls, object controls, tables, captions, notes, and unknown controls must keep the order seen in the source.
2. Preserve source units. HWPUNIT and unit-bearing XML values stay in source units until the `LayoutTree` conversion boundary.
3. Preserve source identity. IDs such as `Id`, `InstId`, `Style`, `BinItem`, `BorderFill`, `ShapeID`, and `SeriesNum` are model fields, not diagnostics.
4. Preserve unknown data. Unsupported records/elements are opaque blocks with enough raw data to count, inspect, and round-trip.
5. Separate raw and normalized views. A normalized enum or helper field may be added, but it must never overwrite the original field value.
6. Layout uses canonical fields only. The renderer must not infer page, table, object, or line geometry from browser measurement.

## 4. Unit Policy

HWP 5.0 `HWPUNIT` and `SHWPUNIT` are `1/7200 inch`. HWPML/HWPX `hwpunit` uses the same axis where `10 pt = 1000 hwpunit`. The canonical model stores these values as integers or explicit unit-bearing values.

```ts
type CanonicalLength =
  | { unit: "hwpunit"; value: number; raw?: string }
  | { unit: "shwpunit"; value: number; raw?: string }
  | { unit: "hwpunit16"; value: number; raw?: string }
  | { unit: "nch"; value: number; raw?: string }
  | { unit: "percent"; value: number; raw?: string }
  | { unit: "unknown"; value: string; raw: string };
```

Rules:

1. Do not convert source dimensions to pixels inside `CanonicalDocument`.
2. Do not store only derived CSS values when the source provides HWPUNIT, relative units, or raw XML strings.
3. If an XML attribute may be `hwpunit` or `nch`, store `{ value, unit, raw }` instead of guessing.
4. `LayoutTree` owns the single conversion boundary to device pixels or CSS pixels.
5. Diagnostics may include a temporary pixel projection, but that projection is never persisted as canonical geometry.

## 5. Top-Level Shape

```ts
interface CanonicalDocument {
  schemaVersion: 1;
  format: "hwp5" | "hwpx" | "hwpml";
  source: RawSourceRef;
  metadata: DocumentMetadata;
  docInfo: DocInfoTables;
  fonts: FontFace[];
  styles: StyleDef[];
  sections: SectionNode[];
  pages: PageDefNode[];
  resources: ResourceRef[];
  unknownControls: UnknownControl[];
  diagnostics: CanonicalDiagnostic[];
}
```

### `rawSource`

Every top-level node and every layout-critical child node should carry a compact `rawSource` reference.

```ts
interface RawSourceRef {
  format: "hwp5" | "hwpx" | "hwpml";
  path?: string;
  stream?: string;
  recordTag?: string | number;
  recordLevel?: number;
  recordOffset?: number;
  recordSize?: number;
  elementName?: string;
  attributes?: Record<string, string>;
  order: number;
  rawBytesRef?: string;
  rawXmlRef?: string;
}
```

The canonical model may store large bytes/XML in a side table, but it must keep a stable reference from the typed node to that raw payload.

## 6. Document, Page, and Section

### `DocumentMetadata`

```ts
interface DocumentMetadata {
  version?: string;
  subVersion?: string;
  summary?: {
    title?: string;
    subject?: string;
    author?: string;
    date?: string;
    keywords?: string[];
    comments?: string;
  };
  beginNumber?: {
    page?: number;
    footnote?: number;
    endnote?: number;
    picture?: number;
    table?: number;
    equation?: number;
    totalPage?: number;
  };
  caretPos?: { list?: number; para?: number; pos?: number };
  compatibleDocument?: RawPreservedMap;
  layoutCompatibility?: RawPreservedMap;
  rawSource: RawSourceRef;
}
```

### `PageDefNode`

`pages` stores source page definitions and page policy, not final laid-out pages.

```ts
interface PageDefNode {
  id: string;
  sectionId: string;
  landscape?: boolean;
  width: CanonicalLength;
  height: CanonicalLength;
  margins: {
    left: CanonicalLength;
    right: CanonicalLength;
    top: CanonicalLength;
    bottom: CanonicalLength;
    header: CanonicalLength;
    footer: CanonicalLength;
    gutter: CanonicalLength;
    gutterType?: string;
  };
  borderFills: PageBorderFillRef[];
  hide?: PageHidePolicy;
  masterPages?: MasterPageRef[];
  rawSource: RawSourceRef;
}
```

### `SectionNode`

```ts
interface SectionNode {
  id: string;
  sourceIndex: number;
  pageDefId?: string;
  startNumber?: {
    pageStartsOn?: string;
    page?: number;
    figure?: number;
    table?: number;
    equation?: number;
  };
  columns?: ColumnDef;
  textDirection?: string;
  lineGrid?: number;
  charGrid?: number;
  headerFooterRefs?: HeaderFooterRef[];
  footnoteShape?: NoteShape;
  endnoteShape?: NoteShape;
  blocks: BlockNode[];
  unknownControls: UnknownControl[];
  rawSource: RawSourceRef;
}
```

## 7. Paragraph, Run, and Line Segment

### `ParagraphNode`

```ts
interface ParagraphNode {
  kind: "paragraph";
  id: string;
  instanceId?: number;
  paraShapeId?: string | number;
  paraStyleId?: string | number;
  styleId?: string | number;
  breakType?: {
    section?: boolean;
    multiColumn?: boolean;
    page?: boolean;
    column?: boolean;
    raw?: number | string;
  };
  controlMask?: number;
  paragraphStyle?: ParagraphStyleSnapshot;
  listInfo?: ListInfo;
  runs: RunNode[];
  lineSegs: LineSegNode[];
  rangeTags: RangeTagNode[];
  inlineControls: InlineControlRef[];
  rawSource: RawSourceRef;
}
```

### `RunNode`

Runs preserve text and inline control order. Extended controls in HWP 5.0 occupy text positions and must be represented explicitly.

```ts
type RunNode =
  | TextRun
  | ControlCharRun
  | InlineObjectRun
  | UnknownInlineRun;

interface TextRun {
  kind: "text";
  text: string;
  charShapeId?: string | number;
  styleId?: string | number;
  charStyle?: CharStyleSnapshot;
  sourceTextRange?: { start: number; end: number };
  rawSource: RawSourceRef;
}

interface ControlCharRun {
  kind: "controlChar";
  controlType:
    | "tab"
    | "lineBreak"
    | "hyphen"
    | "nbspace"
    | "fwspace"
    | "titleMark"
    | "markPenBegin"
    | "markPenEnd"
    | "fieldBegin"
    | "fieldEnd"
    | "bookmark"
    | "unknown";
  attrs?: RawPreservedMap;
  sourceTextRange?: { start: number; end: number };
  rawSource: RawSourceRef;
}
```

### `LineSegNode`

`lineSegs` are source line-layout records/cache. They are required for diagnostics and table long-cell continuation windows, but a new layout engine may validate and recompute them.

```ts
interface LineSegNode {
  textStartPos: number;
  lineVerticalPos: CanonicalLength;
  lineHeight: CanonicalLength;
  textPartHeight: CanonicalLength;
  baselineDistance: CanonicalLength;
  lineSpacing: CanonicalLength;
  columnStartPos: CanonicalLength;
  segmentWidth: CanonicalLength;
  flags: {
    firstLine?: boolean;
    firstLineInColumn?: boolean;
    emptySegment?: boolean;
    firstSegmentInLine?: boolean;
    lastSegmentInLine?: boolean;
    autoHyphenation?: boolean;
    indentationApplied?: boolean;
    paragraphHeadApplied?: boolean;
    raw?: number | string;
  };
  rawSource: RawSourceRef;
}
```

HWPX `linesegarray` attributes map directly where available: `textpos`, `vertpos`, `vertsize`, `textheight`, `baseline`, `spacing`, `horzpos`, `horzsize`, and `flags`.

## 8. Tables, Rows, and Cells

### `TableNode`

```ts
interface TableNode {
  kind: "table";
  id: string;
  object: ObjectNode;
  rowCount: number;
  colCount: number;
  pageBreak?: {
    policy?: "cell" | "row" | "table" | "unknown";
    raw?: number | string;
  };
  repeatHeader?: boolean;
  cellSpacing: CanonicalLength;
  innerMargin: BoxLengths;
  rowSizes: CanonicalLength[];
  borderFillId?: string | number;
  zones: CellZone[];
  rows: TableRowNode[];
  caption?: CaptionNode;
  rawSource: RawSourceRef;
}
```

### `TableRowNode`

```ts
interface TableRowNode {
  rowIndex: number;
  sourceIndex: number;
  declaredHeight?: CanonicalLength;
  isHeader?: boolean;
  cells: TableCellNode[];
  rawSource: RawSourceRef;
}
```

### `TableCellNode`

```ts
interface TableCellNode {
  id: string;
  name?: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  width: CanonicalLength;
  height: CanonicalLength;
  margin?: BoxLengths;
  borderFillId?: string | number;
  hasMargin?: boolean;
  header?: boolean;
  protect?: boolean;
  editable?: boolean;
  dirty?: boolean;
  listHeader?: ListHeader;
  blocks: BlockNode[];
  nestedTables: TableNode[];
  objectRefs: string[];
  rawSource: RawSourceRef;
}
```

Table modeling rules:

1. Store source row/column addresses, spans, row size array, cell dimensions, and margins even when they disagree.
2. Build occupancy grids in `LayoutTree`, not by mutating `rows[].cells[]`.
3. Repeat-header, row split, cell split, and page-break policies must be explicit fields.
4. Long-cell continuation must use paragraph line segment windows, not paragraph counts alone.
5. Nested tables remain nested blocks with their own raw source, not flattened DOM tables.

## 9. Objects

Objects include tables, pictures, drawing shapes, equations, OLE, text art, forms, charts, containers, and unknown object controls.

```ts
interface ObjectNode {
  id: string;
  ctrlId?: string;
  objectType:
    | "table"
    | "picture"
    | "shape"
    | "equation"
    | "ole"
    | "textArt"
    | "form"
    | "chart"
    | "container"
    | "unknown";
  inline: boolean;
  anchor: {
    treatAsChar?: boolean;
    affectLineSpacing?: boolean;
    vertRelTo?: "paper" | "page" | "paragraph" | "cell" | "unknown";
    vertAlign?: string;
    horzRelTo?: "paper" | "page" | "column" | "paragraph" | "cell" | "unknown";
    horzAlign?: string;
    vertOffset: CanonicalLength;
    horzOffset: CanonicalLength;
    flowWithText?: boolean;
    allowOverlap?: boolean;
    holdAnchorAndSO?: boolean;
    rawAttr?: number | string;
  };
  size: {
    width: CanonicalLength;
    height: CanonicalLength;
    widthRelTo?: string;
    heightRelTo?: string;
    protect?: boolean;
  };
  textWrap?: string;
  textFlow?: string;
  zOrder?: number;
  outerMargin?: BoxLengths;
  preventPageBreak?: boolean;
  numberingType?: string;
  description?: string;
  caption?: CaptionNode;
  shapeComponent?: ShapeComponent;
  renderingInfo?: RenderingInfo;
  resourceRef?: string;
  objectSpecific?: RawPreservedMap;
  rawSource: RawSourceRef;
}
```

Required preservation:

1. `SHAPEOBJECT`/object common fields: anchor attr, offsets, size, z-order, outer margin, instance ID, page-break prevention, description.
2. `SIZE` and `POSITION`: relative basis, protect flags, overlap, line-spacing effect, text flow.
3. `SHAPECOMPONENT` and rendering matrices: group offsets, original/current size, flips, rotation, rotation center, matrix sequence.
4. Picture fields: image ref, crop, clip, reverse, effects, line/fill.
5. Equation fields: script string, base unit, color, baseline, version, font name.
6. OLE fields: bin item, draw aspect, moniker, object type, baseline.
7. Container fields: child object order and local coordinate system.
8. Unknown object fields: raw payload and minimal bounding/anchor data when available.

## 10. Fonts and Styles

### `FontFace`

```ts
interface FontFace {
  id: string | number;
  lang?: string;
  face: string;
  type?: string;
  substFont?: RawPreservedMap;
  typeInfo?: RawPreservedMap;
  rawSource: RawSourceRef;
}
```

Font rules:

1. Preserve HWP/HWPX font face as at least `{ lang, id, face, type }`.
2. Preserve language slots rather than collapsing all text to one CSS font family.
3. Font substitution may produce layout metrics, but it must not replace the original face metadata.

### `StyleDef`

```ts
interface StyleDef {
  id: string | number;
  type: "paragraph" | "character" | "unknown";
  name?: string;
  engName?: string;
  paraShapeId?: string | number;
  charShapeId?: string | number;
  nextStyleId?: string | number;
  langId?: number;
  lockForm?: boolean;
  rawSource: RawSourceRef;
}
```

`DocInfoTables` must also preserve `borderFills`, `charShapes`, `paraShapes`, `tabDefs`, `numbering`, `bullets`, `memoShapes`, `compatibleDocument`, and `layoutCompatibility` as ID-addressable maps with raw values.

## 11. Unknown Controls

```ts
interface UnknownControl {
  id: string;
  location:
    | "document"
    | "section"
    | "paragraph"
    | "run"
    | "table"
    | "cell"
    | "object"
    | "tail";
  sourceKind: "hwpRecord" | "hwpxElement" | "xmlAttribute" | "controlChar" | "object";
  name?: string;
  ctrlId?: string | number;
  recordTag?: string | number;
  attrs?: Record<string, string>;
  textPreview?: string;
  childSummary?: Array<{ name: string; count: number }>;
  rawBytesRef?: string;
  rawXmlRef?: string;
  byteLength?: number;
  rawSource: RawSourceRef;
}
```

Unknown-control rules:

1. Unknown HWP records keep tag, level, size, raw bytes, and relative order.
2. Unknown HWPX elements keep element name, raw attributes, text preview, child summary, raw XML reference, and order.
3. Unknown controls are counted in diagnostics and available to QA reports.
4. A renderer may show an unsupported placeholder, but it must not remove the canonical node.

## 12. Fields Passed to `LayoutTree`

The layout engine should consume `CanonicalDocument` and produce immutable layout boxes/fragments. These source fields are mandatory inputs.

### Page and Section Inputs

| Layout need | Canonical fields |
|---|---|
| Paper box | `PageDefNode.width`, `height`, `landscape` |
| Content box | page margins, gutter, header/footer margins, page border/fill offset policy |
| Section flow | `SectionNode.blocks`, columns, text direction, grids, start numbers |
| Header/footer/master page | header/footer refs, hide policy, master page refs |
| Compatibility switches | `metadata.compatibleDocument`, `metadata.layoutCompatibility` |

### Paragraph and Line Inputs

| Layout need | Canonical fields |
|---|---|
| Paragraph box | `paraShapeId`, `paragraphStyle`, margins, indent, border, keep/page-break flags |
| Inline shaping | `runs`, `charShapeId`, `charStyle`, font face refs, tab defs |
| List marker | `listInfo`, numbering/bullet refs, paragraph head char shape |
| Line cache/continuation | `lineSegs`, especially text positions, vertical positions, heights, baseline, width, flags |
| Range effects | `rangeTags`, field/bookmark/mark pen controls |

### Table Inputs

| Layout need | Canonical fields |
|---|---|
| Table anchor and size | `TableNode.object`, object anchor, object size, margins, z-order |
| Grid construction | `rowCount`, `colCount`, `rows[].cells[]`, row/col addresses, spans |
| Row height | `rowSizes`, row declared height, cell declared height, cell margins |
| Pagination | `pageBreak`, `repeatHeader`, row/cell split policy, prevent-page-break |
| Continuation | cell blocks, nested tables, object refs, paragraph `lineSegs` |
| Styling | table/cell `borderFillId`, zones, cell spacing, inner margins |

### Object Inputs

| Layout need | Canonical fields |
|---|---|
| Anchor resolution | `anchor.vertRelTo`, `anchor.horzRelTo`, offsets, align, `inline` |
| Wrap/flow | `textWrap`, `textFlow`, `flowWithText`, `allowOverlap`, `holdAnchorAndSO` |
| Geometry | source width/height, relative size basis, transforms, matrices, outer margins |
| Stacking | `zOrder`, container nesting, group order |
| Object-specific layout | picture crop, equation baseline, OLE baseline, chart/object boxes |

## 13. Prohibitions

These are forbidden in `CanonicalDocument` parsing and schema code:

1. Hard-coded page sizes, page budgets, row weights, line heights, or sample-specific coordinates.
2. HWPUNIT-to-pixel conversion before the `LayoutTree` boundary.
3. Browser DOM measurement as canonical paragraph, table, cell, or object geometry.
4. Arbitrary correction of margins, row heights, line gaps, or font sizes to make one fixture look closer.
5. Dropping unknown records, unknown XML attributes, unknown controls, or unsupported object payloads.
6. Replacing source enum/raw values with normalized labels only.
7. Flattening nested tables, captions, notes, headers, footers, or group objects into plain text.
8. Inferring repeated header rows, split policies, or object anchors when source fields exist but are not parsed.
9. Collapsing language-specific font slots into a single renderer font without preserving the original font table.
10. Mutating `CanonicalDocument` during layout. Layout output must be a separate `LayoutTree`.

## 14. Acceptance Checklist

1. A HWPX fixture can be dumped into stable canonical JSON with sections, page defs, paragraphs, line segments, tables, objects, fonts, styles, raw sources, and unknown controls.
2. A HWP 5 fixture can expose paragraph cluster records, table record fields, object common fields, and unknown tags without loss.
3. QA diagnostics can report counts for unknown controls, tables, cells, line segments, fonts, and object anchors.
4. `LayoutTree` can be generated without reading from the DOM.
5. No code path needs sample-specific constants to explain page/table/object placement.
