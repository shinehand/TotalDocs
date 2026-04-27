#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { format as formatConsole } from 'node:util';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PAKO_PATH = path.join(ROOT_DIR, 'lib', 'pako.min.js');
const PARSER_FILES = [
  'js/hwp-parser.js',
  'js/hwp-parser-hwpx.js',
  'js/hwp-parser-hwp5-container.js',
  'js/hwp-parser-hwp5-records.js',
];
const RECORD_EXAMPLE_LIMIT_PER_TAG = 5;
const RAW_RECORD_DETAIL_LIMIT = 200;
const OBJECT_BLOCK_TYPES = new Set(['image', 'shape', 'textbox', 'equation', 'ole', 'chart', 'video']);
const OBJECT_CONTROL_IDS = new Set(['tbl ', 'gso ']);
const OBJECT_PAYLOAD_TAG_IDS = new Set([78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 95, 98]);

const require = createRequire(import.meta.url);

process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

function printUsage() {
  console.log(`Usage:
  node scripts/dump_hwp_table_metrics.mjs <file.hwp> [options]

Options:
  --out <path>  Write JSON to a file instead of stdout.
  --compact     Emit compact JSON instead of pretty JSON.
  --help        Show this help.`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    inputPath: '',
    outputPath: '',
    pretty: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--compact') {
      options.pretty = false;
      continue;
    }
    if (arg === '--out') {
      options.outputPath = argv[index + 1] || '';
      index += 1;
      if (!options.outputPath) fail('--out requires a path');
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.outputPath = arg.slice('--out='.length);
      if (!options.outputPath) fail('--out requires a path');
      continue;
    }
    if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
    }
    if (options.inputPath) {
      fail(`unexpected extra argument: ${arg}`);
    }
    options.inputPath = arg;
  }

  if (!options.inputPath) {
    printUsage();
    process.exit(1);
  }

  return options;
}

function pushDiagnostic(diagnostics, level, message, details = {}) {
  diagnostics.push({
    level,
    message,
    ...stripEmpty(details),
  });
}

