(() => {
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

        if (!/\.(hwp|hwpx)(?:$|\?)/i.test(url)) return null;

        return {
          url,
          text: (anchor.textContent || '').trim().slice(0, 120),
          ts: Date.now(),
        };
      })
      .filter(Boolean);

    if (links.length === 0) return;

    chrome.runtime.sendMessage({ type: 'SYNC_HWP_LINKS', links }).catch(() => {
      // service worker가 sleep 상태인 경우를 포함해 조용히 무시
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', collectHwpLinks, { once: true });
  } else {
    collectHwpLinks();
  }
})();
