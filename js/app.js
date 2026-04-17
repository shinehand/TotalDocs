/**
 * app.js — HWP Web Viewer & Editor (에디터 · 익스포터 · 상태 · UI 핸들러)
 * (Chrome 확장 plain-script 로딩, type="module" 없음)
 * 의존 로드 순서: pako → jszip → quill → hwp-parser.js → hwp-renderer.js → app.js
 */


/* ═══════════════════════════════════════════════
   HWP EDITOR (Quill 래퍼)
═══════════════════════════════════════════════ */
const HwpEditor = {
  quill: null,

  init() {
    if (this.quill) return;
    if (typeof Quill === 'undefined') {
      console.error('[Editor] Quill 로드 실패 — lib/quill.min.js 확인');
      return;
    }
    this.quill = new Quill('#quillEditor', {
      theme: 'snow',
      placeholder: '문서 내용을 편집하세요...',
      modules: {
        toolbar: [
          [{ header:[1,2,3,false] }],
          ['bold','italic','underline','strike'],
          [{ color:[] }, { background:[] }],
          [{ align:[] }],
          [{ list:'ordered' },{ list:'bullet' }],
          ['clean'],
        ],
      },
    });
    this.quill.on('text-change', () => {
      if (state.mode !== 'edit') return;
      syncEditStateFromEditor();
    });
  },

  loadDocument(doc) {
    this.loadDelta(this.buildDocumentDelta(doc));
  },

  loadDelta(delta) {
    this.init();
    if (!this.quill) return;
    this.quill.setContents(delta || { ops: [] }, 'silent');
    this.quill.setSelection(0, 0);
  },

  buildDocumentDelta(doc) {
    const ops = [];
    doc.pages.forEach((page, pi) => {
      if (pi > 0) ops.push({ insert: `\n── 페이지 ${pi+1} ──\n`, attributes:{ 'code-block':true } });
      page.paragraphs.forEach(block => {
        if (block.type === 'table') {
          this._appendTableOps(ops, block);
          return;
        }
        if (block.type === 'image') {
          ops.push({ insert: '[이미지]' });
          ops.push({ insert: '\n' });
          return;
        }
        this._appendParagraphOps(ops, block);
      });
    });
    return { ops };
  },

  buildDocumentFromDelta(delta) {
    const pages = [{ index: 0, paragraphs: [] }];
    const text = (delta?.ops || [])
      .map(op => (typeof op.insert === 'string' ? op.insert : ''))
      .join('');

    text.split('\n').forEach(line => {
      const normalized = line.trim();
      if (/^── 페이지 \d+ ──$/.test(normalized)) {
        if (pages[pages.length - 1].paragraphs.length) {
          pages.push({ index: pages.length, paragraphs: [] });
        }
        return;
      }

      pages[pages.length - 1].paragraphs.push(HwpParser._createParagraphBlock(line));
    });

    if (!pages[0].paragraphs.length) {
      pages[0].paragraphs.push(HwpParser._createParagraphBlock(''));
    }

    pages.forEach((page, index) => {
      page.index = index;
    });

    return {
      meta: { pages: pages.length, edited:true },
      pages,
    };
  },

  _appendParagraphOps(ops, para) {
    (para.texts || []).forEach(run => {
      if (run.type === 'image') {
        ops.push({ insert: '[이미지]' });
        return;
      }
      const a = {};
      if (run.bold)      a.bold      = true;
      if (run.italic)    a.italic    = true;
      if (run.underline) a.underline = true;
      ops.push(Object.keys(a).length ? { insert: run.text||'', attributes:a } : { insert: run.text||'' });
    });
    const pa = {};
    if (para.align && para.align !== 'left') pa.align = para.align;
    ops.push(Object.keys(pa).length ? { insert:'\n', attributes:pa } : { insert:'\n' });
  },

  _appendTableOps(ops, table) {
    (table.rows || []).forEach(row => {
      const cells = [...(row.cells || [])].sort((a, b) => a.col - b.col);
      const rowText = cells
        .map(cell => HwpParser._cellText(cell).replace(/\n+/g, ' ').trim())
        .join('\t');
      ops.push({ insert: rowText });
      ops.push({ insert: '\n' });
    });
    ops.push({ insert: '\n' });
  },

  getHtml()  { return this.quill ? this.quill.root.innerHTML : ''; },
  getDelta() { return this.quill ? this.quill.getContents() : { ops:[] }; },
  focus()    { this.quill?.focus(); },
};

