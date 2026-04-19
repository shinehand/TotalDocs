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

  buildHwpBlob() {
    const renderer = getHwpWasmRenderer();
    if (!renderer?.exportHwp) {
      throw new Error('HWP 엔진 저장 기능을 사용할 수 없습니다.');
    }
    const bytes = renderer.exportHwp();
    return new Blob([bytes], { type: 'application/x-hwp' });
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
      ? getRenderedCanvasHtml()
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

    const format = getFilenameExtension(state.filename);
    const sync = syncEditStateFromEditor();

    if (state.wasmRenderResult) {
      const blob = this.buildHwpBlob();
      const handle = await this._saveWithPicker(blob, state.filename, {
        handle: state.fileHandle,
        description: 'HWP 문서',
        accept: {
          'application/x-hwp': ['.hwp'],
          'application/octet-stream': ['.hwp'],
        },
      });

      if (handle?.name) {
        setCurrentFilename(handle.name);
        state.fileHandle = handle;
      }

      syncEditStateFromEditor({ markSaved: true });
      updateFileInfoFromSize(blob.size);
      setStatusMessage('현재 HWP 파일에 저장했사옵니다.');
      return true;
    }

    if (!sync?.hasChanges) {
      applyDocumentActionState();
      return false;
    }

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
    setStatusMessage('현재 문서에 저장했사옵니다.');
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
      setStatusMessage('HTML로 내보냈사옵니다.');
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
      setStatusMessage(`${packageLabel}로 저장했사옵니다.`);
      return true;
    }

    if (format === 'hwp') {
      const blob = this.buildHwpBlob();
      await this._saveWithPicker(blob, name, {
        description: 'HWP 문서',
        accept: {
          'application/x-hwp': ['.hwp'],
          'application/octet-stream': ['.hwp'],
        },
      });
      updateFileInfoFromSize(blob.size);
      setStatusMessage('HWP 문서로 저장했사옵니다.');
      return true;
    }

    showError('지원하지 않는 저장 형식입니다.');
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

function getHwpWasmRenderer() {
  return window.HwpWasmRenderer;
}

function getRenderedCanvasHtml() {
  const clone = UI.documentCanvas?.cloneNode(true);
  if (!clone) return '';
  clone.querySelector?.('#wasmCaret')?.remove();
  clone.querySelector?.('#wasmImeInput')?.remove();

  const sourceCanvases = UI.documentCanvas.querySelectorAll('.hwp-page-canvas canvas');
  const clonedCanvases = clone.querySelectorAll?.('.hwp-page-canvas canvas') || [];
  clonedCanvases.forEach?.((canvas, index) => {
    const sourceCanvas = sourceCanvases[index];
    if (!sourceCanvas) return;
    try {
      const img = document.createElement('img');
      img.src = sourceCanvas.toDataURL('image/png');
      img.alt = sourceCanvas.getAttribute('aria-label') || '';
      img.style.cssText = sourceCanvas.getAttribute('style') || 'width:100%;height:auto;display:block;';
      canvas.replaceWith(img);
    } catch (err) {
      console.warn('[HWP Viewer] canvas HTML 변환 실패:', err);
    }
  });

  return clone.innerHTML;
}

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
  wasmCaret:      $('wasmCaret'),
  wasmImeInput:   $('wasmImeInput'),
  pageThumbnails: $('pageThumbnails'),
  qaAuditPanel:   $('qaAuditPanel'),
  qaAuditSummary: $('qaAuditSummary'),
  qaCurrentPageAudit: $('qaCurrentPageAudit'),
  qaHotspotList:  $('qaHotspotList'),
  statusBar:      $('statusBar'),
  statusPageInfo: $('statusPageInfo'),
  statusSectionInfo: $('statusSectionInfo'),
  statusMode:     $('statusMode'),
  statusFieldInfo:$('statusFieldInfo'),
  statusMessage:  $('statusMessage'),
  sbZoomFitWidth: $('sb-zoom-fit-width'),
  sbZoomFit:      $('sb-zoom-fit'),
  sbZoomVal:      $('sb-zoom-val'),
  sbZoomOut:      $('sb-zoom-out'),
  sbZoomIn:       $('sb-zoom-in'),
  fileName:       $('fileName'),
  hRuler:         $('h-ruler'),
  vRuler:         $('v-ruler'),
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
  documentInfo: null,
  fileInfoText: '',
  statusMessage: '',
  documentLocked: false,
  documentLockReason: '',
  fileHandle: null,
  fileSource: '',
  // WASM 줌 상태
  wasmZoom: 1.0,
  wasmZoomTimer: null,
  wasmCursor: null,
  wasmComposing: false,
  wasmEditQueue: Promise.resolve(),
  wasmAuditFocusTimer: null,
  // WASM 검색 상태
  wasmSearchResults: [],
  wasmSearchIndex: -1,
  wasmDiagnostics: null,
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
  state.fileInfoText = `${(sizeBytes/1024).toFixed(1)} KB | ${state.renderedPages || state.doc?.pages?.length || 1}쪽`;
  updateStatusBar();
}

