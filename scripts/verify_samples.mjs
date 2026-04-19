#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const PWCLI = process.env.PWCLI || path.join(CODEX_HOME, 'skills', 'playwright', 'scripts', 'playwright_cli.sh');
const VIEWER_URL = process.env.VIEWER_URL || 'http://127.0.0.1:4173/pages/viewer.html';
const VIEWER_FONT_OVERRIDES = process.env.VIEWER_FONT_OVERRIDES || '';
const SESSION_NAME = process.env.PLAYWRIGHT_CLI_SESSION || 'verify-current';
const SAMPLE_DIR = path.join(ROOT_DIR, 'output', 'playwright', 'inputs');
const DOWNLOADS_DIR = process.env.HWP_DOWNLOADS_DIR || path.join(process.env.HOME || '', 'Downloads');
const SERVED_INPUT_DIR = process.env.VERIFY_SERVED_INPUT_DIR
  || path.join(ROOT_DIR, 'output', 'playwright', 'served-inputs');
const SCREENSHOT_DIR = process.env.VERIFY_SCREENSHOT_DIR
  || path.join(ROOT_DIR, 'output', 'playwright', 'qa-snapshots');
const REPORT_PATH = process.env.VERIFY_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-report.json');
const HOTSPOT_REPORT_PATH = process.env.VERIFY_HOTSPOT_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-hotspots.md');
const INVENTORY_REPORT_PATH = process.env.VERIFY_INVENTORY_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-inventory.md');
const HANCOM_ORACLE_BASELINE_PATH = process.env.HANCOM_ORACLE_BASELINE_PATH
  || path.join(ROOT_DIR, 'docs', 'hancom-oracle-page-baseline.json');
const MAX_SESSION_RETRIES = Number(process.env.PLAYWRIGHT_SESSION_RETRIES || 6);
const RETRY_BASE_DELAY_MS = 250;
const LOAD_TIMEOUT_MS = Number(process.env.VERIFY_LOAD_TIMEOUT_MS || 20000);
const SCROLL_SETTLE_MS = Number(process.env.VERIFY_SCROLL_SETTLE_MS || 350);
const STRICT_PAGE_EXPECTATIONS = process.env.STRICT_PAGE_EXPECTATIONS === '1';
const CAPTURE_SCREENSHOTS = process.env.VERIFY_SCREENSHOTS !== '0';
const SESSION_ARGS = [`-s=${SESSION_NAME}`];
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(['.hwp', '.hwpx', '.owpml']);

function preferExistingPath(...candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates.find(Boolean) || '';
}

const GOYEOPJE_DOWNLOAD_SAMPLE = path.join(DOWNLOADS_DIR, '고엽제등록신청서.hwp');
const GOYEOPJE_FULL_DOWNLOAD_SAMPLE = path.join(DOWNLOADS_DIR, '231229 고엽제후유(의)증환자 등 등록신청서 일체(2024.1.1. 기준).hwp');
const GYEOLSEOKGYE_DOWNLOAD_SAMPLE = path.join(DOWNLOADS_DIR, '결석계.hwp');
const HWPX_DOWNLOAD_SAMPLE = path.join(DOWNLOADS_DIR, '(공고문)인천가정2A-.hwpx');
const ATTACHMENT_DOWNLOAD_SAMPLE = path.join(DOWNLOADS_DIR, '(첨부)정정_공고문_신축다세대잔여세대선착순일반매각.hwp');

const GOYEOPJE_SAMPLE = process.env.GOYEOPJE_SAMPLE
  || preferExistingPath(GOYEOPJE_DOWNLOAD_SAMPLE, path.join(SAMPLE_DIR, 'goyeopje.hwp'));
const GOYEOPJE_FULL_SAMPLE = process.env.GOYEOPJE_FULL_SAMPLE
  || preferExistingPath(GOYEOPJE_FULL_DOWNLOAD_SAMPLE, path.join(SAMPLE_DIR, 'goyeopje-full-2024.hwp'));
const GYEOLSEOKGYE_SAMPLE = process.env.GYEOLSEOKGYE_SAMPLE
  || preferExistingPath(GYEOLSEOKGYE_DOWNLOAD_SAMPLE, path.join(SAMPLE_DIR, 'gyeolseokgye.hwp'));
const HWPX_SAMPLE = process.env.HWPX_SAMPLE
  || preferExistingPath(HWPX_DOWNLOAD_SAMPLE, path.join(SAMPLE_DIR, 'incheon-2a.hwpx'));
const ATTACHMENT_HWP_SAMPLE = process.env.ATTACHMENT_HWP_SAMPLE
  || preferExistingPath(ATTACHMENT_DOWNLOAD_SAMPLE, path.join(SAMPLE_DIR, 'attachment-sale-notice.hwp'));

