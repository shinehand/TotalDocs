# HWPX Raw Preservation Map

Date: 2026-04-24
Owner: Team 2 - HWPX raw preservation map
Scope: `js/hwp-parser-hwpx.js` analysis only. No parser or renderer code changes.

## Goal

The current HWPX parser converts `header.xml` and `section*.xml` into the legacy renderer's compact block model. That path is useful for display, but it is not lossless enough for Hancom Viewer fidelity because many layout, style, object, and control fields are normalized, filtered, or silently ignored.

This map lists what the parser currently preserves, what it drops or abbreviates, and the raw fields/policies that should be added before a deterministic canonical layout path is built.

## Current Parser Shape

High-level flow in `js/hwp-parser-hwpx.js`:

1. `_parseHwpx()` loads the ZIP package, validates `mimetype`, parses a small header reference map, loads image binaries, discovers section order, parses each section, paginates compact blocks, and returns `{ meta, pages }`.
2. `_hwpxParseHeader()` scans all `header.xml` elements, but only materializes `fontface/font`, `borderFill`, `paraPr`, and `charPr`.
3. `_hwpxSectionData()` parses one section into `sectionMeta`, body blocks, header/footer area blocks, and fallback text.
4. `_hwpxBlocksFromContainer()` only accepts direct `p` and `tbl` children.
5. `_hwpxParagraphBlocks()` only accepts `tbl`, `pic`, `t`, `compose`, `lineBreak`, and `tab` inside `run`.
6. `_hwpxTableBlocks()` builds a normalized table block from rows/cells and selected metrics.
7. `_hwpxPictureBlock()` builds an image block if `binaryItemIDRef` resolves to an image data URL.

Loss point summary:

- The parser has no `rawHwpx` package/document graph.
- The header reference map is not lossless.
- Section/page metadata is reduced to renderer-oriented fields.
- Text stream order is not represented as raw tokens.
- Unknown or unsupported controls are ignored unless their text happens to survive through a supported `t` node.
- Unsupported objects are dropped instead of preserved as opaque blocks.
- Tables and pictures retain some raw layout fragments, but not enough to reconstruct source XML or resolve all layout rules.

## Package And Manifest Preservation

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `mimetype` | Validated if present. | Exact value is not stored in output. Missing file is accepted silently. | `rawHwpx.package.mimetype = { path, value, present }`. |
| ZIP entries | Used ad hoc for header, sections, images, preview text. | Full entry list, directory/file flags, sizes, casing, unhandled entries. | `rawHwpx.package.entries[] = { path, normalizedPath, dir, size?, usedAs }`. |
| `version.xml` | Not parsed. | Format/version metadata. | `rawHwpx.package.versionXml = rawXmlSummary(version.xml)`. |
| `settings.xml` | Not parsed. | View/edit settings and compatibility hints. | `rawHwpx.package.settingsXml = rawXmlSummary(settings.xml)`. |
| `META-INF/container.xml`, `container.rdf`, `manifest.xml` | Not parsed. | Container relationship metadata. | `rawHwpx.package.metaInf[path] = rawXmlSummary(path)`. |
| `Contents/content.hpf` | Used only to order section files through `item` and `itemref`. | Manifest item attributes, media types, spine metadata, unreferenced items, raw order. | `rawHwpx.package.contentHpf = { items[], spine[], attrs, rawXmlHash }`. |
| `Preview/PrvText.txt` | Used only as fallback when parsed pages are empty. | Encoding decision, preview presence, preview image. | `rawHwpx.preview = { textPath, imagePath, decodedEncoding, textLength }`. |

Policy:

- Preserve package metadata before parsing document content.
- Keep unknown package entries in diagnostics instead of ignoring them.
- Do not store large raw XML strings in normal parse output by default; store path, attrs, child summaries, source order, text length, and hash. A debug dump can include full XML.

