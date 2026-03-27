(() => {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const btnSelectFile = document.getElementById('btnSelectFile');
  const btnOpenViewer = document.getElementById('btnOpenViewer');
  const status = document.getElementById('status');

  const setStatus = (message, isError = false) => {
    status.textContent = message || '';
    status.classList.toggle('error', Boolean(isError));
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

  const openFileInViewer = async (file) => {
    if (!/\.(hwp|hwpx)$/i.test(file.name)) {
      setStatus('지원되지 않는 파일 형식입니다.', true);
      return;
    }

    try {
      setStatus('파일 준비 중...');
      const b64 = await toBase64(file);
      const response = await chrome.runtime.sendMessage({
        type: 'OPEN_HWP_FROM_POPUP',
        payload: { b64, filename: file.name },
      });

      if (!response?.ok) throw new Error(response?.error || '파일 열기 실패');
      setStatus('뷰어에서 파일을 여는 중...');
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
})();
