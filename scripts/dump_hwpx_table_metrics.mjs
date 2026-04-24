#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const JSZIP_PATH = path.join(ROOT_DIR, 'lib', 'jszip.min.js');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

const require = createRequire(import.meta.url);
const JSZip = require(JSZIP_PATH);

function printUsage() {
  console.log(`Usage:
  node scripts/dump_hwpx_table_metrics.mjs <file.hwpx> [options]

Options:
  --out <path>       Write JSON to a file instead of stdout.
  --section <path>   Limit scanning to a section XML path. May be repeated.
  --compact          Emit compact JSON instead of pretty JSON.
  --help             Show this help.`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    inputPath: '',
    outputPath: '',
    sectionFilters: [],
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
    if (arg === '--section') {
      const sectionPath = argv[index + 1] || '';
      index += 1;
      if (!sectionPath) fail('--section requires a section XML path');
      options.sectionFilters.push(normalizeZipPath(sectionPath));
      continue;
    }
    if (arg.startsWith('--section=')) {
      const sectionPath = arg.slice('--section='.length);
      if (!sectionPath) fail('--section requires a section XML path');
      options.sectionFilters.push(normalizeZipPath(sectionPath));
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

function normalizeZipPath(value = '') {
  return String(value).replace(/\\/g, '/').replace(/^\/+/, '');
}

function localName(name = '') {
  const parts = String(name).split(':');
  return parts[parts.length - 1] || '';
}

function decodeXmlEntities(value = '') {
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }
    return match;
  });
}

function coerceValue(value) {
  if (typeof value !== 'string') return value;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?(?:\d+\.\d+|\d+\.|\.\d+)$/.test(value)) return Number(value);
  return value;
}

function normalizeAttrs(attrs = {}) {
  return Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [key, coerceValue(value)]),
  );
}