const BASE_SAMPLE_DEFS = [
  {
    id: 'goyeopje',
    filePath: GOYEOPJE_SAMPLE,
    filename: 'goyeopje.hwp',
    keywords: ['등록신청서', '처리기간', '고엽제후유'],
  },
  {
    id: 'goyeopje-full-2024',
    filePath: GOYEOPJE_FULL_SAMPLE,
    filename: 'goyeopje-full-2024.hwp',
    keywords: ['등록신청서', '처리기간', '복무기록'],
  },
  {
    id: 'gyeolseokgye',
    filePath: GYEOLSEOKGYE_SAMPLE,
    filename: 'gyeolseokgye.hwp',
    keywords: ['결석계'],
  },
  {
    id: 'attachment-sale-notice',
    filePath: ATTACHMENT_HWP_SAMPLE,
    filename: 'attachment-sale-notice.hwp',
    keywords: ['알려드립니다', '선착순 일반매각', '동·호지정 및 계약체결'],
  },
  {
    id: 'incheon-2a',
    filePath: HWPX_SAMPLE,
    filename: 'incheon-2a.hwpx',
    keywords: ['신혼희망타운', '추가 입주자모집공고', '공급위치', '공급대상'],
  },
];

function isSupportedDocumentFilename(filename = '') {
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());
}

function slugifySampleId(value = '') {
  const normalized = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .toLowerCase();
  return normalized || 'downloads-sample';
}

function ensureUniqueSampleId(baseId, usedIds) {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  let index = 2;
  while (usedIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  const nextId = `${baseId}-${index}`;
  usedIds.add(nextId);
  return nextId;
}

function discoverDownloadsDocuments() {
  if (!existsSync(DOWNLOADS_DIR)) {
    return [];
  }

  return readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSupportedDocumentFilename(entry.name))
    .map((entry) => path.join(DOWNLOADS_DIR, entry.name))
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

function buildSampleDefinitions() {
  const samples = BASE_SAMPLE_DEFS.map((sample) => ({
    ...sample,
    sampleKind: 'known',
  }));
  const usedIds = new Set(samples.map((sample) => sample.id));
  const knownPaths = new Set(samples.map((sample) => path.resolve(sample.filePath)));

  for (const filePath of discoverDownloadsDocuments()) {
    const resolvedPath = path.resolve(filePath);
    if (knownPaths.has(resolvedPath)) continue;

    const filename = path.basename(filePath);
    const id = ensureUniqueSampleId(
      slugifySampleId(path.basename(filename, path.extname(filename))),
      usedIds,
    );

    samples.push({
      id,
      filePath,
      filename,
      keywords: [],
      sampleKind: 'downloads-auto',
    });
  }

  return samples;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function loadHancomOracleBaseline() {
  if (!existsSync(HANCOM_ORACLE_BASELINE_PATH)) {
    return new Map();
  }
  try {
    const payload = JSON.parse(readFileSync(HANCOM_ORACLE_BASELINE_PATH, 'utf8'));
    const docs = payload?.documents || {};
    return new Map(Object.entries(docs)
      .map(([id, entry]) => [id, {
        pageCount: Number(entry?.hancomPageCount),
        evidence: entry?.evidence || '',
      }])
      .filter(([, entry]) => Number.isFinite(entry.pageCount) && entry.pageCount > 0));
  } catch (error) {
    fail(`한컴 기준선 파일 파싱 실패: ${HANCOM_ORACLE_BASELINE_PATH}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} 파일을 찾지 못했습니다: ${filePath}`);
  }
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object' && typeof Atomics.wait === 'function') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  }
  execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${Math.ceil(ms)})`], { stdio: 'ignore' });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableSessionError(output = '') {
  const normalized = String(output).toLowerCase();
  return normalized.includes(`connect enoent ${SESSION_NAME.toLowerCase()}`)
    || (normalized.includes('session ') && normalized.includes(' not found'))
    || normalized.includes('target page, context or browser has been closed');
}

function runPw(args, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 0;
  const throwOnError = options.throwOnError === true;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return execFileSync(PWCLI, [...SESSION_ARGS, ...args], {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          CODEX_HOME,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = error?.stderr?.toString?.() || '';
      const stdout = error?.stdout?.toString?.() || '';
      const details = `${stdout}\n${stderr}`.trim();
      if (attempt < retries && isRetryableSessionError(details)) {
        sleepSync(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      if (throwOnError) {
        const wrapped = new Error(`Playwright 명령 실패: ${args.join(' ')}\n${details}`.trim());
        wrapped.cause = error;
        throw wrapped;
      }
      fail(`Playwright 명령 실패: ${args.join(' ')}\n${details}`.trim());
    }
  }
  return '';
}

function extractResult(output) {
  const text = String(output || '');
  const match = text.match(/### Result\s+([\s\S]*?)### Ran Playwright code/);
  return (match ? match[1] : text).trim();
}

function parsePlaywrightValue(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const first = JSON.parse(trimmed);
    if (typeof first === 'string') {
      try {
        return JSON.parse(first);
      } catch {
        return first;
      }
    }
    return first;
  } catch {
    return trimmed;
  }
}

function evalPage(expression) {
  const result = runPw(['eval', expression], { retries: MAX_SESSION_RETRIES });
  return parsePlaywrightValue(extractResult(result));
}

function parseConsoleCount(output, key) {
  const match = String(output || '').match(new RegExp(`${key}:\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : 0;
}

function toServedUrl(filePath) {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  const relative = path.relative(ROOT_DIR, filePath);
  if (!relative || relative.startsWith('..')) {
    fail(`뷰어가 직접 fetch할 수 없는 경로입니다. 저장소 내부 경로 또는 http(s) URL을 사용해야 합니다: ${filePath}`);
  }
  const encodedPath = relative
    .split(path.sep)
    .map(part => encodeURIComponent(part))
    .join('/');
  return new URL(encodedPath, `${VIEWER_URL.replace(/\/pages\/viewer\.html.*$/, '/')}`).toString();
}

function buildViewerUrl(servedUrl) {
  const target = new URL(VIEWER_URL);
  target.searchParams.set('hwpUrl', servedUrl);
  if (VIEWER_FONT_OVERRIDES) {
    target.searchParams.set('fontOverrides', VIEWER_FONT_OVERRIDES);
  }
  return target.toString();
}

function resolveSampleAccess(sample) {
  const sourcePath = sample.filePath;
  if (/^https?:\/\//i.test(sourcePath)) {
    return {
      sourcePath,
      servedPath: sourcePath,
      servedUrl: sourcePath,
      sourceKind: 'url',
      copiedFromSource: false,
    };
  }

  const relative = path.relative(ROOT_DIR, sourcePath);
  if (relative && !relative.startsWith('..')) {
    return {
      sourcePath,
      servedPath: sourcePath,
      servedUrl: toServedUrl(sourcePath),
      sourceKind: sourcePath.startsWith(DOWNLOADS_DIR) ? 'downloads' : 'workspace',
      copiedFromSource: false,
    };
  }

  mkdirSync(SERVED_INPUT_DIR, { recursive: true });
  const servedPath = path.join(SERVED_INPUT_DIR, sample.filename);
  copyFileSync(sourcePath, servedPath);
  return {
    sourcePath,
    servedPath,
    servedUrl: toServedUrl(servedPath),
    sourceKind: sourcePath.startsWith(DOWNLOADS_DIR) ? 'downloads' : 'external-local',
    copiedFromSource: true,
  };
}

function captureCurrentPageScreenshot(sampleId) {
  if (!CAPTURE_SCREENSHOTS) return null;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const screenshotPath = path.join(SCREENSHOT_DIR, `${sampleId}.png`);
  const output = runPw(['screenshot'], { retries: MAX_SESSION_RETRIES, throwOnError: true });
  const match = String(output || '').match(/\[Screenshot of [^\]]+\]\(([^)]+\.png)\)/);
  if (!match) {
    throw new Error(`Playwright 스크린샷 경로를 파싱하지 못했사옵니다.\n${output}`);
  }
  const sourcePath = path.resolve(ROOT_DIR, match[1]);
  if (!existsSync(sourcePath)) {
    throw new Error(`Playwright 스크린샷 파일이 존재하지 않사옵니다: ${sourcePath}`);
  }
  copyFileSync(sourcePath, screenshotPath);
  return screenshotPath;
}

