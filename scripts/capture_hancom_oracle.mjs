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
const SCREENSHOT_SKILL_DIR = path.join(CODEX_HOME, 'skills', 'screenshot', 'scripts');
const SCREENSHOT_PY = path.join(SCREENSHOT_SKILL_DIR, 'take_screenshot.py');
const SCREENSHOT_PERMISSION_SH = path.join(SCREENSHOT_SKILL_DIR, 'ensure_macos_permissions.sh');
const PWCLI = process.env.PWCLI || path.join(CODEX_HOME, 'skills', 'playwright', 'scripts', 'playwright_cli.sh');
const VIEWER_URL = process.env.VIEWER_URL || 'http://127.0.0.1:4173/pages/viewer.html';
const VIEWER_FONT_OVERRIDES = process.env.VIEWER_FONT_OVERRIDES || '';
const VERIFY_REPORT_PATH = process.env.VERIFY_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-report.json');
const OUTPUT_DIR = process.env.HANCOM_ORACLE_DIR
  || path.join(ROOT_DIR, 'output', 'hancom-oracle');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'hancom-oracle-manifest.json');
const MARKDOWN_PATH = path.join(OUTPUT_DIR, 'hancom-oracle-report.md');
const HTML_PATH = path.join(OUTPUT_DIR, 'hancom-oracle-report.html');
const HANCOM_APP_PATH = process.env.HANCOM_VIEWER_APP || '/Applications/Hancom Office HWP Viewer.app';
const HANCOM_APP_NAME = process.env.HANCOM_VIEWER_NAME || 'Hancom Office HWP Viewer';
const HANCOM_WINDOW_QUERY = process.env.HANCOM_WINDOW_QUERY || '한글';
const HANCOM_OPEN_WAIT_MS = Number(process.env.HANCOM_OPEN_WAIT_MS || 2500);
const HANCOM_WINDOW_RETRIES = Number(process.env.HANCOM_WINDOW_RETRIES || 12);
const HANCOM_RETRY_DELAY_MS = Number(process.env.HANCOM_RETRY_DELAY_MS || 700);
const CHROME_LOAD_WAIT_MS = Number(process.env.HANCOM_CHROME_LOAD_WAIT_MS || 3500);
const HANCOM_RESET_FIRST_PAGE = process.env.HANCOM_RESET_FIRST_PAGE !== '0';
const HANCOM_PAGE_RESET_WAIT_MS = Number(process.env.HANCOM_PAGE_RESET_WAIT_MS || 500);

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

function slugForPath(filePath = '') {
  return String(filePath)
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

function relativeFromOutput(filePath) {
  return path.relative(OUTPUT_DIR, filePath).split(path.sep).join('/');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function asAppleScriptString(value = '') {
  return JSON.stringify(String(value));
}

function buildViewerUrl(servedUrl) {
  const target = new URL(VIEWER_URL);
  target.searchParams.set('hwpUrl', servedUrl);
  if (VIEWER_FONT_OVERRIDES) {
    target.searchParams.set('fontOverrides', VIEWER_FONT_OVERRIDES);
  }
  return target.toString();
}

function ensureDependencies() {
  if (!existsSync(VERIFY_REPORT_PATH)) {
    fail(`QA 리포트를 찾지 못했습니다: ${VERIFY_REPORT_PATH}`);
  }
  if (!existsSync(SCREENSHOT_PY)) {
    fail(`screenshot helper를 찾지 못했습니다: ${SCREENSHOT_PY}`);
  }
  if (!existsSync(SCREENSHOT_PERMISSION_SH)) {
    fail(`screenshot permission helper를 찾지 못했습니다: ${SCREENSHOT_PERMISSION_SH}`);
  }
  if (!existsSync(PWCLI)) {
    fail(`playwright helper를 찾지 못했습니다: ${PWCLI}`);
  }
  if (!existsSync(HANCOM_APP_PATH)) {
    fail(`한컴 Viewer 앱을 찾지 못했습니다: ${HANCOM_APP_PATH}`);
  }
}

function loadReports() {
  const payload = JSON.parse(readFileSync(VERIFY_REPORT_PATH, 'utf8'));
  const reports = Array.isArray(payload?.reports) ? payload.reports : [];
  if (!reports.length) {
    fail(`QA 리포트에 reports 항목이 비어 있사옵니다: ${VERIFY_REPORT_PATH}`);
  }
  return reports;
}

function runScreenshotPermissionPreflight() {
  run('bash', [SCREENSHOT_PERMISSION_SH]);
}

function listHancomWindows() {
  const output = run('python3', [SCREENSHOT_PY, '--list-windows', '--app', HANCOM_WINDOW_QUERY]);
  const normalized = String(output || '').trim();
  if (!normalized || normalized.includes('no matching windows found')) {
    return [];
  }

  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, appName, title, geometry] = line.split('\t');
      return {
        id: Number(id),
        appName: appName || '',
        title: title || '',
        geometry: geometry || '',
      };
    })
    .filter((item) => Number.isFinite(item.id));
}