function getSectionCount() {
  const raw = state.wasmDiagnostics?.sectionCount ?? state.documentInfo?.sectionCount ?? state.doc?.meta?.sectionCount ?? 1;
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getCurrentSection() {
  const current = state.wasmCursor?.sectionIndex != null ? state.wasmCursor.sectionIndex + 1 : 1;
  return Math.max(1, current);
}

function getStatusMessageText() {
  if (state.statusMessage) return state.statusMessage;
  if (!state.filename) return '문서를 열어 주시옵소서.';

  const parts = [state.filename];
  if (state.fileInfoText) parts.push(state.fileInfoText);
  if (state.documentInfo?.version) parts.push(`HWP ${state.documentInfo.version}`);
  return parts.join(' · ');
}

function setStatusMessage(message = '') {
  state.statusMessage = message;
  updateStatusBar();
}

function refreshWasmDiagnostics(options = {}) {
  const renderer = getHwpWasmRenderer();
  if (!renderer?.collectDocumentDiagnostics) {
    state.wasmDiagnostics = null;
    return null;
  }

  try {
    const diagnostics = renderer.collectDocumentDiagnostics({
      includePageInfo: true,
      includeSectionDetails: true,
      includeControlDetails: false,
      ...options,
    });
    state.wasmDiagnostics = diagnostics;
    return diagnostics;
  } catch (err) {
    console.warn('[HWP 진단] 수집 실패:', err);
    state.wasmDiagnostics = null;
    return null;
  }
}

function getWasmDiagnosticsSummaryText() {
  if (!state.wasmRenderResult) return '';
  const counts = state.wasmDiagnostics?.counts;
  if (!counts) return '';

  const parts = [];
  if (counts.tables > 0) parts.push(`표 ${counts.tables}`);
  if (counts.equations > 0) parts.push(`수식 ${counts.equations}`);
  if (counts.charts > 0) parts.push(`차트 ${counts.charts}`);

  const objectCount = (counts.pictures || 0)
    + (counts.shapes || 0)
    + (counts.forms || 0)
    + (counts.oles || 0)
    + (counts.videos || 0);

  if (objectCount > 0) parts.push(`개체 ${objectCount}`);
  if (!parts.length && counts.controls > 0) parts.push(`제어 ${counts.controls}`);
  return parts.join(' · ');
}

function toFiniteCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getWasmPageCounts(page = {}) {
  const counts = page?.counts || {};
  return {
    controls: toFiniteCount(page?.controlCount ?? counts.controls),
    tables: toFiniteCount(counts.tables),
    pictures: toFiniteCount(counts.pictures),
    equations: toFiniteCount(counts.equations),
    charts: toFiniteCount(counts.charts),
    forms: toFiniteCount(counts.forms),
    shapes: toFiniteCount(counts.shapes),
    oles: toFiniteCount(counts.oles),
    videos: toFiniteCount(counts.videos),
    textRuns: toFiniteCount(page?.textRunCount ?? counts.textRuns),
  };
}

function getWasmLayoutSignals(source = {}) {
  return {
    floatingTables: toFiniteCount(source.floatingTables),
    floatingPictures: toFiniteCount(source.floatingPictures),
    wrappedControls: toFiniteCount(source.wrappedControls),
    overlapAllowed: toFiniteCount(source.overlapAllowed),
    keepWithAnchor: toFiniteCount(source.keepWithAnchor),
    repeatHeaderTables: toFiniteCount(source.repeatHeaderTables),
    pageBreakTables: toFiniteCount(source.pageBreakTables),
    pageAnchoredControls: toFiniteCount(source.pageAnchoredControls),
    columnAnchoredControls: toFiniteCount(source.columnAnchoredControls),
    paragraphAnchoredControls: toFiniteCount(source.paragraphAnchoredControls),
    mergedCells: toFiniteCount(source.mergedCells),
    tallCells: toFiniteCount(source.tallCells),
    captionedPictures: toFiniteCount(source.captionedPictures),
    croppedPictures: toFiniteCount(source.croppedPictures),
    rotatedPictures: toFiniteCount(source.rotatedPictures),
    flippedPictures: toFiniteCount(source.flippedPictures),
  };
}

function buildAuditMetricLabels(counts = {}) {
  const labels = [];
  if (counts.controls > 0) labels.push(`제어 ${counts.controls}`);
  if (counts.tables > 0) labels.push(`표 ${counts.tables}`);
  if (counts.pictures > 0) labels.push(`그림 ${counts.pictures}`);
  if (counts.equations > 0) labels.push(`수식 ${counts.equations}`);
  if (counts.charts > 0) labels.push(`차트 ${counts.charts}`);

  const otherObjects = counts.forms + counts.shapes + counts.oles + counts.videos;
  if (otherObjects > 0) labels.push(`개체 ${otherObjects}`);
  if (counts.textRuns > 0) labels.push(`텍스트 ${counts.textRuns}`);
  return labels;
}

function buildAuditSignalLabels(source = {}) {
  const signals = getWasmLayoutSignals(source);
  const labels = [];
  if (signals.floatingTables > 0) labels.push(`부동표 ${signals.floatingTables}`);
  if (signals.floatingPictures > 0) labels.push(`부동그림 ${signals.floatingPictures}`);
  if (signals.repeatHeaderTables > 0) labels.push(`반복머리행 ${signals.repeatHeaderTables}`);
  if (signals.pageBreakTables > 0) labels.push(`셀나눔 ${signals.pageBreakTables}`);
  if (signals.overlapAllowed > 0) labels.push(`겹침허용 ${signals.overlapAllowed}`);
  if (signals.keepWithAnchor > 0) labels.push(`anchor고정 ${signals.keepWithAnchor}`);
  if (signals.pageAnchoredControls > 0) labels.push(`쪽기준 ${signals.pageAnchoredControls}`);
  if (signals.columnAnchoredControls > 0) labels.push(`단기준 ${signals.columnAnchoredControls}`);
  if (signals.paragraphAnchoredControls > 0) labels.push(`문단기준 ${signals.paragraphAnchoredControls}`);
  if (signals.mergedCells > 0) labels.push(`병합셀 ${signals.mergedCells}`);
  if (signals.tallCells > 0) labels.push(`큰셀 ${signals.tallCells}`);
  if (signals.captionedPictures > 0) labels.push(`캡션 ${signals.captionedPictures}`);
  if (signals.croppedPictures > 0) labels.push(`자르기 ${signals.croppedPictures}`);
  if (signals.rotatedPictures > 0) labels.push(`회전 ${signals.rotatedPictures}`);
  if (signals.flippedPictures > 0) labels.push(`반전 ${signals.flippedPictures}`);
  if (signals.wrappedControls > 0) labels.push(`본문배치 ${signals.wrappedControls}`);
  return labels;
}

function setAuditMetricChips(container, labels = [], hot = false) {
  if (!container) return;
  container.innerHTML = '';
  labels.forEach((label) => {
    const chip = document.createElement('span');
    chip.className = `qa-chip${hot ? ' is-hot' : ''}`;
    chip.textContent = label;
    container.appendChild(chip);
  });
}

function buildWasmLayoutHotspots(limit = 5) {
  const pages = Array.isArray(state.wasmDiagnostics?.pages) ? state.wasmDiagnostics.pages : [];
  return pages
    .map((page) => {
      const counts = getWasmPageCounts(page);
      const signals = getWasmLayoutSignals(page?.layoutSignals || {});
      const objectLoad = counts.tables + counts.pictures + counts.equations + counts.charts
        + counts.forms + counts.shapes + counts.oles + counts.videos;
      const layoutRisk = (signals.floatingTables * 220)
        + (signals.floatingPictures * 180)
        + (signals.repeatHeaderTables * 140)
        + (signals.pageBreakTables * 160)
        + (signals.overlapAllowed * 180)
        + (signals.keepWithAnchor * 70)
        + (signals.pageAnchoredControls * 110)
        + (signals.columnAnchoredControls * 80)
        + (signals.mergedCells * 3)
        + (signals.tallCells * 18)
        + (signals.croppedPictures * 50)
        + (signals.rotatedPictures * 30)
        + (signals.flippedPictures * 30);
      const score = (counts.controls * 1000)
        + (objectLoad * 100)
        + layoutRisk
        + (counts.textRuns === 0 && counts.controls > 0 ? 75 : Math.min(counts.textRuns, 400) / 4);
      return {
        pageIndex: Number.isFinite(page?.pageIndex) ? page.pageIndex : 0,
        score,
        counts,
        signalLabels: buildAuditSignalLabels(signals),
      };
    })
    .sort((a, b) => b.score - a.score || a.counts.textRuns - b.counts.textRuns || a.pageIndex - b.pageIndex)
    .slice(0, limit);
}

function flashAuditFocusPage(pageIndex) {
  const pageEl = document.getElementById(`page-${pageIndex}`);
  if (!pageEl) return;
  pageEl.classList.remove('audit-focus');
  void pageEl.offsetWidth;
  pageEl.classList.add('audit-focus');
  if (state.wasmAuditFocusTimer) {
    window.clearTimeout(state.wasmAuditFocusTimer);
  }
  state.wasmAuditFocusTimer = window.setTimeout(() => {
    pageEl.classList.remove('audit-focus');
    state.wasmAuditFocusTimer = null;
  }, 1400);
}

function updateLayoutAuditPanel() {
  if (!UI.qaAuditPanel || !UI.qaAuditSummary || !UI.qaCurrentPageAudit || !UI.qaHotspotList) return;

  const diagnostics = state.wasmDiagnostics;
  const pages = Array.isArray(diagnostics?.pages) ? diagnostics.pages : [];
  if (!state.wasmRenderResult || !pages.length) {
    UI.qaAuditPanel.style.display = 'none';
    UI.qaAuditSummary.innerHTML = '';
    UI.qaCurrentPageAudit.innerHTML = '';
    UI.qaHotspotList.innerHTML = '';
    return;
  }

  UI.qaAuditPanel.style.display = 'block';

  const docCounts = getWasmPageCounts({
    controlCount: diagnostics?.counts?.controls,
    counts: diagnostics?.counts,
  });
  const summaryTitle = document.createElement('div');
  summaryTitle.className = 'qa-audit-title';
  summaryTitle.textContent = `문서 집계 · ${diagnostics.pageCount || pages.length}쪽 · ${diagnostics.sectionCount || 1}구역`;
  const summaryChips = document.createElement('div');
  summaryChips.className = 'qa-chip-row';
  setAuditMetricChips(summaryChips, buildAuditMetricLabels(docCounts));
  const summarySignalLabels = buildAuditSignalLabels(diagnostics?.layoutSignals || {});
  UI.qaAuditSummary.innerHTML = '';
  UI.qaAuditSummary.appendChild(summaryTitle);
  UI.qaAuditSummary.appendChild(summaryChips);
  if (summarySignalLabels.length) {
    const summarySignalTitle = document.createElement('div');
    summarySignalTitle.className = 'qa-audit-subtitle';
    summarySignalTitle.textContent = '문서 조판 신호';
    const summarySignalChips = document.createElement('div');
    summarySignalChips.className = 'qa-chip-row';
    setAuditMetricChips(summarySignalChips, summarySignalLabels);
    UI.qaAuditSummary.appendChild(summarySignalTitle);
    UI.qaAuditSummary.appendChild(summarySignalChips);
  }

  const currentPage = pages[state.currentPage] || pages[0];
  const currentCounts = getWasmPageCounts(currentPage);
  const currentLabel = document.createElement('div');
  currentLabel.className = 'qa-audit-page-label';
  currentLabel.textContent = `현재 쪽 · ${Number.isFinite(currentPage?.pageIndex) ? currentPage.pageIndex + 1 : 1}쪽`;
  const currentTitle = document.createElement('div');
  currentTitle.className = 'qa-audit-title';
  currentTitle.textContent = '쪽별 진단';
  const currentChips = document.createElement('div');
  currentChips.className = 'qa-chip-row';
  setAuditMetricChips(currentChips, buildAuditMetricLabels(currentCounts), true);
  const currentSignalLabels = buildAuditSignalLabels(currentPage?.layoutSignals || {});
  UI.qaCurrentPageAudit.innerHTML = '';
  UI.qaCurrentPageAudit.appendChild(currentTitle);
  UI.qaCurrentPageAudit.appendChild(currentLabel);
  UI.qaCurrentPageAudit.appendChild(currentChips);
  if (currentSignalLabels.length) {
    const currentSignalTitle = document.createElement('div');
    currentSignalTitle.className = 'qa-audit-subtitle';
    currentSignalTitle.textContent = '현재 쪽 조판 신호';
    const currentSignalChips = document.createElement('div');
    currentSignalChips.className = 'qa-chip-row';
    setAuditMetricChips(currentSignalChips, currentSignalLabels, true);
    UI.qaCurrentPageAudit.appendChild(currentSignalTitle);
    UI.qaCurrentPageAudit.appendChild(currentSignalChips);
  }

  const hotspots = buildWasmLayoutHotspots();
  UI.qaHotspotList.innerHTML = '';
  hotspots.forEach((hotspot, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `qa-hotspot-btn${hotspot.pageIndex === state.currentPage ? ' is-current' : ''}`;
    button.dataset.pageIndex = String(hotspot.pageIndex);
    const pageLabel = document.createElement('span');
    pageLabel.className = 'qa-hotspot-page';
    pageLabel.textContent = `${index + 1}. 집중 확인 · ${hotspot.pageIndex + 1}쪽`;
    const meta = document.createElement('span');
    meta.className = 'qa-hotspot-meta';
    meta.textContent = buildAuditMetricLabels(hotspot.counts).join(' · ');
    button.appendChild(pageLabel);
    button.appendChild(meta);
    if (Array.isArray(hotspot.signalLabels) && hotspot.signalLabels.length) {
      const flags = document.createElement('span');
      flags.className = 'qa-hotspot-flags';
      flags.textContent = hotspot.signalLabels.join(' · ');
      button.appendChild(flags);
    }
    button.onclick = () => {
      scrollToPage(hotspot.pageIndex);
      flashAuditFocusPage(hotspot.pageIndex);
    };
    UI.qaHotspotList.appendChild(button);
  });
}

function drawGuidelineRulers() {
  drawHorizontalRuler();
  drawVerticalRuler();
}

function drawHorizontalRuler() {
  const canvas = UI.hRuler;
  const panel = UI.viewerPanel;
  if (!canvas || !panel) return;

  const width = Math.max(1, canvas.clientWidth || panel.clientWidth || 1);
  const height = Math.max(1, canvas.clientHeight || 20);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#e4e4e4');
  grad.addColorStop(1, '#cfcfcf');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const pageEl = UI.documentCanvas.querySelector('.hwp-page');
  const pageWidth = pageEl?.getBoundingClientRect().width || Math.min(width - 64, 820);
  const originX = Math.max(24, (panel.clientWidth - pageWidth) / 2 - panel.scrollLeft);
  const minor = 10;
  const major = 50;

  ctx.strokeStyle = 'rgba(30,30,30,0.45)';
  ctx.fillStyle = '#4b4b4b';
  ctx.font = '10px Malgun Gothic';

  for (let x = originX, mark = 0; x <= width; x += minor, mark += minor) {
    const isMajor = mark % major === 0;
    const tick = isMajor ? height - 4 : height - 9;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, height);
    ctx.lineTo(Math.round(x) + 0.5, tick);
    ctx.stroke();
    if (isMajor && x >= 0) ctx.fillText(String(mark / 10), x + 2, 9);
  }
}