function parsePageCount(pageInfo) {
  const match = String(pageInfo || '').match(/(\d+)\s*\/\s*(\d+)\s*쪽/);
  return match ? Number(match[2]) : 0;
}

function toFiniteCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getPageCounts(page = {}) {
  const counts = page?.counts || {};
  return {
    controls: toFiniteCount(page?.controlCount ?? counts.controls),
    tables: toFiniteCount(counts.tables),
    pictures: toFiniteCount(counts.pictures),
    equations: toFiniteCount(counts.equations),
    charts: toFiniteCount(counts.charts),
    forms: toFiniteCount(counts.forms),
    shapes: toFiniteCount(counts.shapes),
    oles: toFiniteCount(counts.oles),
    videos: toFiniteCount(counts.videos),
    textRuns: toFiniteCount(page?.textRunCount ?? counts.textRuns),
  };
}

function getLayoutSignals(source = {}) {
  return {
    floatingTables: toFiniteCount(source.floatingTables),
    floatingPictures: toFiniteCount(source.floatingPictures),
    wrappedControls: toFiniteCount(source.wrappedControls),
    overlapAllowed: toFiniteCount(source.overlapAllowed),
    keepWithAnchor: toFiniteCount(source.keepWithAnchor),
    repeatHeaderTables: toFiniteCount(source.repeatHeaderTables),
    pageBreakTables: toFiniteCount(source.pageBreakTables),
    pageAnchoredControls: toFiniteCount(source.pageAnchoredControls),
    columnAnchoredControls: toFiniteCount(source.columnAnchoredControls),
    paragraphAnchoredControls: toFiniteCount(source.paragraphAnchoredControls),
    mergedCells: toFiniteCount(source.mergedCells),
    tallCells: toFiniteCount(source.tallCells),
    captionedPictures: toFiniteCount(source.captionedPictures),
    croppedPictures: toFiniteCount(source.croppedPictures),
    rotatedPictures: toFiniteCount(source.rotatedPictures),
    flippedPictures: toFiniteCount(source.flippedPictures),
  };
}