/* ═══════════════════════════════════════════════
   EXPORTER
═══════════════════════════════════════════════ */
const HwpExporter = {
  basename: 'document',

  setFilename(name) { this.basename = name.replace(/\.[^.]+$/,''); },

  canOverwriteFormat(format) {
    return format === 'hwpx' || format === 'owpml';
  },

  buildHtmlBlob() {
    const html = this._wrap(getCurrentDocumentHtml());
    return new Blob([html], { type: 'text/html;charset=utf-8' });
  },

  async buildHwpxBlob() {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 로드 필요');
    const zip = new JSZip();
    zip.file('mimetype','application/hwp+zip',{compression:'STORE'});
    zip.folder('Contents').file('section0.xml', this._deltaToXml(getCurrentDocumentDelta()));
    zip.folder('META-INF').file('container.xml',
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Contents/section0.xml" media-type="application/xml"/></rootfiles></container>`
    );
    return zip.generateAsync({type:'blob'});
  },

  exportPdf() {
    if (!ensureDocumentActionAllowed('내보내기')) return false;
    const w = window.open('','_blank','width=900,height=700');
    if (!w) { alert('팝업 차단 해제 후 재시도하세요.'); return false; }
    // WASM 모드: 현재 캔버스 HTML(SVG 포함) 그대로 인쇄
    const bodyContent = state.wasmRenderResult
      ? UI.documentCanvas.innerHTML
      : getCurrentDocumentHtml();
    w.document.write(this._wrap(bodyContent));
    w.document.close();
    w.onload = () => { w.focus(); w.print(); w.onafterprint = ()=>w.close(); };
    return true;
  },

  printAsPdf() {
    return this.exportPdf();
  },

  async saveCurrent() {
    if (!ensureDocumentActionAllowed('저장')) return false;
    const disabledReason = getSaveCurrentDisabledReason();
    if (disabledReason) {
      showError(disabledReason);
      return false;
    }

    const sync = syncEditStateFromEditor();
    if (!sync?.hasChanges) {
      applyDocumentActionState();
      return false;
    }

    const format = getFilenameExtension(state.filename);
    if (!this.canOverwriteFormat(format)) {
      showError('현재 파일 덮어쓰기는 HWPX/OWPML 파일만 지원합니다. 다른 이름으로 저장을 사용해 주세요.');
      return false;
    }

    const blob = await this.buildHwpxBlob();
    const packageExt = format === 'owpml' ? 'owpml' : 'hwpx';
    const packageLabel = packageExt === 'owpml' ? 'OWPML 문서' : 'HWPX 문서';
    const handle = await this._saveWithPicker(blob, state.filename, {
      handle: state.fileHandle,
      description: packageLabel,
      accept: {
        'application/hwp+zip': [`.${packageExt}`],
        'application/octet-stream': [`.${packageExt}`],
      },
    });

    if (handle?.name) {
      setCurrentFilename(handle.name);
      state.fileHandle = handle;
    }
    state.doc = state.editedDoc || state.doc;
    syncEditStateFromEditor({ markSaved: true });
    updateFileInfoFromSize(blob.size);
    return true;
  },

  async saveAs(format) {
    if (!ensureDocumentActionAllowed('다른 이름으로 저장')) return false;
    const disabledReason = getSaveAsDisabledReason(format);
    if (disabledReason) {
      showError(disabledReason);
      return false;
    }

    if (format === 'pdf') {
      return this.exportPdf();
    }

    const suffix = format.toLowerCase();
    const name = `${this.basename}.${suffix}`;
    if (format === 'html') {
      const blob = this.buildHtmlBlob();
      await this._saveWithPicker(blob, name, {
        description: 'HTML 문서',
        accept: {
          'text/html': ['.html'],
        },
      });
      return true;
    }

    if (format === 'hwpx' || format === 'owpml') {
      const blob = await this.buildHwpxBlob();
      const packageLabel = format === 'owpml' ? 'OWPML 문서' : 'HWPX 문서';
      await this._saveWithPicker(blob, name, {
        description: packageLabel,
        accept: {
          'application/hwp+zip': [`.${suffix}`],
          'application/octet-stream': [`.${suffix}`],
        },
      });
      return true;
    }

    showError('현재는 .hwp 바이너리 저장을 지원하지 않습니다. HWPX 또는 OWPML로 저장해 주세요.');
    return false;
  },

  _wrap(body) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${this.basename}</title>
<style>
body{font-family:'HCR Batang','함초롬바탕','Noto Serif KR','Malgun Gothic',serif;max-width:860px;margin:0 auto;padding:60px 80px;font-size:14px;line-height:1.68}
.hwp-page{background:#fff;padding:0 0 24px;margin-bottom:24px;break-after:page;display:flex;flex-direction:column;min-height:980px}
.hwp-page-header{flex:0 0 auto;position:relative}
.hwp-page-body{flex:1 1 auto;position:relative}
.hwp-page-footer{margin-top:auto;padding-top:18px;position:relative}
.hwp-page p{margin:0 0 4px;white-space:pre-wrap}
.hwp-page-number{font-size:12px;letter-spacing:0.08em;color:#475569}
.hwp-inline-image{display:inline-block;vertical-align:middle;margin-right:10px}
.hwp-table-wrap{margin:10px 0 16px;overflow-x:auto}
.hwp-table{width:100%;border-collapse:collapse;table-layout:fixed;background:#fff;font-size:12.7px;outline:1.5px solid #374151;outline-offset:-1px}
.hwp-table[data-source-format="hwpx"]{outline:none}
.hwp-table-cell{border:1px solid #6b7280;padding:4px 6px;vertical-align:top;font-size:12.7px;line-height:1.32;white-space:normal}
.hwp-table-paragraph{margin:0;min-height:1.1em;line-height:1.22}
.hwp-table-paragraph+.hwp-table-paragraph{margin-top:3px}
.hwp-table-cell-content{position:relative}
.hwp-image-block{margin:10px 0;text-align:center}
.hwp-image-block[data-align="left"]{text-align:left}
.hwp-image-block[data-align="right"]{text-align:right}
.hwp-image-block[data-inline="true"]{margin:4px 0 8px}
.hwp-image{max-width:100%;height:auto;display:inline-block}
.hwp-object-block{margin:8px 0;text-align:left}
.hwp-object-block[data-align="center"]{text-align:center}
.hwp-object-block[data-align="right"]{text-align:right}
.hwp-object-block[data-inline="true"]{margin:4px 0 8px}
.hwp-equation,.hwp-ole{display:inline-block;max-width:100%;white-space:pre-wrap}
.hwp-equation{padding:6px 10px;border-radius:8px;background:#f8fafc;border:1px solid #cbd5e1;font-family:'Cambria Math','Times New Roman',serif;color:#111827}
.hwp-ole{padding:7px 10px;border-radius:8px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-size:12px}
.hwp-table-nested{margin-top:6px}
.hwp-table-nested>.hwp-table-wrap{margin:6px 0 0}
.hwp-table[data-layout="first-page-primary"] .hwp-table-row[data-row-role="title"]>td{padding-top:10px;padding-bottom:10px;vertical-align:middle}
.hwp-table[data-layout="first-page-primary"] .hwp-table-row[data-row-role^="person-form"]>td,
.hwp-table[data-layout="first-page-primary"] .hwp-table-row[data-row-role^="military-form"]>td{padding-top:6px;padding-bottom:6px;vertical-align:middle}
.hwp-table-cell[data-role="field-label"]{font-size:11.8px;font-weight:400;white-space:nowrap;letter-spacing:-0.01em}
.hwp-table-cell[data-role="field-inline-note"]{font-size:11.8px}
.hwp-table-cell[data-role="process-period"] .hwp-table-paragraph{text-align:center}
.hwp-form-title-grid{display:grid;grid-template-columns:minmax(170px,1fr) minmax(282px,1.45fr);align-items:center;column-gap:10px;min-height:74px}
.hwp-form-title-label{margin:0;text-align:center;font-size:19px;font-weight:500;letter-spacing:0.01em;line-height:1.06;white-space:nowrap}
.hwp-form-title-options{display:flex;flex-direction:column;justify-content:center;gap:8px}
.hwp-form-title-option{margin:0;font-size:14.5px;line-height:1.04;font-weight:400;letter-spacing:-0.01em;white-space:nowrap}
.hwp-form-header-layout{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(220px,42%);align-items:start;column-gap:12px;width:100%}
.hwp-form-header-title{grid-column:2;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:68px}
.hwp-form-header-title .hwp-table-paragraph{margin:0;text-align:center}
.hwp-form-header-approval{grid-column:3;justify-self:end;min-width:min(100%,280px);width:min(100%,320px)}
.hwp-form-header-approval .hwp-table-wrap{margin:0}
@media print{body{padding:20mm 25mm}.hwp-page{padding:0;margin-bottom:0}}
</style>
</head><body>${body}</body></html>`;
  },

  buildDocumentHtml(doc) {
    if (!doc?.pages?.length) return '<p>&nbsp;</p>';
    const root = document.createElement('div');
    const listStateRef = {};

    doc.pages.forEach((page, pi) => {
      const pageEl = document.createElement('div');
      pageEl.className = 'hwp-page';
      pageEl.dataset.pageIndex = String(pi);
      if (pi === 0) pageEl.dataset.pageRole = 'first';
      applyPageStyle(pageEl, page, pi);

      if (pi === 0 && doc.meta?.note) {
        const note = document.createElement('div');
        note.style.cssText = 'background:#fef9c3;padding:8px 12px;border-radius:4px;font-size:12px;color:#78350f;margin-bottom:16px;white-space:pre-wrap;';
        note.textContent = doc.meta.note;
        pageEl.appendChild(note);
      }

      const { headerEl, bodyEl, footerEl } = createPageSections(pageEl);
      const tableIndexRef = { value: 0 };
      (page.headerBlocks || []).forEach(block => appendBlockByType(headerEl, block, { pageIndex: pi, tableIndexRef, listStateRef }));
      page.paragraphs.forEach(block => appendBlockByType(bodyEl, block, { pageIndex: pi, tableIndexRef, listStateRef }));
      (page.footerBlocks || []).forEach(block => appendBlockByType(footerEl, block, { pageIndex: pi, tableIndexRef, listStateRef }));

      root.appendChild(pageEl);
    });

    return root.innerHTML || '<p>&nbsp;</p>';
  },

  _deltaToXml(delta) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?><sec xmlns:hp="urn:hwp">\n`;
    let cur = '';
    (delta.ops||[]).forEach(op => {
      if (typeof op.insert !== 'string') return;
      op.insert.split('\n').forEach((line, i, arr) => {
        if (line) {
          const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          cur += `  <hp:run><hp:t>${esc}</hp:t></hp:run>\n`;
        }
        if (i < arr.length - 1) { xml += `<hp:p>\n${cur}</hp:p>\n`; cur = ''; }
      });
    });
    if (cur) xml += `<hp:p>\n${cur}</hp:p>\n`;
    return xml + '</sec>';
  },

  async _saveWithPicker(blob, name, options = {}) {
    const {
      handle = null,
      description = 'HWP Viewer Export',
      accept = null,
    } = options;

    if (handle?.createWritable) {
      await this._writeToHandle(handle, blob);
      return handle;
    }

    if (typeof window.showSaveFilePicker === 'function') {
      const ext = (name.split('.').pop() || 'bin').toLowerCase();
      const newHandle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{
          description,
          accept: accept || {
            [blob.type || 'application/octet-stream']: [`.${ext}`],
          },
        }],
      });
      await this._writeToHandle(newHandle, blob);
      return newHandle;
    }

    this._downloadByAnchor(blob, name);
    return null;
  },

  async _writeToHandle(handle, blob) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  },

  _downloadByAnchor(blob, name) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  },
};