function drawVerticalRuler() {
  const canvas = UI.vRuler;
  const panel = UI.viewerPanel;
  if (!canvas || !panel) return;

  const width = Math.max(1, canvas.clientWidth || 20);
  const height = Math.max(1, canvas.clientHeight || panel.clientHeight || 1);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, '#e4e4e4');
  grad.addColorStop(1, '#cfcfcf');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const minor = 10;
  const major = 50;
  const scrollTop = panel.scrollTop;

  ctx.strokeStyle = 'rgba(30,30,30,0.45)';
  ctx.fillStyle = '#4b4b4b';
  ctx.font = '10px Malgun Gothic';

  for (let y = -(scrollTop % minor), mark = scrollTop - (scrollTop % minor); y <= height; y += minor, mark += minor) {
    const isMajor = mark % major === 0;
    const tick = isMajor ? width - 4 : width - 9;
    ctx.beginPath();
    ctx.moveTo(width, Math.round(y) + 0.5);
    ctx.lineTo(tick, Math.round(y) + 0.5);
    ctx.stroke();
    if (isMajor && y >= 10) {
      ctx.save();
      ctx.translate(9, y + 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(mark / 10), 0, 0);
      ctx.restore();
    }
  }
}

function hasLoadedDocument() {
  return Boolean(state.doc || state.wasmRenderResult);
}