## Binary Resource Preservation

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `BinData/*.{png,jpg,jpeg,gif,bmp,webp}` | Loaded into `header.images[name] = data:image/...`. Key is file basename without extension. | Original path, extension casing, MIME, byte length, checksum, duplicate names, relation to header bin item, linked/embedded distinction. | `resources.binaries[idOrPath] = { path, id, mime, ext, byteLength, checksum, dataUrl?, source }`. |
| Non-image `BinData/*` | Ignored. | OLE, embedded packages, scripts, alternate media. | Preserve entry metadata and mark `renderSupport: 'unsupported'`. |
| Header binary item metadata | Not parsed. | `binItem`, storage/link attributes if present in header. | Add `header.rawBinItems[]`; resolve pictures by binary item ID and path. |

Policy:

- Keep the existing `header.images` compatibility map for renderer fallback.
- Add a separate `resources` graph that is keyed by source ID/path and not by lossy basename.

## Header Reference Map

### Font Faces

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `fontfaces`, `fontface` | `refs.fontFaces[LANG][id] = face`; `hangulFonts` alias. | `itemCnt`, `fontCnt`, source order, unknown attrs. | `header.rawFontfaces = { attrs, facesByLang, order[] }`. |
| `font` | `id` and `face` only. | `type`, `isEmbedded`, `substituteFont`, `typeInfo`, child metadata. | `font = { id, face, type, isEmbedded, attrs, children }`. |

Raw fields needed:

- `font.lang`, `font.id`, `font.face`, `font.type`, `font.isEmbedded`.
- Full language-slot map for `HANGUL`, `LATIN`, `HANJA`, `JAPANESE`, `OTHER`, `SYMBOL`, and `USER`.
- `rawAttrs` on every font-related node.

### Border Fills

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `borderFill` | `left/right/top/bottom` border type, width, color; `winBrush.faceColor`; basic gradient `{ type, angle, colors }`. | `threeD`, `shadow`, `centerLine`, `breakCellSeparateLine`, slash/backSlash/diagonal flags, child order. | `header.rawBorderFills[id] = { attrs, borders, fillBrush, diagonal, rawChildren }`. |
| Border sides | `type`, parsed `widthMm`, normalized color. | Original width unit/string, alpha, unknown side attrs. | Store both normalized and `rawAttrs`. |
| Fill brush | `winBrush.faceColor`; partial `gradation`. | Hatch color/style, image brush, alpha, gradient center/step/mode, alternate fill nodes. | Preserve full `fillBrush` subtree summary. |

Raw fields needed:

- `rawBorderFill.attrs`.
- `rawBorderFill.sides.{left,right,top,bottom,diagonal,slash,backSlash}`.
- `rawBorderFill.fill = { winBrush, gradation, imgBrush, rawChildren }`.

### Paragraph Properties

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `paraPr` | `align.horizontal`, margin left/right/intent/prev/next, line spacing type/value. | `heading`, `border`, `autoSpacing`, `breakSetting`, vertical alignment, tab refs, list refs, keep/widow/orphan/page-break policies, units. | `header.rawParaProps[id] = { attrs, align, margin, lineSpacing, heading, border, breakSetting, autoSpacing, rawChildren }`. |
| `margin` children | Numeric `value` only. | Unit/type attrs, original signed values. | Preserve `{ value, unit?, rawAttrs }` per side. |
| `lineSpacing` | Normalized type and numeric value. | Original type token and other attrs. | Store normalized + raw. |

Raw fields needed:

- `rawParaPr.attrs`.
- `rawParaPr.align.attrs`.
- `rawParaPr.margin.left/right/intent/prev/next.rawAttrs`.
- `rawParaPr.heading`, `rawParaPr.border`, `rawParaPr.breakSetting`, `rawParaPr.autoSpacing`.

