/**
 * parser.worker.js — HWP 파싱 Web Worker
 *
 * 파싱 로직을 메인 스레드와 분리해 UI 블로킹을 원천 차단합니다.
 * hwp-parser.js 를 importScripts 로 로드해 HwpParser 를 공유합니다.
 * main thread ↔ Worker 통신: postMessage / onmessage
 */

try { importScripts('../lib/pako.min.js'); } catch (e) { /* pako 없으면 DecompressionStream fallback */ }
try { importScripts('../lib/jszip.min.js'); } catch (e) { /* JSZip 없으면 HWPX는 메인 스레드로 fallback */ }
importScripts('../js/hwp-parser.js');

/* ── 메시지 수신 → 파싱 실행 ── */
self.onmessage = async ({ data }) => {
  const { buffer, filename } = data;
  try {
    const doc = await HwpParser.parse(buffer, filename);
    self.postMessage({ type: 'done', doc });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