function getSaveCurrentDisabledReason() {
  if (!hasLoadedDocument()) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if (state.mode !== 'edit') return '편집 모드에서 수정한 뒤 저장할 수 있습니다.';
  if (!state.hasUnsavedChanges) return '저장할 편집 내용이 없습니다.';
  if (state.wasmRenderResult) {
    if (getFilenameExtension(state.filename) !== 'hwp') {
      return '현재 문서는 HWP로만 바로 저장할 수 있습니다. 다른 이름으로 저장을 사용해 주세요.';
    }
    return '';
  }
  if (!HwpExporter.canOverwriteFormat(getFilenameExtension(state.filename))) {
    return '현재 파일 덮어쓰기는 HWPX/OWPML 파일만 지원합니다. 다른 이름으로 저장을 사용해 주세요.';
  }
  return '';
}

function getSaveAsDisabledReason(format = UI.saveAsFormat?.value || 'hwpx') {
  if (!hasLoadedDocument()) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if ((format === 'hwpx' || format === 'owpml') && !state.doc) {
    return '현재 문서는 HWPX/OWPML로 재패키징할 수 없습니다. HTML, PDF 또는 HWP 저장을 사용해 주세요.';
  }
  if (format === 'hwp' && !state.wasmRenderResult) {
    return '현재 문서는 HWP 바이너리 저장을 지원하지 않습니다. HWP 엔진 경로로 연 문서에서만 저장할 수 있습니다.';
  }
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
  const hasWasm = Boolean(state.wasmRenderResult);

  UI.btnEditMode.disabled = (!state.doc && !hasWasm) || locked;
  UI.btnSaveCurrent.disabled = Boolean(saveCurrentReason);
  UI.btnSaveAs.disabled = Boolean(saveAsReason);
  UI.btnPrint.disabled = Boolean(printReason);
  if (UI.sbZoomFitWidth) UI.sbZoomFitWidth.disabled = !hasWasm;
  if (UI.sbZoomFit) UI.sbZoomFit.disabled = !hasWasm;
  if (UI.sbZoomOut) UI.sbZoomOut.disabled = !hasWasm;
  if (UI.sbZoomIn) UI.sbZoomIn.disabled = !hasWasm;

  UI.btnEditMode.title = locked
    ? title
    : hasWasm
      ? '문서 위에서 직접 편집합니다.'
      : '';
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

/* ── WASM 렌더링 (HWP 엔진 기반 Canvas 렌더링) ── */
const WASM_INIT_TIMEOUT_MS = 10000; // WASM 초기화 최대 대기 시간 (10초)
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

async function waitForHwpWasmRenderer() {
  let renderer = getHwpWasmRenderer();
  let waited = 0;

  while (!renderer && waited < WASM_INIT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    waited += 100;
    renderer = getHwpWasmRenderer();
  }

  return renderer;
}

async function tryWasmRender(buffer, filename) {
  const renderer = await waitForHwpWasmRenderer();
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
  if (UI.wasmCaret) UI.documentCanvas.appendChild(UI.wasmCaret);
  if (UI.wasmImeInput) UI.documentCanvas.appendChild(UI.wasmImeInput);
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
  requestAnimationFrame(() => {
    drawGuidelineRulers();
    syncWasmCursorVisual();
  });
}

function isWasmEditMode() {
  return state.mode === 'edit' && Boolean(state.wasmRenderResult);
}

function queueWasmEdit(task) {
  const run = async () => {
    try {
      await task();
    } catch (err) {
      console.error('[HWP 편집] 실패:', err);
      showError('문서 직접 편집 실패: ' + err.message);
    }
  };

  state.wasmEditQueue = state.wasmEditQueue.then(run, run);
  return state.wasmEditQueue;
}

function setActiveThumbnail(pageIndex) {
  document.querySelectorAll('.page-thumb').forEach((thumb) => {
    thumb.classList.toggle('active', Number(thumb.dataset.page) === pageIndex);
  });
}

function focusWasmImeInput() {
  if (!isWasmEditMode() || !UI.wasmImeInput) return;
  UI.wasmImeInput.focus({ preventScroll: true });
}

function hideWasmCursorVisual() {
  UI.wasmCaret?.classList.remove('is-active');
}

function setWasmEditVisualState(active) {
  UI.viewerPanel?.classList.toggle('wasm-edit-mode', active);
  if (!active) {
    hideWasmCursorVisual();
    if (UI.wasmImeInput) UI.wasmImeInput.value = '';
  }
}

function getWasmCanvasMetrics(pageIndex) {
  const pageEl = document.getElementById('page-' + pageIndex);
  const canvas = pageEl?.querySelector('canvas');
  if (!pageEl || !canvas) return null;

  const rect = canvas.getBoundingClientRect();
  return {
    pageEl,
    canvas,
    scaleX: rect.width / canvas.width,
    scaleY: rect.height / canvas.height,
  };
}

function keepWasmCursorInView(top, height) {
  if (!UI.viewerPanel) return;
  const padding = 40;
  const viewTop = UI.viewerPanel.scrollTop;
  const viewBottom = viewTop + UI.viewerPanel.clientHeight;

  if (top < viewTop + padding) {
    UI.viewerPanel.scrollTo({ top: Math.max(0, top - padding), behavior: 'smooth' });
    return;
  }

  if (top + height > viewBottom - padding) {
    UI.viewerPanel.scrollTo({
      top: Math.max(0, top + height - UI.viewerPanel.clientHeight + padding),
      behavior: 'smooth',
    });
  }
}

function syncWasmCursorVisual() {
  if (!isWasmEditMode() || !state.wasmCursor) {
    hideWasmCursorVisual();
    return;
  }

  const renderer = getHwpWasmRenderer();
  if (!renderer?.getCursorRect) {
    hideWasmCursorVisual();
    return;
  }

  let rect;
  try {
    rect = renderer.getCursorRect(
      state.wasmCursor.sectionIndex,
      state.wasmCursor.paragraphIndex,
      state.wasmCursor.charOffset,
    );
  } catch (err) {
    console.warn('[HWP 편집] 커서 좌표 조회 실패:', err);
    hideWasmCursorVisual();
    return;
  }

  if (!rect || rect.pageIndex == null) {
    hideWasmCursorVisual();
    return;
  }

  const metrics = getWasmCanvasMetrics(rect.pageIndex);
  if (!metrics || !UI.wasmCaret) {
    hideWasmCursorVisual();
    return;
  }

  const left = metrics.pageEl.offsetLeft + rect.x * state.wasmZoom * metrics.scaleX;
  const top = metrics.pageEl.offsetTop + rect.y * state.wasmZoom * metrics.scaleY;
  const height = Math.max(18, rect.height * state.wasmZoom * metrics.scaleY);

  UI.wasmCaret.style.left = `${left}px`;
  UI.wasmCaret.style.top = `${top}px`;
  UI.wasmCaret.style.height = `${height}px`;
  UI.wasmCaret.classList.add('is-active');

  if (UI.wasmImeInput) {
    UI.wasmImeInput.style.left = `${left}px`;
    UI.wasmImeInput.style.top = `${top}px`;
    UI.wasmImeInput.style.height = `${height}px`;
  }

  state.currentPage = rect.pageIndex;
  setActiveThumbnail(rect.pageIndex);
  updateStatusBar();
  keepWasmCursorInView(top, height);
}

function setWasmCursor(position, options = {}) {
  if (!position) return;
  const { focus = true } = options;
  state.wasmCursor = {
    sectionIndex: position.sectionIndex,
    paragraphIndex: position.paragraphIndex,
    charOffset: position.charOffset ?? 0,
  };
  requestAnimationFrame(syncWasmCursorVisual);
  if (focus) focusWasmImeInput();
}

function getWasmPointerPosition(event) {
  const pageEl = event.target.closest?.('.hwp-page-canvas');
  const canvas = pageEl?.querySelector?.('canvas');
  if (!pageEl || !canvas) return null;

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    pageIndex: Number(pageEl.dataset.pageIndex || 0),
    pageX: ((event.clientX - rect.left) * scaleX) / state.wasmZoom,
    pageY: ((event.clientY - rect.top) * scaleY) / state.wasmZoom,
  };
}