### Character Properties

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `charPr` | `fontName`, `fontNameLatin`, `fontRefs`, font size, text/shade color, bold/italic, underline/strike/outline/shadow, first available ratio/spacing/relSz/offset slot. | `useFontSpace`, `useKerning`, `symMark`, `borderFillIDRef`, raw height, per-language ratio/spacing/relSz/offset arrays, decoration raw attrs. | `header.rawCharProps[id] = { attrs, fontRef, ratio, spacing, relSz, offset, decorations, rawChildren }`. |
| `fontRef` | Per-language ID refs. | Raw attrs and unresolved missing refs. | Preserve all slots with resolved font metadata and raw ID. |
| `ratio`, `spacing`, `relSz`, `offset` | Collapsed to first numeric language slot. | Six other language slots and original attr values. | Store complete slot map. |
| `underline`, `strikeout`, `outline`, `shadow` | Partially normalized. | Decoration type/shape semantics and unknown attrs. | Store normalized fields plus full raw attrs. |

Raw fields needed:

- `rawCharPr.attrs`.
- `rawCharPr.fontRef.slots`.
- `rawCharPr.metrics.ratio/spacing/relSz/offset` with all language slots.
- `rawCharPr.decorations.*.rawAttrs`.

### Header Nodes Currently Ignored

The following header-level structures are not materialized by the HWPX parser and should be preserved before fidelity work depends on them:

- `styles/style`: style IDs, names, next style, paragraph/character refs.
- `tabPr/tabItem`: tab stops, alignment, leader.
- `numbering/paraHead`, bullets, paragraph heads: list marker formats, levels, starts, widths.
- `beginNum`: document-level page/picture/table/equation starting numbers.
- `docOption`, `compatibleDocument`, `layoutCompatibility`: compatibility switches.
- `trackchageConfig` and typo-equivalent source names.
- Any unknown header child under `head` or reference lists.

Proposed field:

```text
header.rawRefs = {
  fontfaces,
  borderFills,
  paraProps,
  charProps,
  styles,
  tabProps,
  numberings,
  bullets,
  beginNum,
  docOptions,
  compatibility,
  unknown[]
}
```

## Section And Page Metadata

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `secPr` | Not stored as raw. Descendants are sampled into `sectionMeta`. | `secPr` attrs, child order, unsupported children. | `section.rawSecPr = { attrs, children, sourceOrder }`. |
| `visibility` | All attrs copied into `sectionMeta.visibility`. | Raw node identity and defaults. | Preserve as `rawVisibility` as well as normalized visibility. |
| `pagePr` | width, height, landscape. | `gutterType`, raw orientation token semantics, unknown attrs. | `rawPagePr.attrs`; keep width/height in HWPUNIT. |
| `margin` | left/right/top/bottom/header/footer. | `gutter`, raw attrs, unit semantics. | `rawPageMargin.attrs`, including `gutter`. |
| `pageBorderFill` | type, `borderFillIDRef`, resolved style, offset left/right/top/bottom. | `textBorder`, `headerInside`, `footerInside`, `fillArea`, raw attrs. | `rawPageBorderFills[] = { attrs, offset, borderFillRef }`. |
| `pageNum` | position, format type, side char; only `DIGIT` renders. | Non-digit formats and raw attrs. | `rawPageNum.attrs`; preserve unsupported formats for later. |
| `newNum` | First descendant with `numType="PAGE"` becomes `startPageNum`. | Multiple `newNum`, section-local vs paragraph-local source order, non-page counters. | `rawNewNums[] = { attrs, sourcePath }`. |
| `startNum` | Ignored. | Page/picture/table/equation starts. | `rawStartNum.attrs`. |
| `grid` | Ignored. | line grid, char grid, manuscript paper format. | `rawGrid.attrs`. |
| `lineNumberShape` | Ignored. | Line numbering policy. | `rawLineNumberShape.attrs`. |
| `colPr` | Ignored. | Column count, layout, gaps, separators. | `rawColumnPr.attrs` and children. |
| `footNotePr`, `endNotePr` | Ignored. | Note numbering, note line, spacing, placement. | `rawFootNotePr`, `rawEndNotePr`. |
| `header`, `footer` | Parsed into blocks by `subList`; applyPageType retained. | `id`, raw attrs, unknown content, unsupported controls, empty visual content. | `rawHeaderFooterAreas[] = { kind, attrs, subListRaw, blocks, unknownControls }`. |

