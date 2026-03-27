(() => {
  const recentList = document.getElementById('recentList');
  const linkList = document.getElementById('linkList');

  const formatTime = (ts) => {
    try {
      return new Date(ts).toLocaleString('ko-KR');
    } catch {
      return '';
    }
  };

  const renderList = (container, items, renderItem, emptyText) => {
    container.innerHTML = '';
    if (!items?.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = emptyText;
      container.appendChild(li);
      return;
    }
    items.forEach(item => container.appendChild(renderItem(item)));
  };

  const renderRecentItem = (item) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'link';
    button.disabled = true;
    button.textContent = `${item.name} · ${formatTime(item.ts)}`;
    li.appendChild(button);
    return li;
  };

  const renderLinkItem = (item) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'link';
    button.title = item.url;
    button.textContent = `${item.text || item.url} · ${formatTime(item.ts)}`;
    button.addEventListener('click', async () => {
      const viewerBase = chrome.runtime.getURL('pages/viewer.html');
      await chrome.tabs.create({
        url: `${viewerBase}?hwpUrl=${encodeURIComponent(item.url)}`,
      });
    });
    li.appendChild(button);
    return li;
  };

  const refresh = async () => {
    const { recentHwpFiles = [], discoveredHwpLinks = [] } = await chrome.storage.local.get([
      'recentHwpFiles',
      'discoveredHwpLinks',
    ]);

    renderList(recentList, recentHwpFiles, renderRecentItem, '아직 기록이 없습니다.');
    renderList(linkList, discoveredHwpLinks, renderLinkItem, '이 페이지에서 발견된 링크가 없습니다.');
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recentHwpFiles || changes.discoveredHwpLinks) {
      refresh();
    }
  });

  refresh().catch((error) => {
    linkList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `목록 로드 실패: ${error.message}`;
    linkList.appendChild(li);
  });
})();
