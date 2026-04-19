#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const PWCLI = process.env.PWCLI || path.join(CODEX_HOME, 'skills', 'playwright', 'scripts', 'playwright_cli.sh');
const SCREENSHOT_PY = path.join(CODEX_HOME, 'skills', 'screenshot', 'scripts', 'take_screenshot.py');
const SCREENSHOT_PERMISSION_SH = path.join(CODEX_HOME, 'skills', 'screenshot', 'scripts', 'ensure_macos_permissions.sh');
const VIEWER_URL = process.env.VIEWER_URL || 'http://127.0.0.1:4173/pages/viewer.html';
const VERIFY_REPORT_PATH = process.env.VERIFY_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-report.json');
const OUTPUT_DIR = process.env.HANCOM_PAGE_AUDIT_DIR
  || path.join(ROOT_DIR, 'output', 'hancom-oracle', 'page-audit');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'hancom-page-audit-manifest.json');
const HANCOM_APP_PATH = process.env.HANCOM_VIEWER_APP || '/Applications/Hancom Office HWP Viewer.app';
const HANCOM_APP_NAME = process.env.HANCOM_VIEWER_NAME || 'Hancom Office HWP Viewer';
const HANCOM_WINDOW_QUERY = process.env.HANCOM_WINDOW_QUERY || '한글';
const HANCOM_OPEN_WAIT_MS = Number(process.env.HANCOM_OPEN_WAIT_MS || 2500);
const HANCOM_SCROLL_WAIT_MS = Number(process.env.HANCOM_PAGE_SCROLL_WAIT_MS || 650);
const HANCOM_ZOOM = Number(process.env.HANCOM_PAGE_AUDIT_ZOOM || 50);
const HANCOM_WINDOW_WIDTH = Number(process.env.HANCOM_PAGE_AUDIT_WINDOW_WIDTH || 1120);
const HANCOM_WINDOW_HEIGHT = Number(process.env.HANCOM_PAGE_AUDIT_WINDOW_HEIGHT || 1340);
const CHROME_LOAD_WAIT_MS = Number(process.env.HANCOM_CHROME_LOAD_WAIT_MS || 3500);
const FILTER_IDS = new Set((process.env.HANCOM_PAGE_AUDIT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function tryRun(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch {
    return '';
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function slug(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .toLowerCase() || 'document';
}

function shortHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parsePageCount(report) {
  if (Number.isFinite(report?.pageCount) && report.pageCount > 0) {
    return report.pageCount;
  }
  const match = String(report?.pageInfo || '').match(/(\d+)\s*\/\s*(\d+)\s*쪽/);
  return match ? Number(match[2]) : 0;
}

function asAppleScriptString(value = '') {
  return JSON.stringify(String(value));
}

function ensureDependencies() {
  if (!existsSync(VERIFY_REPORT_PATH)) fail(`QA 리포트를 찾지 못했사옵니다: ${VERIFY_REPORT_PATH}`);
  if (!existsSync(PWCLI)) fail(`playwright helper를 찾지 못했사옵니다: ${PWCLI}`);
  if (!existsSync(SCREENSHOT_PY)) fail(`screenshot helper를 찾지 못했사옵니다: ${SCREENSHOT_PY}`);
  if (!existsSync(SCREENSHOT_PERMISSION_SH)) fail(`screenshot permission helper를 찾지 못했사옵니다: ${SCREENSHOT_PERMISSION_SH}`);
  if (!existsSync(HANCOM_APP_PATH)) fail(`한컴 Viewer 앱을 찾지 못했사옵니다: ${HANCOM_APP_PATH}`);
}

function loadReports() {
  const payload = JSON.parse(readFileSync(VERIFY_REPORT_PATH, 'utf8'));
  return (Array.isArray(payload?.reports) ? payload.reports : [])
    .filter((report) => !report.fatal && report.sourcePath && report.servedUrl)
    .filter((report) => FILTER_IDS.size === 0 || FILTER_IDS.has(report.id));
}

function normalizeMatch(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()[\]{}_.-]/g, '');
}

function listHancomWindows() {
  const output = run('python3', [SCREENSHOT_PY, '--list-windows', '--app', HANCOM_WINDOW_QUERY]);
  return String(output || '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('no matching windows found'))
    .map((line) => {
      const [id, appName, title, geometry] = line.split('\t');
      return { id: Number(id), appName: appName || '', title: title || '', geometry: geometry || '' };
    })
    .filter((item) => Number.isFinite(item.id));
}

function pickHancomWindow(windows, report) {
  const basename = path.basename(report.sourcePath || report.filename || '');
  const basenameNoExt = path.basename(basename, path.extname(basename));
  const candidates = [basename, basenameNoExt, report.filename, report.id]
    .map(normalizeMatch)
    .filter(Boolean);

  let bestWindow = null;
  let bestScore = -1;
  for (const windowInfo of windows) {
    const title = normalizeMatch(windowInfo.title);
    let score = 0;
    for (const candidate of candidates) {
      if (title === candidate) score += 1000;
      else if (title.includes(candidate)) score += 400;
      else if (candidate.includes(title) && title) score += 150;
    }
    if (score > bestScore) {
      bestScore = score;
      bestWindow = windowInfo;
    }
  }
  return bestScore > 0 ? bestWindow : windows[windows.length - 1] || null;
}

function openInHancom(filePath) {
  run('open', ['-a', HANCOM_APP_PATH, filePath]);
  run('osascript', ['-e', `tell application "${HANCOM_APP_NAME}" to activate`]);
  sleep(HANCOM_OPEN_WAIT_MS);
}

function waitForHancomWindow(report) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const picked = pickHancomWindow(listHancomWindows(), report);
    if (picked) return picked;
    sleep(650);
  }
  return null;
}

function configureHancomWindow(windowInfo) {
  const title = asAppleScriptString(windowInfo.title);
  tryRun('osascript', [
    '-e', `tell application "${HANCOM_APP_NAME}" to activate`,
    '-e', 'delay 0.1',
    '-e', 'tell application "System Events"',
    '-e', `  tell process "${HANCOM_APP_NAME}"`,
    '-e', '    set frontmost to true',
    '-e', `    if exists (first window whose name is ${title}) then`,
    '-e', `      tell first window whose name is ${title}`,
    '-e', '        try',
    '-e', '          set position to {56, 38}',
    '-e', `          set size to {${HANCOM_WINDOW_WIDTH}, ${HANCOM_WINDOW_HEIGHT}}`,
    '-e', '        end try',
    '-e', '        try',
    '-e', `          set value of slider 1 to ${HANCOM_ZOOM}`,
    '-e', '        end try',
    '-e', '      end tell',
    '-e', '    end if',
    '-e', '  end tell',
    '-e', 'end tell',
  ]);
  sleep(700);
}

function setHancomScroll(windowInfo, ratio) {
  const title = asAppleScriptString(windowInfo.title);
  const value = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  tryRun('osascript', [
    '-e', `tell application "${HANCOM_APP_NAME}" to activate`,
    '-e', 'delay 0.05',
    '-e', 'tell application "System Events"',
    '-e', `  tell process "${HANCOM_APP_NAME}"`,
    '-e', '    set frontmost to true',
    '-e', `    if exists (first window whose name is ${title}) then`,
    '-e', `      tell first window whose name is ${title}`,
    '-e', '        try',
    '-e', '          perform action "AXRaise"',
    '-e', '        end try',
    '-e', '        try',
    '-e', `          set value of scroll bar 1 of scroll area 1 to ${value}`,
    '-e', '        end try',
    '-e', '      end tell',
    '-e', '    end if',
    '-e', '  end tell',
    '-e', 'end tell',
  ]);
  sleep(HANCOM_SCROLL_WAIT_MS);
}

function captureHancomWindow(windowInfo, destinationPath) {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const output = run('python3', [
    SCREENSHOT_PY,
    '--window-id',
    String(windowInfo.id),
    '--path',
    destinationPath,
  ]);
  const savedPath = String(output || '').trim().split('\n').pop() || destinationPath;
  if (!existsSync(savedPath)) fail(`한컴 페이지 캡처 실패: ${savedPath}`);
  if (savedPath !== destinationPath) copyFileSync(savedPath, destinationPath);
  return destinationPath;
}

function buildViewerUrl(servedUrl, auditId) {
  const target = new URL(VIEWER_URL);
  target.searchParams.set('hwpUrl', servedUrl);
  target.searchParams.set('engineBust', auditId);
  return target.toString();
}

function extractResult(output) {
  const text = String(output || '');
  const match = text.match(/### Result\s+([\s\S]*?)### Ran Playwright code/);
  return (match ? match[1] : text).trim();
}

function parsePlaywrightValue(output) {
  const raw = extractResult(output);
  const parsed = JSON.parse(raw);
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
}

function runPw(sessionName, args) {
  return run(PWCLI, ['-s', sessionName, ...args], {
    env: { ...process.env, CODEX_HOME },
  });
}

function captureChromePages(report, docDir, pageCount, auditId) {
  const sessionName = `audit-${shortHash(report.id || report.filename)}`;
  const viewerTarget = buildViewerUrl(report.servedUrl, auditId);
  const pages = [];

  tryRun(PWCLI, ['-s', sessionName, 'close-all'], { env: process.env });
  try {
    runPw(sessionName, ['open', viewerTarget]);
    runPw(sessionName, ['resize', '1440', '1800']);
    sleep(CHROME_LOAD_WAIT_MS);
    const countOutput = runPw(sessionName, [
      'eval',
      '(() => document.querySelectorAll(".hwp-page-canvas canvas").length)()',
    ]);
    const canvasCount = Number(parsePlaywrightValue(countOutput));
    if (canvasCount < pageCount) {
      fail(`${report.filename}: Chrome canvas 수 부족 ${canvasCount}/${pageCount}`);
    }

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const output = runPw(sessionName, [
        'eval',
        `(() => {
          const canvas = document.querySelectorAll(".hwp-page-canvas canvas")[${pageIndex}];
          if (!canvas) return "";
          return canvas.toDataURL("image/png");
        })()`,
      ]);
      const dataUrl = parsePlaywrightValue(output);
      const base64 = String(dataUrl).split(',')[1] || '';
      if (!base64) fail(`${report.filename} ${pageIndex + 1}쪽 Chrome 캔버스 추출 실패`);
      const chromePath = path.join(docDir, `chrome-page-${String(pageIndex + 1).padStart(3, '0')}.png`);
      writeFileSync(chromePath, Buffer.from(base64, 'base64'));
      pages.push({ pageIndex, chromePage: chromePath });
    }
  } finally {
    tryRun(PWCLI, ['-s', sessionName, 'close-all'], { env: process.env });
  }

  return pages;
}

function captureHancomPages(report, docDir, pageCount) {
  openInHancom(report.sourcePath);
  const windowInfo = waitForHancomWindow(report);
  if (!windowInfo) fail(`${report.filename}: 한컴 창을 찾지 못했사옵니다.`);
  configureHancomWindow(windowInfo);

  const pages = [];
  const topPageDenominator = Math.max(1, pageCount - 2);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const ratio = pageCount <= 1 ? 0 : Math.min(1, pageIndex / topPageDenominator);
    const targetBand = pageCount > 1 && pageIndex === pageCount - 1 ? 'last' : 'first';
    setHancomScroll(windowInfo, ratio);
    const hancomPath = path.join(docDir, `hancom-page-${String(pageIndex + 1).padStart(3, '0')}.png`);
    captureHancomWindow(windowInfo, hancomPath);
    pages.push({ pageIndex, hancomScreenshot: hancomPath, scrollRatio: ratio, targetBand });
  }

  return {
    windowId: windowInfo.id,
    windowTitle: windowInfo.title,
    windowGeometry: windowInfo.geometry,
    pages,
  };
}