async function rerenderWasmWithCursor(nextCursor) {
  const renderer = getHwpWasmRenderer();
  if (!renderer?.rerenderAtZoom) return;
  const result = await renderer.rerenderAtZoom(state.wasmZoom);
  if (!result) return;
  state.wasmRenderResult = result;
  refreshWasmDiagnostics({ includeSectionDetails: false });
  renderWasmPages(result);
  state.hasUnsavedChanges = true;
  applyDocumentActionState();
  updateStatusBar();
  setWasmCursor(nextCursor, { focus: true });
}

async function insertTextAtWasmCursor(text) {
  if (!text || !state.wasmCursor) return;
  const renderer = getHwpWasmRenderer();
  if (!renderer?.insertText) return;

  const cursor = state.wasmCursor;
  const result = renderer.insertText(
    cursor.sectionIndex,
    cursor.paragraphIndex,
    cursor.charOffset,
    text,
  );

  await rerenderWasmWithCursor({
    sectionIndex: cursor.sectionIndex,
    paragraphIndex: cursor.paragraphIndex,
    charOffset: result?.charOffset ?? (cursor.charOffset + [...text].length),
  });
}

async function deleteBackwardAtWasmCursor() {
  if (!state.wasmCursor) return;
  const renderer = getHwpWasmRenderer();
  if (!renderer) return;

  const cursor = state.wasmCursor;
  if (cursor.charOffset > 0 && renderer.deleteText) {
    const result = renderer.deleteText(
      cursor.sectionIndex,
      cursor.paragraphIndex,
      cursor.charOffset - 1,
      1,
    );
    await rerenderWasmWithCursor({
      sectionIndex: cursor.sectionIndex,
      paragraphIndex: cursor.paragraphIndex,
      charOffset: result?.charOffset ?? Math.max(0, cursor.charOffset - 1),
    });
    return;
  }

  if (cursor.paragraphIndex > 0 && renderer.mergeParagraph) {
    const result = renderer.mergeParagraph(cursor.sectionIndex, cursor.paragraphIndex);
    await rerenderWasmWithCursor({
      sectionIndex: cursor.sectionIndex,
      paragraphIndex: result?.paraIdx ?? (cursor.paragraphIndex - 1),
      charOffset: result?.charOffset ?? 0,
    });
  }
}

