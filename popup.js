(() => {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const btnSelectFile = document.getElementById('btnSelectFile');
  const btnOpenViewer = document.getElementById('btnOpenViewer');
  const status = document.getElementById('status');
  const recentList = document.getElementById('recentList');
  const recentEmpty = document.getElementById('recentEmpty');

  const setStatus = (message, isError = false) => {
    status.textContent = message || '';
    status.classList.toggle('error', Boolean(isError));
  };

  const sendMessage = async (payload) => {
    const response = await chrome.runtime.sendMessage(payload);
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
    return response;
  };

  const toBase64 = async (file) => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const CHUNK = 8192;

    for (let i = 0; i < bytes.length; i += CHUNK) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }

    return btoa(chunks.join(''));
  };

  const sourceLabel = (source) => {
    switch (source) {
      case 'remote-link':
        return '링크';
      case 'popup-upload':
        return '로컬 업로드';
      case 'viewer':
        return '뷰어';
      default:
        return '기록';
    }
  };

  const formatTimestamp = (ts) => {
    const value = Number(ts) || 0;
    if (!value) return '';
    return new Date(value).toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderRecentFiles = (items) => {
    recentList.innerHTML = '';

    if (!Array.isArray(items) || items.length === 0) {
      recentEmpty.style.display = '';
      return;
    }

    recentEmpty.style.display = 'none';

    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'recent-item';

      const name = document.createElement('div');
      name.className = 'recent-name';
      name.textContent = item.name || '(이름 없음)';
      li.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'recent-meta';

      const label = document.createElement('span');
      const when = formatTimestamp(item.ts);
      label.textContent = [sourceLabel(item.source), when].filter(Boolean).join(' · ');
      meta.appendChild(label);

      if (item.url) {
        const openBtn = document.createElement('button');
        openBtn.className = 'recent-open';
        openBtn.textContent = '다시 열기';
        openBtn.addEventListener('click', async () => {
          try {
            setStatus('최근 링크를 여는 중...');
            const response = await sendMessage({ type: 'OPEN_RECENT_HWP_LINK', url: item.url });
            if (!response?.ok) throw new Error(response?.error || '최근 링크 열기 실패');
            setStatus(response.message || '최근 링크를 열었습니다.');
            window.close();
          } catch (err) {
            setStatus(err.message || '최근 링크를 열지 못했습니다.', true);
          }
        });
        meta.appendChild(openBtn);
      }

      li.appendChild(meta);
      recentList.appendChild(li);
    });
  };

  const refreshRecentFiles = async () => {
    try {
      const response = await sendMessage({ type: 'GET_RECENT_HWP_FILES' });
      if (!response?.ok) throw new Error(response?.error || '최근 파일을 불러오지 못했습니다.');
      renderRecentFiles(response.items || []);
    } catch (err) {
      recentList.innerHTML = '';
      recentEmpty.style.display = '';
      setStatus(err.message || '최근 파일 조회 실패', true);
    }
  };

  const openFileInViewer = async (file) => {
    if (!/\.(hwp|hwpx)$/i.test(file.name)) {
      setStatus('지원되지 않는 파일 형식입니다.', true);
      return;
    }

    try {
      setStatus('파일 준비 중...');
      const b64 = await toBase64(file);
      const response = await sendMessage({
        type: 'OPEN_HWP_FROM_POPUP',
        payload: { b64, filename: file.name },
      });

      if (!response?.ok) throw new Error(response?.error || '파일 열기 실패');
      setStatus(response.message || '뷰어에서 파일을 여는 중...');
      window.close();
    } catch (err) {
      setStatus(err.message || '파일 처리 중 오류가 발생했습니다.', true);
    }
  };

  const handleFileList = (files) => {
    const file = files?.[0];
    if (file) openFileInViewer(file);
  };

  btnSelectFile.addEventListener('click', () => fileInput.click());
  btnOpenViewer.addEventListener('click', () => {
    setStatus('빈 뷰어 탭을 여는 중...');
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/viewer.html') });
    window.close();
  });

  fileInput.addEventListener('change', (event) => {
    handleFileList(event.target.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (event) => {
    handleFileList(event.dataTransfer?.files);
  });

  refreshRecentFiles();
})();