function stripEmpty(object = {}) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    if (value === null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

function sortObjectByKey(object = {}) {
  return Object.fromEntries(
    Object.entries(object).sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function increment(map, key, amount = 1) {
  const normalized = String(key ?? '');
  map[normalized] = (map[normalized] || 0) + amount;
}

function toHex(value, width = 2) {
  return `0x${(Number(value) >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256Hex(bytes = new Uint8Array()) {
  return createHash('sha256').update(Buffer.from(bytes || [])).digest('hex');
}

function hexPreview(bytes = new Uint8Array(), limit = 16) {
  return Array.from((bytes || []).slice(0, limit))
    .map(byte => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

function pageSplitPolicy(splitPage) {
  switch (Number(splitPage) || 0) {
    case 1: return 'CELL';
    case 2: return 'SPLIT';
    case 3: return 'RESERVED';
    default: return 'NONE';
  }
}

function decodeParagraphBreakType(flags = 0) {
  const raw = Number(flags) || 0;
  return {
    raw,
    hex: toHex(raw, 2),
    section: Boolean(raw & 0x01),
    multiColumn: Boolean(raw & 0x02),
    page: Boolean(raw & 0x04),
    column: Boolean(raw & 0x08),
  };
}

function normalizeTablePageBreak(table = {}) {
  const rawSplitPage = Number(table.rawLayout?.splitPage ?? table.splitPage) || 0;
  const explicit = String(table.pageBreak || table.rawLayout?.pageBreak || '').trim().toUpperCase();
  if (explicit && explicit !== '0') return explicit;
  return pageSplitPolicy(rawSplitPage);
}

function cleanJson(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array || value instanceof Uint16Array || value instanceof Uint32Array || value instanceof Int32Array) {
    return Array.from(value);
  }
  if (seen.has(value)) return '[Circular]';
  if (depth > 12) return '[MaxDepth]';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map(item => cleanJson(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'function' || child === undefined) continue;
    out[key] = cleanJson(child, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

function shallowPick(object = {}, keys = []) {
  const out = {};
  for (const key of keys) {
    if (object?.[key] !== undefined) out[key] = cleanJson(object[key]);
  }
  return out;
}

function textLength(block = {}) {
  return (block.texts || []).reduce((sum, run) => sum + String(run?.text || '').length, 0);
}

function summarizeLineSegs(lineSegs = []) {
  const segments = Array.isArray(lineSegs) ? lineSegs : [];
  if (!segments.length) {
    return {
      count: 0,
      totalHeight: 0,
      maxHeight: 0,
      minY: null,
      maxY: null,
      flagCounts: {},
    };
  }

  const heights = segments.map(seg => Math.max(Number(seg?.height) || 0, Number(seg?.textHeight) || 0));
  const ys = segments.map(seg => Number(seg?.y) || 0);
  const flagCounts = {};
  for (const seg of segments) {
    increment(flagCounts, toHex(seg?.flags || 0, 8));
  }

  return {
    count: segments.length,
    totalHeight: heights.reduce((sum, value) => sum + value, 0),
    maxHeight: Math.max(...heights),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    flagCounts: sortObjectByKey(flagCounts),
  };
}

function countBlocks(blocks = []) {
  const counts = { paragraphCount: 0, tableCount: 0, lineSegCount: 0, objectCount: 0 };
  const visit = block => {
    if (!block) return;
    if (block.type === 'paragraph') {
      counts.paragraphCount += 1;
      counts.lineSegCount += Array.isArray(block.lineSegs) ? block.lineSegs.length : 0;
      return;
    }
    if (isObjectBlock(block)) {
      counts.objectCount += 1;
      for (const child of block.paragraphs || []) visit(child);
      return;
    }
    if (block.type === 'table') {
      counts.tableCount += 1;
      for (const row of block.rows || []) {
        for (const cell of row.cells || []) {
          for (const child of cell.paragraphs || []) visit(child);
        }
      }
      return;
    }
    for (const child of block.paragraphs || []) visit(child);
  };

  for (const block of blocks || []) visit(block);
  return counts;
}

function controlSummary(controls = []) {
  return (Array.isArray(controls) ? controls : []).map(control => stripEmpty({
    kind: control.kind || '',
    controlId: control.controlId || '',
    controlKind: control.controlKind || '',
    offset: control.offset,
    sourceOffset: control.sourceOffset,
    spanBytes: control.spanBytes,
    charCodeHex: control.charCodeHex,
    replacement: control.replacement,
    recordTagId: control.recordTagId,
    recordLevel: control.recordLevel,
    recordSize: control.recordSize,
  }));
}

function objectLayout(block = {}) {
  return stripEmpty(shallowPick(block, [
    'align',
    'inline',
    'affectLineSpacing',
    'vertRelTo',
    'vertAlign',
    'horzRelTo',
    'horzAlign',
    'offsetX',
    'offsetY',
    'flowWithText',
    'allowOverlap',
    'holdAnchorAndSO',
    'widthRelTo',
    'heightRelTo',
    'sizeProtected',
    'textWrap',
    'textFlow',
    'zOrder',
    'outMargin',
    'rawObjectLayout',
  ]));
}

function isObjectBlock(block = {}) {
  return Boolean(block && OBJECT_BLOCK_TYPES.has(block.type));
}

function objectMetric(block = {}, locator = {}) {
  const nestedCounts = countBlocks(block.paragraphs || []);
  return stripEmpty({
    index: locator.objectIndex,
    sectionIndex: locator.sectionIndex,
    context: locator.context,
    path: locator.path,
    parentTableIndex: locator.parentTableIndex ?? null,
    nestingDepth: locator.nestingDepth || 0,
    type: block.type || '',
    sourceFormat: block.sourceFormat || '',
    width: block.width,
    height: block.height,
    alt: block.alt,
    description: block.description,
    hasImageSource: Boolean(block.src),
    imageSourceLength: block.src ? String(block.src).length : 0,
    binaryName: block.binaryName || '',
    pictureBinId: block.pictureBinId,
    pictureRefId: block.pictureRefId,
    pictureStreamId: block.pictureStreamId,
    pictureMime: block.pictureMime || '',
    rawPicture: cleanJson(block.rawPicture),
    oleBinId: block.oleBinId,
    hasChartData: block.hasChartData,
    hasVideoData: block.hasVideoData,
    paragraphCount: nestedCounts.paragraphCount,
    lineSegCount: nestedCounts.lineSegCount,
    nestedTableCount: nestedCounts.tableCount,
    textLength: textLength(block),
    layout: objectLayout(block),
  });
}

function cellMetric(cell = {}, rowIndex = 0, cellIndex = 0) {
  const nestedCounts = countBlocks(cell.paragraphs || []);
  return stripEmpty({
    index: cellIndex,
    rowIndex,
    row: cell.row,
    col: cell.col,
    rowSpan: cell.rowSpan,
    colSpan: cell.colSpan,
    width: cell.width,
    height: cell.height,
    contentHeight: cell.contentHeight,
    padding: Array.isArray(cell.padding) ? [...cell.padding] : cell.padding,
    borderFillId: cell.borderFillId,
    borderStyle: cleanJson(cell.borderStyle),
    verticalAlign: cell.verticalAlign,
    paragraphCount: nestedCounts.paragraphCount,
    lineSegCount: nestedCounts.lineSegCount,
    nestedTableCount: nestedCounts.tableCount,
    listFlags: cell.listFlags,
    unknownWidth: cell.unknownWidth,
  });
}

function rowMetric(row = {}) {
  const cells = (row.cells || []).map((cell, cellIndex) => cellMetric(cell, row.index, cellIndex));
  const cellHeights = cells
    .map(cell => Number(cell.height) || 0)
    .filter(height => height > 0);
  return {
    index: row.index,
    cellCount: cells.length,
    height: cellHeights.length ? Math.max(...cellHeights) : null,
    cells,
  };
}

function buildTableMetric(table = {}, locator = {}) {
  const rows = (table.rows || []).map(rowMetric);
  const cells = rows.flatMap(row => row.cells);
  const spanCount = cells.filter(cell => (
    (Number(cell.rowSpan) || 1) > 1 || (Number(cell.colSpan) || 1) > 1
  )).length;
  const rawSplitPage = Number(table.rawLayout?.splitPage ?? table.splitPage) || 0;
  const pageBreak = normalizeTablePageBreak(table);

  return stripEmpty({
    index: locator.tableIndex,
    sectionIndex: locator.sectionIndex,
    context: locator.context,
    path: locator.path,
    parentTableIndex: locator.parentTableIndex ?? null,
    nestingDepth: locator.nestingDepth || 0,
    sourceFormat: table.sourceFormat || '',
    rowCount: table.rowCount,
    colCount: table.colCount,
    cellCount: cells.length,
    spanCount,
    mergedCellCount: spanCount,
    columnWidths: cleanJson(table.columnWidths || []),
    rowHeights: cleanJson(table.rowHeights || []),
    rowCellCounts: cleanJson(table.rowCellCounts || []),
    cellSpacing: table.cellSpacing,
    defaultCellPadding: cleanJson(table.defaultCellPadding),
    borderFillId: table.borderFillId,
    validZones: cleanJson(table.validZones || []),
    pageBreak,
    repeatHeader: Boolean(table.repeatHeader),
    numHeaderRows: Number(table.numHeaderRows) || 0,
    split: {
      raw: rawSplitPage,
      policy: pageSplitPolicy(rawSplitPage),
      hasSplitSignal: rawSplitPage > 0 || !['', '0', 'NONE'].includes(pageBreak),
    },
    layout: objectLayout(table),
    rawLayout: cleanJson(table.rawLayout),
    rows,
  });
}

function paragraphMetric(block = {}, locator = {}) {
  const lineSegs = Array.isArray(block.lineSegs) ? block.lineSegs : [];
  const controls = controlSummary(block.controls || []);
  const controlKindCounts = {};
  for (const control of controls) {
    increment(controlKindCounts, control.controlKind || control.kind || 'unknown');
  }

  return stripEmpty({
    index: locator.paragraphIndex,
    sectionIndex: locator.sectionIndex,
    context: locator.context,
    path: locator.path,
    align: block.align,
    styleId: block.styleId,
    styleName: block.styleName,
    textRunCount: Array.isArray(block.texts) ? block.texts.length : 0,
    textLength: textLength(block),
    lineHeightPx: block.lineHeightPx,
    layoutHeightPx: block.layoutHeightPx,
    lineSegCount: lineSegs.length,
    lineSegSummary: summarizeLineSegs(lineSegs),
    lineSegs: cleanJson(lineSegs),
    controlCount: controls.length,
    controlKindCounts: sortObjectByKey(controlKindCounts),
    controls,
    hwp: cleanJson(block.hwp),
    rawLayout: cleanJson(block.rawLayout),
  });
}

function collectParsedMetrics(parsedBody = null) {
  const tables = [];
  const paragraphs = [];
  const objects = [];
  const sections = [];
  const contexts = {
    body: { tableCount: 0, paragraphCount: 0, lineSegCount: 0, objectCount: 0 },
    header: { tableCount: 0, paragraphCount: 0, lineSegCount: 0, objectCount: 0 },
    footer: { tableCount: 0, paragraphCount: 0, lineSegCount: 0, objectCount: 0 },
  };

  const addCounts = (context, counts) => {
    const bucket = contexts[context] || (contexts[context] = {
      tableCount: 0,
      paragraphCount: 0,
      lineSegCount: 0,
      objectCount: 0,
    });
    bucket.tableCount += counts.tableCount;
    bucket.paragraphCount += counts.paragraphCount;
    bucket.lineSegCount += counts.lineSegCount;
    bucket.objectCount += counts.objectCount || 0;
  };

  const walkBlocks = (blocks = [], locator = {}) => {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      const blockPath = `${locator.path}/block[${blockIndex}]`;

      if (block?.type === 'paragraph') {
        const paragraphIndex = paragraphs.length;
        paragraphs.push(paragraphMetric(block, {
          ...locator,
          path: blockPath,
          paragraphIndex,
        }));
        continue;
      }

      if (isObjectBlock(block)) {
        const objectIndex = objects.length;
        objects.push(objectMetric(block, {
          ...locator,
          path: blockPath,
          objectIndex,
        }));
        if (Array.isArray(block.paragraphs)) {
          walkBlocks(block.paragraphs, {
            ...locator,
            path: `${blockPath}/paragraphs`,
          });
        }
        continue;
      }

      if (block?.type === 'table') {
        const tableIndex = tables.length;
        tables.push(buildTableMetric(block, {
          ...locator,
          path: blockPath,
          tableIndex,
        }));

        for (const row of block.rows || []) {
          for (let cellIndex = 0; cellIndex < (row.cells || []).length; cellIndex += 1) {
            const cell = row.cells[cellIndex];
            walkBlocks(cell.paragraphs || [], {
              ...locator,
              parentTableIndex: tableIndex,
              nestingDepth: (locator.nestingDepth || 0) + 1,
              path: `${blockPath}/row[${row.index}]/cell[${cellIndex}]`,
            });
          }
        }
        continue;
      }

      if (Array.isArray(block?.paragraphs)) {
        walkBlocks(block.paragraphs, {
          ...locator,
          path: blockPath,
        });
      }
    }
  };

  const parsedSections = Array.isArray(parsedBody?.sections) && parsedBody.sections.length
    ? parsedBody.sections
    : [{
      order: 0,
      paragraphs: parsedBody?.paragraphs || [],
      headerBlocks: parsedBody?.headerBlocks || [],
      footerBlocks: parsedBody?.footerBlocks || [],
      pageStyle: parsedBody?.pageStyle || null,
    }];

  parsedSections.forEach((section, sectionIndex) => {
    const before = {
      tableCount: tables.length,
      paragraphCount: paragraphs.length,
      objectCount: objects.length,
    };

    const bodyCounts = countBlocks(section.paragraphs || []);
    const headerCounts = countBlocks(section.headerBlocks || []);
    const footerCounts = countBlocks(section.footerBlocks || []);

    addCounts('body', bodyCounts);
    addCounts('header', headerCounts);
    addCounts('footer', footerCounts);

    walkBlocks(section.paragraphs || [], {
      sectionIndex,
      context: 'body',
      path: `sections[${sectionIndex}]/body`,
      parentTableIndex: null,
      nestingDepth: 0,
    });
    walkBlocks(section.headerBlocks || [], {
      sectionIndex,
      context: 'header',
      path: `sections[${sectionIndex}]/header`,
      parentTableIndex: null,
      nestingDepth: 0,
    });
    walkBlocks(section.footerBlocks || [], {
      sectionIndex,
      context: 'footer',
      path: `sections[${sectionIndex}]/footer`,
      parentTableIndex: null,
      nestingDepth: 0,
    });

    sections.push(stripEmpty({
      index: sectionIndex,
      order: section.order ?? sectionIndex,
      body: bodyCounts,
      header: headerCounts,
      footer: footerCounts,
      tableIndices: Array.from(
        { length: tables.length - before.tableCount },
        (_, offset) => before.tableCount + offset,
      ),
      paragraphIndices: Array.from(
        { length: paragraphs.length - before.paragraphCount },
        (_, offset) => before.paragraphCount + offset,
      ),
      objectIndices: Array.from(
        { length: objects.length - before.objectCount },
        (_, offset) => before.objectCount + offset,
      ),
      pageStyle: cleanJson(section.pageStyle || null),
    }));
  });

  return {
    tables,
    paragraphs,
    objects,
    sections,
    contexts,
  };
}

function aggregateParsedSignals(tables = [], paragraphs = [], objects = []) {
  const tablePageBreakPolicies = {};
  const tableSplitPolicies = {};
  const objectTypes = {};
  const objectAnchorRelTo = {};
  let repeatHeaderTableCount = 0;
  let splitTableCount = 0;
  let mergedCellCount = 0;
  let paragraphControlBreakCount = 0;
  const paragraphControlKinds = {};
  const lineSegFlagCounts = {};

  for (const table of tables) {
    increment(tablePageBreakPolicies, table.pageBreak || 'NONE');
    increment(tableSplitPolicies, table.split?.policy || 'NONE');
    if (table.repeatHeader) repeatHeaderTableCount += 1;
    if (table.split?.hasSplitSignal) splitTableCount += 1;
    mergedCellCount += Number(table.mergedCellCount) || 0;
  }

  for (const paragraph of paragraphs) {
    for (const [kind, count] of Object.entries(paragraph.controlKindCounts || {})) {
      increment(paragraphControlKinds, kind, count);
    }
    paragraphControlBreakCount += (paragraph.controls || []).filter(control => (
      /break/i.test(control.kind || '') || /break/i.test(control.controlKind || '')
    )).length;
    for (const [flag, count] of Object.entries(paragraph.lineSegSummary?.flagCounts || {})) {
      increment(lineSegFlagCounts, flag, count);
    }
  }

  for (const object of objects) {
    increment(objectTypes, object.type || 'unknown');
    increment(objectAnchorRelTo, `${object.layout?.vertRelTo || 'unknown'}/${object.layout?.horzRelTo || 'unknown'}`);
  }

  return {
    tablePageBreakPolicies: sortObjectByKey(tablePageBreakPolicies),
    tableSplitPolicies: sortObjectByKey(tableSplitPolicies),
    repeatHeaderTableCount,
    splitTableCount,
    mergedCellCount,
    objectTypes: sortObjectByKey(objectTypes),
    objectAnchorRelTo: sortObjectByKey(objectAnchorRelTo),
    paragraphControlBreakCount,
    paragraphControlKinds: sortObjectByKey(paragraphControlKinds),
    lineSegFlagCounts: sortObjectByKey(lineSegFlagCounts),
  };
}

function loadExistingParser(diagnostics) {
  if (!existsSync(PAKO_PATH)) {
    pushDiagnostic(diagnostics, 'warn', 'lib/pako.min.js not found; parser will fall back to platform DecompressionStream if available.', {
      todo: 'Restore lib/pako.min.js for deterministic Node-side HWP inflation.',
    });
  }

  const pako = existsSync(PAKO_PATH) ? require(PAKO_PATH) : undefined;
  const capturedConsole = {};
  for (const level of ['log', 'warn', 'error']) {
    capturedConsole[level] = (...args) => {
      pushDiagnostic(diagnostics, level === 'log' ? 'info' : level, formatConsole(...args), {
        source: 'existing-hwp-parser',
      });
    };
  }

  const context = vm.createContext({
    console: capturedConsole,
    pako,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
    ArrayBuffer,
    DataView,
    Promise,
    setTimeout,
    clearTimeout,
    DecompressionStream: globalThis.DecompressionStream,
    CompressionStream: globalThis.CompressionStream,
    btoa: globalThis.btoa || (value => Buffer.from(value, 'binary').toString('base64')),
    atob: globalThis.atob || (value => Buffer.from(value, 'base64').toString('binary')),
  });
  context.globalThis = context;
  context.self = context;

  for (const relativePath of PARSER_FILES) {
    const scriptPath = path.join(ROOT_DIR, relativePath);
    if (!existsSync(scriptPath)) {
      throw new Error(`required parser file not found: ${relativePath}`);
    }
    const code = readFileSync(scriptPath, 'utf8');
    vm.runInContext(code, context, { filename: relativePath });
  }

  if (!context.HwpParser) {
    throw new Error('existing parser did not register global HwpParser');
  }

  return context.HwpParser;
}

function recordTagName(tagId) {
  const names = {
    16: 'DOCUMENT_PROPERTIES',
    17: 'ID_MAPPINGS',
    18: 'BIN_DATA',
    19: 'FACE_NAME',
    20: 'BORDER_FILL',
    21: 'CHAR_SHAPE',
    22: 'TAB_DEF',
    23: 'NUMBERING',
    24: 'BULLET',
    25: 'PARA_SHAPE',
    26: 'STYLE',
    66: 'PARA_HEADER',
    67: 'PARA_TEXT',
    68: 'PARA_CHAR_SHAPE',
    69: 'PARA_LINE_SEG',
    71: 'CTRL_HEADER',
    72: 'LIST_HEADER',
    73: 'PAGE_DEF',
    74: 'FOOTNOTE_SHAPE',
    75: 'PAGE_BORDER_FILL',
    76: 'PAGE_NUM_PARA',
    77: 'TABLE',
    78: 'SHAPE_COMPONENT',
    79: 'SHAPE_COMPONENT_LINE',
    80: 'SHAPE_COMPONENT_RECTANGLE',
    81: 'SHAPE_COMPONENT_ELLIPSE',
    82: 'SHAPE_COMPONENT_ARC',
    83: 'SHAPE_COMPONENT_POLYGON',
    84: 'SHAPE_COMPONENT_OLE',
    85: 'SHAPE_COMPONENT_PICTURE',
    86: 'SHAPE_COMPONENT',
    87: 'CONTAINER',
    88: 'EQEDIT',
    89: 'CTRL_DATA',
    95: 'CHART_DATA',
    98: 'VIDEO_DATA',
    99: 'MEMO_SHAPE',
  };
  return names[tagId] || `TAG_${tagId}`;
}

function recordLocator(rec = {}, record = {}, context = {}) {
  const tagName = recordTagName(rec.tagId);
  return stripEmpty({
    recordIndex: record.recordIndex,
    offset: record.offset,
    level: rec.level,
    tagId: rec.tagId,
    tagName,
    size: rec.size,
    headerSize: Math.max(0, (rec.startPos || 0) - (record.offset || 0)),
    bodyOffset: rec.startPos,
    nextOffset: rec.nextPos,
    bodySha256: sha256Hex(rec.body).slice(0, 24),
    bodyPreviewHex: hexPreview(rec.body, 16),
    parentControls: context.parentControls || [],
  });
}

function addRecordInventory(inventory, rec = {}, record = {}, context = {}) {
  const tagName = recordTagName(rec.tagId);
  const bucket = inventory[tagName] || (inventory[tagName] = {
    tagId: rec.tagId,
    tagName,
    count: 0,
    totalBodyBytes: 0,
    levels: {},
    examples: [],
  });
  bucket.count += 1;
  bucket.totalBodyBytes += Number(rec.size) || 0;
  increment(bucket.levels, rec.level);
  if (bucket.examples.length < RECORD_EXAMPLE_LIMIT_PER_TAG) {
    bucket.examples.push(recordLocator(rec, record, context));
  }
}

function finalizeRecordInventory(inventory = {}) {
  const out = {};
  for (const [tagName, bucket] of Object.entries(inventory)) {
    out[tagName] = {
      ...bucket,
      levels: sortObjectByKey(bucket.levels || {}),
    };
  }
  return sortObjectByKey(out);
}

function isUnknownRecordTag(tagId) {
  return recordTagName(tagId).startsWith('TAG_');
}

function hasParentControl(controlStack = [], controlId = '') {
  return controlStack.some(control => control?.controlId === controlId);
}

function positiveMetrics(...values) {
  return values
    .map(value => Number(value) || 0)
    .filter(value => value > 0);
}

function objectPayloadMetric(HwpParser, rec = {}, record = {}, context = {}) {
  const metric = recordLocator(rec, record, context);
  const body = rec.body || new Uint8Array();
  if (rec.tagId === 85) {
    metric.picture = stripEmpty({
      binId: HwpParser._parseHwpPictureBinId?.(body, null) || 0,
      widthCandidates: positiveMetrics(
        HwpParser._u32(body, 52),
        HwpParser._u32(body, 20),
        HwpParser._u32(body, 28),
      ),
      heightCandidates: positiveMetrics(
        HwpParser._u32(body, 56),
        HwpParser._u32(body, 32),
        HwpParser._u32(body, 40),
      ),
      payloadTailPreviewHex: hexPreview(body.slice(Math.max(0, body.length - 24)), 24),
    });
  } else if (rec.tagId === 84 && body.length >= 24) {
    metric.ole = stripEmpty({
      attr: HwpParser._u16(body, 0),
      extentX: HwpParser._i32(body, 2),
      extentY: HwpParser._i32(body, 6),
      binId: HwpParser._u16(body, 10),
    });
  } else if (rec.tagId === 88 && body.length >= 6) {
    metric.equation = stripEmpty({
      attr: HwpParser._u32(body, 0),
      scriptLength: HwpParser._u16(body, 4),
    });
  }
  return stripEmpty(metric);
}

function compactTableInfo(tableInfo = {}, record = {}) {
  const splitPage = Number(tableInfo?.splitPage) || 0;
  return stripEmpty({
    recordIndex: record.recordIndex,
    offset: record.offset,
    level: record.level,
    rowCount: tableInfo?.rowCount,
    colCount: tableInfo?.colCount,
    cellSpacing: tableInfo?.cellSpacing,
    defaultCellPadding: cleanJson(tableInfo?.defaultCellPadding),
    rowCellCounts: cleanJson(tableInfo?.rowCellCounts || []),
    borderFillId: tableInfo?.borderFillId,
    repeatHeader: Boolean(tableInfo?.repeatHeader),
    splitPage,
    splitPolicy: pageSplitPolicy(splitPage),
    validZoneCount: tableInfo?.validZoneCount,
    validZones: cleanJson(tableInfo?.validZones || []),
    rawLayout: cleanJson({
      attr: tableInfo?.attr,
      splitPage: tableInfo?.splitPage,
      repeatHeader: Boolean(tableInfo?.repeatHeader),
      rowCellCounts: tableInfo?.rowCellCounts || [],
      borderFillId: tableInfo?.borderFillId,
      validZoneInfoSize: tableInfo?.validZoneInfoSize,
      validZones: tableInfo?.validZones || [],
      rawTailBytes: tableInfo?.rawTailBytes || [],
    }),
  });
}

function compactCellRecord(cell = {}, record = {}) {
  return stripEmpty({
    recordIndex: record.recordIndex,
    offset: record.offset,
    level: record.level,
    parentControls: record.parentControls || [],
    row: cell?.row,
    col: cell?.col,
    rowSpan: cell?.rowSpan,
    colSpan: cell?.colSpan,
    width: cell?.width,
    height: cell?.height,
    padding: cleanJson(cell?.padding),
    borderFillId: cell?.borderFillId,
    verticalAlign: cell?.verticalAlign,
    paragraphCount: cell?.paragraphCount,
    listFlags: cell?.listFlags,
  });
}

function scanRecordMetrics(HwpParser, bytes) {
  const tagCounts = {};
  const tagNameCounts = {};
  const controlCounts = {};
  const recordInventory = {};
  const unknownTagCounts = {};
  const unknownRecords = [];
  const objectControls = [];
  const objectPayloadRecords = [];
  const nonTableListHeaders = [];
  const controlStack = [];
  let unknownRecordCount = 0;
  let objectControlCount = 0;
  let objectPayloadRecordCount = 0;
  let listHeaderRecordCount = 0;
  let nonTableListHeaderCount = 0;
  const paragraphBreakTypeCounts = {
    section: 0,
    multiColumn: 0,
    page: 0,
    column: 0,
    any: 0,
  };
  const lineSegFlagCounts = {};
  const tableSplitPolicies = {};
  const tablePageBreakPolicies = {};
  const tableInfos = [];
  const cellRecords = [];
  const paragraphHeaders = [];
  let lineSegCount = 0;
  let lineSegRecordCount = 0;
  let paragraphHeaderCount = 0;
  let tableInfoCount = 0;
  let cellRecordCount = 0;
  let recordCount = 0;
  let truncated = false;
  let pos = 0;

  while (pos < bytes.length && recordCount < 500000) {
    const rec = HwpParser._readRecord(bytes, pos);
    if (!rec || rec.nextPos <= pos) break;
    const bodyEnd = rec.startPos + rec.size;
    if (bodyEnd > bytes.length) truncated = true;

    while (controlStack.length && rec.level <= controlStack[controlStack.length - 1].level) {
      controlStack.pop();
    }
    const recordLocatorContext = {
      parentControls: controlStack.map(control => `${control.controlId}@${control.recordIndex}`),
    };

    increment(tagCounts, rec.tagId);
    increment(tagNameCounts, recordTagName(rec.tagId));

    const recordRef = {
      recordIndex: recordCount,
      offset: pos,
      level: rec.level,
    };
    addRecordInventory(recordInventory, rec, recordRef, recordLocatorContext);
    if (isUnknownRecordTag(rec.tagId)) {
      increment(unknownTagCounts, rec.tagId);
      unknownRecordCount += 1;
      if (unknownRecords.length < RAW_RECORD_DETAIL_LIMIT) {
        unknownRecords.push(recordLocator(rec, recordRef, recordLocatorContext));
      }
    }
    if (OBJECT_PAYLOAD_TAG_IDS.has(rec.tagId) && controlStack.some(control => OBJECT_CONTROL_IDS.has(control.controlId))) {
      objectPayloadRecordCount += 1;
      if (objectPayloadRecords.length < RAW_RECORD_DETAIL_LIMIT) {
        objectPayloadRecords.push(objectPayloadMetric(HwpParser, rec, recordRef, recordLocatorContext));
      }
    }

    if (rec.tagId === 66) {
      const header = HwpParser._parseHwpParaHeader(rec.body);
      const breakType = decodeParagraphBreakType(header?.splitFlags || 0);
      paragraphHeaderCount += 1;
      if (breakType.raw) {
        paragraphBreakTypeCounts.any += 1;
        if (breakType.section) paragraphBreakTypeCounts.section += 1;
        if (breakType.multiColumn) paragraphBreakTypeCounts.multiColumn += 1;
        if (breakType.page) paragraphBreakTypeCounts.page += 1;
        if (breakType.column) paragraphBreakTypeCounts.column += 1;
      }
      paragraphHeaders.push(stripEmpty({
        ...recordRef,
        charCount: header?.charCount,
        controlMask: header?.controlMask,
        controlMaskHex: toHex(header?.controlMask || 0, 8),
        paraShapeId: header?.paraShapeId,
        styleId: header?.styleId,
        charShapeCount: header?.charShapeCount,
        lineAlignCount: header?.lineAlignCount,
        breakType,
      }));
    } else if (rec.tagId === 69) {
      const lineSegs = HwpParser._parseHwpParaLineSeg(rec.body);
      lineSegRecordCount += 1;
      lineSegCount += lineSegs.length;
      for (const seg of lineSegs) {
        increment(lineSegFlagCounts, toHex(seg?.flags || 0, 8));
      }
    } else if (rec.tagId === 71) {
      const controlId = HwpParser._ctrlId(rec.body) || 'unknown';
      increment(controlCounts, controlId);
      if (OBJECT_CONTROL_IDS.has(controlId)) {
        objectControlCount += 1;
        const objectInfo = HwpParser._parseHwpObjectCommon(rec.body);
        if (objectControls.length < RAW_RECORD_DETAIL_LIMIT) {
          objectControls.push(stripEmpty({
            ...recordLocator(rec, recordRef, recordLocatorContext),
            controlId,
            objectLayout: cleanJson(objectInfo),
          }));
        }
      }
      controlStack.push({
        controlId,
        level: rec.level,
        recordIndex: recordCount,
        offset: pos,
      });
    } else if (rec.tagId === 77) {
      const tableInfo = HwpParser._parseTableInfo(rec.body);
      if (tableInfo) {
        tableInfoCount += 1;
        const splitPolicy = pageSplitPolicy(tableInfo.splitPage);
        increment(tableSplitPolicies, splitPolicy);
        increment(tablePageBreakPolicies, splitPolicy);
        tableInfos.push(compactTableInfo(tableInfo, recordRef));
      }
    } else if (rec.tagId === 72) {
      listHeaderRecordCount += 1;
      if (hasParentControl(controlStack, 'tbl ')) {
        const cell = HwpParser._parseTableCell(rec.body);
        if (cell) {
          cellRecordCount += 1;
          cellRecords.push(compactCellRecord(cell, {
            ...recordRef,
            parentControls: recordLocatorContext.parentControls,
          }));
        }
      } else {
        nonTableListHeaderCount += 1;
        if (nonTableListHeaders.length < RAW_RECORD_DETAIL_LIMIT) {
          nonTableListHeaders.push(recordLocator(rec, recordRef, recordLocatorContext));
        }
      }
    }

    recordCount += 1;
    pos = rec.nextPos;
    if (truncated) break;
  }

  return {
    recordCount,
    consumedBytes: pos,
    totalBytes: bytes.length,
    truncated,
    tagCounts: sortObjectByKey(tagCounts),
    tagNameCounts: sortObjectByKey(tagNameCounts),
    controlCounts: sortObjectByKey(controlCounts),
    paragraphHeaderCount,
    paragraphBreakTypeCounts,
    paragraphHeaders,
    lineSegRecordCount,
    lineSegCount,
    lineSegFlagCounts: sortObjectByKey(lineSegFlagCounts),
    tableInfoCount,
    listHeaderRecordCount,
    cellRecordCount,
    nonTableListHeaderCount,
    nonTableListHeaders,
    tableSplitPolicies: sortObjectByKey(tableSplitPolicies),
    tablePageBreakPolicies: sortObjectByKey(tablePageBreakPolicies),
    tableInfos,
    cellRecords,
    recordInventory: finalizeRecordInventory(recordInventory),
    unknownRecordCount,
    unknownTagCounts: sortObjectByKey(unknownTagCounts),
    unknownRecords,
    objectControlCount,
    objectControls,
    objectPayloadRecordCount,
    objectPayloadRecords,
  };
}

function scoreRecordScan(scan = {}) {
  return (
    (scan.paragraphHeaderCount || 0) * 12
    + (scan.tableInfoCount || 0) * 25
    + (scan.cellRecordCount || 0) * 8
    + (scan.lineSegCount || 0) * 4
    + (scan.recordCount || 0)
    - (scan.truncated ? 200 : 0)
  );
}

async function inspectRawHwp(HwpParser, bytes, diagnostics) {
  const cfb = HwpParser._createCfbContext(bytes);
  if (!cfb) {
    pushDiagnostic(diagnostics, 'error', 'OLE/CFB container could not be parsed.', {
      todo: 'Verify this is an HWP 5.x compound document and not HWPX/legacy HWP 3.x.',
    });
    return null;
  }

  let fileHeader = null;
  let compressed = true;
  let distributed = false;
  const fileHeaderEntry = HwpParser._cfbEntryByPath(cfb, 'FileHeader');
  if (fileHeaderEntry) {
    const data = HwpParser._readCfbEntryStream(cfb, fileHeaderEntry);
    fileHeader = HwpParser._parseHwpFileHeader(data);
    compressed = fileHeader?.flags?.compressed ?? true;
    distributed = fileHeader?.flags?.distributed ?? false;
    if (fileHeader?.flags?.passwordProtected && !distributed) {
      pushDiagnostic(diagnostics, 'error', 'Password-protected HWP is not currently decoded by the existing parser.', {
        todo: 'Add a password/decryption path before table metrics can be extracted.',
      });
    }
    if (fileHeader?.flags?.drm || fileHeader?.flags?.certificateEncrypted) {
      pushDiagnostic(diagnostics, 'error', 'Encrypted/DRM HWP cannot be inspected safely with the current parser.', {
        todo: 'Surface an external Hancom conversion or a supported decryptor before fidelity metrics.',
      });
    }
  }

  let docInfo = { borderFills: {}, borderFillCount: 0 };
  const docInfoEntry = HwpParser._cfbEntryByPath(cfb, 'DocInfo');
  if (docInfoEntry) {
    try {
      const docInfoData = HwpParser._readCfbEntryStream(cfb, docInfoEntry);
      if (docInfoData?.length) {
        docInfo = await HwpParser._parseHwpDocInfoStream(docInfoData, {
          compressedHint: compressed,
          distributedHint: distributed,
        });
      }
    } catch (error) {
      pushDiagnostic(diagnostics, 'warn', `DocInfo metrics could not be decoded: ${error?.message || error}`, {
        todo: 'Border/fill names may be incomplete until DocInfo inflation succeeds.',
      });
    }
  }

  const sectionEntries = HwpParser._hwpSectionEntries(cfb, docInfo, distributed);
  const sections = [];
  for (let sectionIndex = 0; sectionIndex < sectionEntries.length; sectionIndex += 1) {
    const { number, entry, path: sectionPath } = sectionEntries[sectionIndex];
    const sectionBytes = HwpParser._readCfbEntryStream(cfb, entry);
    if (!sectionBytes?.length) {
      sections.push({
        index: sectionIndex,
        order: number,
        path: sectionPath,
        streamSize: entry?.streamSz || 0,
        diagnostics: [{ level: 'warn', message: 'Section stream is empty or unreadable.' }],
      });
      continue;
    }

    let attempts = [];
    try {
      attempts = await HwpParser._buildHwpRecordAttempts(sectionBytes, {
        compressedHint: compressed,
        distributedHint: distributed,
      });
    } catch (error) {
      pushDiagnostic(diagnostics, 'warn', `Section ${sectionPath} could not be inflated: ${error?.message || error}`, {
        todo: 'Raw stream was kept, but compressed BodyText metrics may be unavailable.',
      });
      attempts = [{ mode: 'raw', bytes: sectionBytes }];
    }

    const scannedAttempts = attempts.map(attempt => ({
      mode: attempt.mode,
      score: 0,
      metrics: scanRecordMetrics(HwpParser, attempt.bytes),
    }));
    for (const attempt of scannedAttempts) {
      attempt.score = scoreRecordScan(attempt.metrics);
    }
    scannedAttempts.sort((left, right) => right.score - left.score);
    const best = scannedAttempts[0] || null;

    sections.push(stripEmpty({
      index: sectionIndex,
      order: number,
      path: sectionPath,
      streamSize: entry?.streamSz || sectionBytes.length,
      selectedMode: best?.mode || '',
      selectedScore: best?.score || 0,
      attempts: scannedAttempts.map(attempt => ({
        mode: attempt.mode,
        score: attempt.score,
        recordCount: attempt.metrics.recordCount,
        paragraphHeaderCount: attempt.metrics.paragraphHeaderCount,
        tableInfoCount: attempt.metrics.tableInfoCount,
        listHeaderRecordCount: attempt.metrics.listHeaderRecordCount,
        cellRecordCount: attempt.metrics.cellRecordCount,
        nonTableListHeaderCount: attempt.metrics.nonTableListHeaderCount,
        lineSegCount: attempt.metrics.lineSegCount,
        truncated: attempt.metrics.truncated,
      })),
      rawRecords: best?.metrics || null,
    }));
  }

  return {
    container: {
      sectorSize: cfb.ss,
      miniCutoff: cfb.miniCutoff,
      entryCount: cfb.entries?.length || 0,
      sectionStreamCount: sectionEntries.length,
    },
    fileHeader: cleanJson(fileHeader),
    documentProperties: cleanJson(docInfo?.documentProperties || null),
    docInfoSummary: {
      borderFillCount: docInfo?.borderFillCount || 0,
      charShapeCount: docInfo?.charShapeCount || 0,
      paraShapeCount: docInfo?.paraShapeCount || 0,
      styleCount: docInfo?.styleCount || 0,
      binDataRefCount: docInfo?.binDataRefCount || 0,
    },
    sections,
  };
}

function aggregateRawSignals(raw = null) {
  const out = {
    paragraphHeaderCount: 0,
    paragraphPageBreakCount: 0,
    paragraphColumnBreakCount: 0,
    paragraphSectionBreakCount: 0,
    paragraphMultiColumnBreakCount: 0,
    tableInfoCount: 0,
    listHeaderRecordCount: 0,
    tableCellRecordCount: 0,
    nonTableListHeaderCount: 0,
    lineSegRecordCount: 0,
    lineSegCount: 0,
    tableSplitPolicies: {},
    tablePageBreakPolicies: {},
    controlCounts: {},
    tagNameCounts: {},
    lineSegFlagCounts: {},
    unknownRecordCount: 0,
    unknownTagCounts: {},
    objectControlCount: 0,
    objectPayloadRecordCount: 0,
  };

  for (const section of raw?.sections || []) {
    const records = section.rawRecords || {};
    out.paragraphHeaderCount += records.paragraphHeaderCount || 0;
    out.paragraphPageBreakCount += records.paragraphBreakTypeCounts?.page || 0;
    out.paragraphColumnBreakCount += records.paragraphBreakTypeCounts?.column || 0;
    out.paragraphSectionBreakCount += records.paragraphBreakTypeCounts?.section || 0;
    out.paragraphMultiColumnBreakCount += records.paragraphBreakTypeCounts?.multiColumn || 0;
    out.tableInfoCount += records.tableInfoCount || 0;
    out.listHeaderRecordCount += records.listHeaderRecordCount || 0;
    out.tableCellRecordCount += records.cellRecordCount || 0;
    out.nonTableListHeaderCount += records.nonTableListHeaderCount || 0;
    out.lineSegRecordCount += records.lineSegRecordCount || 0;
    out.lineSegCount += records.lineSegCount || 0;
    out.unknownRecordCount += records.unknownRecordCount || 0;
    out.objectControlCount += records.objectControlCount || 0;
    out.objectPayloadRecordCount += records.objectPayloadRecordCount || 0;

    for (const [key, value] of Object.entries(records.tableSplitPolicies || {})) increment(out.tableSplitPolicies, key, value);
    for (const [key, value] of Object.entries(records.tablePageBreakPolicies || {})) increment(out.tablePageBreakPolicies, key, value);
    for (const [key, value] of Object.entries(records.controlCounts || {})) increment(out.controlCounts, key, value);
    for (const [key, value] of Object.entries(records.tagNameCounts || {})) increment(out.tagNameCounts, key, value);
    for (const [key, value] of Object.entries(records.lineSegFlagCounts || {})) increment(out.lineSegFlagCounts, key, value);
    for (const [key, value] of Object.entries(records.unknownTagCounts || {})) increment(out.unknownTagCounts, key, value);
  }

  out.tableSplitPolicies = sortObjectByKey(out.tableSplitPolicies);
  out.tablePageBreakPolicies = sortObjectByKey(out.tablePageBreakPolicies);
  out.controlCounts = sortObjectByKey(out.controlCounts);
  out.tagNameCounts = sortObjectByKey(out.tagNameCounts);
  out.lineSegFlagCounts = sortObjectByKey(out.lineSegFlagCounts);
  out.unknownTagCounts = sortObjectByKey(out.unknownTagCounts);
  return out;
}

async function buildReport(inputPath) {
  const resolvedInputPath = path.resolve(inputPath);
  if (!existsSync(resolvedInputPath)) fail(`input file not found: ${resolvedInputPath}`);

  const diagnostics = [];
  const bytes = new Uint8Array(await readFile(resolvedInputPath));
  const HwpParser = loadExistingParser(diagnostics);
  const format = HwpParser._detectFormat(bytes, resolvedInputPath);
  if (format !== 'hwp5') {
    fail(`expected an HWP5 .hwp file, detected: ${format || 'unknown'}`);
  }

  const report = {
    filename: path.basename(resolvedInputPath),
    inputPath: resolvedInputPath,
    generatedAt: new Date().toISOString(),
    format,
    parser: {
      strategy: 'existing HwpParser VM reuse + raw record scan',
      reusedFiles: PARSER_FILES,
    },
    tableCount: 0,
    objectCount: 0,
    paragraphCount: 0,
    lineSegCount: 0,
    counts: {},
    signals: {},
    tables: [],
    objects: [],
    paragraphs: [],
    sections: [],
    raw: null,
    diagnostics,
    todos: [],
  };

  let raw = null;
  try {
    raw = await inspectRawHwp(HwpParser, bytes, diagnostics);
    report.raw = raw;
  } catch (error) {
    pushDiagnostic(diagnostics, 'error', `Raw HWP record inspection failed: ${error?.stack || error?.message || error}`, {
      todo: 'Keep existing parser changes browser-safe, then retry this CLI on the same file.',
    });
  }

  let parsedBody = null;
  try {
    parsedBody = await HwpParser._parseBodyText(bytes);
  } catch (error) {
    pushDiagnostic(diagnostics, 'error', `Existing HWP body parser failed: ${error?.stack || error?.message || error}`, {
      todo: 'Use raw.sections[].rawRecords.tableInfos as a partial fallback until full table block construction succeeds.',
    });
  }

  if (parsedBody) {
    const parsed = collectParsedMetrics(parsedBody);
    report.tables = parsed.tables;
    report.objects = parsed.objects;
    report.paragraphs = parsed.paragraphs;
    report.sections = parsed.sections;
    report.tableCount = parsed.tables.length;
    report.objectCount = parsed.objects.length;
    report.paragraphCount = parsed.paragraphs.length;
    report.lineSegCount = parsed.paragraphs.reduce((sum, paragraph) => sum + (paragraph.lineSegCount || 0), 0);
    report.counts = {
      sections: parsed.sections.length,
      tables: report.tableCount,
      objects: report.objectCount,
      objectAnchors: report.tableCount + report.objectCount,
      paragraphs: report.paragraphCount,
      lineSegs: report.lineSegCount,
      cells: parsed.tables.reduce((sum, table) => sum + (table.cellCount || 0), 0),
      contexts: parsed.contexts,
      raw: aggregateRawSignals(raw),
    };
    report.signals = {
      parsed: aggregateParsedSignals(parsed.tables, parsed.paragraphs, parsed.objects),
      raw: report.counts.raw,
    };
  } else {
    const rawSignals = aggregateRawSignals(raw);
    report.tableCount = rawSignals.tableInfoCount;
    report.objectCount = rawSignals.objectControlCount;
    report.paragraphCount = rawSignals.paragraphHeaderCount;
    report.lineSegCount = rawSignals.lineSegCount;
    report.counts = {
      sections: raw?.sections?.length || 0,
      tables: report.tableCount,
      objects: report.objectCount,
      objectAnchors: report.objectCount,
      paragraphs: report.paragraphCount,
      lineSegs: report.lineSegCount,
      cells: rawSignals.tableCellRecordCount,
      raw: rawSignals,
    };
    report.signals = { raw: rawSignals };
    report.todos.push('Parsed table blocks are unavailable; inspect raw.sections[].rawRecords.tableInfos/cellRecords for partial table metrics.');
  }

  if (!report.tables.length && raw?.sections?.some(section => section.rawRecords?.tableInfoCount > 0)) {
    report.todos.push('Raw TABLE records were found, but the existing parser did not build table blocks for them.');
  }
  if ((report.counts.raw?.paragraphPageBreakCount || 0) > 0 && !report.paragraphs.some(paragraph => paragraph.hwp?.breakType)) {
    report.todos.push('Existing paragraph blocks do not yet preserve PARA_HEADER breakType; raw paragraph break signals are reported under signals.raw.');
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReport(options.inputPath);
  const json = JSON.stringify(report, null, options.pretty ? 2 : 0);

  if (options.outputPath) {
    await writeFile(path.resolve(options.outputPath), `${json}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main().catch(error => {
  console.error(`Error: ${error?.stack || error?.message || error}`);
  process.exit(1);
});
