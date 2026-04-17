(() => {
  'use strict';

  const MAX_LINK_TEXT_LENGTH = 120;
  const HWP_EXTENSIONS = /\.(hwp|hwpx|owpml)(?:$|[?#])/i;
  const BADGE_CLASS = 'chromehwp-badge';
  const HOVER_CLASS = 'chromehwp-hover-card';
  const PROCESSED_ATTR = 'data-chromehwp-processed';
  const HOVER_SHOW_DELAY = 350;  // 호버 카드 표시 지연 (ms)
  const HOVER_HIDE_DELAY = 200;  // 호버 카드 숨김 지연 (ms)

  // ─── HWP 링크 수집 → 서비스 워커 동기화 ───

  const collectHwpLinks = () => {
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => {
        const rawHref = anchor.getAttribute('href') || '';
        let url = '';
        try {
          url = new URL(rawHref, location.href).href;
        } catch {
          return null;
        }

        if (!HWP_EXTENSIONS.test(url)) return null;

        return {
          url,
          text: (anchor.textContent || '').trim().slice(0, MAX_LINK_TEXT_LENGTH),
          ts: Date.now(),
        };
      })
      .filter(Boolean);

    if (links.length === 0) return;

    chrome.runtime.sendMessage({ type: 'SYNC_HWP_LINKS', links }).catch(() => {
      // service worker가 sleep 상태인 경우를 포함해 조용히 무시
    });
  };

  // ─── HWP 링크 배지 + 호버 카드 ───

  function isHwpLink(anchor) {
    if (!anchor.href) return false;
    return HWP_EXTENSIONS.test(anchor.href);
  }

  // 안전한 DOM 요소 생성 (innerHTML 미사용)
  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function createBadge(anchor) {
    const badge = createEl('span', BADGE_CLASS, 'HWP');
    badge.title = 'ChromeHWP로 열기';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'open-hwp', url: anchor.href });
    });
    return badge;
  }

  // ─── 호버 카드 ───

  let activeCard = null;
  let hoverTimeout = null;
  const thumbnailCache = new Map();

  function showHoverCard(anchor) {
    hideHoverCard();

    const card = document.createElement('div');
    card.className = HOVER_CLASS;

    const titleText = anchor.textContent?.trim() || anchor.href.split('/').pop().split('?')[0];
    card.appendChild(createEl('div', 'chromehwp-hover-title', truncate(titleText, 120)));

    const ext = (anchor.href.match(/\.(hwp|hwpx|owpml)/i) || [])[1]?.toUpperCase() || 'HWP';
    card.appendChild(createEl('div', 'chromehwp-hover-meta', ext));

    // 썸네일 영역
    const thumbContainer = createEl('div', 'chromehwp-hover-thumb chromehwp-thumb-loading', '');
    const spinner = createEl('span', 'chromehwp-thumb-spinner', '⏳');
    thumbContainer.appendChild(spinner);
    card.appendChild(thumbContainer);

    // 푸터
    const footer = createEl('div', 'chromehwp-hover-action', '▶  ChromeHWP로 열기');
    card.appendChild(footer);

    card.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-hwp', url: anchor.href });
      hideHoverCard();
    });

    document.body.appendChild(card);
    activeCard = card;

    // 위치 계산
    const rect = anchor.getBoundingClientRect();
    const cardHeight = card.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;

    let left = rect.left + window.scrollX;
    let top = spaceBelow >= cardHeight + 8
      ? rect.bottom + window.scrollY + 4
      : rect.top + window.scrollY - cardHeight - 4;

    const cardWidth = card.offsetWidth;
    if (left + cardWidth > window.scrollX + window.innerWidth - 8)
      left = window.scrollX + window.innerWidth - cardWidth - 8;
    if (left < window.scrollX + 8) left = window.scrollX + 8;

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;

    card.addEventListener('mouseenter', () => clearTimeout(hoverTimeout));
    card.addEventListener('mouseleave', () => hideHoverCard());

    // 썸네일 추출 요청
    const cached = thumbnailCache.get(anchor.href);
    if (cached) {
      insertThumbnailImg(thumbContainer, cached.dataUri);
    } else if (cached === null) {
      thumbContainer.remove();
    } else {
      chrome.runtime.sendMessage({ type: 'EXTRACT_THUMBNAIL', url: anchor.href }, (response) => {
        if (response && response.dataUri) {
          thumbnailCache.set(anchor.href, response);
          if (activeCard === card) insertThumbnailImg(thumbContainer, response.dataUri);
        } else {
          thumbnailCache.set(anchor.href, null);
          if (activeCard === card) thumbContainer.remove();
        }
      });
    }
  }

  function insertThumbnailImg(container, dataUri) {
    container.className = 'chromehwp-hover-thumb';
    container.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUri;
    img.alt = '미리보기';
    img.referrerPolicy = 'no-referrer';
    container.appendChild(img);
  }

  function hideHoverCard() {
    if (activeCard) { activeCard.remove(); activeCard = null; }
    clearTimeout(hoverTimeout);
  }

  function attachHoverEvents(anchor) {
    anchor.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimeout);
      hideHoverCard();
      hoverTimeout = setTimeout(() => showHoverCard(anchor), HOVER_SHOW_DELAY);
    });
    anchor.addEventListener('mouseleave', () => {
      hoverTimeout = setTimeout(() => hideHoverCard(), HOVER_HIDE_DELAY);
    });
  }

  // ─── 링크 처리 ───

  function processLinks(root = document) {
    const anchors = root.querySelectorAll('a[href]');
    for (const anchor of anchors) {
      if (anchor.hasAttribute(PROCESSED_ATTR)) continue;
      if (!isHwpLink(anchor)) continue;

      anchor.setAttribute(PROCESSED_ATTR, 'true');
      const badge = createBadge(anchor);
      anchor.insertAdjacentElement('afterend', badge);
      attachHoverEvents(anchor);
    }
  }

  function observeDynamicContent() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) processLinks(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── 초기화 ───

  function init() {
    collectHwpLinks();
    processLinks();
    observeDynamicContent();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