function main() {
  ensureDependencies();
  run('bash', [SCREENSHOT_PERMISSION_SH]);

  const reports = loadReports();
  if (!reports.length) fail('감사 대상 QA report가 비어 있사옵니다.');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const auditId = `page-audit-${Date.now()}`;
  const documents = [];

  for (const report of reports) {
    const pageCount = parsePageCount(report);
    if (!pageCount) {
      console.warn(`- skip ${report.filename}: pageCount 없음`);
      continue;
    }
    const docId = report.id || slug(report.filename);
    const docDir = path.join(OUTPUT_DIR, docId);
    mkdirSync(docDir, { recursive: true });

    console.log(`→ ${report.filename}: ${pageCount}쪽 전체 캡처`);
    const chromePages = captureChromePages(report, docDir, pageCount, auditId);
    const hancomCapture = captureHancomPages(report, docDir, pageCount);
    const chromeByIndex = new Map(chromePages.map((page) => [page.pageIndex, page]));
    const pages = hancomCapture.pages.map((page) => ({
      ...page,
      chromePage: chromeByIndex.get(page.pageIndex)?.chromePage || '',
    }));

    documents.push({
      id: docId,
      filename: report.filename,
      sourcePath: report.sourcePath,
      servedUrl: report.servedUrl,
      pageCount,
      hancomWindowId: hancomCapture.windowId,
      hancomTitle: hancomCapture.windowTitle,
      hancomGeometry: hancomCapture.windowGeometry,
      pages,
    });
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    auditId,
    verifyReportPath: VERIFY_REPORT_PATH,
    outputDirectory: OUTPUT_DIR,
    hancomZoom: HANCOM_ZOOM,
    count: documents.length,
    totalPages: documents.reduce((sum, doc) => sum + doc.pageCount, 0),
    documents,
  }, null, 2)}\n`);

  console.log(`✓ manifest: ${MANIFEST_PATH}`);
  console.log(`✓ documents: ${documents.length}`);
  console.log(`✓ pages: ${documents.reduce((sum, doc) => sum + doc.pageCount, 0)}`);
}

main();