/* ═══════════════════════════════════════════════
   APP STATE & DOM
═══════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const UI = {
  dropZone:       $('dropZone'),
  fileInput:      $('fileInput'),
  btnOpenFile:    $('btnOpenFile'),
  btnDropOpen:    $('btnDropOpen'),
  btnEditMode:    $('btnEditMode'),
  btnViewMode:    $('btnViewMode'),
  exportGroup:    $('exportGroup'),
  btnSaveCurrent: $('btnSaveCurrent'),
  saveAsFormat:   $('saveAsFormat'),
  btnSaveAs:      $('btnSaveAs'),
  btnPrint:       $('btnPrint'),
  btnCloseError:  $('btnCloseError'),
  loadingOverlay: $('loadingOverlay'),
  loadingMsg:     $('loadingMsg'),
  errorBanner:    $('errorBanner'),
  errorMsg:       $('errorMsg'),
  mainContent:    $('mainContent'),
  viewerPanel:    $('viewerPanel'),
  editorPanel:    $('editorPanel'),
  documentCanvas: $('documentCanvas'),
  pageThumbnails: $('pageThumbnails'),
  statusBar:      $('statusBar'),
  statusPageInfo: $('statusPageInfo'),
  statusFileInfo: $('statusFileInfo'),
  statusMode:     $('statusMode'),
  fileName:       $('fileName'),
  // WASM 보조 툴바
  wasmToolbar:    $('wasmToolbar'),
  btnZoomOut:     $('btnZoomOut'),
  btnZoomIn:      $('btnZoomIn'),
  btnZoomFit:     $('btnZoomFit'),
  zoomLevel:      $('zoomLevel'),
  wasmSearchInput:$('wasmSearchInput'),
  btnSearchPrev:  $('btnSearchPrev'),
  btnSearchNext:  $('btnSearchNext'),
  wasmSearchInfo: $('wasmSearchInfo'),
  btnSearchClear: $('btnSearchClear'),
};

const state = {
  doc: null,
  wasmRenderResult: null,
  wasmBuffer: null,
  filename: '',
  mode: 'view',
  currentPage: 0,
  renderedPages: 1,
  editedDoc: null,
  editedHtml: '',
  editedDelta: null,
  editBaseline: '',
  hasUnsavedChanges: false,
  documentLocked: false,
  documentLockReason: '',
  fileHandle: null,
  fileSource: '',
  // WASM 줌 상태
  wasmZoom: 1.0,
  wasmZoomTimer: null,
  // WASM 검색 상태
  wasmSearchResults: [],
  wasmSearchIndex: -1,
};

function getFilenameExtension(name = '') {
  return (String(name).split('.').pop() || '').toLowerCase();
}

function setCurrentFilename(name) {
  if (!name) return;
  state.filename = name;
  HwpExporter.setFilename(name);
  UI.fileName.textContent = name;
  document.title = `${name} - ChromeHWP Viewer`;
}

function updateFileInfoFromSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes)) return;
  UI.statusFileInfo.textContent = `${(sizeBytes/1024).toFixed(1)} KB | ${state.doc?.meta?.pages || state.renderedPages || 1}페이지`;
}

function hasLoadedDocument() {
  return Boolean(state.doc || state.wasmRenderResult);
}

function getSaveCurrentDisabledReason() {
  if (!state.doc) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if (state.mode !== 'edit') return '편집 모드에서 수정한 뒤 저장할 수 있습니다.';
  if (!state.hasUnsavedChanges) return '저장할 편집 내용이 없습니다.';
  if (!HwpExporter.canOverwriteFormat(getFilenameExtension(state.filename))) {
    return '현재 파일 덮어쓰기는 HWPX/OWPML 파일만 지원합니다. 다른 이름으로 저장을 사용해 주세요.';
  }
  return '';
}

function getSaveAsDisabledReason(format = UI.saveAsFormat?.value || 'hwpx') {
  if (!state.doc) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if (format === 'hwp') return '현재는 .hwp 바이너리 저장을 지원하지 않습니다. HWPX 또는 OWPML을 사용해 주세요.';
  if (format === 'pdf' && state.mode === 'edit' && state.hasUnsavedChanges) {
    return '';
  }
  return '';
}

function getPrintDisabledReason() {
  if (!hasLoadedDocument()) return '인쇄할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 인쇄할 수 없습니다.';
  return '';
}

function getDocumentLockReason(doc) {
  if (!doc || !Array.isArray(doc.pages) || doc.pages.length === 0) {
    return '문서가 정상적으로 로드되지 않아 편집/내보내기를 사용할 수 없습니다.';
  }

  if (doc.meta?.parseError) return String(doc.meta.parseError);

  const note = String(doc.meta?.note || '');
  if (/파싱\s*실패|파싱\s*오류/i.test(note)) {
    return '파싱에 실패한 문서라 편집/내보내기를 제한합니다.';
  }

  const firstBlock = doc.pages[0]?.paragraphs?.[0];
  const firstText = HwpParser._blockText(firstBlock).trim();
  if (
    /^⚠️\s*파싱 오류:/.test(firstText) ||
    /^⚠️\s*이 HWP 파일의 텍스트를 추출하지 못했습니다/.test(firstText)
  ) {
    return '문서 텍스트를 추출하지 못해 편집/내보내기를 제한합니다.';
  }

  return '';
}

function applyDocumentActionState() {
  const locked = Boolean(state.documentLocked);
  const title = locked ? (state.documentLockReason || '') : '';
  const saveCurrentReason = getSaveCurrentDisabledReason();
  const saveAsReason = getSaveAsDisabledReason();
  const printReason = getPrintDisabledReason();

  // WASM 모드에서는 편집 모드 비활성화 (편집은 기존 파서 기반만 지원)
  UI.btnEditMode.disabled = !state.doc || locked;
  UI.btnSaveCurrent.disabled = Boolean(saveCurrentReason);
  UI.btnSaveAs.disabled = Boolean(saveAsReason);
  UI.btnPrint.disabled = Boolean(printReason);

  UI.btnEditMode.title = title;
  UI.btnSaveCurrent.title = saveCurrentReason || '';
  UI.btnSaveAs.title = saveAsReason || '';
  UI.btnPrint.title = printReason || '';
  if (UI.saveAsFormat) UI.saveAsFormat.title = saveAsReason || '';
}

function ensureDocumentActionAllowed(actionLabel) {
  if (!hasLoadedDocument()) {
    showError(`${actionLabel}할 문서가 없습니다.`);
    return false;
  }
  if (!state.documentLocked) return true;

  showError(state.documentLockReason || `현재 문서는 ${actionLabel}할 수 없습니다.`);
  return false;
}

/* ── Web Worker 파싱 ── */
function parseWithWorker(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'hwpx' || ext === 'owpml') {
    return HwpParser.parse(buffer, filename);
  }

  return new Promise((resolve, reject) => {
    let worker;
    let timer = null;
    let settled = false;
    const WORKER_TIMEOUT_MS = 30_000; // 30초

    const finish = (handler) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (worker) worker.terminate();
      handler();
    };

    try {
      const workerUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
        ? chrome.runtime.getURL('js/parser.worker.js')
        : new URL('../js/parser.worker.js', window.location.href).href;
      worker = new Worker(workerUrl);
    } catch (e) {
      return reject(e);
    }

    timer = setTimeout(() => {
      finish(() => reject(new Error('파싱 시간 초과: Worker 처리 제한(30초)')));
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        showLoading(data.msg);
      } else if (data.type === 'done') {
        finish(() => resolve(data.doc));
      } else if (data.type === 'error') {
        finish(() => reject(new Error(data.message)));
      } else if (data.type === 'fallback_main') {
        // Worker가 HWPX를 JSZip 없이 파싱 못함 → 메인 스레드에서 처리
        finish(() => {
          console.log('[APP] Worker fallback → 메인 스레드 파싱');
          HwpParser.parse(buffer.slice(0), filename)
            .then(resolve).catch(reject);
        });
      }
    };
    worker.onerror = (e) => {
      finish(() => reject(new Error('Worker 오류: ' + e.message)));
    };

    // slice(0)로 ArrayBuffer 전체 복사본을 만들어 worker에만 transfer합니다.
    // 원본 buffer는 detach되지 않아 worker 타임아웃/실패 시 메인 스레드 fallback 파싱에 그대로 사용됩니다.
    const workerBuffer = buffer.slice(0);
    worker.postMessage({ buffer: workerBuffer, filename }, [workerBuffer]);
  });
}