function buildMetricLabels(counts = {}) {
  const labels = [];
  if (counts.controls > 0) labels.push(`제어 ${counts.controls}`);
  if (counts.tables > 0) labels.push(`표 ${counts.tables}`);
  if (counts.pictures > 0) labels.push(`그림 ${counts.pictures}`);
  if (counts.equations > 0) labels.push(`수식 ${counts.equations}`);
  if (counts.charts > 0) labels.push(`차트 ${counts.charts}`);
  const otherObjects = counts.forms + counts.shapes + counts.oles + counts.videos;
  if (otherObjects > 0) labels.push(`개체 ${otherObjects}`);
  if (counts.textRuns > 0) labels.push(`텍스트 ${counts.textRuns}`);
  return labels;
}

function buildSignalLabels(source = {}) {
  const signals = getLayoutSignals(source);
  const labels = [];
  if (signals.floatingTables > 0) labels.push(`부동표 ${signals.floatingTables}`);
  if (signals.floatingPictures > 0) labels.push(`부동그림 ${signals.floatingPictures}`);
  if (signals.repeatHeaderTables > 0) labels.push(`반복머리행 ${signals.repeatHeaderTables}`);
  if (signals.pageBreakTables > 0) labels.push(`셀나눔 ${signals.pageBreakTables}`);
  if (signals.overlapAllowed > 0) labels.push(`겹침허용 ${signals.overlapAllowed}`);
  if (signals.keepWithAnchor > 0) labels.push(`anchor고정 ${signals.keepWithAnchor}`);
  if (signals.pageAnchoredControls > 0) labels.push(`쪽기준 ${signals.pageAnchoredControls}`);
  if (signals.columnAnchoredControls > 0) labels.push(`단기준 ${signals.columnAnchoredControls}`);
  if (signals.paragraphAnchoredControls > 0) labels.push(`문단기준 ${signals.paragraphAnchoredControls}`);
  if (signals.mergedCells > 0) labels.push(`병합셀 ${signals.mergedCells}`);
  if (signals.tallCells > 0) labels.push(`큰셀 ${signals.tallCells}`);
  if (signals.captionedPictures > 0) labels.push(`캡션 ${signals.captionedPictures}`);
  if (signals.croppedPictures > 0) labels.push(`자르기 ${signals.croppedPictures}`);
  if (signals.rotatedPictures > 0) labels.push(`회전 ${signals.rotatedPictures}`);
  if (signals.flippedPictures > 0) labels.push(`반전 ${signals.flippedPictures}`);
  if (signals.wrappedControls > 0) labels.push(`본문배치 ${signals.wrappedControls}`);
  return labels;
}

function buildReportHotspots(diagnostics, limit = 5) {
  const pages = Array.isArray(diagnostics?.pages) ? diagnostics.pages : [];
  return pages
    .map((page) => {
      const counts = getPageCounts(page);
      const signals = getLayoutSignals(page?.layoutSignals || {});
      const objectLoad = counts.tables + counts.pictures + counts.equations + counts.charts
        + counts.forms + counts.shapes + counts.oles + counts.videos;
      const layoutRisk = (signals.floatingTables * 220)
        + (signals.floatingPictures * 180)
        + (signals.repeatHeaderTables * 140)
        + (signals.pageBreakTables * 160)
        + (signals.overlapAllowed * 180)
        + (signals.keepWithAnchor * 70)
        + (signals.pageAnchoredControls * 110)
        + (signals.columnAnchoredControls * 80)
        + (signals.mergedCells * 3)
        + (signals.tallCells * 18)
        + (signals.croppedPictures * 50)
        + (signals.rotatedPictures * 30)
        + (signals.flippedPictures * 30);
      const score = (counts.controls * 1000)
        + (objectLoad * 100)
        + layoutRisk
        + (counts.textRuns === 0 && counts.controls > 0 ? 75 : Math.min(counts.textRuns, 400) / 4);
      return {
        pageIndex: Number.isFinite(page?.pageIndex) ? page.pageIndex : 0,
        score,
        counts,
        layoutSignals: signals,
        signalLabels: buildSignalLabels(signals),
      };
    })
    .sort((a, b) => b.score - a.score || a.counts.textRuns - b.counts.textRuns || a.pageIndex - b.pageIndex)
    .slice(0, limit);
}

