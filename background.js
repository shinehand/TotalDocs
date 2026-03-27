/**
 * background.js — Service Worker (Manifest V3)
 *
 * 기능:
 *  1. 툴바 아이콘 클릭 → viewer.html 새 탭 오픈
 *  2. 웹페이지의 .hwp/.hwpx 링크 우클릭 → "HWP 에디터로 열기" 컨텍스트 메뉴
 *     클릭 시 해당 URL을 fetch해 ArrayBuffer를 chrome.storage.session에 저장 후
 *     viewer.html을 새 탭으로 열어 즉시 파일 로드
 */

/* ── 설치/업데이트 시 컨텍스트 메뉴 등록 ── */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:                 'hwp-open-link',
    title:              'HWP 에디터로 열기',
    contexts:           ['link'],
    targetUrlPatterns:  ['*://*/*/*.hwp', '*://*/*/*.hwpx',
                         '*://*/*/*.hwp?*', '*://*/*/*.hwpx?*'],
  });
});

/* ── 툴바 아이콘 클릭 ── */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/viewer.html') });
});

/* ── 컨텍스트 메뉴 클릭 ── */
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'hwp-open-link') return;

  const hwpUrl  = info.linkUrl;
  const viewerBase = chrome.runtime.getURL('pages/viewer.html');

  /* Service Worker에서 파일을 직접 fetch →
     ArrayBuffer를 base64로 변환 후 chrome.storage.session에 임시 저장
     (뷰어 탭이 열리면 꺼내서 처리) */
  try {
    const resp = await fetch(hwpUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const ab     = await resp.arrayBuffer();
    const bytes  = new Uint8Array(ab);

    // ArrayBuffer → base64 (Service Worker는 btoa 대신 직접 변환)
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(binary);

    // 파일명 추출
    const filename = decodeURIComponent(hwpUrl.split('/').pop().split('?')[0]) || 'document.hwp';

    // session storage에 임시 저장 (탭 닫으면 자동 삭제)
    await chrome.storage.session.set({
      pendingHwp: { b64, filename, ts: Date.now() }
    });
    await addRecentFile(filename);

    // 뷰어 탭 열기
    chrome.tabs.create({ url: viewerBase + '?fromContext=1' });

  } catch (err) {
    // fetch 실패 (CORS 등) → URL 파라미터로 전달해 뷰어에서 재시도
    console.warn('[BG] fetch 실패, URL 파라미터 방식으로 전환:', err.message);
    chrome.tabs.create({
      url: viewerBase + '?hwpUrl=' + encodeURIComponent(hwpUrl)
    });
  }
});

const MAX_LINKS = 100;
const MAX_RECENTS = 20;

async function mergeDiscoveredLinks(incomingLinks) {
  if (!Array.isArray(incomingLinks) || incomingLinks.length === 0) return;

  const normalized = incomingLinks
    .map(link => ({
      url: String(link?.url || '').trim(),
      text: String(link?.text || '').trim(),
      ts: Number(link?.ts) || Date.now(),
    }))
    .filter(link => /^https?:\/\//i.test(link.url) && /\.(hwp|hwpx)(?:$|\?)/i.test(link.url));

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

async function addRecentFile(filename) {
  const name = String(filename || '').trim();
  if (!name) return;

  const { recentHwpFiles = [] } = await chrome.storage.local.get('recentHwpFiles');
  const filtered = recentHwpFiles.filter(item => item?.name !== name);
  filtered.unshift({ name, ts: Date.now() });
  await chrome.storage.local.set({ recentHwpFiles: filtered.slice(0, MAX_RECENTS) });
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

  if (msg.type === 'OPEN_HWP_FROM_POPUP') {
    const { b64, filename } = msg.payload || {};
    if (!b64 || !filename) {
      sendResponse({ ok: false, error: '파일 데이터가 비어 있습니다.' });
      return false;
    }

    (async () => {
      await chrome.storage.session.set({ pendingHwp: { b64, filename, ts: Date.now() } });
      await addRecentFile(filename);
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/viewer.html?fromContext=1') });
      sendResponse({ ok: true });
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
});