/* ── WASM 렌더링 (rhwp 기반 — Canvas 렌더링) ── */
const WASM_INIT_TIMEOUT_MS = 10000; // WASM 초기화 최대 대기 시간 (10초)
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

async function tryWasmRender(buffer, filename) {
  const renderer = window.RhwpWasmRenderer;
  if (!renderer) return null;

  // WASM 초기화 대기
  let waited = 0;
  while (!renderer.isReady() && waited < WASM_INIT_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 100));
    waited += 100;
  }
  if (!renderer.isReady()) return null;

  return renderer.renderDocument(buffer, state.wasmZoom);
}

/**
 * WASM Canvas 결과를 뷰어에 렌더링한다.
 * pages 배열은 {canvas, width, height, index} 구조.
 */
function renderWasmPages(result) {
  const { pageCount, pages } = result;
  UI.documentCanvas.innerHTML = '';
  UI.pageThumbnails.innerHTML = '';
  state.renderedPages = pageCount;

  pages.forEach(({ canvas, index: pi }) => {
    // 페이지 래퍼
    const pageEl = document.createElement('div');
    pageEl.className = 'hwp-page hwp-page-canvas';
    pageEl.id = 'page-' + pi;
    pageEl.dataset.pageIndex = String(pi);
    if (pi === 0) pageEl.dataset.pageRole = 'first';

    // Canvas 크기를 뷰어 폭에 맞게 CSS로 조정 (WASM 렌더링 해상도는 유지)
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    pageEl.appendChild(canvas);

    UI.documentCanvas.appendChild(pageEl);

    // 사이드바 썸네일 — canvas를 toDataURL로 변환하여 <img> 삽입
    const th = document.createElement('div');
    th.className = 'page-thumb' + (pi === 0 ? ' active' : '');
    th.dataset.page = pi;
    th.onclick = () => scrollToPage(pi);

    const pv = document.createElement('div');
    pv.className = 'page-thumb-preview page-thumb-preview-canvas';

    // 썸네일 이미지 생성 (비동기 — canvas 렌더 완료 후)
    requestAnimationFrame(() => {
      try {
        const thumbImg = document.createElement('img');
        thumbImg.src = canvas.toDataURL('image/jpeg', 0.6);
        thumbImg.alt = (pi + 1) + ' 페이지';
        thumbImg.style.cssText = 'width:100%;height:auto;display:block;';
        pv.appendChild(thumbImg);
      } catch (e) { /* cross-origin 등 무시 */ }
    });

    th.appendChild(pv);
    th.appendChild(document.createTextNode((pi + 1) + ' 페이지'));
    UI.pageThumbnails.appendChild(th);
  });

  updateStatusBar();
  updateZoomUI();
}

