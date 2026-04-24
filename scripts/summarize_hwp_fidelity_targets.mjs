#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_VERIFY_REPORT_PATH = path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-report.json');
const DEFAULT_VISUAL_AUDIT_REPORT_PATH = path.join(
  ROOT_DIR,
  'output',
  'hancom-oracle',
  'page-audit',
  'hancom-page-audit-report.json',
);
const STRICT_FAILURE_VERDICTS = new Set(['mismatch', 'capture-error', 'capture-review']);
const ADVISORY_VERDICTS = new Set(['review']);
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, OK: 4 };
const VISUAL_VERDICT_RANK = {
  'capture-error': 0,
  mismatch: 1,
  'capture-review': 1,
  review: 2,
  close: 3,
  match: 4,
  ok: 4,
};

function printHelp() {
  process.stdout.write(`Usage: node scripts/summarize_hwp_fidelity_targets.mjs [options]

Summarize HWP fidelity targets from:
  output/playwright/verify-samples-report.json
  output/hancom-oracle/page-audit/hancom-page-audit-report.json

Options:
  --format markdown|json|both      Output format. Default: markdown
  --json                           Alias for --format json
  --markdown                       Alias for --format markdown
  --out <path>                     Write output to a file instead of stdout
  --verify-report <path>           Override verify-samples-report.json path
  --visual-audit-report <path>     Override hancom-page-audit-report.json path
  --audit-report <path>            Alias for --visual-audit-report
  --extensions <list>              Comma-separated extensions. Default: .hwp
  --include-hwpx                   Include .hwpx documents in addition to .hwp
  --strict-visual-audit            Treat stale/missing visual audit as strict
  --no-strict-visual-audit         Treat stale/missing visual audit as advisory
  --visual-max-age-hours <number>  Default: FIDELITY_VISUAL_MAX_AGE_HOURS or 24
  --top-pages <number>             Visual pages to list per document. Default: 5
  --top-hotspots <number>          Layout hotspots to list per document. Default: 3
  --help                           Show this help
`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, optionName) {
  const inlinePrefix = `${optionName}=`;
  const current = argv[index];
  if (current.startsWith(inlinePrefix)) {
    return { value: current.slice(inlinePrefix.length), nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${optionName} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parseFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeExtension(value) {
  const extension = String(value || '').trim().toLowerCase();
  if (!extension) return '';
  return extension.startsWith('.') ? extension : `.${extension}`;
}

function parseExtensions(value) {
  return String(value || '')
    .split(',')
    .map(normalizeExtension)
    .filter(Boolean);
}

function parseArgs(argv) {
  const defaultMaxAge = parseFiniteNumber(process.env.FIDELITY_VISUAL_MAX_AGE_HOURS, 24);
  const options = {
    verifyReportPath: process.env.VERIFY_REPORT_PATH || DEFAULT_VERIFY_REPORT_PATH,
    visualAuditReportPath: process.env.HANCOM_PAGE_AUDIT_REPORT_PATH || DEFAULT_VISUAL_AUDIT_REPORT_PATH,
    format: 'markdown',
    outPath: '',
    extensions: ['.hwp'],
    strictVisualAudit: process.env.FIDELITY_REQUIRE_VISUAL_AUDIT === '1',
    visualMaxAgeHours: defaultMaxAge,
    topPages: 5,
    topHotspots: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--json') {
      options.format = 'json';
      continue;
    }
    if (arg === '--markdown') {
      options.format = 'markdown';
      continue;
    }
    if (arg === '--include-hwpx') {
      options.extensions = [...new Set([...options.extensions, '.hwpx'])];
      continue;
    }
    if (arg === '--strict-visual-audit') {
      options.strictVisualAudit = true;
      continue;
    }
    if (arg === '--no-strict-visual-audit') {
      options.strictVisualAudit = false;
      continue;
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      const parsed = readOptionValue(argv, index, '--format');
      options.format = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const parsed = readOptionValue(argv, index, '--out');
      options.outPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--verify-report' || arg.startsWith('--verify-report=')) {
      const parsed = readOptionValue(argv, index, '--verify-report');
      options.verifyReportPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--visual-audit-report' || arg.startsWith('--visual-audit-report=')) {
      const parsed = readOptionValue(argv, index, '--visual-audit-report');
      options.visualAuditReportPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--audit-report' || arg.startsWith('--audit-report=')) {
      const parsed = readOptionValue(argv, index, '--audit-report');
      options.visualAuditReportPath = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--extensions' || arg.startsWith('--extensions=')) {
      const parsed = readOptionValue(argv, index, '--extensions');
      options.extensions = parseExtensions(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--visual-max-age-hours' || arg.startsWith('--visual-max-age-hours=')) {
      const parsed = readOptionValue(argv, index, '--visual-max-age-hours');
      options.visualMaxAgeHours = parseFiniteNumber(parsed.value, options.visualMaxAgeHours);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--top-pages' || arg.startsWith('--top-pages=')) {
      const parsed = readOptionValue(argv, index, '--top-pages');
      options.topPages = Math.max(1, Math.floor(parseFiniteNumber(parsed.value, options.topPages)));
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--top-hotspots' || arg.startsWith('--top-hotspots=')) {
      const parsed = readOptionValue(argv, index, '--top-hotspots');
      options.topHotspots = Math.max(0, Math.floor(parseFiniteNumber(parsed.value, options.topHotspots)));
      index = parsed.nextIndex;
      continue;
    }

    fail(`unknown option: ${arg}`);
  }

  options.format = String(options.format || '').toLowerCase();
  if (!['markdown', 'json', 'both'].includes(options.format)) {
    fail(`unsupported format: ${options.format}`);
  }
  if (!options.extensions.length) {
    fail('--extensions must include at least one extension');
  }

  return options;
}

function resolveInputPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(ROOT_DIR, filePath);
}

function pathDetails(filePath) {
  if (!filePath) {
    return { path: '', absolutePath: '', exists: false };
  }
  const absolutePath = resolveInputPath(filePath);
  return {
    path: filePath,
    absolutePath,
    exists: existsSync(absolutePath),
  };
}

function readRequiredJson(filePath, label) {
  const absolutePath = resolveInputPath(filePath);
  if (!existsSync(absolutePath)) {
    fail(`${label} not found: ${absolutePath}`);
  }
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`${label} could not be parsed: ${absolutePath}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOptionalJson(filePath, label) {
  const absolutePath = resolveInputPath(filePath);
  if (!existsSync(absolutePath)) {
    return { payload: null, error: `${label} not found: ${absolutePath}` };
  }
  try {
    return { payload: JSON.parse(readFileSync(absolutePath, 'utf8')), error: '' };
  } catch (error) {
    return {
      payload: null,
      error: `${label} could not be parsed: ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hoursBetween(later, earlier) {
  if (!later || !earlier) return null;
  return (later.getTime() - earlier.getTime()) / 36e5;
}

function normalizeKey(value = '') {
  return String(value || '').normalize('NFC').trim().toLowerCase();
}

function filenameOf(report = {}) {
  return report.filename || path.basename(report.sourcePath || report.filePath || '');
}

function extensionOf(report = {}) {
  return path.extname(filenameOf(report)).toLowerCase();
}

function isTargetDocument(report, extensions) {
  return extensions.has(extensionOf(report));
}

function buildAuditIndex(visualAuditPayload) {
  const results = Array.isArray(visualAuditPayload?.results)
    ? visualAuditPayload.results
    : Array.isArray(visualAuditPayload?.documents)
      ? visualAuditPayload.documents
      : [];
  const byKey = new Map();
  for (const doc of results) {
    const keys = [
      doc.id,
      doc.filename,
      path.basename(doc.sourcePath || ''),
      path.basename(doc.filename || '', path.extname(doc.filename || '')),
    ];
    for (const key of keys.map(normalizeKey).filter(Boolean)) {
      if (!byKey.has(key)) byKey.set(key, doc);
    }
  }
  return { results, byKey };
}

function findAuditDoc(report, auditIndex) {
  const keys = [
    report.id,
    report.filename,
    path.basename(report.sourcePath || ''),
    path.basename(report.filename || '', path.extname(report.filename || '')),
  ].map(normalizeKey).filter(Boolean);
  for (const key of keys) {
    const doc = auditIndex.byKey.get(key);
    if (doc) return doc;
  }
  return null;
}

function makeIssue(priority, category, message, evidence = {}) {
  return {
    priority,
    rank: PRIORITY_RANK[priority] ?? PRIORITY_RANK.P3,
    category,
    message,
    evidence,
  };
}

function sortIssues(issues) {
  return [...issues].sort((a, b) => (
    (a.rank ?? 99) - (b.rank ?? 99)
    || String(a.document || '').localeCompare(String(b.document || ''), 'ko')
    || String(a.category || '').localeCompare(String(b.category || ''), 'ko')
    || String(a.message || '').localeCompare(String(b.message || ''), 'ko')
  ));
}

function addIssue(issues, priority, category, message, evidence = {}) {
  issues.push(makeIssue(priority, category, message, evidence));
}

function countMatchingVerdicts(verdictCounts = {}, verdictSet) {
  return Object.entries(verdictCounts || {})
    .filter(([verdict]) => verdictSet.has(verdict))
    .reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
}

function formatVerdictCounts(verdictCounts = {}) {
  const entries = Object.entries(verdictCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => (
      (VISUAL_VERDICT_RANK[a[0]] ?? 9) - (VISUAL_VERDICT_RANK[b[0]] ?? 9)
      || String(a[0]).localeCompare(String(b[0]))
    ));
  return entries.map(([verdict, count]) => `${verdict}:${count}`).join(', ') || 'none';
}

function summarizeVisualPages(pages = [], limit = 5) {
  return (Array.isArray(pages) ? pages : [])
    .map((page) => ({
      pageIndex: Number.isFinite(page?.pageIndex) ? page.pageIndex : null,
      pageNumber: Number.isFinite(page?.pageIndex) ? page.pageIndex + 1 : null,
      verdict: page?.verdict || 'unknown',
      verdictRank: VISUAL_VERDICT_RANK[page?.verdict] ?? 8,
      diff: asNumber(page?.diff),
      captureQualityStatus: page?.captureQuality?.status || '',
      pageCompare: pathDetails(page?.pageCompare || ''),
      hancomScreenshot: pathDetails(page?.hancomScreenshot || ''),
      chromePage: pathDetails(page?.chromePage || ''),
    }))
    .sort((a, b) => (
      a.verdictRank - b.verdictRank
      || (b.diff ?? -1) - (a.diff ?? -1)
      || (a.pageNumber ?? 0) - (b.pageNumber ?? 0)
    ))
    .slice(0, limit);
}

function buildVisualAuditStatus(visualAuditPayload, visualAuditError, verifyPayload, options) {
  const generatedAt = visualAuditPayload?.generatedAt || '';
  const auditDate = parseTimestamp(generatedAt);
  const verifyGeneratedAt = verifyPayload?.generatedAt || '';
  const verifyDate = parseTimestamp(verifyGeneratedAt);
  const now = new Date();
  const staleReasons = [];

  if (!visualAuditPayload) {
    staleReasons.push({
      code: 'missing',
      message: visualAuditError || 'visual audit report is missing',
    });
  } else if (!auditDate) {
    staleReasons.push({
      code: 'missing-generated-at',
      message: 'visual audit generatedAt is missing or invalid',
    });
  } else {
    if (verifyDate && auditDate < verifyDate) {
      staleReasons.push({
        code: 'older-than-verify-report',
        message: `visual audit ${generatedAt} is older than verify report ${verifyGeneratedAt}`,
      });
    }
    if (Number.isFinite(options.visualMaxAgeHours) && options.visualMaxAgeHours > 0) {
      const ageHours = hoursBetween(now, auditDate);
      if (ageHours !== null && ageHours > options.visualMaxAgeHours) {
        staleReasons.push({
          code: 'older-than-max-age',
          message: `visual audit age ${ageHours.toFixed(1)}h exceeds ${options.visualMaxAgeHours}h`,
        });
      }
    }
  }

  return {
    available: Boolean(visualAuditPayload),
    path: resolveInputPath(options.visualAuditReportPath),
    generatedAt,
    verifyGeneratedAt,
    strict: options.strictVisualAudit,
    stale: staleReasons.length > 0,
    staleReasons,
    maxAgeHours: options.visualMaxAgeHours,
    ageHours: auditDate ? Number(hoursBetween(now, auditDate).toFixed(2)) : null,
  };
}

function buildPageCountStatus(report, auditDoc, issues) {
  const verifyPageCount = asNumber(report.pageCount);
  const diagnosticPageCount = asNumber(report.diagnosticPageCount);
  const domPageCount = asNumber(report.pageElementCount);
  const thumbnailCount = asNumber(report.thumbnailCount);
  const hancomExpectedPages = asNumber(report.hancomExpectedPages);
  const visualPageCount = asNumber(auditDoc?.pageCount);
  const checks = [];

  const addCheck = (name, ok, expected, actual) => {
    checks.push({ name, ok, expected, actual });
  };

  if (!verifyPageCount || verifyPageCount < 1) {
    addIssue(issues, 'P0', 'page-count', `invalid verify pageCount: ${report.pageCount ?? '(missing)'}`);
  }

  if (verifyPageCount && diagnosticPageCount !== null) {
    const ok = report.diagnosticPageMatch === true && verifyPageCount === diagnosticPageCount;
    addCheck('diagnostics', ok, verifyPageCount, diagnosticPageCount);
    if (!ok) {
      addIssue(issues, 'P1', 'page-count', `status/diagnostics page-count mismatch: verify=${verifyPageCount}, diagnostics=${diagnosticPageCount}`);
    }
  } else if (verifyPageCount) {
    addIssue(issues, 'P2', 'page-count', 'diagnostic page count is missing');
  }

  if (verifyPageCount && domPageCount !== null) {
    const ok = verifyPageCount === domPageCount;
    addCheck('dom-pages', ok, verifyPageCount, domPageCount);
    if (!ok) {
      addIssue(issues, 'P1', 'page-count', `DOM page-count mismatch: verify=${verifyPageCount}, dom=${domPageCount}`);
    }
  }

  if (verifyPageCount && hancomExpectedPages !== null) {
    const ok = report.hancomPageMatch === true && verifyPageCount === hancomExpectedPages;
    addCheck('hancom-baseline', ok, hancomExpectedPages, verifyPageCount);
    if (!ok) {
      addIssue(issues, 'P1', 'page-count', `Hancom baseline page-count mismatch: expected=${hancomExpectedPages}, actual=${verifyPageCount}`);
    }
  }

  if (verifyPageCount && visualPageCount !== null) {
    const ok = verifyPageCount === visualPageCount;
    addCheck('visual-audit', ok, verifyPageCount, visualPageCount);
    if (!ok) {
      addIssue(issues, 'P1', 'page-count', `visual audit page-count mismatch: verify=${verifyPageCount}, visual=${visualPageCount}`);
    }
  }

  if (verifyPageCount && thumbnailCount !== null && thumbnailCount > 0 && thumbnailCount < verifyPageCount) {
    addIssue(issues, 'P2', 'page-count', `thumbnail count is below page count: thumbnails=${thumbnailCount}, pages=${verifyPageCount}`);
  }

  if (report.pageWalkOk === false) {
    addIssue(issues, 'P2', 'page-count', `page walk failed: ${(report.pageWalk || []).join(' | ')}`);
  }

  const hasFailure = checks.some((check) => check.ok === false);
  const state = issues.some((issue) => issue.category === 'page-count' && issue.rank <= PRIORITY_RANK.P1)
    ? 'fail'
    : hasFailure
      ? 'fail'
      : issues.some((issue) => issue.category === 'page-count')
        ? 'warn'
        : 'ok';

  return {
    state,
    verifyPageCount,
    pageInfo: report.pageInfo || '',
    diagnosticPageCount,
    diagnosticPageMatch: report.diagnosticPageMatch === true,
    domPageCount,
    thumbnailCount,
    hancomExpectedPages,
    hancomPageMatch: report.hancomPageMatch === true,
    visualPageCount,
    visualPageMatch: visualPageCount === null ? null : verifyPageCount === visualPageCount,
    checks,
  };
}

function buildRenderedFontDiagnosticLabel(diagnostics = null) {
  if (!diagnostics) return '';
  const parts = [];
  const formatHistogram = (entries = [], limit = 5) => (
    Array.isArray(entries)
      ? entries.slice(0, limit).map((entry) => `${entry.value}(${entry.count})`).join(', ')
      : ''
  );
  const fontFamilies = formatHistogram(diagnostics.fontFamilyHistogram);
  const fontSizes = formatHistogram(diagnostics.fontSizeHistogram, 3);
  const lineHeights = formatHistogram(diagnostics.lineHeightHistogram, 3);
  if (fontFamilies) parts.push(`family ${fontFamilies}`);
  if (fontSizes) parts.push(`size ${fontSizes}`);
  if (lineHeights) parts.push(`line-height ${lineHeights}`);
  return parts.join(' | ');
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function buildFontDiagnostics(report, issues) {
  const rendered = report.renderedFontDiagnostics || report.diagnostics?.renderedFontDiagnostics || null;
  const coverage = report.diagnostics?.fontCoverage || {};
  const documentInfoFonts = report.diagnostics?.documentInfo?.fontsUsed || report.documentInfo?.fontsUsed || [];
  const fontsUsed = uniqueStrings(
    Array.isArray(report.fontsUsed) && report.fontsUsed.length ? report.fontsUsed : documentInfoFonts,
  );
  const unresolvedFonts = uniqueStrings(
    Array.isArray(report.unresolvedFonts) && report.unresolvedFonts.length
      ? report.unresolvedFonts
      : coverage.unresolvedFonts,
  );
  const resolvedFonts = Array.isArray(report.resolvedFonts) && report.resolvedFonts.length
    ? report.resolvedFonts
    : Array.isArray(coverage.resolvedFonts)
      ? coverage.resolvedFonts
      : [];

  if (unresolvedFonts.length) {
    addIssue(issues, 'P2', 'fonts', `unresolved fonts: ${unresolvedFonts.join(', ')}`);
  }

  return {
    available: Boolean(rendered),
    label: buildRenderedFontDiagnosticLabel(rendered),
    inspectedElementCount: asNumber(rendered?.inspectedElementCount),
    totalElementCount: asNumber(rendered?.totalElementCount),
    textElementCount: asNumber(rendered?.textElementCount),
    styledElementCount: asNumber(rendered?.styledElementCount),
    truncated: Boolean(rendered?.truncated),
    fontFamilyHistogram: Array.isArray(rendered?.fontFamilyHistogram) ? rendered.fontFamilyHistogram.slice(0, 8) : [],
    fontSizeHistogram: Array.isArray(rendered?.fontSizeHistogram) ? rendered.fontSizeHistogram.slice(0, 5) : [],
    lineHeightHistogram: Array.isArray(rendered?.lineHeightHistogram) ? rendered.lineHeightHistogram.slice(0, 5) : [],
    fontsUsed,
    fontsUsedSource: report.fontsUsedSource || (fontsUsed.length ? 'diagnostics' : ''),
    resolvedFonts,
    unresolvedFonts,
  };
}

function buildScreenshotSummary(report, visualPages, issues) {
  const verifyScreenshot = pathDetails(report.screenshotPath || '');
  if (!verifyScreenshot.path || !verifyScreenshot.exists) {
    addIssue(issues, 'P1', 'screenshot', `verify screenshot is missing: ${verifyScreenshot.path || '(none)'}`);
  }
  const primaryVisualPage = visualPages.find((page) => page.verdictRank <= 2) || visualPages[0] || null;
  return {
    verify: verifyScreenshot,
    visualCompare: primaryVisualPage?.pageCompare || pathDetails(''),
    hancom: primaryVisualPage?.hancomScreenshot || pathDetails(''),
    chrome: primaryVisualPage?.chromePage || pathDetails(''),
  };
}

function summarizeHotspots(report, limit) {
  return (Array.isArray(report.hotspots) ? report.hotspots : [])
    .slice(0, limit)
    .map((hotspot) => ({
      pageIndex: Number.isFinite(hotspot?.pageIndex) ? hotspot.pageIndex : null,
      pageNumber: Number.isFinite(hotspot?.pageIndex) ? hotspot.pageIndex + 1 : null,
      score: asNumber(hotspot?.score),
      counts: hotspot?.counts || {},
      layoutSignals: hotspot?.layoutSignals || {},
      signalLabels: Array.isArray(hotspot?.signalLabels) ? hotspot.signalLabels : [],
    }));
}

function buildDocumentSummary(report, auditDoc, options) {
  const issues = [];
  const filename = filenameOf(report);

  if (report.fatal) {
    addIssue(issues, 'P0', 'load', `document load failed: ${report.fatal}`);
  }

  if (Array.isArray(report.issues) && report.issues.length) {
    for (const issue of report.issues) {
      addIssue(issues, 'P1', 'verify', String(issue));
    }
  }

  if (Number(report.consoleErrors) > 0) {
    addIssue(issues, 'P1', 'console', `console errors: ${report.consoleErrors}`);
  }

  if (Array.isArray(report.missingKeywords) && report.missingKeywords.length) {
    addIssue(issues, 'P2', 'keywords', `missing keywords: ${report.missingKeywords.join(', ')}`);
  }

  const pageCountStatus = buildPageCountStatus(report, auditDoc, issues);

  if (!auditDoc) {
    addIssue(
      issues,
      options.strictVisualAudit ? 'P0' : 'P2',
      'visual',
      'document is missing from visual audit report',
    );
  }

  const verdictCounts = auditDoc?.verdictCounts || {};
  const strictFailureCount = countMatchingVerdicts(verdictCounts, STRICT_FAILURE_VERDICTS);
  const advisoryCount = countMatchingVerdicts(verdictCounts, ADVISORY_VERDICTS);
  if (strictFailureCount > 0) {
    addIssue(
      issues,
      'P1',
      'visual',
      `strict visual verdicts require action: ${formatVerdictCounts(verdictCounts)}`,
      { strictFailureCount },
    );
  }
  if (advisoryCount > 0) {
    addIssue(
      issues,
      'P2',
      'visual',
      `visual review verdicts need inspection: ${formatVerdictCounts(verdictCounts)}`,
      { reviewCount: advisoryCount },
    );
  }

  const visualPages = summarizeVisualPages(auditDoc?.pages || [], options.topPages);
  const screenshots = buildScreenshotSummary(report, visualPages, issues);
  const renderedFontDiagnostics = buildFontDiagnostics(report, issues);
  const hotspots = summarizeHotspots(report, options.topHotspots);
  const sortedIssues = sortIssues(issues);
  const priority = sortedIssues[0]?.priority || 'OK';

  return {
    priority,
    rank: PRIORITY_RANK[priority],
    id: report.id || '',
    filename,
    extension: extensionOf(report),
    sourcePath: report.sourcePath || report.filePath || '',
    servedPath: report.servedPath || '',
    sampleKind: report.sampleKind || '',
    pageCountStatus,
    visual: {
      available: Boolean(auditDoc),
      pageCount: asNumber(auditDoc?.pageCount),
      verdictCounts,
      strictFailureCount,
      advisoryCount,
      topPages: visualPages,
    },
    screenshots,
    renderedFontDiagnostics,
    layoutSignals: report.layoutSignals || {},
    layoutSignalLabels: Array.isArray(report.layoutSignalLabels) ? report.layoutSignalLabels : [],
    hotspots,
    issues: sortedIssues,
  };
}

function addDocumentToIssue(issue, doc) {
  return {
    ...issue,
    document: doc.filename,
    documentId: doc.id,
  };
}

function buildPriorityCounts(issues) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const issue of issues) {
    if (Object.hasOwn(counts, issue.priority)) {
      counts[issue.priority] += 1;
    }
  }
  return counts;
}

function buildSummary(options) {
  const verifyPayload = readRequiredJson(options.verifyReportPath, 'verify report');
  const visualRead = readOptionalJson(options.visualAuditReportPath, 'visual audit report');
  const visualAuditStatus = buildVisualAuditStatus(visualRead.payload, visualRead.error, verifyPayload, options);
  const auditIndex = buildAuditIndex(visualRead.payload);
  const extensions = new Set(options.extensions.map(normalizeExtension));
  const reports = Array.isArray(verifyPayload.reports) ? verifyPayload.reports : [];
  const targetReports = reports.filter((report) => isTargetDocument(report, extensions));
  const skippedReports = reports.filter((report) => !isTargetDocument(report, extensions));

  const globalIssues = [];
  if (visualAuditStatus.stale) {
    const priority = options.strictVisualAudit ? 'P0' : 'P2';
    for (const reason of visualAuditStatus.staleReasons) {
      addIssue(globalIssues, priority, 'visual-audit-stale', reason.message, { code: reason.code });
    }
  }

  const documents = targetReports
    .map((report) => buildDocumentSummary(report, findAuditDoc(report, auditIndex), options))
    .sort((a, b) => (
      a.rank - b.rank
      || b.visual.strictFailureCount - a.visual.strictFailureCount
      || b.visual.advisoryCount - a.visual.advisoryCount
      || String(a.filename).localeCompare(String(b.filename), 'ko')
    ));

  const documentIssues = documents.flatMap((doc) => doc.issues.map((issue) => addDocumentToIssue(issue, doc)));
  const priorityIssues = sortIssues([...globalIssues, ...documentIssues]);

  return {
    generatedAt: new Date().toISOString(),
    rootDirectory: ROOT_DIR,
    inputs: {
      verifyReportPath: resolveInputPath(options.verifyReportPath),
      visualAuditReportPath: resolveInputPath(options.visualAuditReportPath),
      verifyGeneratedAt: verifyPayload.generatedAt || '',
    },
    filter: {
      extensions: [...extensions],
      includedDocumentCount: targetReports.length,
      skippedDocumentCount: skippedReports.length,
      skippedDocuments: skippedReports.map((report) => filenameOf(report)),
    },
    visualAuditStatus,
    priorityCounts: buildPriorityCounts(priorityIssues),
    priorityIssues,
    documents,
  };
}

function markdownEscape(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function code(value) {
  const text = String(value || '');
  return text ? `\`${text.replace(/`/g, '\\`')}\`` : '`(none)`';
}

function formatPriorityIssuesMarkdown(issues) {
  if (!issues.length) {
    return ['## Priority Issues', '', 'No priority issues found.', ''];
  }
  const lines = [
    '## Priority Issues',
    '',
    '| priority | document | category | issue |',
    '| --- | --- | --- | --- |',
  ];
  for (const issue of issues) {
    lines.push(`| ${issue.priority} | ${markdownEscape(issue.document || 'global')} | ${markdownEscape(issue.category)} | ${markdownEscape(issue.message)} |`);
  }
  lines.push('');
  return lines;
}

function pageCountLabel(status = {}) {
  const parts = [`${status.state}`];
  if (status.verifyPageCount !== null) parts.push(`verify ${status.verifyPageCount}`);
  if (status.diagnosticPageCount !== null) parts.push(`diag ${status.diagnosticPageCount}`);
  if (status.domPageCount !== null) parts.push(`dom ${status.domPageCount}`);
  if (status.hancomExpectedPages !== null) parts.push(`hancom ${status.hancomExpectedPages}`);
  if (status.visualPageCount !== null) parts.push(`visual ${status.visualPageCount}`);
  return parts.join(' / ');
}

function fontLabel(fonts = {}) {
  if (fonts.label) return fonts.label;
  const parts = [];
  parts.push(fonts.available ? 'rendered diagnostics available' : 'rendered diagnostics not collected');
  if (Array.isArray(fonts.fontsUsed) && fonts.fontsUsed.length) parts.push(`fonts ${fonts.fontsUsed.join(', ')}`);
  if (Array.isArray(fonts.unresolvedFonts) && fonts.unresolvedFonts.length) parts.push(`unresolved ${fonts.unresolvedFonts.join(', ')}`);
  return parts.join(' / ');
}

function visualAuditStatusLabel(status = {}) {
  if (!status.available) return `missing${status.strict ? ' (strict)' : ''}`;
  if (status.stale) return `stale${status.strict ? ' (strict)' : ''}`;
  return `fresh${status.strict ? ' (strict)' : ''}`;
}

function renderMarkdown(summary) {
  const lines = [
    '# HWP Fidelity Targets',
    '',
    `Generated: ${summary.generatedAt}`,
    `Verify report: ${code(summary.inputs.verifyReportPath)}`,
    `Visual audit: ${code(summary.inputs.visualAuditReportPath)}`,
    `Visual audit status: ${visualAuditStatusLabel(summary.visualAuditStatus)}`,
    `Filter: ${summary.filter.extensions.map((extension) => code(extension)).join(', ')}`,
    `Documents: ${summary.filter.includedDocumentCount} included, ${summary.filter.skippedDocumentCount} skipped`,
    '',
  ];

  if (summary.visualAuditStatus.staleReasons.length) {
    lines.push('## Visual Audit Staleness');
    lines.push('');
    for (const reason of summary.visualAuditStatus.staleReasons) {
      lines.push(`- ${reason.code}: ${reason.message}`);
    }
    lines.push('');
  }

  lines.push(...formatPriorityIssuesMarkdown(summary.priorityIssues));

  lines.push('## Documents');
  lines.push('');
  lines.push('| priority | document | page-count | visual verdicts | screenshot | rendered fonts |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const doc of summary.documents) {
    const screenshot = doc.screenshots.verify.path
      ? `${doc.screenshots.verify.exists ? 'ok' : 'missing'} ${doc.screenshots.verify.path}`
      : 'missing';
    lines.push([
      doc.priority,
      markdownEscape(doc.filename),
      markdownEscape(pageCountLabel(doc.pageCountStatus)),
      markdownEscape(formatVerdictCounts(doc.visual.verdictCounts)),
      markdownEscape(screenshot),
      markdownEscape(fontLabel(doc.renderedFontDiagnostics)),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');

  for (const doc of summary.documents) {
    lines.push(`### ${doc.priority} ${doc.filename}`);
    lines.push('');
    lines.push(`- source: ${doc.sourcePath || '(none)'}`);
    lines.push(`- page-count: ${pageCountLabel(doc.pageCountStatus)}`);
    lines.push(`- visual verdicts: ${formatVerdictCounts(doc.visual.verdictCounts)}`);
    lines.push(`- screenshot: ${doc.screenshots.verify.path || '(none)'} (${doc.screenshots.verify.exists ? 'exists' : 'missing'})`);
    lines.push(`- rendered-font-diagnostics: ${fontLabel(doc.renderedFontDiagnostics)}`);
    if (doc.screenshots.visualCompare.path) {
      lines.push(`- primary-visual-compare: ${doc.screenshots.visualCompare.path}`);
    }
    if (doc.issues.length) {
      lines.push(`- issues: ${doc.issues.map((issue) => `${issue.priority} ${issue.message}`).join(' / ')}`);
    } else {
      lines.push('- issues: none');
    }
    if (doc.visual.topPages.length) {
      const pageLabels = doc.visual.topPages.map((page) => {
        const diff = page.diff === null ? 'n/a' : page.diff.toFixed(3);
        return `p${page.pageNumber} ${page.verdict} diff ${diff} compare ${page.pageCompare.path || '(none)'}`;
      });
      lines.push(`- top-visual-pages: ${pageLabels.join(' / ')}`);
    }
    if (doc.hotspots.length) {
      const hotspotLabels = doc.hotspots.map((hotspot) => {
        const signals = hotspot.signalLabels.length ? ` signals ${hotspot.signalLabels.join(', ')}` : '';
        return `p${hotspot.pageNumber} score ${hotspot.score ?? 'n/a'}${signals}`;
      });
      lines.push(`- hotspots: ${hotspotLabels.join(' / ')}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function renderOutput(summary, format) {
  if (format === 'json') {
    return `${JSON.stringify(summary, null, 2)}\n`;
  }
  if (format === 'both') {
    return `${renderMarkdown(summary)}\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`;
  }
  return renderMarkdown(summary);
}

function writeOutput(output, outPath) {
  if (!outPath) {
    process.stdout.write(output);
    return;
  }
  const absolutePath = resolveInputPath(outPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, output);
  console.error(`Wrote ${absolutePath}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = buildSummary(options);
  writeOutput(renderOutput(summary, options.format), options.outPath);
}

main();