Policy:

- Do not use `querySelector`-style first descendant lookup for fields that can occur multiple times. Preserve all matching nodes with source order, then select the effective normalized value separately.
- Keep `sectionMeta.pageStyle` for legacy renderer compatibility, but attach raw fields under `sectionMeta.raw`.

## Body Container And Source Order

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| Section root children | Direct `p` and `tbl` only. | Direct `ctrl`, `switch`, unknown objects, comments, processing order around `secPr`. | `section.children[] = { order, kind, blockRef?, rawNodeSummary }`. |
| `subList` containers | Direct `p` and `tbl` only. | `subList` attrs beyond selected table cell fields, nested unsupported controls. | `rawSubList = { attrs, childOrder[] }`. |
| Empty visual nodes | Often filtered by `_blockHasVisualContent()` in header/footer and table paths. | Empty but layout-bearing controls, invisible anchors, fields. | Preserve raw node even when visual output is empty. |

Policy:

- Every XML element that is skipped by a container parser should be accounted for in `unknown[]` or `unsupported[]`.
- Source order should be stable and local to parent: `order` as child index and `path` as a generated canonical XML path.

## Paragraph And Run Preservation

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `p` attrs | `id`, `paraPrIDRef`, `styleIDRef`, `pageBreak`, `columnBreak`, `merged`. | Any other paragraph attrs; raw align token if present; parent context. | `rawParagraph.attrs = allAttrs`; keep selected normalized fields separately. |
| `paraPrIDRef` | Resolved into copied paragraph style fields. | Original style link can be obscured by copied values. | Keep `paraStyleRef = { paraPrIDRef, styleIDRef, resolvedParaPrId }`. |
| `linesegarray/lineseg` | Selected attrs; computed average line height; filters out zero/large segments. | Full raw attrs, rejected segments, segment source order. | `rawLineSegArray = { attrs, segments[], rejectedSegments[] }`. |
| `run` attrs | `charPrIDRef` is used for style lookup. | Raw run attrs and run-level source order are not stored. | `rawRuns[] = { order, attrs, charPrIDRef, children[] }`. |
| Text run merging | Consecutive same-style text is merged. | Original run boundaries and token boundaries. | Keep rendered `texts[]`, plus `rawTextTokens[]` with source order. |
| Whitespace trim | Leading/trailing whitespace-only runs are trimmed. | Source whitespace significance at paragraph boundaries. | Preserve raw tokens even if normalized renderer text trims them. |
| Empty paragraphs | Empty block emitted only when layout hints/run/page/column break exist. | Unknown-control-only paragraphs can become empty without diagnostics. | Emit `emptyParagraph` plus `rawRuns` and `unknownControls`. |

Raw fields needed:

```text
paragraph.raw = {
  attrs,
  paraStyleRef,
  lineSegArray,
  runs: [
    {
      order,
      attrs,
      charStyleRef,
      children: token[]
    }
  ],
  unknownChildren: []
}
```

## Text Tokens And Inline Controls

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `t` | Text content; child `fwSpace` becomes U+3000. | Raw attrs, mixed child order, other `t` children. | Token `{ kind: 'text', attrs, text, children }`. |
| `fwSpace` | U+3000 when inside `t`. | Raw node and any attrs. | Token `{ kind: 'space', subtype: 'fwSpace', text: '\u3000', raw }`. |
| `lineBreak` | `\n`. | Raw attrs and break type if any. | Token `{ kind: 'break', subtype: 'lineBreak', raw }`. |
| `tab` | `\t`. | Tab stop metadata, attrs. | Token `{ kind: 'tab', raw }`; connect to `tabPr` later. |
| `compose` | Converted circled-number fallback text. | `composeText`, PUA sequence, compose/circle attrs. | Token `{ kind: 'compose', text, rawComposeText, attrs }`. |
| `ctrl` | Ignored. | Control marker position. | Token `{ kind: 'control', controlType: 'unknown', raw }`. |
| `fieldBegin`, `parameters`, `fieldEnd` | Ignored. Text inside supported `t` may remain, but field boundaries are lost. | Formula/hyperlink metadata, IDs, params, dirty/editable state. | Tokens for `fieldBegin`, `fieldParam`, `fieldEnd`; pair by IDs. |
| Other run children | Ignored. | Bookmarks, notes, autonumbering, hidden fields, unsupported inline objects. | Opaque token with source summary. |