/* ── WASM 줌 ── */
function updateZoomUI() {
  if (!UI.zoomLevel) return;
  UI.zoomLevel.textContent = Math.round(state.wasmZoom * 100) + '%';
}

async function applyWasmZoom(newZoom) {
  newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  if (Math.abs(newZoom - state.wasmZoom) < 0.001) return;
  state.wasmZoom = newZoom;
  updateZoomUI();

  // 줌 변경 시 재렌더 (디바운스 100ms)
  clearTimeout(state.wasmZoomTimer);
  state.wasmZoomTimer = setTimeout(async () => {
    if (!state.wasmRenderResult) return;
    const renderer = window.RhwpWasmRenderer;
    if (!renderer) return;
    showLoading('줌 재렌더 중...');
    try {
      const result = await renderer.rerenderAtZoom(state.wasmZoom);
      if (result) {
        state.wasmRenderResult = result;
        renderWasmPages(result);
      }
    } catch (e) {
      console.warn('[APP] 줌 재렌더 실패:', e.message);
    } finally {
      hideLoading();
    }
  }, 100);
}

function wasmZoomIn() {
  const next = ZOOM_STEPS.find(s => s > state.wasmZoom + 0.01);
  applyWasmZoom(next || ZOOM_MAX);
}
function wasmZoomOut() {
  const prev = [...ZOOM_STEPS].reverse().find(s => s < state.wasmZoom - 0.01);
  applyWasmZoom(prev || ZOOM_MIN);
}
function wasmZoomFit() {
  // 뷰어 패널 너비 기준으로 줌 계산
  const panelWidth = UI.viewerPanel?.clientWidth || 860;
  const firstCanvas = UI.documentCanvas.querySelector('canvas');
  if (!firstCanvas) { applyWasmZoom(1.0); return; }
  // canvas.width는 실제 렌더 픽셀 (zoom=1 기준 ~794px for A4)
  const baseWidth = firstCanvas.width / state.wasmZoom;
  const fit = Math.min(1.5, (panelWidth - 48) / baseWidth);
  applyWasmZoom(Math.max(ZOOM_MIN, fit));
}

/* ── WASM 텍스트 검색 ── */
let _wasmSearchDebounce = null;

function performWasmSearch(query) {
  clearTimeout(_wasmSearchDebounce);
  _wasmSearchDebounce = setTimeout(() => {
    const renderer = window.RhwpWasmRenderer;
    if (!renderer || !state.wasmRenderResult) return;

    if (!query) {
      clearWasmSearch();
      return;
    }

    const results = renderer.searchText(query, false);
    state.wasmSearchResults = results;
    state.wasmSearchIndex = results.length > 0 ? 0 : -1;
    updateWasmSearchUI();
    if (results.length > 0) scrollToWasmSearchResult(0);
  }, 300);
}

function clearWasmSearch() {
  state.wasmSearchResults = [];
  state.wasmSearchIndex = -1;
  updateWasmSearchUI();
}

function updateWasmSearchUI() {
  if (!UI.wasmSearchInfo) return;
  const count = state.wasmSearchResults.length;
  const idx = state.wasmSearchIndex;
  const hasQuery = !!(UI.wasmSearchInput?.value);

  if (count === 0) {
    UI.wasmSearchInfo.textContent = hasQuery ? '없음' : '';
    UI.wasmSearchInfo.classList.toggle('hidden', !hasQuery);
    if (UI.btnSearchPrev) UI.btnSearchPrev.disabled = true;
    if (UI.btnSearchNext) UI.btnSearchNext.disabled = true;
    UI.btnSearchClear?.classList.toggle('hidden', !hasQuery);
  } else {
    UI.wasmSearchInfo.textContent = (idx + 1) + ' / ' + count;
    UI.wasmSearchInfo.classList.remove('hidden');
    if (UI.btnSearchPrev) UI.btnSearchPrev.disabled = (idx <= 0);
    if (UI.btnSearchNext) UI.btnSearchNext.disabled = (idx >= count - 1);
    UI.btnSearchClear?.classList.remove('hidden');
  }
}

function scrollToWasmSearchResult(idx) {
  const result = state.wasmSearchResults[idx];
  if (!result || result.page == null) return;
  scrollToPage(result.page);
}

