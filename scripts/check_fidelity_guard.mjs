#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const VERIFY_REPORT_PATH = process.env.VERIFY_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'playwright', 'verify-samples-report.json');
const HANCOM_PAGE_AUDIT_REPORT_PATH = process.env.HANCOM_PAGE_AUDIT_REPORT_PATH
  || path.join(ROOT_DIR, 'output', 'hancom-oracle', 'page-audit', 'hancom-page-audit-report.json');
const REQUIRE_VISUAL_AUDIT = process.env.FIDELITY_REQUIRE_VISUAL_AUDIT === '1';
const VISUAL_MAX_AGE_HOURS = Number(process.env.FIDELITY_VISUAL_MAX_AGE_HOURS || 24);

function readJson(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} 파일이 없습니다: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
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

function pushVisualAuditIssue(warnings, failures, message) {
  if (REQUIRE_VISUAL_AUDIT) failures.push(message);
  else warnings.push(message);
}

function pushFailure(failures, report, message) {
  failures.push(`${report.filename || report.id || 'unknown'}: ${message}`);
}

function verifyReport(report, failures) {
  if (report.fatal) {
    pushFailure(failures, report, `로드 실패: ${report.fatal}`);
    return;
  }

  if (Array.isArray(report.issues) && report.issues.length) {
    pushFailure(failures, report, `검증 이슈: ${report.issues.join(' / ')}`);
  }

  const pageCount = asNumber(report.pageCount);
  if (!pageCount || pageCount < 1) {
    pushFailure(failures, report, `페이지 수 비정상: ${report.pageCount}`);
  }

  if (Number.isFinite(report.hancomExpectedPages) && report.hancomPageMatch !== true) {
    pushFailure(
      failures,
      report,
      `한컴 페이지 기준 불일치: expected=${report.hancomExpectedPages}, actual=${report.pageCount}`,
    );
  }

  if (report.diagnosticPageMatch !== true) {
    pushFailure(
      failures,
      report,
      `상태바/진단 페이지 수 불일치: status=${report.pageCount}, diagnostics=${report.diagnosticPageCount}`,
    );
  }

  if (pageCount && report.pageElementCount !== pageCount) {
    pushFailure(
      failures,
      report,
      `DOM 페이지 수 불일치: status=${pageCount}, dom=${report.pageElementCount}`,
    );
  }

  if (pageCount && report.thumbnailCount > 0 && report.thumbnailCount < pageCount) {
    pushFailure(
      failures,
      report,
      `썸네일 수 부족: pages=${pageCount}, thumbnails=${report.thumbnailCount}`,
    );
  }

  if (report.renderedGeometryMatch !== true) {
    const expected = report.renderedGeometry?.expectedFirstPage;
    const actual = report.renderedGeometry?.actualFirstPage;
    pushFailure(
      failures,
      report,
      `첫 페이지 용지 치수 불일치: expected=${expected?.width}x${expected?.height}, actual=${actual?.width}x${actual?.height}`,
    );
  }

  if (!report.screenshotPath || !existsSync(report.screenshotPath)) {
    pushFailure(failures, report, `스크린샷 누락: ${report.screenshotPath || '(none)'}`);
  }
}

function summarizeStructuralAudit(verifyPayload) {
  const reports = Array.isArray(verifyPayload.reports) ? verifyPayload.reports : [];
  const summary = {
    documents: reports.length,
    passed: 0,
    failed: 0,
    failedFiles: [],
  };

  for (const report of reports) {
    const structuralIssues = [];
    verifyReport(report, structuralIssues);
    if (structuralIssues.length) {
      summary.failed += 1;
      summary.failedFiles.push({ filename: report.filename || report.id || 'unknown', issues: structuralIssues });
    } else {
      summary.passed += 1;
    }
  }

  return summary;
}

