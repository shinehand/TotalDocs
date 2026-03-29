#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const PWCLI = process.env.PWCLI || path.join(CODEX_HOME, 'skills', 'playwright', 'scripts', 'playwright_cli.sh');
const VIEWER_URL = process.env.VIEWER_URL || 'http://127.0.0.1:4174/pages/viewer.html';
const SESSION_NAME = 'verify-current';

const HWP_SAMPLE = process.env.HWP_SAMPLE
  || '/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/goyeopje.hwp';
const HWPX_SAMPLE = process.env.HWPX_SAMPLE
  || '/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/incheon-2a.hwpx';
const ATTACHMENT_HWP_SAMPLE = process.env.ATTACHMENT_HWP_SAMPLE
  || '/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/attachment-sale-notice.hwp';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function ensureFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} 파일을 찾지 못했습니다: ${filePath}`);
  }
}

function runPw(args) {
  try {
    return execFileSync(PWCLI, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        CODEX_HOME,
        PLAYWRIGHT_CLI_SESSION: SESSION_NAME,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString?.() || '';
    const stdout = error?.stdout?.toString?.() || '';
    fail(`Playwright 명령 실패: ${args.join(' ')}\n${stdout}\n${stderr}`.trim());
  }
}

function extractSnapshotPath(commandOutput) {
  const match = commandOutput.match(/\[Snapshot\]\(([^)]+)\)/);
  if (!match) return '';
  return match[1];
}

function loadSnapshot(commandOutput) {
  const rel = extractSnapshotPath(commandOutput);
  if (!rel) {
    fail('snapshot 경로를 찾지 못했습니다.');
  }
  const abs = path.resolve(ROOT_DIR, rel);
  if (!existsSync(abs)) {
    fail(`snapshot 파일이 존재하지 않습니다: ${abs}`);
  }
  return readFileSync(abs, 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractButtonRef(snapshot, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = snapshot.match(new RegExp(`button "${escaped}" \\[ref=(e\\d+)\\]`));
    if (match) return match[1];
  }
  return '';
}

async function uploadFile(filePath) {
  for (const directRef of ['e8', 'e15']) {
    try {
      runPw(['click', directRef]);
      runPw(['upload', filePath]);
      return;
    } catch {}
  }

  let ref = '';
  let lastSnapshot = '';
  const started = Date.now();
  while (!ref && Date.now() - started < 8000) {
    const snapOut = runPw(['snapshot']);
    lastSnapshot = loadSnapshot(snapOut);
    ref = extractButtonRef(lastSnapshot, ['파일 선택', '📂 파일 열기']);
    if (ref) break;
    await sleep(500);
  }

  if (!ref) {
    if (/button "📂 파일 열기" \[ref=e8\]/.test(lastSnapshot)) {
      ref = 'e8';
    } else if (/button "파일 선택" \[ref=e15\]/.test(lastSnapshot)) {
      ref = 'e15';
    } else {
      fail('파일 업로드 버튼 ref를 찾지 못했습니다.');
    }
  }

  runPw(['click', ref]);
  runPw(['upload', filePath]);
}

async function waitForCondition(name, predicate, timeoutMs = 12000, intervalMs = 600) {
  const started = Date.now();
  let lastSnapshot = '';

  while (Date.now() - started < timeoutMs) {
    const snapOut = runPw(['snapshot']);
    lastSnapshot = loadSnapshot(snapOut);
    if (predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await sleep(intervalMs);
  }

  fail(`${name} 대기 시간 초과`);
}

function assertSnapshot(snapshot, checks) {
  const failures = checks.filter(check => !check.test(snapshot));
  if (failures.length) {
    const details = failures.map(check => `- ${check.name}`).join('\n');
    fail(`회귀검증 실패\n${details}`);
  }
}

async function verifyHwp() {
  await uploadFile(HWP_SAMPLE);
  const snapshot = await waitForCondition(
    'HWP 로드',
    text => /goyeopje\.hwp/.test(text) || /3 페이지/.test(text),
  );

  assertSnapshot(snapshot, [
    {
      name: 'HWP 페이지 수(3페이지) 확인 실패',
      test: text => /3 페이지/.test(text),
    },
    {
      name: 'HWP 핵심 키워드(등록신청서/처리기간) 확인 실패',
      test: text => /등록신청서|처리기간/.test(text),
    },
    {
      name: 'HWP 파일명 배지 확인 실패',
      test: text => /goyeopje\.hwp/.test(text),
    },
  ]);
}

async function verifyHwpx() {
  await uploadFile(HWPX_SAMPLE);
  const snapshot = await waitForCondition(
    'HWPX 로드',
    text => /incheon-2a\.hwpx/.test(text) || /5 페이지/.test(text),
  );

  assertSnapshot(snapshot, [
    {
      name: 'HWPX 페이지 수(5페이지) 확인 실패',
      test: text => /5 페이지/.test(text),
    },
    {
      name: 'HWPX 첫 페이지 핵심 문구 확인 실패',
      test: text => /신혼희망타운\(공공분양\)|추가 입주자모집공고/.test(text),
    },
    {
      name: 'HWPX 파일명 배지 확인 실패',
      test: text => /incheon-2a\.hwpx/.test(text),
    },
  ]);
}

async function verifyAttachmentHwp() {
  await uploadFile(ATTACHMENT_HWP_SAMPLE);
  const snapshot = await waitForCondition(
    '추가 HWP 로드',
    text => /attachment-sale-notice\.hwp/.test(text) || /알려드립니다|동·호지정 및 계약체결/.test(text),
    15000,
  );

  assertSnapshot(snapshot, [
    {
      name: '추가 HWP 파일명 배지 확인 실패',
      test: text => /attachment-sale-notice\.hwp/.test(text),
    },
    {
      name: '추가 HWP 핵심 안내 문구 확인 실패',
      test: text => /알려드립니다|선착순 일반매각/.test(text),
    },
    {
      name: '추가 HWP 일정 표 구조 확인 실패',
      test: text => /동·호지정 및 계약체결/.test(text),
    },
    {
      name: '추가 HWP 상단 배너 이미지 확인 실패',
      test: text => /img "BIN000[12]\.png"/.test(text),
    },
  ]);
}

async function main() {
  if (!existsSync(PWCLI)) {
    fail(`playwright_cli.sh 경로를 찾지 못했습니다: ${PWCLI}`);
  }

  ensureFileExists(HWP_SAMPLE, 'HWP 샘플');
  ensureFileExists(HWPX_SAMPLE, 'HWPX 샘플');
  ensureFileExists(ATTACHMENT_HWP_SAMPLE, '추가 HWP 샘플');

  runPw(['close-all']);
  runPw(['open', VIEWER_URL]);

  try {
    await verifyHwp();
    await verifyHwpx();
    await verifyAttachmentHwp();
    console.log('✓ 샘플 회귀검증 통과');
    console.log(`- session: ${SESSION_NAME}`);
    console.log(`- hwp: ${HWP_SAMPLE}`);
    console.log(`- hwpx: ${HWPX_SAMPLE}`);
    console.log(`- attachment: ${ATTACHMENT_HWP_SAMPLE}`);
  } finally {
    runPw(['close-all']);
  }
}

await main();
