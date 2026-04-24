#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const DEFAULT_SAMPLE = path.join(process.env.HOME || '', 'Downloads', '(공고문)인천가정2A-.hwpx');
const SAMPLE_PATH = process.env.HWPX_SAMPLE || DEFAULT_SAMPLE;
const OUTPUT_PATH = process.env.HWPX_LAYOUT_FIXTURE_OUT
  || path.join(ROOT_DIR, 'output', 'playwright', 'incheon-2a-layout-fixture.json');

if (!existsSync(SAMPLE_PATH)) {
  throw new Error(`HWPX sample not found: ${SAMPLE_PATH}`);
}

function unzipText(entry) {
  return execFileSync('unzip', ['-p', SAMPLE_PATH, entry], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function attrs(source = '') {
  const out = {};
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    const key = match[1].replace(/^.*:/, '');
    const value = match[2];
    out[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

function firstAttrs(xml = '', tagName = '') {
  const match = xml.match(new RegExp(`<[^:>]*:?${tagName}\\b([^>]*)>`, 'i'));
  return match ? attrs(match[1]) : {};
}

function textLength(xml = '') {
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

const sectionXml = unzipText('Contents/section0.xml');
const lineSegs = Array.from(sectionXml.matchAll(/<[^:>]*:?lineseg\b([^>]*)\/>/gi))
  .map((match, index) => ({ index, ...attrs(match[1]) }));

const rows = [];
let rowIndex = 0;
for (const rowMatch of sectionXml.matchAll(/<[^:>]*:?tr\b[^>]*>([\s\S]*?)<\/[^:>]*:?tr>/gi)) {
  const rowXml = rowMatch[1];
  const cells = [];
  let cellIndex = 0;
  for (const cellMatch of rowXml.matchAll(/<[^:>]*:?tc\b([^>]*)>([\s\S]*?)<\/[^:>]*:?tc>/gi)) {
    const cellXml = cellMatch[2];
    const size = firstAttrs(cellXml, 'cellSz');
    const subList = firstAttrs(cellXml, 'subList');
    const span = firstAttrs(cellXml, 'cellSpan');
    const address = firstAttrs(cellXml, 'cellAddr');
    const paragraphCount = (cellXml.match(/<[^:>]*:?p\b/gi) || []).length;
    const nestedTableCount = Math.max(0, (cellXml.match(/<[^:>]*:?tbl\b/gi) || []).length - 1);
    cells.push({
      cellIndex,
      col: Number(address.colAddr) || 0,
      row: Number(address.rowAddr) || rowIndex,
      colSpan: Number(span.colSpan) || 1,
      rowSpan: Number(span.rowSpan) || 1,
      width: Number(size.width) || 0,
      height: Number(size.height) || 0,
      subListTextWidth: Number(subList.textWidth) || 0,
      subListTextHeight: Number(subList.textHeight) || 0,
      paragraphCount,
      nestedTableCount,
      textLength: textLength(cellXml),
    });
    cellIndex += 1;
  }
  if (cells.length) {
    rows.push({
      rowIndex,
      cellCount: cells.length,
      maxCellHeight: Math.max(...cells.map(cell => cell.height || 0)),
      maxSubListTextHeight: Math.max(...cells.map(cell => cell.subListTextHeight || 0)),
      paragraphCount: cells.reduce((sum, cell) => sum + cell.paragraphCount, 0),
      nestedTableCount: cells.reduce((sum, cell) => sum + cell.nestedTableCount, 0),
      textLength: cells.reduce((sum, cell) => sum + cell.textLength, 0),
      cells,
    });
  }
  rowIndex += 1;
}

const tallRows = rows
  .slice()
  .sort((a, b) => (
    Math.max(b.maxCellHeight, b.maxSubListTextHeight) - Math.max(a.maxCellHeight, a.maxSubListTextHeight)
    || b.textLength - a.textLength
  ))
  .slice(0, 20);

const fixture = {
  source: SAMPLE_PATH,
  section: 'Contents/section0.xml',
  generatedAt: new Date().toISOString(),
  purpose: 'Focused raw HWPX layout fixture for TotalDocs table/cell continuation work.',
  lineSegSummary: {
    count: lineSegs.length,
    first: lineSegs.slice(0, 12),
    maxVertSize: Math.max(0, ...lineSegs.map(seg => Number(seg.vertsize) || 0)),
    maxTextHeight: Math.max(0, ...lineSegs.map(seg => Number(seg.textheight) || 0)),
    maxHorzSize: Math.max(0, ...lineSegs.map(seg => Number(seg.horzsize) || 0)),
  },
  rowSummary: {
    scannedRows: rows.length,
    tallRows,
  },
};

mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote HWPX layout fixture: ${OUTPUT_PATH}`);
