/**
 * background.js — Service Worker (Manifest V3, module)
 *
 * 기능:
 *  1. 웹페이지의 .hwp/.hwpx/.owpml 링크 우클릭 → "HWP 에디터로 열기" 컨텍스트 메뉴
 *     클릭 시 해당 URL을 fetch해 ArrayBuffer를 chrome.storage.session에 저장 후
 *     viewer.html을 새 탭으로 열어 즉시 파일 로드
 *  2. 팝업과 뷰어 사이 최근 파일 메타데이터 동기화
 *  3. HWP 링크 배지 썸네일 추출 (sw/thumbnail-extractor.js)
 */

import { extractThumbnailFromUrl } from './sw/thumbnail-extractor.js';

const MAX_LINKS = 100;
const MAX_RECENTS = 20;
const HWP_LINK_PATTERN = /\.(hwp|hwpx|owpml)(?:$|[?#])/i;

/* ── 설치/업데이트 시 컨텍스트 메뉴 등록 ── */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn('[BG] 기존 컨텍스트 메뉴 정리 실패:', chrome.runtime.lastError.message);
    }

    chrome.contextMenus.create({
      id: 'hwp-open-link',
      title: 'HWP 에디터로 열기',
      contexts: ['link'],
      targetUrlPatterns: [
        '*://*/*.hwp',
        '*://*/*.hwpx',
        '*://*/*.owpml',
        '*://*/*.hwp?*',
        '*://*/*.hwpx?*',
        '*://*/*.owpml?*',
        '*://*/*.hwp#*',
        '*://*/*.hwpx#*',
        '*://*/*.owpml#*',
      ],
    });
  });
});

function getViewerBaseUrl() {
  return chrome.runtime.getURL('pages/viewer.html');
}

function getFilenameFromUrl(hwpUrl) {
  const lastSegment = String(hwpUrl || '').split('/').pop() || '';
  return decodeURIComponent(lastSegment.split(/[?#]/)[0]) || 'document.hwp';
}

function encodeArrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function isHttpHwpUrl(url) {
  return /^https?:\/\//i.test(url) && HWP_LINK_PATTERN.test(url);
}

async function openRemoteHwpInViewer(hwpUrl, source = 'link') {
  const url = String(hwpUrl || '').trim();
  if (!isHttpHwpUrl(url)) {
    throw new Error('유효한 HWP 링크가 아닙니다.');
  }

  const viewerBase = getViewerBaseUrl();
  const filename = getFilenameFromUrl(url);

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const b64 = encodeArrayBufferToBase64(await resp.arrayBuffer());
    await chrome.storage.session.set({
      pendingHwp: { b64, filename, ts: Date.now(), source, url },
    });
    await addRecentFile({ name: filename, url, source: 'remote-link' });
    await chrome.tabs.create({ url: `${viewerBase}?fromContext=1` });

    return { mode: 'prefetch', filename };
  } catch (err) {
    console.warn('[BG] fetch 실패, URL 파라미터 방식으로 전환:', err.message);
    await addRecentFile({ name: filename, url, source: 'remote-link' });
    await chrome.tabs.create({ url: `${viewerBase}?hwpUrl=${encodeURIComponent(url)}` });

    return { mode: 'url-fallback', filename, reason: err.message };
  }
}

/* ── 컨텍스트 메뉴 클릭 ── */
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'hwp-open-link') return;

  try {
    await openRemoteHwpInViewer(info.linkUrl, 'context-menu');
  } catch (err) {
    console.error('[BG] 컨텍스트 메뉴 열기 실패:', err.message);
  }
});

async function mergeDiscoveredLinks(incomingLinks) {
  if (!Array.isArray(incomingLinks) || incomingLinks.length === 0) return;

  const normalized = incomingLinks
    .map(link => ({
      url: String(link?.url || '').trim(),
      text: String(link?.text || '').trim(),
      ts: Number(link?.ts) || Date.now(),
    }))
    .filter(link => /^https?:\/\//i.test(link.url) && HWP_LINK_PATTERN.test(link.url));

  if (normalized.length === 0) return;

  const { discoveredHwpLinks = [] } = await chrome.storage.local.get('discoveredHwpLinks');
  const mergedMap = new Map();

  for (const item of discoveredHwpLinks) {
    if (!item?.url) continue;
    mergedMap.set(item.url, item);
  }
  for (const item of normalized) {
    mergedMap.set(item.url, item);
  }

  const merged = Array.from(mergedMap.values())
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, MAX_LINKS);

  await chrome.storage.local.set({ discoveredHwpLinks: merged });
}

function normalizeRecentItem(input) {
  if (typeof input === 'string') {
    return {
      name: input.trim(),
      url: '',
      source: 'viewer',
      ts: Date.now(),
    };
  }

  const name = String(input?.name || '').trim();
  if (!name) return null;

  const url = String(input?.url || '').trim();
  return {
    name,
    url: isHttpHwpUrl(url) ? url : '',
    source: String(input?.source || 'unknown').trim() || 'unknown',
    ts: Date.now(),
  };
}

function recentKey(item) {
  if (item.url) return `url:${item.url}`;
  return `name:${item.name}`;
}