/* ── 버퍼 처리 (공통 코어) ── */
async function processBuffer(buffer, filename, sizeBytes, options = {}) {
  showLoading(`파싱 중... (${(sizeBytes/1024).toFixed(0)} KB)`);

  // 1차: rhwp WASM 렌더링 시도 (HWP/HWPX 모두 지원, 훨씬 정확한 레이아웃)
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let wasmResult = null;
  if (ext === 'hwp' || ext === 'hwpx') {
    try {
      showLoading('WASM 렌더링 중...');
      wasmResult = await tryWasmRender(buffer.slice(0), filename);
    } catch (e) {
      console.warn('[APP] WASM 렌더링 실패, 기존 파서로 폴백:', e.message);
    }
  }

  if (wasmResult) {
    // WASM 렌더링 성공 — state 세팅 (doc은 null, wasmRenderResult 보관)
    state.doc = null;
    state.wasmRenderResult = wasmResult;
    state.wasmBuffer = buffer;
    state.filename = filename;
    state.mode = 'view';
    state.currentPage = 0;
    state.renderedPages = wasmResult.pageCount;
    state.editedDoc = null;
    state.editedHtml = '';
    state.editedDelta = null;
    state.editBaseline = '';
    state.hasUnsavedChanges = false;
    state.documentLocked = false;
    state.documentLockReason = '';
    state.fileHandle = options.fileHandle || null;
    state.fileSource = options.fileSource || '';
    setCurrentFilename(filename);
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'ADD_RECENT_HWP_FILE', filename }).catch((err) => {
        console.warn('[APP] 최근 파일 저장 실패:', err?.message || err);
      });
    }
    hideLoading();
    renderHWP(null, wasmResult);
    updateUiAfterLoad(filename, sizeBytes);
    // WASM 툴바 표시 + body 클래스로 레이아웃 조정
    UI.wasmToolbar?.classList.remove('hidden');
    document.body.classList.add('wasm-toolbar-visible');
    return;
  }

  // 2차: 기존 JS 파서 (OWPML 또는 WASM 실패 시 폴백)
  let doc;
  try {
    doc = await parseWithWorker(buffer, filename);
  } catch (e) {
    console.warn('[APP] Worker 실패, 메인 스레드로 재시도:', e.message);
    try {
      doc = await HwpParser.parse(buffer, filename);
    } catch (e2) {
      console.error('[HWP] 파싱 실패:', e2);
      doc = {
        meta: { pages:1, note: '파싱 오류: ' + e2.message, parseError: '파싱 오류: ' + e2.message },
        pages: [{ index:0, paragraphs:[{ align:'left', texts:[{
          text: '⚠️ 파싱 오류: ' + e2.message,
          bold:false, italic:false, underline:false, fontSize:12,
          fontName:'Malgun Gothic', color:'#dc2626'
        }] }] }]
      };
    }
  }

  state.doc = doc;
  state.wasmRenderResult = null;
  state.wasmBuffer = null;
  // 기존 파서로 렌더링 시 WASM 툴바 숨김
  UI.wasmToolbar?.classList.add('hidden');
  document.body.classList.remove('wasm-toolbar-visible');
  state.filename = filename;
  state.mode = 'view';
  state.currentPage = 0;
  state.renderedPages = doc.pages?.length || 1;
  state.editedDoc = null;
  state.editedHtml = '';
  state.editedDelta = null;
  state.editBaseline = '';
  state.hasUnsavedChanges = false;
  state.documentLockReason = getDocumentLockReason(doc);
  state.documentLocked = Boolean(state.documentLockReason);
  state.fileHandle = options.fileHandle || null;
  state.fileSource = options.fileSource || '';
  setCurrentFilename(filename);
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'ADD_RECENT_HWP_FILE', filename }).catch((err) => {
      console.warn('[APP] 최근 파일 저장 실패:', err?.message || err);
    });
  }

  hideLoading();
  renderHWP(doc);
  updateUiAfterLoad(filename, sizeBytes);
}

/* ── 파일 처리 ── */
async function processFile(file, options = {}) {
  if (!/\.(hwp|hwpx|owpml)$/i.test(file.name)) {
    showError('지원 형식: .hwp, .hwpx, .owpml 파일만 가능합니다.');
    return;
  }

  showLoading('파일을 읽는 중...');
  try {
    const buffer = await file.arrayBuffer();
    await processBuffer(buffer, file.name, file.size, options);
  } catch (err) {
    hideLoading();
    showError('오류: ' + err.message);
    console.error('[APP]', err);
  }
}