function summarizeVisualAudit(warnings, failures, verifyPayload) {
  if (!existsSync(HANCOM_PAGE_AUDIT_REPORT_PATH)) {
    const message = `한컴 페이지 감사 리포트가 없습니다: ${HANCOM_PAGE_AUDIT_REPORT_PATH}`;
    if (REQUIRE_VISUAL_AUDIT) failures.push(message);
    else warnings.push(message);
    return;
  }

  const audit = readJson(HANCOM_PAGE_AUDIT_REPORT_PATH, '한컴 페이지 감사 리포트');
  const auditGeneratedAt = parseTimestamp(audit.generatedAt);
  const verifyGeneratedAt = verifyPayload.generatedAt;
  const verifyDate = parseTimestamp(verifyGeneratedAt);
  if (!auditGeneratedAt) {
    pushVisualAuditIssue(warnings, failures, '한컴 페이지 감사 리포트 generatedAt을 읽을 수 없습니다.');
  } else {
    if (verifyDate && auditGeneratedAt < verifyDate) {
      pushVisualAuditIssue(
        warnings,
        failures,
        `한컴 페이지 감사 리포트가 검증 리포트보다 오래되었습니다: visual=${audit.generatedAt}, verify=${verifyGeneratedAt}`,
      );
    }

    if (Number.isFinite(VISUAL_MAX_AGE_HOURS) && VISUAL_MAX_AGE_HOURS > 0) {
      const ageHours = (Date.now() - auditGeneratedAt.getTime()) / 36e5;
      if (ageHours > VISUAL_MAX_AGE_HOURS) {
        pushVisualAuditIssue(
          warnings,
          failures,
          `한컴 페이지 감사 리포트가 너무 오래되었습니다: ${ageHours.toFixed(1)}h > ${VISUAL_MAX_AGE_HOURS}h`,
        );
      }
    }
  }

  const results = Array.isArray(audit.results) ? audit.results : [];
  if (!results.length) {
    const message = '한컴 페이지 감사 리포트가 비어 있습니다.';
    if (REQUIRE_VISUAL_AUDIT) failures.push(message);
    else warnings.push(message);
    return;
  }

  const verifyReports = Array.isArray(verifyPayload.reports) ? verifyPayload.reports : [];
  const auditByFilename = new Map(results.map((doc) => [doc.filename, doc]));
  for (const report of verifyReports) {
    if (!report.filename) continue;
    const auditDoc = auditByFilename.get(report.filename);
    if (!auditDoc) {
      pushVisualAuditIssue(warnings, failures, `${report.filename}: 한컴 페이지 감사 대상에서 누락되었습니다.`);
      continue;
    }
    if (Number.isFinite(report.pageCount) && Number.isFinite(auditDoc.pageCount) && report.pageCount !== auditDoc.pageCount) {
      pushVisualAuditIssue(
        warnings,
        failures,
        `${report.filename}: 검증/한컴 감사 페이지 수 불일치 verify=${report.pageCount}, visual=${auditDoc.pageCount}`,
      );
    }
  }

  const strictFailureVerdicts = new Set(['mismatch', 'capture-error', 'capture-review']);
  const advisoryVerdicts = new Set(['review']);
  for (const doc of results) {
    const counts = doc.verdictCounts || {};
    const badCount = Object.entries(counts)
      .filter(([verdict]) => strictFailureVerdicts.has(verdict))
      .reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
    const advisoryCount = Object.entries(counts)
      .filter(([verdict]) => advisoryVerdicts.has(verdict))
      .reduce((sum, [, count]) => sum + (Number(count) || 0), 0);

    if (badCount > 0) {
      const message = `${doc.filename}: 한컴 이미지 감사 mismatch/capture-error/capture-review ${badCount}쪽`;
      if (REQUIRE_VISUAL_AUDIT) failures.push(message);
      else warnings.push(message);
    }
    if (advisoryCount > 0) {
      warnings.push(`${doc.filename}: 한컴 이미지 감사 review ${advisoryCount}쪽`);
    }
  }
}

function main() {
  const verifyPayload = readJson(VERIFY_REPORT_PATH, '샘플 검증 리포트');
  const reports = Array.isArray(verifyPayload.reports) ? verifyPayload.reports : [];
  const failures = [];
  const warnings = [];

  if (!reports.length) {
    failures.push(`검증 대상 리포트가 비어 있습니다: ${VERIFY_REPORT_PATH}`);
  }

  for (const report of reports) {
    verifyReport(report, failures);
  }
  const structuralSummary = summarizeStructuralAudit(verifyPayload);
  summarizeVisualAudit(warnings, failures, verifyPayload);

  console.log(`Fidelity guard: ${reports.length} document(s) checked`);
  console.log(`- verify report: ${VERIFY_REPORT_PATH}`);
  console.log(`- visual audit: ${HANCOM_PAGE_AUDIT_REPORT_PATH}`);
  console.log(`- require visual audit: ${REQUIRE_VISUAL_AUDIT ? 'yes' : 'no'}`);
  console.log(`- visual max age hours: ${VISUAL_MAX_AGE_HOURS}`);
  console.log(`- structural pass: ${structuralSummary.passed}/${structuralSummary.documents}`);
  console.log(`- structural fail: ${structuralSummary.failed}/${structuralSummary.documents}`);

  if (structuralSummary.failedFiles.length) {
    console.log('\nStructural summary');
    for (const item of structuralSummary.failedFiles) {
      console.log(`- ${item.filename}`);
      for (const issue of item.issues) {
        console.log(`  - ${issue}`);
      }
    }
  }

  if (warnings.length) {
    console.log('\nWarnings');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (failures.length) {
    console.error('\nFailures');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('\n✓ Fidelity guard passed');
}

main();