function parseAttrs(source = '') {
  const attrs = {};
  const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attrPattern)) {
    attrs[localName(match[1])] = decodeXmlEntities(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseStartTag(token) {
  const trimmed = token
    .replace(/^</, '')
    .replace(/>$/, '')
    .replace(/\/\s*$/, '')
    .trim();
  const spaceIndex = trimmed.search(/\s/);
  if (spaceIndex === -1) {
    return { name: trimmed, attrSource: '' };
  }
  return {
    name: trimmed.slice(0, spaceIndex),
    attrSource: trimmed.slice(spaceIndex + 1),
  };
}

function parseXmlTree(xml = '') {
  const root = {
    name: '#document',
    localName: '#document',
    attrs: {},
    children: [],
    parent: null,
    start: 0,
    end: xml.length,
  };
  const stack = [root];
  const tagPattern = /<[^<>]+>/g;

  for (const match of xml.matchAll(tagPattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    if (/^<\?/.test(token) || /^<!/.test(token)) continue;

    const closeMatch = token.match(/^<\s*\/\s*([A-Za-z_][\w:.-]*)\s*>$/);
    if (closeMatch) {
      const closeLocalName = localName(closeMatch[1]);
      for (let index = stack.length - 1; index > 0; index -= 1) {
        const node = stack[index];
        stack.pop();
        node.end = end;
        if (node.localName === closeLocalName || node.name === closeMatch[1]) break;
      }
      continue;
    }

    const startMatch = token.match(/^<\s*([A-Za-z_][\w:.-]*)/);
    if (!startMatch) continue;

    const { name, attrSource } = parseStartTag(token);
    const parent = stack[stack.length - 1];
    const selfClosing = /\/\s*>$/.test(token);
    const node = {
      name,
      localName: localName(name),
      attrs: parseAttrs(attrSource),
      children: [],
      parent,
      start,
      startTagEnd: end,
      end: selfClosing ? end : null,
    };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function directChildren(node, wantedLocalName) {
  return (node?.children || []).filter((child) => child.localName === wantedLocalName);
}

function firstDirectChild(node, wantedLocalName) {
  return directChildren(node, wantedLocalName)[0] || null;
}

function childAttrs(node, wantedLocalName) {
  return firstDirectChild(node, wantedLocalName)?.attrs || {};
}

function numberAttr(attrs = {}, key, fallback = null) {
  const value = attrs[key];
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function presentAttrs(attrs = {}, keys = []) {
  const out = {};
  for (const key of keys) {
    if (attrs[key] != null && attrs[key] !== '') {
      out[key] = coerceValue(attrs[key]);
    }
  }
  return out;
}

function countDescendants(node, wantedLocalName) {
  if (!node) return 0;
  let count = 0;
  const stack = [...(node.children || [])];
  while (stack.length) {
    const current = stack.pop();
    if (current.localName === wantedLocalName) count += 1;
    stack.push(...(current.children || []));
  }
  return count;
}

function collectDescendants(node, wantedLocalName, out = []) {
  for (const child of node.children || []) {
    if (child.localName === wantedLocalName) out.push(child);
    collectDescendants(child, wantedLocalName, out);
  }
  return out;
}

function nearestAncestor(node, wantedLocalName) {
  let current = node?.parent || null;
  while (current) {
    if (current.localName === wantedLocalName) return current;
    current = current.parent;
  }
  return null;
}

function tableContext(node) {
  let current = node?.parent || null;
  while (current && current.localName !== '#document') {
    if (current.localName === 'header' || current.localName === 'footer') {
      return current.localName;
    }
    current = current.parent;
  }
  return 'body';
}

function isBreakEnabled(value) {
  return value != null && value !== '' && String(value) !== '0';
}

function paragraphBreakMetrics(paragraphs = []) {
  const breaks = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const pageBreak = paragraph.attrs.pageBreak;
    const columnBreak = paragraph.attrs.columnBreak;
    if (isBreakEnabled(pageBreak) || isBreakEnabled(columnBreak)) {
      breaks.push({
        paragraphIndex,
        pageBreak: coerceValue(pageBreak ?? ''),
        columnBreak: coerceValue(columnBreak ?? ''),
      });
    }
  });
  return breaks;
}

function buildCellMetrics(cellNode, rowIndex, cellIndex) {
  const cellAttrs = normalizeAttrs(cellNode.attrs);
  const cellAddrAttrs = childAttrs(cellNode, 'cellAddr');
  const cellSpanAttrs = childAttrs(cellNode, 'cellSpan');
  const cellSizeAttrs = childAttrs(cellNode, 'cellSz');
  const cellMarginAttrs = childAttrs(cellNode, 'cellMargin');
  const subListNode = firstDirectChild(cellNode, 'subList');
  const subListAttrs = subListNode?.attrs || {};
  const paragraphs = directChildren(subListNode, 'p');
  const breaks = paragraphBreakMetrics(paragraphs);

  const width = numberAttr(cellSizeAttrs, 'width');
  const height = numberAttr(cellSizeAttrs, 'height');
  const rowAddress = numberAttr(cellAddrAttrs, 'rowAddr', rowIndex);
  const colAddress = numberAttr(cellAddrAttrs, 'colAddr', cellIndex);
  const colSpan = numberAttr(cellSpanAttrs, 'colSpan', 1);
  const rowSpan = numberAttr(cellSpanAttrs, 'rowSpan', 1);

  return {
    index: cellIndex,
    rowIndex,
    row: rowAddress,
    col: colAddress,
    colSpan,
    rowSpan,
    width,
    height,
    attrs: cellAttrs,
    cellAddr: normalizeAttrs(cellAddrAttrs),
    cellSpan: normalizeAttrs(cellSpanAttrs),
    cellSz: normalizeAttrs(cellSizeAttrs),
    cellMargin: normalizeAttrs(cellMarginAttrs),
    subList: {
      attrs: normalizeAttrs(subListAttrs),
      textWidth: numberAttr(subListAttrs, 'textWidth'),
      textHeight: numberAttr(subListAttrs, 'textHeight'),
      paragraphCount: paragraphs.length,
      pageBreakParagraphCount: breaks.filter((entry) => isBreakEnabled(entry.pageBreak)).length,
      columnBreakParagraphCount: breaks.filter((entry) => isBreakEnabled(entry.columnBreak)).length,
      paragraphBreaks: breaks,
    },
    subListParagraphCount: paragraphs.length,
    nestedTableCount: Math.max(0, countDescendants(subListNode, 'tbl')),
  };
}

function buildTableMetrics(tableNode, tableIndex, sectionIndex, sectionTableIndex, xmlPath, tableIndexByNode) {
  const tableAttrs = normalizeAttrs(tableNode.attrs);
  const rowNodes = directChildren(tableNode, 'tr');
  const parentTable = nearestAncestor(tableNode, 'tbl');
  const paragraphBreaks = [];

  const rows = rowNodes.map((rowNode, rowIndex) => {
    const cells = directChildren(rowNode, 'tc').map((cellNode, cellIndex) => {
      const cell = buildCellMetrics(cellNode, rowIndex, cellIndex);
      for (const paragraphBreak of cell.subList.paragraphBreaks) {
        paragraphBreaks.push({
          rowIndex,
          cellIndex,
          ...paragraphBreak,
        });
      }
      return cell;
    });
    const rowHeights = cells
      .map((cell) => cell.height)
      .filter((height) => Number.isFinite(height));
    return {
      index: rowIndex,
      attrs: normalizeAttrs(rowNode.attrs),
      cellCount: cells.length,
      height: rowHeights.length ? Math.max(...rowHeights) : null,
      cellHeights: cells.map((cell) => cell.height),
      cells,
    };
  });

  const cells = rows.flatMap((row) => row.cells);
  const headerCells = cells.filter((cell) => isBreakEnabled(cell.attrs.header));
  const tableSizeAttrs = childAttrs(tableNode, 'sz');

  return {
    index: tableIndex,
    sectionIndex,
    sectionTableIndex,
    xmlPath,
    context: tableContext(tableNode),
    nestingDepth: countTableAncestors(tableNode),
    parentTableIndex: parentTable ? tableIndexByNode.get(parentTable) ?? null : null,
    id: tableAttrs.id ?? null,
    attrs: tableAttrs,
    pagination: {
      ...presentAttrs(tableNode.attrs, ['pageBreak', 'repeatHeader', 'noAdjust']),
      headerCellCount: headerCells.length,
      paragraphPageBreakCount: paragraphBreaks.filter((entry) => isBreakEnabled(entry.pageBreak)).length,
      paragraphColumnBreakCount: paragraphBreaks.filter((entry) => isBreakEnabled(entry.columnBreak)).length,
      paragraphBreaks,
    },
    declaredRowCount: numberAttr(tableNode.attrs, 'rowCnt'),
    declaredColCount: numberAttr(tableNode.attrs, 'colCnt'),
    rowCount: rows.length,
    cellCount: cells.length,
    rowHeights: rows.map((row) => row.height),
    tableSize: {
      attrs: normalizeAttrs(tableSizeAttrs),
      width: numberAttr(tableSizeAttrs, 'width'),
      height: numberAttr(tableSizeAttrs, 'height'),
    },
    position: normalizeAttrs(childAttrs(tableNode, 'pos')),
    outMargin: normalizeAttrs(childAttrs(tableNode, 'outMargin')),
    inMargin: normalizeAttrs(childAttrs(tableNode, 'inMargin')),
    rows,
  };
}

function countTableAncestors(node) {
  let count = 0;
  let current = node?.parent || null;
  while (current) {
    if (current.localName === 'tbl') count += 1;
    current = current.parent;
  }
  return count;
}

function zipFindFile(zip, requestedPath) {
  const normalized = normalizeZipPath(requestedPath);
  if (zip.files[normalized]) return normalized;
  const lower = normalized.toLowerCase();
  return Object.keys(zip.files).find((key) => normalizeZipPath(key).toLowerCase() === lower) || null;
}

function naturalSectionPaths(zip) {
  return Object.keys(zip.files)
    .filter((key) => !zip.files[key].dir && /(?:^|\/)Contents\/section\d+\.xml$/i.test(normalizeZipPath(key)))
    .sort((a, b) => {
      const ai = Number((a.match(/section(\d+)\.xml$/i) || [])[1] || 0);
      const bi = Number((b.match(/section(\d+)\.xml$/i) || [])[1] || 0);
      return ai - bi;
    });
}

async function orderedSectionPaths(zip) {
  const naturalPaths = naturalSectionPaths(zip);
  const contentPath = zipFindFile(zip, 'Contents/content.hpf');
  if (!contentPath) return naturalPaths;

  try {
    const xml = await zip.files[contentPath].async('string');
    const itemById = new Map();
    for (const match of xml.matchAll(/<[^:>\s]*:?item\b([^>]*)>/gi)) {
      const attrs = parseAttrs(match[1]);
      const href = attrs.href || attrs['full-path'];
      if (attrs.id && href) itemById.set(attrs.id, normalizeZipPath(href));
    }

    const ordered = [];
    for (const match of xml.matchAll(/<[^:>\s]*:?itemref\b([^>]*)>/gi)) {
      const attrs = parseAttrs(match[1]);
      const href = itemById.get(attrs.idref);
      if (!href || !/section\d+\.xml$/i.test(href)) continue;
      const requested = /^Contents\//i.test(href) ? href : `Contents/${href}`;
      const key = zipFindFile(zip, requested);
      if (key && !ordered.includes(key)) ordered.push(key);
    }

    for (const key of naturalPaths) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    return ordered.length ? ordered : naturalPaths;
  } catch {
    return naturalPaths;
  }
}

async function buildReport(inputPath, sectionFilters = []) {
  const resolvedInputPath = path.resolve(inputPath);
  if (!existsSync(resolvedInputPath)) fail(`input file not found: ${resolvedInputPath}`);
  if (!existsSync(JSZIP_PATH)) fail(`JSZip bundle not found: ${JSZIP_PATH}`);

  const buffer = await readFile(resolvedInputPath);
  const zip = await JSZip.loadAsync(buffer);
  let sectionPaths = await orderedSectionPaths(zip);

  if (sectionFilters.length) {
    const selected = [];
    for (const sectionFilter of sectionFilters) {
      const key = zipFindFile(zip, sectionFilter);
      if (!key) fail(`section XML not found in package: ${sectionFilter}`);
      selected.push(key);
    }
    sectionPaths = selected;
  }
  if (!sectionPaths.length) fail('no Contents/section*.xml files found in package');

  const tables = [];
  const sections = [];

  for (let sectionIndex = 0; sectionIndex < sectionPaths.length; sectionIndex += 1) {
    const xmlPath = sectionPaths[sectionIndex];
    const xml = await zip.files[xmlPath].async('string');
    const tree = parseXmlTree(xml);
    const tableNodes = collectDescendants(tree, 'tbl');
    const tableIndexByNode = new Map(
      tableNodes.map((tableNode, sectionTableIndex) => [tableNode, tables.length + sectionTableIndex]),
    );

    const sectionTableIndices = [];
    tableNodes.forEach((tableNode, sectionTableIndex) => {
      const tableIndex = tables.length;
      sectionTableIndices.push(tableIndex);
      tables.push(buildTableMetrics(
        tableNode,
        tableIndex,
        sectionIndex,
        sectionTableIndex,
        xmlPath,
        tableIndexByNode,
      ));
    });

    sections.push({
      index: sectionIndex,
      xmlPath,
      tableCount: tableNodes.length,
      tableIndices: sectionTableIndices,
    });
  }

  return {
    source: resolvedInputPath,
    generatedAt: new Date().toISOString(),
    dependencies: {
      jszip: {
        source: path.relative(ROOT_DIR, JSZIP_PATH),
        version: JSZip.version || null,
      },
      packageJsonPresent: existsSync(PACKAGE_JSON_PATH),
    },
    sectionCount: sections.length,
    tableCount: tables.length,
    sections,
    tables,
  };
}

const options = parseArgs(process.argv.slice(2));
const report = await buildReport(options.inputPath, options.sectionFilters);
const json = options.pretty
  ? `${JSON.stringify(report, null, 2)}\n`
  : JSON.stringify(report);

if (options.outputPath) {
  await writeFile(path.resolve(options.outputPath), json);
} else {
  process.stdout.write(json);
}