function buildHotspotMarkdown(reports) {
  const lines = [
    '# Verify Sample Hotspots',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Viewer: ${VIEWER_URL}`,
    '',
  ];

  for (const report of reports) {
    lines.push(`## ${report.filename}`);
    if (report.fatal) {
      lines.push('');
      lines.push(`- fatal: ${report.fatal}`);
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push(`- source: ${report.sourcePath}`);
    lines.push(`- page: ${report.pageInfo}`);
    lines.push(`- section: ${report.sectionInfo}`);
    if (Array.isArray(report.fontsUsed) && report.fontsUsed.length) {
      lines.push(`- fonts: ${report.fontsUsed.join(', ')}`);
    }
    if (Array.isArray(report.unresolvedFonts) && report.unresolvedFonts.length) {
      lines.push(`- unresolved-fonts: ${report.unresolvedFonts.join(', ')}`);
    }
    if (Array.isArray(report.layoutSignalLabels) && report.layoutSignalLabels.length) {
      lines.push(`- layout-signals: ${report.layoutSignalLabels.join(' · ')}`);
    }
    if (Number.isFinite(report.hancomExpectedPages)) {
      lines.push(`- hancom-pages: expected ${report.hancomExpectedPages}, actual ${report.pageCount}, match=${report.hancomPageMatch}`);
    }
    if (report.screenshotPath) {
      lines.push(`- screenshot: ${report.screenshotPath}`);
    }
    lines.push('- hotspots:');
    for (const hotspot of report.hotspots || []) {
      const metricLine = buildMetricLabels(hotspot.counts).join(' · ');
      const signalLine = Array.isArray(hotspot.signalLabels) && hotspot.signalLabels.length
        ? ` · 신호: ${hotspot.signalLabels.join(' · ')}`
        : '';
      lines.push(`  - ${hotspot.pageIndex + 1}쪽 · ${metricLine}${signalLine}`);
    }
    if (Array.isArray(report.issues) && report.issues.length) {
      lines.push('- issues:');
      for (const issue of report.issues) {
        lines.push(`  - ${issue}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function buildInventoryMarkdown(samples, reports, downloadsFiles) {
  const reportById = new Map(reports.map((report) => [report.id, report]));
  const lines = [
    '# Downloads HWP Inventory',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Downloads Directory: ${DOWNLOADS_DIR}`,
    `Discovered Documents: ${downloadsFiles.length}`,
    `Verified Documents: ${reports.length}`,
    '',
  ];

  for (const sample of samples) {
    const report = reportById.get(sample.id);
    const kindLabel = sample.sampleKind === 'known' ? '기준 샘플' : '자동 발견';
    lines.push(`## ${sample.filename}`);
    lines.push('');
    lines.push(`- path: ${sample.filePath}`);
    lines.push(`- kind: ${kindLabel}`);
    if (!report) {
      lines.push('- status: 미검증');
      lines.push('');
      continue;
    }
    if (report.fatal) {
      lines.push(`- status: 실패`);
      lines.push(`- fatal: ${report.fatal}`);
      lines.push('');
      continue;
    }
    lines.push('- status: 완료');
    lines.push(`- page: ${report.pageInfo}`);
    lines.push(`- section: ${report.sectionInfo}`);
    lines.push(`- source: ${report.sourcePath}`);
    if (Array.isArray(report.fontsUsed) && report.fontsUsed.length) {
      lines.push(`- fonts: ${report.fontsUsed.join(', ')}`);
    }
    if (Array.isArray(report.unresolvedFonts) && report.unresolvedFonts.length) {
      lines.push(`- unresolved-fonts: ${report.unresolvedFonts.join(', ')}`);
    }
    if (Array.isArray(report.layoutSignalLabels) && report.layoutSignalLabels.length) {
      lines.push(`- layout-signals: ${report.layoutSignalLabels.join(' · ')}`);
    }
    if (Number.isFinite(report.hancomExpectedPages)) {
      lines.push(`- hancom-pages: expected ${report.hancomExpectedPages}, actual ${report.pageCount}, match=${report.hancomPageMatch}`);
    }
    if (report.screenshotPath) {
      lines.push(`- screenshot: ${report.screenshotPath}`);
    }
    if (Array.isArray(report.hotspots) && report.hotspots.length) {
      lines.push('- hotspots:');
      for (const hotspot of report.hotspots) {
        const metricLine = buildMetricLabels(hotspot.counts).join(' · ');
        const signalLine = Array.isArray(hotspot.signalLabels) && hotspot.signalLabels.length
          ? ` · 신호: ${hotspot.signalLabels.join(' · ')}`
          : '';
        lines.push(`  - ${hotspot.pageIndex + 1}쪽 · ${metricLine}${signalLine}`);
      }
    }
    if (Array.isArray(report.issues) && report.issues.length) {
      lines.push('- issues:');
      for (const issue of report.issues) {
        lines.push(`  - ${issue}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function baseSampleState() {
  return {
    pageInfo: '',
    sectionInfo: '',
    modeInfo: '',
    message: '',
    canvasCount: 0,
    thumbnailCount: 0,
    hasRenderer: false,
    keywordHits: {},
    diagnostics: null,
  };
}

function readSampleState(keywords = []) {
  const keywordsLiteral = JSON.stringify(keywords);
  return evalPage(
    `JSON.stringify((() => {
      const keywords = ${keywordsLiteral};
      const renderer = globalThis.HwpWasmRenderer;
      const statusPageInfo = document.getElementById('statusPageInfo')?.textContent?.trim() || '';
      const statusSectionInfo = document.getElementById('statusSectionInfo')?.textContent?.trim() || '';
      const statusMode = document.getElementById('statusMode')?.textContent?.trim() || '';
      const statusMessage = document.getElementById('statusMessage')?.textContent?.trim() || '';
      const diagnostics = globalThis.__ChromeHwpDiagnostics?.getCurrent?.()
        || renderer?.collectDocumentDiagnostics?.({ includePageInfo: true, includeSectionDetails: true, includeControlDetails: false })
        || null;
      const fontModule = globalThis.FontSubstitution || null;
      const rawFontsUsed = Array.isArray(diagnostics?.documentInfo?.fontsUsed) ? diagnostics.documentInfo.fontsUsed : [];
      const resolvedFonts = rawFontsUsed.map(fontName => {
        const resolved = fontModule?.resolveFont ? fontModule.resolveFont(fontName, 0, 0) : fontName;
        const registered = fontModule?.REGISTERED_FONTS?.has?.(resolved) || false;
        return { raw: fontName, resolved, registered };
      });
      const diagnosticsSummary = diagnostics ? {
        pageCount: Number.isFinite(diagnostics.pageCount) ? diagnostics.pageCount : 0,
        sectionCount: Number.isFinite(diagnostics.sectionCount) ? diagnostics.sectionCount : 0,
        documentInfo: diagnostics.documentInfo || null,
        fontCoverage: {
          rawFonts: rawFontsUsed,
          resolvedFonts,
          unresolvedFonts: resolvedFonts.filter(entry => !entry.registered).map(entry => entry.raw),
        },
        counts: diagnostics.counts || {},
        layoutSignals: diagnostics.layoutSignals || {},
        controlTypes: diagnostics.controlTypes || {},
        pages: Array.isArray(diagnostics.pages) ? diagnostics.pages.map(page => ({
          pageIndex: Number.isFinite(page.pageIndex) ? page.pageIndex : null,
          width: Number.isFinite(page.width) ? page.width : null,
          height: Number.isFinite(page.height) ? page.height : null,
          sectionIndex: Number.isFinite(page.sectionIndex) ? page.sectionIndex : null,
          columns: Number.isFinite(page.columns) ? page.columns : 0,
          controlCount: Number.isFinite(page.controlCount) ? page.controlCount : 0,
          counts: page.counts || {},
          layoutSignals: page.layoutSignals || {},
          controlTypes: page.controlTypes || {},
          textRunCount: Number.isFinite(page.textRunCount) ? page.textRunCount : 0,
        })) : [],
      } : null;
      const keywordHits = Object.fromEntries(keywords.map(keyword => {
        try {
          const hits = renderer?.searchText?.(keyword) || [];
          return [keyword, Array.isArray(hits) ? hits.length : 0];
        } catch {
          return [keyword, -1];
        }
      }));
      return {
        pageInfo: statusPageInfo,
        sectionInfo: statusSectionInfo,
        modeInfo: statusMode,
        message: statusMessage,
        canvasCount: document.querySelectorAll('.hwp-page canvas').length,
        thumbnailCount: document.querySelectorAll('.page-thumb, .thumbnail-item, .thumb-item').length,
        hasRenderer: Boolean(renderer),
        keywordHits,
        diagnostics: diagnosticsSummary,
      };
    })())`,
  );
}

async function waitForDocument(sample) {
  const started = Date.now();
  let lastState = baseSampleState();

  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    lastState = readSampleState(sample.keywords);
    const loaded = lastState.hasRenderer
      && lastState.canvasCount > 0
      && lastState.message.includes(sample.filename)
      && /쪽/.test(lastState.pageInfo);
    if (loaded) {
      return lastState;
    }
    await sleep(500);
  }

  throw new Error(`${sample.filename} 로드 대기 시간 초과\n마지막 상태: ${JSON.stringify(lastState, null, 2)}`);
}

async function walkPages(totalPages) {
  const seen = [];
  for (let index = 0; index < totalPages; index += 1) {
    evalPage(
      `(function() {
        const target = document.querySelectorAll('.hwp-page-canvas')[${index}];
        if (!target) return 'missing';
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        return 'ok';
      })()`,
    );
    await sleep(SCROLL_SETTLE_MS);
    const pageInfo = evalPage(
      `JSON.stringify(document.getElementById('statusPageInfo')?.textContent?.trim() || '')`,
    );
    seen.push(String(pageInfo || ''));
  }
  return seen;
}

async function verifySample(sample, hancomOracleBaseline) {
  const access = resolveSampleAccess(sample);
  const viewerUrl = buildViewerUrl(access.servedUrl);

  runPw(['close-all'], { retries: MAX_SESSION_RETRIES });
  runPw(['open', viewerUrl], { retries: MAX_SESSION_RETRIES });
  runPw(['resize', '1600', '1200'], { retries: MAX_SESSION_RETRIES });

  const state = await waitForDocument(sample);
  let screenshotPath = null;
  let screenshotError = null;
  try {
    screenshotPath = captureCurrentPageScreenshot(sample.id);
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }
  const totalPages = parsePageCount(state.pageInfo);
  const pageWalk = await walkPages(totalPages);
  const consoleOutput = runPw(['console', 'error'], { retries: MAX_SESSION_RETRIES });
  const consoleErrors = parseConsoleCount(consoleOutput, 'Errors');
  const consoleWarnings = parseConsoleCount(consoleOutput, 'Warnings');
  const issues = [];

  const missingKeywords = Object.entries(state.keywordHits)
    .filter(([, count]) => !Number.isFinite(count) || count <= 0)
    .map(([keyword]) => keyword);
  const pageWalkOk = pageWalk.length === totalPages
    && pageWalk.every((value, idx) => new RegExp(`^${idx + 1}\\s*/\\s*${totalPages}\\s*쪽$`).test(value));
  const diagnostics = state.diagnostics || null;
  const diagnosticCounts = diagnostics?.counts || null;
  const diagnosticPageCount = Number.isFinite(diagnostics?.pageCount) ? diagnostics.pageCount : null;
  const diagnosticSectionCount = Number.isFinite(diagnostics?.sectionCount) ? diagnostics.sectionCount : null;
  const diagnosticPageMatch = diagnosticPageCount == null ? null : diagnosticPageCount === totalPages;
  const diagnosticControlCountSum = Array.isArray(diagnostics?.pages)
    ? diagnostics.pages.reduce((sum, page) => sum + (Number.isFinite(page.controlCount) ? page.controlCount : 0), 0)
    : null;
  const diagnosticControlCount = Number.isFinite(diagnosticCounts?.controls) ? diagnosticCounts.controls : null;
  const hotspots = buildReportHotspots(diagnostics);
  const layoutSignalLabels = buildSignalLabels(diagnostics?.layoutSignals || {});
  const fontsUsed = Array.isArray(diagnostics?.documentInfo?.fontsUsed)
    ? diagnostics.documentInfo.fontsUsed.slice().sort((a, b) => String(a).localeCompare(String(b), 'ko'))
    : [];
  const resolvedFonts = Array.isArray(diagnostics?.fontCoverage?.resolvedFonts)
    ? diagnostics.fontCoverage.resolvedFonts
    : [];
  const unresolvedFonts = Array.isArray(diagnostics?.fontCoverage?.unresolvedFonts)
    ? diagnostics.fontCoverage.unresolvedFonts.slice().sort((a, b) => String(a).localeCompare(String(b), 'ko'))
    : [];
  const hancomOracle = hancomOracleBaseline.get(sample.id) || null;
  const hancomExpectedPages = Number.isFinite(hancomOracle?.pageCount)
    ? hancomOracle.pageCount
    : null;
  const hancomPageMatch = hancomExpectedPages == null
    ? null
    : totalPages === hancomExpectedPages;

  const report = {
    id: sample.id,
    sampleKind: sample.sampleKind || 'known',
    filename: sample.filename,
    filePath: access.sourcePath,
    sourcePath: access.sourcePath,
    servedPath: access.servedPath,
    servedUrl: access.servedUrl,
    sourceKind: access.sourceKind,
    copiedFromSource: access.copiedFromSource,
    pageInfo: state.pageInfo,
    sectionInfo: state.sectionInfo,
    modeInfo: state.modeInfo,
    message: state.message,
    canvasCount: state.canvasCount,
    thumbnailCount: state.thumbnailCount,
    pageCount: totalPages,
    pageWalk,
    pageWalkOk,
    keywordHits: state.keywordHits,
    missingKeywords,
    diagnostics,
    diagnosticPageCount,
    diagnosticSectionCount,
    diagnosticPageMatch,
    diagnosticControlCount,
    diagnosticControlCountSum,
    documentInfo: diagnostics?.documentInfo || null,
    fontsUsed,
    resolvedFonts,
    unresolvedFonts,
    hancomExpectedPages,
    hancomPageMatch,
    hancomEvidence: hancomOracle?.evidence || null,
    layoutSignals: diagnostics?.layoutSignals || null,
    layoutSignalLabels,
    hotspots,
    screenshotPath,
    screenshotError,
    consoleErrors,
    consoleWarnings,
    issues,
  };

  if (!pageWalkOk) {
    issues.push(`페이지 끝 순회 실패: ${pageWalk.join(' | ')}`);
  }
  if (missingKeywords.length) {
    issues.push(`핵심 키워드 검색 실패: ${missingKeywords.join(', ')}`);
  }
  if (consoleErrors > 0) {
    issues.push(`렌더 중 콘솔 오류 ${consoleErrors}건 발생`);
  }
  if (screenshotError) {
    issues.push(`스크린샷 저장 실패: ${screenshotError}`);
  }
  if (!diagnostics) {
    issues.push('엔진 구조 진단 데이터 수집 실패');
  } else {
    if (diagnosticPageMatch === false) {
      issues.push(`진단 페이지 수 불일치: 상태바 ${totalPages}, 진단 ${diagnosticPageCount}`);
    }
    if (!Number.isFinite(diagnosticSectionCount) || diagnosticSectionCount < 1) {
      issues.push('진단 구역 수가 비정상입니다.');
    }
    if (diagnosticControlCount != null && diagnosticControlCountSum != null && diagnosticControlCount !== diagnosticControlCountSum) {
      issues.push(`진단 제어 수 합계 불일치: 총 ${diagnosticControlCount}, 페이지 합 ${diagnosticControlCountSum}`);
    }
  }
  if (unresolvedFonts.length) {
    issues.push(`미해소 글꼴: ${unresolvedFonts.join(', ')}`);
  }
  if (hancomPageMatch === false) {
    issues.push(`한컴 Viewer 페이지 수 불일치: 한컴 ${hancomExpectedPages}, ChromeHWP ${totalPages}`);
  }

  return report;
}

async function main() {
  if (!existsSync(PWCLI)) {
    fail(`playwright_cli.sh 경로를 찾지 못했습니다: ${PWCLI}`);
  }

  const samples = buildSampleDefinitions();
  const downloadsFiles = discoverDownloadsDocuments();
  const hancomOracleBaseline = loadHancomOracleBaseline();

  for (const sample of samples) {
    ensureFileExists(sample.filePath, sample.filename);
  }

  const reports = [];
  let hasIssues = false;
  try {
    for (const sample of samples) {
      let report;
      try {
        report = await verifySample(sample, hancomOracleBaseline);
      } catch (error) {
        report = {
          id: sample.id,
          filename: sample.filename,
          filePath: sample.filePath,
          servedUrl: toServedUrl(sample.filePath),
          fatal: error instanceof Error ? error.message : String(error),
          issues: ['문서 로드 실패'],
        };
      }
      reports.push(report);
      console.log(`✓ ${report.filename}`);
      if (report.fatal) {
        console.log(`  - fatal: ${report.fatal}`);
      } else {
        console.log(`  - page: ${report.pageInfo}`);
        console.log(`  - section: ${report.sectionInfo}`);
        if (report.sampleKind !== 'known') {
          console.log(`  - kind: auto-discovered`);
        }
        console.log(`  - keywords: ${JSON.stringify(report.keywordHits)}`);
        console.log(`  - source: ${report.sourceKind} ${report.sourcePath}`);
        if (report.diagnostics?.counts) {
          console.log(`  - diagnostics: ${JSON.stringify({
            pageCount: report.diagnosticPageCount,
            sectionCount: report.diagnosticSectionCount,
            controls: report.diagnostics.counts.controls || 0,
            tables: report.diagnostics.counts.tables || 0,
            equations: report.diagnostics.counts.equations || 0,
            charts: report.diagnostics.counts.charts || 0,
            pictures: report.diagnostics.counts.pictures || 0,
            forms: report.diagnostics.counts.forms || 0,
            shapes: report.diagnostics.counts.shapes || 0,
          })}`);
        }
        if (Array.isArray(report.fontsUsed) && report.fontsUsed.length) {
          console.log(`  - fonts: ${report.fontsUsed.join(', ')}`);
        }
        if (Array.isArray(report.unresolvedFonts) && report.unresolvedFonts.length) {
          console.log(`  - unresolved-fonts: ${report.unresolvedFonts.join(', ')}`);
        }
        if (Array.isArray(report.layoutSignalLabels) && report.layoutSignalLabels.length) {
          console.log(`  - layout-signals: ${report.layoutSignalLabels.join(', ')}`);
        }
        if (Array.isArray(report.hotspots) && report.hotspots.length) {
          console.log(`  - hotspots: ${report.hotspots.map((hotspot) => {
            const metrics = buildMetricLabels(hotspot.counts).join(', ');
            const signals = Array.isArray(hotspot.signalLabels) && hotspot.signalLabels.length
              ? `; ${hotspot.signalLabels.join(', ')}`
              : '';
            return `${hotspot.pageIndex + 1}쪽(${metrics}${signals})`;
          }).join(' | ')}`);
        }
        if (report.screenshotPath) {
          console.log(`  - screenshot: ${report.screenshotPath}`);
        }
        if (Number.isFinite(report.hancomExpectedPages)) {
          console.log(`  - hancom: expected ${report.hancomExpectedPages}, actual ${report.pageCount}, match=${report.hancomPageMatch}`);
        }
      }
      if (Array.isArray(report.issues) && report.issues.length) {
        hasIssues = true;
        for (const issue of report.issues) {
          console.log(`  - issue: ${issue}`);
        }
      }
    }
  } finally {
    runPw(['close-all'], { retries: MAX_SESSION_RETRIES });
  }

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  mkdirSync(path.dirname(HOTSPOT_REPORT_PATH), { recursive: true });
  mkdirSync(path.dirname(INVENTORY_REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify({
    viewerUrl: VIEWER_URL,
    viewerFontOverrides: VIEWER_FONT_OVERRIDES,
    sessionName: SESSION_NAME,
    strictPageExpectations: STRICT_PAGE_EXPECTATIONS,
    generatedAt: new Date().toISOString(),
    downloadsDirectory: DOWNLOADS_DIR,
    hancomOracleBaselinePath: HANCOM_ORACLE_BASELINE_PATH,
    downloadsInventory: downloadsFiles,
    verifiedDocumentCount: reports.length,
    reports,
  }, null, 2)}\n`);
  writeFileSync(HOTSPOT_REPORT_PATH, buildHotspotMarkdown(reports));
  writeFileSync(INVENTORY_REPORT_PATH, buildInventoryMarkdown(samples, reports, downloadsFiles));

  console.log('✓ 샘플 회귀검증 완료');
  console.log(`- downloads: ${downloadsFiles.length} documents`);
  console.log(`- viewer: ${VIEWER_URL}`);
  console.log(`- report: ${REPORT_PATH}`);
  console.log(`- hotspots: ${HOTSPOT_REPORT_PATH}`);
  console.log(`- inventory: ${INVENTORY_REPORT_PATH}`);
  if (hasIssues) {
    process.exitCode = 1;
  }
}

await main();