async function addRecentFile(itemLike) {
  const item = normalizeRecentItem(itemLike);
  if (!item) return;

  const { recentHwpFiles = [] } = await chrome.storage.local.get('recentHwpFiles');
  const merged = [item, ...recentHwpFiles]
    .filter(existing => existing?.name)
    .map(existing => ({
      name: String(existing.name || '').trim(),
      url: String(existing.url || '').trim(),
      source: String(existing.source || 'unknown').trim() || 'unknown',
      ts: Number(existing.ts) || 0,
    }));

  const deduped = [];
  const seen = new Set();
  for (const entry of merged) {
    const key = recentKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= MAX_RECENTS) break;
  }

  await chrome.storage.local.set({ recentHwpFiles: deduped });
}

async function getRecentFiles() {
  const { recentHwpFiles = [] } = await chrome.storage.local.get('recentHwpFiles');
  return recentHwpFiles
    .filter(item => item?.name)
    .map(item => ({
      name: String(item.name || '').trim(),
      url: isHttpHwpUrl(item.url) ? item.url : '',
      source: String(item.source || 'unknown').trim() || 'unknown',
      ts: Number(item.ts) || 0,
    }))
    .slice(0, MAX_RECENTS);
}

/* ── 뷰어/팝업/컨텐츠 스크립트 메시지 처리 ── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_PENDING_HWP') {
    chrome.storage.session.get('pendingHwp').then(result => {
      sendResponse(result.pendingHwp || null);
      // 사용 후 삭제
      chrome.storage.session.remove('pendingHwp');
    });
    return true; // 비동기 응답
  }

  if (msg.type === 'GET_RECENT_HWP_FILES') {
    getRecentFiles().then(items => {
      sendResponse({ ok: true, items });
    }).catch(err => {
      sendResponse({ ok: false, error: err?.message || '최근 파일 조회 실패' });
    });
    return true;
  }

  if (msg.type === 'OPEN_RECENT_HWP_LINK') {
    const url = String(msg.url || '').trim();
    openRemoteHwpInViewer(url, 'popup-recent').then(result => {
      sendResponse({
        ok: true,
        message: result.mode === 'prefetch'
          ? '최근 링크를 미리 불러와 열었습니다.'
          : '최근 링크를 직접 열었습니다. (네트워크 환경에 따라 로딩될 수 있습니다.)',
      });
    }).catch(err => {
      sendResponse({ ok: false, error: err?.message || '최근 링크 열기 실패' });
    });
    return true;
  }

  if (msg.type === 'OPEN_HWP_FROM_POPUP') {
    const { b64, filename } = msg.payload || {};
    if (!b64 || !filename) {
      sendResponse({ ok: false, error: '파일 데이터가 비어 있습니다.' });
      return false;
    }

    (async () => {
      await chrome.storage.session.set({ pendingHwp: { b64, filename, ts: Date.now(), source: 'popup-upload' } });
      await addRecentFile({ name: filename, source: 'popup-upload' });
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/viewer.html?fromContext=1') });
      sendResponse({ ok: true, message: '파일을 뷰어로 전달했습니다.' });
    })().catch(err => {
      sendResponse({ ok: false, error: err?.message || '파일 열기에 실패했습니다.' });
    });

    return true;
  }

  if (msg.type === 'SYNC_HWP_LINKS') {
    mergeDiscoveredLinks(msg.links).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      sendResponse({ ok: false, error: err?.message || '링크 동기화 실패' });
    });
    return true;
  }

  if (msg.type === 'ADD_RECENT_HWP_FILE') {
    addRecentFile(msg.filename).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      sendResponse({ ok: false, error: err?.message || '최근 파일 저장 실패' });
    });
    return true;
  }

  // content-script에서 HWP 링크 클릭 → 뷰어로 열기
  if (msg.type === 'open-hwp') {
    const url = String(msg.url || '').trim();
    if (!url) {
      sendResponse({ ok: false, error: 'URL이 없습니다.' });
      return false;
    }
    openRemoteHwpInViewer(url, 'content-script-badge').then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      sendResponse({ ok: false, error: err?.message || '파일 열기 실패' });
    });
    return true;
  }

  // CORS 우회 파일 fetch (뷰어 탭 → 서비스 워커)
  // Service Worker의 fetch는 host_permissions에 의해 CORS 제한 없음
  if (msg.type === 'FETCH_FILE') {
    const url = String(msg.url || '').trim();
    if (!url) {
      sendResponse({ error: 'URL이 필요합니다.' });
      return false;
    }
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          sendResponse({ error: `HTTP ${response.status}: ${response.statusText}` });
          return;
        }
        const buffer = await response.arrayBuffer();
        sendResponse({ data: Array.from(new Uint8Array(buffer)) });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // HWP 링크 썸네일 추출 (content-script → service worker)
  if (msg.type === 'EXTRACT_THUMBNAIL') {
    const url = String(msg.url || '').trim();
    if (!url) {
      sendResponse({ error: 'URL이 필요합니다.' });
      return false;
    }
    (async () => {
      try {
        const result = await extractThumbnailFromUrl(url);
        sendResponse(result || { error: 'PrvImage not found' });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }
});