function normalizeMatch(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()[\]{}_.-]/g, '');
}

function pickHancomWindow(windows, report) {
  if (windows.length === 1) {
    return windows[0];
  }

  const basename = path.basename(report.sourcePath || report.filePath || report.filename || '');
  const basenameNoExt = path.basename(basename, path.extname(basename));
  const servedBase = path.basename(report.filename || '');
  const candidates = [basename, basenameNoExt, servedBase, report.id]
    .map(normalizeMatch)
    .filter(Boolean);

  let bestWindow = null;
  let bestScore = -1;
  for (const windowInfo of windows) {
    const title = normalizeMatch(windowInfo.title);
    let score = 0;
    for (const candidate of candidates) {
      if (!candidate) continue;
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

function parseGeometry(geometry = '') {
  const match = String(geometry).match(/(\d+)x(\d+)([+-]\d+)([+-]\d+)/);
  if (!match) {
    return null;
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

function openInHancom(filePath) {
  run('open', ['-a', HANCOM_APP_PATH, filePath]);
  run('osascript', ['-e', `tell application "${HANCOM_APP_NAME}" to activate`]);
  sleep(HANCOM_OPEN_WAIT_MS);
}

function waitForHancomWindow(report) {
  for (let attempt = 0; attempt < HANCOM_WINDOW_RETRIES; attempt += 1) {
    const windows = listHancomWindows();
    const picked = pickHancomWindow(windows, report);
    if (picked) {
      return picked;
    }
    sleep(HANCOM_RETRY_DELAY_MS);
  }
  return null;
}

function resetHancomToFirstPage(windowInfo = null) {
  if (!HANCOM_RESET_FIRST_PAGE) {
    return;
  }

  const windowTitle = windowInfo?.title ? asAppleScriptString(windowInfo.title) : '""';
  tryRun('osascript', [
    '-e', `tell application "${HANCOM_APP_NAME}" to activate`,
    '-e', 'delay 0.1',
    '-e', 'tell application "System Events"',
    '-e', `  tell process "${HANCOM_APP_NAME}"`,
    '-e', '    set frontmost to true',
    '-e', '    set targetWindow to missing value',
    '-e', `    if ${windowTitle} is not "" and exists (first window whose name is ${windowTitle}) then`,
    '-e', `      set targetWindow to first window whose name is ${windowTitle}`,
    '-e', '    else if (count of windows) > 0 then',
    '-e', '      set targetWindow to window 1',
    '-e', '    end if',
    '-e', '    if targetWindow is not missing value then',
    '-e', '      try',
    '-e', '        perform action "AXRaise" of targetWindow',
    '-e', '      end try',
    '-e', '      delay 0.1',
    '-e', '      try',
    '-e', '        set value of scroll bar 1 of scroll area 1 of targetWindow to 0',
    '-e', '      end try',
    '-e', '      delay 0.15',
    '-e', '    end if',
    '-e', '    key code 115 using {command down}',
    '-e', '    delay 0.1',
    '-e', '    key code 126 using {command down}',
    '-e', '    delay 0.1',
    '-e', '    key code 115',
    '-e', '  end tell',
    '-e', 'end tell',
  ]);
  sleep(HANCOM_PAGE_RESET_WAIT_MS);
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
  if (!existsSync(savedPath)) {
    fail(`한컴 기준선 캡처 실패: ${savedPath}`);
  }
  return savedPath;
}

function captureChromeHwp(report, destinationPath, viewport = {}) {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const sessionName = `or-${shortHash(report.id || report.filename)}`;
  const width = Number.isFinite(viewport.width) ? viewport.width : 1400;
  const height = Number.isFinite(viewport.height) ? viewport.height : 1000;
  const viewerTarget = buildViewerUrl(report.servedUrl);

  tryRun(PWCLI, ['-s', sessionName, 'close-all'], { env: process.env });
  let screenshotOutput = '';
  try {
    run(PWCLI, ['-s', sessionName, 'open', viewerTarget], { env: process.env });
    run(PWCLI, ['-s', sessionName, 'resize', String(width), String(height)], { env: process.env });
    sleep(CHROME_LOAD_WAIT_MS);
    screenshotOutput = run(PWCLI, ['-s', sessionName, 'screenshot'], { env: process.env });
  } finally {
    tryRun(PWCLI, ['-s', sessionName, 'close-all'], { env: process.env });
  }

  const match = screenshotOutput.match(/\[Screenshot of [^\]]+\]\(([^)]+\.png)\)/);
  if (!match) {
    fail(`ChromeHWP 스크린샷 경로를 파싱하지 못했사옵니다.\n${screenshotOutput}`);
  }

  const sourcePath = path.resolve(ROOT_DIR, match[1]);
  if (!existsSync(sourcePath)) {
    fail(`ChromeHWP 스크린샷 파일이 존재하지 않사옵니다: ${sourcePath}`);
  }

  copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function buildMarkdown(entries) {
  const lines = [
    '# Hancom Oracle Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `QA Report: ${VERIFY_REPORT_PATH}`,
    '',
    '한컴 Viewer를 정답 기준으로 삼아, 같은 문서의 한컴 화면과 ChromeHWP 화면을 짝지은 비교 산출물이옵니다.',
    '',
  ];

  for (const entry of entries) {
    lines.push(`## ${entry.filename}`);
    lines.push('');
    lines.push(`- source: ${entry.sourcePath}`);
    lines.push(`- page: ${entry.pageInfo || '알 수 없음'}`);
    lines.push(`- hancom-window: ${entry.hancomTitle} (${entry.hancomGeometry})`);
    lines.push(`- hancom-screenshot: ${entry.hancomScreenshot}`);
    lines.push(`- chromehwp-screenshot: ${entry.chromeHwpScreenshot}`);
    if (Array.isArray(entry.layoutSignalLabels) && entry.layoutSignalLabels.length) {
      lines.push(`- layout-signals: ${entry.layoutSignalLabels.join(' · ')}`);
    }
    if (Array.isArray(entry.hotspotSummary) && entry.hotspotSummary.length) {
      lines.push(`- hotspots: ${entry.hotspotSummary.join(' / ')}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function buildHtml(entries) {
  const cards = entries.map((entry) => {
    const layoutSignals = Array.isArray(entry.layoutSignalLabels) && entry.layoutSignalLabels.length
      ? `<p><strong>신호</strong> ${escapeHtml(entry.layoutSignalLabels.join(' · '))}</p>`
      : '';
    const hotspots = Array.isArray(entry.hotspotSummary) && entry.hotspotSummary.length
      ? `<p><strong>집중 확인</strong> ${escapeHtml(entry.hotspotSummary.join(' / '))}</p>`
      : '';

    return `
      <section class="card">
        <header class="card-header">
          <h2>${escapeHtml(entry.filename)}</h2>
          <p>${escapeHtml(entry.sourcePath)}</p>
          <p><strong>쪽</strong> ${escapeHtml(entry.pageInfo || '알 수 없음')}</p>
          <p><strong>한컴 창</strong> ${escapeHtml(entry.hancomTitle)} (${escapeHtml(entry.hancomGeometry)})</p>
          ${layoutSignals}
          ${hotspots}
        </header>
        <div class="compare-grid">
          <figure>
            <figcaption>Hancom Viewer</figcaption>
            <img src="${escapeHtml(relativeFromOutput(entry.hancomScreenshot))}" alt="${escapeHtml(entry.filename)} Hancom Viewer">
          </figure>
          <figure>
            <figcaption>ChromeHWP</figcaption>
            <img src="${escapeHtml(relativeFromOutput(entry.chromeHwpScreenshot))}" alt="${escapeHtml(entry.filename)} ChromeHWP">
          </figure>
        </div>
      </section>
    `;
  }).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hancom Oracle Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f0ea;
      --panel: #fffdfa;
      --border: #d8d0c3;
      --ink: #1d1a16;
      --muted: #6e6559;
      --accent: #8a2d2d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Pretendard", "SUIT", "Apple SD Gothic Neo", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(157, 115, 53, 0.08), transparent 30%),
        linear-gradient(180deg, #f6f2ea 0%, #efe8dc 100%);
    }
    main {
      width: min(1800px, calc(100vw - 48px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
    }
    .intro {
      margin: 0 0 28px;
      color: var(--muted);
      line-height: 1.55;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 22px;
      margin-bottom: 24px;
      box-shadow: 0 18px 48px rgba(60, 43, 17, 0.08);
    }
    .card-header h2 {
      margin: 0 0 6px;
      font-size: 24px;
    }
    .card-header p {
      margin: 4px 0;
      color: var(--muted);
    }
    .compare-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-top: 18px;
    }
    figure {
      margin: 0;
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      background: #f7f3ed;
    }
    figcaption {
      padding: 12px 14px;
      font-weight: 700;
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      background: rgba(138, 45, 45, 0.05);
    }
    img {
      display: block;
      width: 100%;
      height: auto;
      background: white;
    }
    @media (max-width: 980px) {
      main { width: min(100vw - 24px, 1800px); }
      .compare-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Hancom Oracle Report</h1>
    <p class="intro">한컴 Viewer를 정답 기준선으로 삼아, 같은 문서를 같은 시점에 캡처한 비교판이옵니다. 이후 조판 수술은 이 화면쌍을 기준으로 진행하옵니다.</p>
    ${cards}
  </main>
</body>
</html>
`;
}

function buildEntries(reports) {
  const entries = [];
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const report of reports) {
    if (!report?.sourcePath || !report?.servedUrl) {
      continue;
    }
    if (!existsSync(report.sourcePath)) {
      console.warn(`- skip ${report.filename}: source not found ${report.sourcePath}`);
      continue;
    }

    console.log(`→ ${report.filename} 기준선 캡처 중...`);
    openInHancom(report.sourcePath);
    const windowInfo = waitForHancomWindow(report);
    if (!windowInfo) {
      console.warn(`- skip ${report.filename}: 한컴 창을 찾지 못했사옵니다.`);
      continue;
    }
    resetHancomToFirstPage(windowInfo);

    const geometry = parseGeometry(windowInfo.geometry);
    const hancomScreenshot = captureHancomWindow(
      windowInfo,
      path.join(OUTPUT_DIR, `${report.id}-hancom.png`),
    );
    const chromeHwpScreenshot = captureChromeHwp(
      report,
      path.join(OUTPUT_DIR, `${report.id}-chromehwp.png`),
      geometry || {},
    );

    entries.push({
      id: report.id,
      filename: report.filename,
      sourcePath: report.sourcePath,
      servedUrl: report.servedUrl,
      pageInfo: report.pageInfo || '',
      hancomWindowId: windowInfo.id,
      hancomTitle: windowInfo.title,
      hancomGeometry: windowInfo.geometry,
      hancomScreenshot,
      chromeHwpScreenshot,
      layoutSignalLabels: Array.isArray(report.layoutSignalLabels) ? report.layoutSignalLabels : [],
      hotspotSummary: Array.isArray(report.hotspots)
        ? report.hotspots.map((hotspot) => {
          const pageIndex = Number.isFinite(hotspot?.pageIndex) ? hotspot.pageIndex : 0;
          return `${pageIndex + 1}쪽`;
        })
        : [],
    });
  }

  return entries;
}

function main() {
  ensureDependencies();
  runScreenshotPermissionPreflight();
  const reports = loadReports();
  const entries = buildEntries(reports);
  if (!entries.length) {
    fail('캡처된 한컴 기준선이 없사옵니다.');
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    verifyReportPath: VERIFY_REPORT_PATH,
    outputDirectory: OUTPUT_DIR,
    count: entries.length,
    entries,
  }, null, 2)}\n`);
  writeFileSync(MARKDOWN_PATH, buildMarkdown(entries));
  writeFileSync(HTML_PATH, buildHtml(entries));

  console.log(`✓ manifest: ${MANIFEST_PATH}`);
  console.log(`✓ report: ${MARKDOWN_PATH}`);
  console.log(`✓ html: ${HTML_PATH}`);
}

main();