Policy:

- Text extraction should be a projection from raw tokens, not the only representation.
- Field/control tokens must remain in the run even when the legacy renderer cannot show them.
- Unknown inline controls should not force a new paragraph unless their object layout says they are floating/block-level.

## Table Preservation

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| `tbl` attrs | Selected attrs in `table.rawLayout`; normalized row/col counts, spacing, repeat header count, page break. | All other attrs, source child order, raw table-level margins/caption/cell zones. | `table.rawTable = { attrs, childOrder, inMargin, cellzoneList, caption, rawObjectLayout }`. |
| Object layout on `tbl` | Parsed through `_hwpxParseObjectLayout()` and attached by `_withObjectLayout()`. | Some object attrs and layout children; see object section. | Use shared `rawObject` policy. |
| `inMargin` | Used as fallback padding when cell has no margin. | Not retained as raw table-level field. | `rawTable.inMargin.attrs`. |
| `cellzoneList/cellzone` | Ignored. | Region-specific border fill overrides. | `rawTable.cellZones[] = { attrs, borderFillRef }`; later apply to cell border resolution. |
| `caption` | Ignored. | Caption side, width, gap, blocks. | `rawTable.caption = { attrs, blocks, rawSubList }`. |
| `tr` | Row index inferred from order. | Row attrs and source identity. | `row.rawRow = { attrs, order }`. |
| `tc` attrs | `borderFillIDRef`, `hasMargin`, `dirty`, `editable`. | Any other attrs, cell source order. | `cell.rawCell.attrs = allAttrs`. |
| `cellAddr`, `cellSpan`, `cellSz` | Core numeric attrs retained. | Raw attrs and invalid/raw values. | Preserve raw beside normalized values. |
| `cellMargin` | Normalized padding; invalid/inherit values collapse to 0. | Original inherit sentinel and raw attrs. | `rawCell.margin = { rawAttrs, normalizedPadding, inheritedFromTable }`. |
| `subList` | Blocks and `textWidth/textHeight` retained. | Other attrs such as vertical layout policies and raw child order. | `rawCell.subList = { attrs, childOrder }`. |
| Nested table blocks | Parsed if direct child. | Unsupported siblings around nested table. | Preserve child order in subList. |

Policy:

- Keep current `rawLayout` for compatibility, but introduce explicit `rawTable`, `rawRow`, and `rawCell`.
- Preserve `cellzoneList` before table border/style fidelity work. It is present in the sample and directly changes cell appearance.
- Store row/column occupancy metadata without destroying source cell order.