/* ── 컨텍스트 메뉴 / URL 파라미터로 파일 자동 로드 ── */
async function autoLoadFromParams() {
  const params = new URLSearchParams(location.search);

  // 방법 1: background.js가 session storage에 저장해 둔 파일 데이터 가져오기
  if (params.get('fromContext') === '1') {
    showLoading('파일 데이터 수신 중...');
    try {
      const pending = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_PENDING_HWP' }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      });
      if (!pending) throw new Error('전달된 파일 데이터가 없습니다.');

      const { b64, filename } = pending;
      // base64 → ArrayBuffer
      const binary = atob(b64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await processBuffer(bytes.buffer, filename, bytes.length);
    } catch (err) {
      hideLoading();
      showError('파일 로드 실패: ' + err.message);
      console.error('[APP] fromContext 오류:', err);
    }
    return;
  }

  // 방법 2: CORS로 인해 background fetch 실패 → URL 파라미터로 직접 fetch 시도
  const hwpUrl = params.get('hwpUrl');
  if (hwpUrl) {
    showLoading('원격 파일 다운로드 중...');
    try {
      const resp = await fetch(hwpUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const buffer = await resp.arrayBuffer();
      const filename = decodeURIComponent(hwpUrl.split('/').pop().split('?')[0]) || 'document.hwp';
      await processBuffer(buffer, filename, buffer.byteLength);
    } catch (err) {
      hideLoading();
      showError('원격 파일 로드 실패: ' + err.message);
      console.error('[APP] hwpUrl 오류:', err);
    }
  }
}

function blockPreviewText(block) {
  return HwpParser._blockText(block)
    .replace(/\s+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function createPageSections(pageEl) {
  const headerEl = document.createElement('div');
  headerEl.className = 'hwp-page-header';
  const bodyEl = document.createElement('div');
  bodyEl.className = 'hwp-page-body';
  const footerEl = document.createElement('div');
  footerEl.className = 'hwp-page-footer';
  pageEl.append(headerEl, bodyEl, footerEl);
  return { headerEl, bodyEl, footerEl };
}

function renderDocument(doc) {
  UI.documentCanvas.innerHTML = '';
  UI.pageThumbnails.innerHTML = '';
  state.renderedPages = doc.pages.length || 1;
  const listStateRef = {};

  doc.pages.forEach((page, pi) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'hwp-page';
    pageEl.id = 'page-' + pi;
    pageEl.dataset.pageIndex = String(pi);
    if (pi === 0) pageEl.dataset.pageRole = 'first';
    applyPageStyle(pageEl, page, pi);

    if (pi === 0 && doc.meta?.note) {
      const n = document.createElement('div');
      n.style.cssText = 'background:#fef9c3;padding:8px 12px;border-radius:4px;font-size:12px;color:#78350f;margin-bottom:16px;white-space:pre-wrap;';
      n.textContent = doc.meta.note;
      pageEl.appendChild(n);
    }

    const { headerEl, bodyEl, footerEl } = createPageSections(pageEl);
    const tableIndexRef = { value: 0 };
    (page.headerBlocks || []).forEach(block => appendBlockByType(headerEl, block, { pageIndex: pi, tableIndexRef, listStateRef }));
    page.paragraphs.forEach(block => appendBlockByType(bodyEl, block, { pageIndex: pi, tableIndexRef, listStateRef }));
    (page.footerBlocks || []).forEach(block => appendBlockByType(footerEl, block, { pageIndex: pi, tableIndexRef, listStateRef }));

    UI.documentCanvas.appendChild(pageEl);

    // 사이드바 썸네일
    const th = document.createElement('div');
    th.className = 'page-thumb' + (pi === 0 ? ' active' : '');
    th.dataset.page = pi;
    th.onclick = () => scrollToPage(pi);

    const pv = document.createElement('div');
    pv.className = 'page-thumb-preview';
    pv.textContent = page.paragraphs
      .slice(0, 5)
      .map(block => blockPreviewText(block))
      .filter(Boolean)
      .join('\n')
      .slice(0, 120);
    th.appendChild(pv);
    th.appendChild(document.createTextNode((pi+1) + ' 페이지'));
    UI.pageThumbnails.appendChild(th);
  });

  requestAnimationFrame(() => applyDeferredObjectLayouts(UI.documentCanvas));
  updateStatusBar();
}

function renderHWP(data, wasmResult) {
  if (wasmResult) {
    renderWasmPages(wasmResult);
  } else {
    renderDocument(data);
  }
  state.currentPage = 0;
  UI.viewerPanel.scrollTop = 0;
  UI.documentCanvas.scrollTop = 0;
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page === 0));
  updateStatusBar();
}

function getCurrentDocumentHtml() {
  if (state.mode === 'edit') return HwpEditor.getHtml();
  if (state.editedDoc) return HwpExporter.buildDocumentHtml(state.editedDoc);
  if (state.doc) return HwpExporter.buildDocumentHtml(state.doc);
  return UI.documentCanvas.innerHTML;
}

function getCurrentDocumentDelta() {
  if (state.mode === 'edit') return HwpEditor.getDelta();
  if (state.editedDelta) return state.editedDelta;
  return state.doc ? HwpEditor.buildDocumentDelta(state.doc) : { ops: [] };
}

function syncEditStateFromEditor(options = {}) {
  const { markSaved = false } = options;
  if (state.mode !== 'edit') return null;

  const currentDelta = HwpEditor.getDelta();
  const serializedDelta = JSON.stringify(currentDelta);
  const hasChanges = serializedDelta !== state.editBaseline;

  if (hasChanges || markSaved) {
    state.editedDelta = currentDelta;
    state.editedHtml = HwpEditor.getHtml();
    state.editedDoc = HwpEditor.buildDocumentFromDelta(currentDelta);
  }

  if (markSaved) {
    state.editBaseline = serializedDelta;
    state.hasUnsavedChanges = false;
  } else {
    state.hasUnsavedChanges = hasChanges;
  }

  applyDocumentActionState();
  return { currentDelta, serializedDelta, hasChanges };
}

function scrollToPage(pi) {
  document.getElementById('page-' + pi)?.scrollIntoView({ behavior:'smooth', block:'start' });
  state.currentPage = pi;
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page === pi));
  updateStatusBar();
}

/* ── 편집 모드 ── */
function enterEditMode() {
  if (!state.doc) return;
  if (!ensureDocumentActionAllowed('편집')) return;
  if (state.editedDelta) HwpEditor.loadDelta(state.editedDelta);
  else HwpEditor.loadDocument(state.doc);
  state.editBaseline = JSON.stringify(HwpEditor.getDelta());
  state.hasUnsavedChanges = false;
  UI.viewerPanel.style.display = 'none';
  UI.editorPanel.style.display = 'flex';
  UI.btnEditMode.style.display = 'none';
  UI.btnViewMode.style.display = '';
  state.mode = 'edit';
  applyDocumentActionState();
  updateStatusBar();
  HwpEditor.focus();
}

function enterViewMode() {
  syncEditStateFromEditor();

  UI.editorPanel.style.display = 'none';
  UI.viewerPanel.style.display = '';
  UI.btnViewMode.style.display = 'none';
  UI.btnEditMode.style.display = '';
  state.mode = 'view';
  if (state.editedDoc) renderHWP(state.editedDoc);
  else renderHWP(state.doc);
  updateStatusBar();
}

/* ── UI 헬퍼 ── */
function updateUiAfterLoad(filename, sizeBytes) {
  UI.dropZone.style.display    = 'none';
  UI.mainContent.style.display = 'flex';
  UI.statusBar.style.display   = 'flex';
  UI.exportGroup.style.display = 'flex';
  setCurrentFilename(filename);
  updateFileInfoFromSize(sizeBytes);
  UI.errorBanner.style.display = 'none';
  applyDocumentActionState();
  if (state.documentLocked) {
    showError(state.documentLockReason);
  }
}

// style.display 직접 제어 — CSS display:flex 가 hidden 속성을 덮어쓰는 문제 방지
function showLoading(msg) {
  UI.loadingMsg.textContent    = msg || '처리 중...';
  UI.loadingOverlay.style.display = 'flex';
}
function hideLoading()  { UI.loadingOverlay.style.display = 'none'; }
function showError(msg) {
  UI.errorMsg.textContent    = msg;
  UI.errorBanner.style.display = 'flex';
}

function updateStatusBar() {
  UI.statusPageInfo.textContent = `${state.currentPage+1} / ${state.renderedPages || state.doc?.pages?.length || 1} 페이지`;
  const e = state.mode === 'edit';
  UI.statusMode.textContent = e ? '편집 모드' : '보기 모드';
  UI.statusMode.className   = 'mode-badge ' + (e ? 'edit' : 'view');
}