async function splitParagraphAtWasmCursor() {
  if (!state.wasmCursor) return;
  const renderer = getHwpWasmRenderer();
  if (!renderer?.splitParagraph) return;

  const cursor = state.wasmCursor;
  const result = renderer.splitParagraph(
    cursor.sectionIndex,
    cursor.paragraphIndex,
    cursor.charOffset,
  );

  await rerenderWasmWithCursor({
    sectionIndex: cursor.sectionIndex,
    paragraphIndex: result?.paraIdx ?? (cursor.paragraphIndex + 1),
    charOffset: result?.charOffset ?? 0,
  });
}

function moveWasmCursorHorizontally(direction) {
  if (!state.wasmCursor) return;
  const renderer = getHwpWasmRenderer();
  if (!renderer?.getParagraphLength) return;

  const cursor = state.wasmCursor;
  if (direction < 0) {
    if (cursor.charOffset > 0) {
      setWasmCursor({ ...cursor, charOffset: cursor.charOffset - 1 });
      return;
    }
    if (cursor.paragraphIndex > 0) {
      const prevLength = renderer.getParagraphLength(cursor.sectionIndex, cursor.paragraphIndex - 1);
      setWasmCursor({
        sectionIndex: cursor.sectionIndex,
        paragraphIndex: cursor.paragraphIndex - 1,
        charOffset: prevLength,
      });
    }
    return;
  }

  const paragraphLength = renderer.getParagraphLength(cursor.sectionIndex, cursor.paragraphIndex);
  if (cursor.charOffset < paragraphLength) {
    setWasmCursor({ ...cursor, charOffset: cursor.charOffset + 1 });
    return;
  }

  const paragraphCount = renderer.getParagraphCount?.(cursor.sectionIndex) || 0;
  if (cursor.paragraphIndex + 1 < paragraphCount) {
    setWasmCursor({
      sectionIndex: cursor.sectionIndex,
      paragraphIndex: cursor.paragraphIndex + 1,
      charOffset: 0,
    });
  }
}

function moveWasmCursorVertically(delta) {
  if (!state.wasmCursor) return;
  const renderer = getHwpWasmRenderer();
  if (!renderer?.moveVertical || !renderer?.getCursorRect) return;

  try {
    const rect = renderer.getCursorRect(
      state.wasmCursor.sectionIndex,
      state.wasmCursor.paragraphIndex,
      state.wasmCursor.charOffset,
    );
    const next = renderer.moveVertical(
      state.wasmCursor.sectionIndex,
      state.wasmCursor.paragraphIndex,
      state.wasmCursor.charOffset,
      delta,
      rect?.x ?? 0,
    );
    if (next?.sectionIndex != null) {
      setWasmCursor(next);
    }
  } catch (err) {
    console.warn('[HWP 편집] 세로 이동 실패:', err);
  }
}