## Object And Picture Preservation

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| Common object attrs | Selected `id`, `zOrder`, `numberingType`, `lock`; normalized text wrap/flow, offsets, relTo/align. | `href`, `groupLevel`, `instid`, `reverse`, `dropcapstyle`, and unknown attrs. | `rawObject.attrs = allAttrs`. |
| `pos` | Selected attrs and normalized rel/align/offset booleans. | Raw tokens for all attrs, defaults, unknown positioning flags. | `rawObject.pos.attrs`. |
| `sz` | width/height/protect selected. | Raw widthRelTo/heightRelTo and unknown attrs not in raw map. | `rawObject.size.attrs = allAttrs`. |
| `offset` | Used for pictures when `pos` is absent. | Raw node only selected attrs. | `rawObject.offset.attrs`. |
| `outMargin` | Normalized four-side array and raw selected attrs. | Raw node order/unknown attrs. | `rawObject.outMargin.attrs`. |
| `pic/img` | Image ref resolved to data URL; width/height from `curSz` or `orgSz`; shape comment text. | `imgRect`, `imgClip`, `imgDim`, `effects`, `flip`, `rotationInfo`, `renderingInfo`, matrices, crop geometry, alpha/effects, reverse. | `rawPicture = { attrs, img, curSz, orgSz, imgRect, imgClip, imgDim, effects, flip, rotationInfo, renderingInfo, shapeComment }`. |
| Missing image resource | Picture returns `null`. | Broken image object and its layout anchor are lost. | Emit unsupported image placeholder with `missingResource: true` and raw object. |
| Unsupported drawing objects | Dropped by container/run parser. | Lines, rectangles, ellipses, polygons, text boxes, groups, OLE, equations, form controls, charts/text art if present. | Opaque object block/run with raw attrs, child summary, object layout, and text fallback. |

Policy:

- A known unsupported object should become `{ type: 'unsupported-object', sourceFormat: 'hwpx', objectKind, rawObject, fallbackText }`, not disappear.
- Pictures should be preserved even when binary resolution fails.
- Transform matrices should be retained before any simplified width/height or offset normalization.

## Header, Footer, Notes, And Page Numbers

| Source | Currently retained | Dropped or abbreviated | Preserve as raw |
|---|---|---|---|
| Header/footer blocks | Blocks from `subList`, filtered for visual content; selected by `applyPageType`. | Empty layout controls, area IDs, raw attrs, unsupported nodes. | `rawArea = { kind, attrs, subList, allBlocks, unknownControls }`. |
| Header/footer visibility | First-page hiding is applied. | Visibility raw policy and reason diagnostics. | Add `visibilityDecision = { pageIndex, hiddenBy }` in debug/canonical dump. |
| Page number | Renderer synthesizes digit-only paragraph. | Non-digit formats, exact placement baseline, side char raw semantics. | Preserve raw page number control and mark synthesized block as derived. |
| Footnotes/endnotes | Section-level note settings ignored; note controls ignored. | Footnote/endnote body and placement. | Preserve note settings in `section.raw` and note controls as opaque controls. |

Policy:

- Synthesized page-number blocks should carry `derivedFromRawPageNumRef`.
- Header/footer raw blocks should not be filtered out of canonical data even if the legacy renderer filters them.

## Unknown Control Policy

Unknown controls must be stable, ordered, and safe. The goal is not to render every control immediately; the goal is to never lose the evidence required to render or round-trip it later.

### Classification

Classify skipped HWPX nodes into these buckets:

| Bucket | Examples | Output shape |
|---|---|---|
| `unknown-inline-control` | Unknown `run` child, unsupported field marker, bookmark-like nodes. | Preserve as token in `rawRuns[].children[]`; optional zero-width renderer fallback. |
| `unknown-block-control` | Unsupported direct child in section/subList that occupies flow. | Preserve as block with `type: 'unsupported-control'`. |
| `unknown-floating-object` | Unsupported object with `pos`, `sz`, `zOrder`, or wrap attrs. | Preserve as object block/run with `rawObjectLayout`. |
| `known-unsupported-control` | Equation, OLE, form controls, text art, drawing shapes, group/container, chart-like objects. | Preserve specific `objectKind` and raw subtree summary. |
| `metadata-only-control` | Visibility, settings, compatibility, field metadata with no direct visual body. | Preserve under nearest owner `raw.*` and diagnostics. |

### Required Raw Control Shape

```text
rawControl = {
  id,
  kind,
  localName,
  namespaceURI,
  prefix,
  attrs,
  path,
  order,
  parentKind,
  textPreview,
  childSummary,
  rawObjectLayout?,
  resourceRefs?,
  pairedWith?,
  renderSupport: 'supported' | 'partial' | 'unsupported',
  dropRisk: 'layout' | 'content' | 'metadata' | 'roundtrip'
}
```

### Pairing Rules