/* ── 이벤트 ── */
UI.btnOpenFile.onclick = UI.btnDropOpen.onclick = () => UI.fileInput.click();
UI.fileInput.onchange  = e => { const f=e.target.files?.[0]; if(f) processFile(f, { fileHandle: null, fileSource: 'input' }); UI.fileInput.value=''; };
UI.btnEditMode.onclick = enterEditMode;
UI.btnViewMode.onclick = enterViewMode;
UI.btnSaveCurrent.onclick = () => {
  HwpExporter.saveCurrent().catch(err => {
    if (err?.name === 'AbortError') return;
    showError('저장 실패: ' + err.message);
  });
};
UI.btnSaveAs.onclick = () => {
  HwpExporter.saveAs(UI.saveAsFormat?.value || 'hwpx').catch(err => {
    if (err?.name === 'AbortError') return;
    showError('다른 이름으로 저장 실패: ' + err.message);
  });
};
UI.btnPrint.onclick = () => {
  HwpExporter.printAsPdf();
};
UI.saveAsFormat.onchange = () => applyDocumentActionState();
UI.btnCloseError.onclick  = () => { UI.errorBanner.style.display = 'none'; };

UI.dropZone.addEventListener('dragenter', e => { e.preventDefault(); UI.dropZone.classList.add('drag-over'); });
UI.dropZone.addEventListener('dragover',  e => { e.preventDefault(); UI.dropZone.classList.add('drag-over'); });
UI.dropZone.addEventListener('dragleave', e => { if(!UI.dropZone.contains(e.relatedTarget)) UI.dropZone.classList.remove('drag-over'); });
UI.dropZone.addEventListener('drop', e => {
  e.preventDefault(); UI.dropZone.classList.remove('drag-over');
  const f = e.dataTransfer?.files?.[0]; if(f) processFile(f, { fileHandle: null, fileSource: 'drop' });
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if(f && /\.(hwp|hwpx|owpml)$/i.test(f.name)) processFile(f, { fileHandle: null, fileSource: 'drop' });
});

UI.viewerPanel?.addEventListener('scroll', () => {
  if (!state.doc) return;
  let closest=0, minDist=Infinity;
  document.querySelectorAll('.hwp-page').forEach((el,i) => {
    const d = Math.abs(el.getBoundingClientRect().top - 80);
    if (d < minDist) { minDist=d; closest=i; }
  });
  if (closest !== state.currentPage) {
    state.currentPage = closest;
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page===closest));
    updateStatusBar();
  }
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key==='o') { e.preventDefault(); UI.fileInput.click(); }
  if (e.ctrlKey && e.key==='e') { e.preventDefault(); state.mode==='view' ? enterEditMode() : enterViewMode(); }
  if (e.ctrlKey && e.key==='s') {
    e.preventDefault();
    if (!UI.btnSaveCurrent.disabled) {
      HwpExporter.saveCurrent().catch(err => {
        if (err?.name === 'AbortError') return;
        showError('저장 실패: ' + err.message);
      });
    }
  }
  if (e.ctrlKey && e.key === 'p') {
    e.preventDefault();
    if (!UI.btnPrint.disabled) {
      HwpExporter.printAsPdf();
    }
  }
  if (e.key==='Escape' && state.mode==='edit') enterViewMode();

  // WASM 줌 단축키 (Ctrl+= / Ctrl+- / Ctrl+0)
  if (state.wasmRenderResult) {
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); wasmZoomIn(); }
    if (e.ctrlKey && e.key === '-') { e.preventDefault(); wasmZoomOut(); }
    if (e.ctrlKey && e.key === '0') { e.preventDefault(); applyWasmZoom(1.0); }
    // Ctrl+F: 검색 포커스
    if (e.ctrlKey && e.key === 'f') { e.preventDefault(); UI.wasmSearchInput?.focus(); }
  }
});

// WASM 보조 툴바 이벤트 리스너
if (UI.btnZoomIn)  UI.btnZoomIn.onclick  = wasmZoomIn;
if (UI.btnZoomOut) UI.btnZoomOut.onclick = wasmZoomOut;
if (UI.btnZoomFit) UI.btnZoomFit.onclick = wasmZoomFit;

// Ctrl+휠 줌
UI.viewerPanel?.addEventListener('wheel', e => {
  if (!e.ctrlKey || !state.wasmRenderResult) return;
  e.preventDefault();
  if (e.deltaY < 0) wasmZoomIn(); else wasmZoomOut();
}, { passive: false });

if (UI.wasmSearchInput) {
  UI.wasmSearchInput.addEventListener('input', () => {
    performWasmSearch(UI.wasmSearchInput.value.trim());
  });
  UI.wasmSearchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const count = state.wasmSearchResults.length;
      if (!count) return;
      if (e.shiftKey) {
        if (state.wasmSearchIndex > 0) {
          state.wasmSearchIndex--;
          updateWasmSearchUI();
          scrollToWasmSearchResult(state.wasmSearchIndex);
        }
      } else {
        if (state.wasmSearchIndex < count - 1) {
          state.wasmSearchIndex++;
          updateWasmSearchUI();
          scrollToWasmSearchResult(state.wasmSearchIndex);
        }
      }
    }
    if (e.key === 'Escape') {
      UI.wasmSearchInput.value = '';
      clearWasmSearch();
      UI.wasmSearchInput.blur();
    }
  });
}
if (UI.btnSearchPrev) {
  UI.btnSearchPrev.onclick = () => {
    if (state.wasmSearchIndex > 0) {
      state.wasmSearchIndex--;
      updateWasmSearchUI();
      scrollToWasmSearchResult(state.wasmSearchIndex);
    }
  };
}
if (UI.btnSearchNext) {
  UI.btnSearchNext.onclick = () => {
    const count = state.wasmSearchResults.length;
    if (state.wasmSearchIndex < count - 1) {
      state.wasmSearchIndex++;
      updateWasmSearchUI();
      scrollToWasmSearchResult(state.wasmSearchIndex);
    }
  };
}
if (UI.btnSearchClear) {
  UI.btnSearchClear.onclick = () => {
    if (UI.wasmSearchInput) UI.wasmSearchInput.value = '';
    clearWasmSearch();
  };
}

console.log('[HWP Viewer] app.js 로드 완료 ✓');

/* ── 페이지 로드 시 URL 파라미터 자동 처리 ── */
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  // Chrome 확장 컨텍스트에서만 실행
  autoLoadFromParams().catch(e => console.error('[APP] autoLoad 오류:', e));
}