function enterWasmEditMode() {
  state.mode = 'edit';
  UI.viewerPanel.style.display = '';
  UI.editorPanel.style.display = 'none';
  UI.btnEditMode.style.display = 'none';
  UI.btnViewMode.style.display = '';
  setWasmEditVisualState(true);
  if (!state.wasmCursor) {
    setWasmCursor({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  } else {
    syncWasmCursorVisual();
    focusWasmImeInput();
  }
  applyDocumentActionState();
  updateStatusBar();
  setStatusMessage('문서 위 직접 편집 중이옵니다.');
}

function exitWasmEditMode() {
  state.mode = 'view';
  UI.btnViewMode.style.display = 'none';
  UI.btnEditMode.style.display = '';
  setWasmEditVisualState(false);
  applyDocumentActionState();
  setStatusMessage('');
  updateStatusBar();
}

/* ── WASM 줌 ── */
function updateZoomUI() {
  const zoomText = Math.round(state.wasmZoom * 100) + '%';
  if (UI.zoomLevel) UI.zoomLevel.textContent = zoomText;
  if (UI.sbZoomVal) UI.sbZoomVal.textContent = zoomText;
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
    const renderer = getHwpWasmRenderer();
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

function wasmZoomPageFit() {
  const panelWidth = UI.viewerPanel?.clientWidth || 860;
  const panelHeight = UI.viewerPanel?.clientHeight || 900;
  const firstCanvas = UI.documentCanvas.querySelector('canvas');
  if (!firstCanvas) { applyWasmZoom(1.0); return; }
  const baseWidth = firstCanvas.width / state.wasmZoom;
  const baseHeight = firstCanvas.height / state.wasmZoom;
  const fitWidth = (panelWidth - 56) / baseWidth;
  const fitHeight = (panelHeight - 56) / baseHeight;
  const fit = Math.min(1.5, fitWidth, fitHeight);
  applyWasmZoom(Math.max(ZOOM_MIN, fit));
}

/* ── WASM 텍스트 검색 ── */
let _wasmSearchDebounce = null;

function performWasmSearch(query) {
  clearTimeout(_wasmSearchDebounce);
  _wasmSearchDebounce = setTimeout(() => {
    const renderer = getHwpWasmRenderer();
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

  // 1차: HWP 엔진 WASM 렌더링 시도 (HWP/HWPX 모두 지원, 훨씬 정확한 레이아웃)
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
    state.documentInfo = wasmResult.docInfo || null;
    state.editedDoc = null;
    state.editedHtml = '';
    state.editedDelta = null;
    state.editBaseline = '';
    state.hasUnsavedChanges = false;
    state.wasmCursor = null;
    state.wasmComposing = false;
    state.wasmEditQueue = Promise.resolve();
    state.wasmDiagnostics = null;
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
    refreshWasmDiagnostics();
    renderHWP(null, wasmResult);
    setWasmEditVisualState(false);
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
  state.documentInfo = {
    sectionCount: doc.meta?.sectionCount || 1,
    pageCount: doc.pages?.length || 1,
    version: doc.meta?.version || '',
  };
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
  state.wasmCursor = null;
  state.wasmComposing = false;
  state.wasmEditQueue = Promise.resolve();
  state.wasmDiagnostics = null;
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
  setWasmEditVisualState(false);
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
  const hasExtensionRuntime = typeof chrome !== 'undefined' && chrome.runtime?.id;

  // 방법 1: background.js가 session storage에 저장해 둔 파일 데이터 가져오기
  if (params.get('fromContext') === '1' && hasExtensionRuntime) {
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
  requestAnimationFrame(drawGuidelineRulers);
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
  if (state.mode === 'edit' && state.wasmRenderResult) return getRenderedCanvasHtml();
  if (state.mode === 'edit') return HwpEditor.getHtml();
  if (state.editedDoc) return HwpExporter.buildDocumentHtml(state.editedDoc);
  if (state.doc) return HwpExporter.buildDocumentHtml(state.doc);
  return getRenderedCanvasHtml();
}

function getCurrentDocumentDelta() {
  if (state.mode === 'edit') return HwpEditor.getDelta();
  if (state.editedDelta) return state.editedDelta;
  return state.doc ? HwpEditor.buildDocumentDelta(state.doc) : { ops: [] };
}

function syncEditStateFromEditor(options = {}) {
  const { markSaved = false } = options;
  if (state.wasmRenderResult) {
    if (markSaved) state.hasUnsavedChanges = false;
    applyDocumentActionState();
    return null;
  }
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
  const pageEl = document.getElementById('page-' + pi);
  if (!pageEl || !UI.viewerPanel) return;
  UI.viewerPanel.scrollTo({
    top: Math.max(0, pageEl.offsetTop - 24),
    behavior: 'smooth',
  });
  state.currentPage = pi;
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page === pi));
  updateStatusBar();
  drawGuidelineRulers();
}

function moveToPage(direction) {
  const totalPages = state.renderedPages || state.doc?.pages?.length || 1;
  const nextPage = Math.max(0, Math.min(totalPages - 1, state.currentPage + direction));
  if (nextPage !== state.currentPage) scrollToPage(nextPage);
}

/* ── 편집 모드 ── */
function enterEditMode() {
  if (state.wasmRenderResult) {
    if (!ensureDocumentActionAllowed('편집')) return;
    enterWasmEditMode();
    return;
  }
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
  setStatusMessage('텍스트 편집 모드이옵니다.');
  HwpEditor.focus();
}

function enterViewMode() {
  if (state.wasmRenderResult) {
    exitWasmEditMode();
    return;
  }
  syncEditStateFromEditor();

  UI.editorPanel.style.display = 'none';
  UI.viewerPanel.style.display = '';
  UI.btnViewMode.style.display = 'none';
  UI.btnEditMode.style.display = '';
  state.mode = 'view';
  if (state.editedDoc) renderHWP(state.editedDoc);
  else renderHWP(state.doc);
  setStatusMessage('');
  updateStatusBar();
}

/* ── UI 헬퍼 ── */
function updateUiAfterLoad(filename, sizeBytes) {
  UI.dropZone.style.display    = 'none';
  UI.mainContent.style.display = 'flex';
  UI.statusBar.style.display   = 'flex';
  UI.exportGroup.style.display = 'flex';
  UI.viewerPanel.style.display = '';
  UI.editorPanel.style.display = 'none';
  UI.btnViewMode.style.display = 'none';
  UI.btnEditMode.style.display = '';
  state.statusMessage = '';
  setCurrentFilename(filename);
  updateFileInfoFromSize(sizeBytes);
  UI.errorBanner.style.display = 'none';
  applyDocumentActionState();
  if (state.documentLocked) {
    showError(state.documentLockReason);
  }
  requestAnimationFrame(drawGuidelineRulers);
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
  const totalPages = state.renderedPages || state.doc?.pages?.length || 1;
  const totalSections = getSectionCount();
  const currentSection = Math.min(totalSections, getCurrentSection());
  const isEdit = state.mode === 'edit';
  const diagnosticsSummary = getWasmDiagnosticsSummaryText();

  UI.statusPageInfo.textContent = `${state.currentPage + 1} / ${totalPages} 쪽`;
  if (UI.statusSectionInfo) {
    UI.statusSectionInfo.textContent = `구역: ${currentSection} / ${totalSections}`;
  }
  UI.statusMode.textContent = isEdit
    ? (state.hasUnsavedChanges ? '삽입 *' : '삽입')
    : '읽기';
  if (UI.statusFieldInfo) {
    UI.statusFieldInfo.textContent = diagnosticsSummary;
    UI.statusFieldInfo.style.display = diagnosticsSummary ? '' : 'none';
  }
  if (UI.statusMessage) UI.statusMessage.textContent = getStatusMessageText();
  updateLayoutAuditPanel();
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

document.addEventListener('click', (event) => {
  const actionEl = event.target.closest?.('[data-action]');
  if (!actionEl) return;

  const action = actionEl.getAttribute('data-action');
  switch (action) {
    case 'open-file':
      UI.fileInput.click();
      break;
    case 'save-current':
      if (!UI.btnSaveCurrent.disabled) UI.btnSaveCurrent.click();
      break;
    case 'save-as':
      if (!UI.btnSaveAs.disabled) UI.btnSaveAs.click();
      break;
    case 'print-document':
      if (!UI.btnPrint.disabled) UI.btnPrint.click();
      break;
    case 'enter-edit-mode':
      if (!UI.btnEditMode.disabled) UI.btnEditMode.click();
      break;
    case 'enter-view-mode':
      if (UI.btnViewMode.style.display !== 'none') UI.btnViewMode.click();
      break;
    case 'zoom-fit':
      if (state.wasmRenderResult) wasmZoomFit();
      break;
    case 'zoom-page-fit':
      if (state.wasmRenderResult) wasmZoomPageFit();
      break;
    case 'zoom-in':
      if (state.wasmRenderResult) wasmZoomIn();
      break;
    case 'zoom-out':
      if (state.wasmRenderResult) wasmZoomOut();
      break;
    case 'zoom-reset':
      if (state.wasmRenderResult) applyWasmZoom(1.0);
      break;
    case 'first-page':
      scrollToPage(0);
      break;
    case 'prev-page':
      moveToPage(-1);
      break;
    case 'next-page':
      moveToPage(1);
      break;
    case 'last-page': {
      const totalPages = state.renderedPages || state.doc?.pages?.length || 1;
      scrollToPage(totalPages - 1);
      break;
    }
    case 'focus-search':
      UI.wasmSearchInput?.focus();
      break;
    default:
      break;
  }
});

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

UI.documentCanvas?.addEventListener('mousedown', (event) => {
  if (!isWasmEditMode() || event.button !== 0) return;

  const pointer = getWasmPointerPosition(event);
  if (!pointer) return;

  const renderer = getHwpWasmRenderer();
  if (!renderer?.hitTest) return;

  event.preventDefault();
  try {
    const hit = renderer.hitTest(pointer.pageIndex, pointer.pageX, pointer.pageY);
    if (!hit || hit.paragraphIndex == null || hit.paragraphIndex >= 0xFFFFFF00) {
      focusWasmImeInput();
      return;
    }
    setWasmCursor(hit);
  } catch (err) {
    console.warn('[HWP 편집] hitTest 실패:', err);
  }
});

if (UI.wasmImeInput) {
  UI.wasmImeInput.addEventListener('compositionstart', () => {
    state.wasmComposing = true;
  });

  UI.wasmImeInput.addEventListener('compositionend', (event) => {
    state.wasmComposing = false;
    UI.wasmImeInput.value = '';
    if (!isWasmEditMode() || !event.data) return;
    queueWasmEdit(() => insertTextAtWasmCursor(event.data));
  });

  UI.wasmImeInput.addEventListener('paste', (event) => {
    if (!isWasmEditMode()) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    UI.wasmImeInput.value = '';
    queueWasmEdit(() => insertTextAtWasmCursor(text));
  });

  UI.wasmImeInput.addEventListener('keydown', (event) => {
    if (!isWasmEditMode()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key) {
      case 'Backspace':
        event.preventDefault();
        event.stopPropagation();
        queueWasmEdit(deleteBackwardAtWasmCursor);
        return;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        queueWasmEdit(splitParagraphAtWasmCursor);
        return;
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        queueWasmEdit(() => insertTextAtWasmCursor('\t'));
        return;
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        moveWasmCursorHorizontally(-1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        event.stopPropagation();
        moveWasmCursorHorizontally(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        moveWasmCursorVertically(-1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        moveWasmCursorVertically(1);
        return;
      default:
        break;
    }

    if (state.wasmComposing) return;
    if (event.key.length === 1) {
      event.preventDefault();
      event.stopPropagation();
      UI.wasmImeInput.value = '';
      queueWasmEdit(() => insertTextAtWasmCursor(event.key));
    }
  });
}

UI.viewerPanel?.addEventListener('scroll', () => {
  if (!hasLoadedDocument()) return;
  let closest=0, minDist=Infinity;
  const panelTop = UI.viewerPanel.getBoundingClientRect().top;
  document.querySelectorAll('.hwp-page').forEach((el,i) => {
    const d = Math.abs(el.getBoundingClientRect().top - panelTop - 24);
    if (d < minDist) { minDist=d; closest=i; }
  });
  if (closest !== state.currentPage) {
    state.currentPage = closest;
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page===closest));
    updateStatusBar();
  }
  drawGuidelineRulers();
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
if (UI.sbZoomIn) UI.sbZoomIn.onclick = wasmZoomIn;
if (UI.sbZoomOut) UI.sbZoomOut.onclick = wasmZoomOut;
if (UI.sbZoomFitWidth) UI.sbZoomFitWidth.onclick = wasmZoomFit;
if (UI.sbZoomFit) UI.sbZoomFit.onclick = wasmZoomPageFit;

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

window.addEventListener('resize', () => {
  requestAnimationFrame(drawGuidelineRulers);
});

window.__ChromeHwpDiagnostics = {
  getCurrent: () => state.wasmDiagnostics,
  collect: (options = {}) => {
    const renderer = getHwpWasmRenderer();
    if (!renderer?.collectDocumentDiagnostics) return null;
    return renderer.collectDocumentDiagnostics(options);
  },
};

console.log('[HWP Viewer] app.js 로드 완료 ✓');

/* ── 페이지 로드 시 URL 파라미터 자동 처리 ── */
autoLoadFromParams().catch(e => console.error('[APP] autoLoad 오류:', e));