- Pair `fieldBegin` and `fieldEnd` by `id`/`beginIDRef` and keep all `parameters` children in between.
- Keep malformed/unpaired fields as diagnostics, not as discarded nodes.
- Keep control tokens at their original run position even when the visible text is rendered without them.
- For controls that own a `subList`, preserve the subList child order and parse supported child blocks into a nested `blocks` array.

### Fallback Rendering Rules

- Inline unknown controls: render nothing by default, but expose diagnostics and raw tokens.
- Block unknown controls: render a small placeholder only in debug mode; legacy viewer mode may hide it while preserving canonical data.
- Floating unknown objects: reserve anchor/layout metadata and optionally show a placeholder box in debug mode.
- Missing-resource pictures: emit an image placeholder with original dimensions if available.

## Application Order

Recommended implementation order for raw preservation:

1. Add package-level `rawHwpx.package` and `resources` metadata without changing current `pages`.
2. Add a generic XML summary helper: `attrs`, `localName`, `namespaceURI`, `path`, `order`, `textPreview`, `childSummary`, and optional hash.
3. Extend `_hwpxParseHeader()` to preserve full raw refs while keeping the existing normalized `borderFills`, `paraProps`, `charProps`, and `fontFaces`.
4. Extend `_hwpxSectionMeta()` to attach `sectionMeta.raw` for `secPr`, page settings, notes, columns, grid, numbering, page borders, header/footer area attrs, and all repeated metadata nodes.
5. Extend paragraph parsing with `rawParagraph`, `rawLineSegArray`, `rawRuns`, and `rawTextTokens`; do not change rendered `texts[]` yet.
6. Add unknown inline control capture for unhandled `run` children, especially `ctrl`, `fieldBegin`, `parameters`, and `fieldEnd`.
7. Extend table raw preservation with `rawTable`, `rawRow`, `rawCell`, `cellzoneList`, table `inMargin`, caption, and full `subList` attrs.
8. Extend picture/object preservation with `rawObject` and `rawPicture`; emit placeholders for missing image resources.
9. Add known-unsupported object/control blocks for unsupported shapes, equations, OLE, forms, groups, and text art.
10. Add diagnostics counts: unknown by localName, unsupported by objectKind, missing resources, discarded visual nodes, and repeated metadata selections.
11. Only after raw preservation is stable, let layout-tree work consume raw fields and reduce legacy heuristics.

## Compatibility Notes

- Keep current normalized fields so `hwp-renderer.js` and existing verification scripts continue to run.
- Attach raw data beside normalized fields rather than replacing them.
- Use source HWPUNIT values as raw numeric fields; only renderer/layout code should convert to pixels.
- Avoid storing full raw XML strings in normal runtime output to limit memory pressure; use summaries and hashes unless a debug dump explicitly asks for raw XML.
- The canonical dump should be deterministic: stable key order, stable source order, stable generated IDs.

## Immediate Preservation Checklist

- `rawHwpx.package.entries`, `contentHpf`, `settingsXml`, `versionXml`.
- `resources.binaries` for every `BinData` entry, including non-images.
- `header.rawRefs.fontfaces`, `borderFills`, `paraProps`, `charProps`, `styles`, `tabProps`, `numberings`, `beginNum`, `compatibility`, `unknown`.
- `sectionMeta.raw.secPr`, `pagePr`, `margin`, `grid`, `colPr`, `startNum`, `visibility`, `lineNumberShape`, `footNotePr`, `endNotePr`, `pageBorderFills`, `pageNum`, `newNums`.
- `paragraph.raw.attrs`, `lineSegArray`, `runs`, `textTokens`, `unknownChildren`.
- `table.rawTable`, `row.rawRow`, `cell.rawCell`, `cellZones`, `caption`.
- `object.rawObject`, `picture.rawPicture`, missing-resource placeholders.
- `rawControl` entries for unknown and known-unsupported controls.
- Diagnostics proving that skipped nodes are counted, named, and traceable.
