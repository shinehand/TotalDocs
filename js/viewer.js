/**
 * viewer.js — 앱 진입점
 * ─────────────────────────────────────────────────────────────────────────────
 * 파일 업로드, 뷰어 렌더링, 편집 모드 전환, 내보내기를 모두 조율합니다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { HwpParser }   from './hwp-parser.js';
import { HwpEditor }   from './editor.js';
import { HwpExporter } from './exporter.js';

/* ═══════════════════════════════════════════════
   DOM 요소 참조
═══════════════════════════════════════════════ */
const $  = id => document.getElementById(id);

const UI = {
  dropZone:       $('dropZone'),
  fileInput:      $('fileInput'),
  btnOpenFile:    $('btnOpenFile'),
  btnDropOpen:    $('btnDropOpen'),
  btnEditMode:    $('btnEditMode'),
  btnViewMode:    $('btnViewMode'),
  exportGroup:    $('exportGroup'),
  btnExportHTML:  $('btnExportHTML'),
  btnExportPDF:   $('btnExportPDF'),
  btnExportHWPX:  $('btnExportHWPX'),
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
};

/* ═══════════════════════════════════════════════
   앱 상태
═══════════════════════════════════════════════ */
const state = {
  /** @type {object|null} 파싱된 HwpDocument */
  doc:        null,
  /** @type {string} 원본 파일명 */
  filename:   '',
  /** @type {'view'|'edit'} 현재 모드 */
  mode:       'view',
  /** 현재 표시 중인 페이지 인덱스 (0-based) */
  currentPage: 0,
};

/* ═══════════════════════════════════════════════
   모듈 인스턴스
═══════════════════════════════════════════════ */
const editor   = new HwpEditor();
let   exporter = null;

/* ═══════════════════════════════════════════════
   파일 처리
═══════════════════════════════════════════════ */

/**
 * File 객체를 받아 파싱 → 렌더링 전체 파이프라인 실행
 * @param {File} file
 */
async function processFile(file) {
  const allowed = /\.(hwp|hwpx)$/i;
  if (!allowed.test(file.name)) {
    showError(`지원하지 않는 파일 형식입니다: ${file.name} (.hwp 또는 .hwpx 파일을 선택하세요)`);
    return;
  }

  showLoading('파일을 읽는 중...');

  try {
    const buffer = await file.arrayBuffer();
    showLoading(`HWP 파일 파싱 중... (${(file.size / 1024).toFixed(0)} KB) — 잠시 기다려주세요`);

    let doc;
    try {
      doc = await HwpParser.parse(buffer, file.name);
    } catch (parseErr) {
      // 파싱 실패해도 빈 문서로 계속 진행
      console.error('[HWP] 파싱 오류:', parseErr);
      doc = {
        meta: { title: file.name, author: '', pages: 1, note: `파싱 오류: ${parseErr.message}` },
        pages: [{ index: 0, paragraphs: [{ align: 'left', texts: [{ text: `⚠️ 파싱 오류: ${parseErr.message}`, bold: false, italic: false, underline: false, fontSize: 12, fontName: 'Malgun Gothic', color: '#dc2626' }] }] }],
      };
    }

    state.doc         = doc;
    state.filename    = file.name;
    state.mode        = 'view';
    state.currentPage = 0;

    exporter = new HwpExporter(editor, file.name);

    hideLoading();
    renderDocument(doc);
    updateUiAfterLoad(file);

  } catch (err) {
    hideLoading();
    showError(`오류: ${err.message}`);
    console.error('[HWP] 예상치 못한 오류:', err);
  }
}

/* ═══════════════════════════════════════════════
   뷰어 렌더링
═══════════════════════════════════════════════ */

/**
 * HwpDocument를 HTML로 렌더링하여 #documentCanvas에 삽입
 * @param {object} doc HwpDocument
 */
function renderDocument(doc) {
  UI.documentCanvas.innerHTML = '';
  UI.pageThumbnails.innerHTML = '';

  doc.pages.forEach((page, pageIdx) => {
    // ── 페이지 컨테이너 ──────────────────────
    const pageEl = document.createElement('div');
    pageEl.className  = 'hwp-page';
    pageEl.id         = `page-${pageIdx}`;
    pageEl.dataset.page = pageIdx;

    // 파싱 메타 노트 표시
    if (pageIdx === 0 && doc.meta?.note) {
      const noteEl = document.createElement('div');
      noteEl.style.cssText =
        'background:#fef9c3;padding:8px 12px;border-radius:4px;font-size:12px;color:#78350f;margin-bottom:16px;';
      noteEl.textContent = `ℹ️ ${doc.meta.note}`;
      pageEl.appendChild(noteEl);
    }

    // ── 단락 렌더링 ──────────────────────────
    page.paragraphs.forEach(para => {
      const pEl = document.createElement('p');
      pEl.style.textAlign = para.align || 'left';

      if (para.texts.length === 0 || (para.texts.length === 1 && para.texts[0].text === '')) {
        pEl.innerHTML = '&nbsp;'; // 빈 단락
      } else {
        para.texts.forEach(run => {
          const span = document.createElement('span');
          span.textContent = run.text;

          const s = span.style;
          if (run.bold)      s.fontWeight    = 'bold';
          if (run.italic)    s.fontStyle     = 'italic';
          if (run.underline) s.textDecoration = 'underline';
          if (run.fontSize)  s.fontSize      = `${run.fontSize}pt`;
          if (run.fontName)  s.fontFamily    = `'${run.fontName}', sans-serif`;
          if (run.color && run.color !== '#000000') s.color = run.color;

          pEl.appendChild(span);
        });
      }

      pageEl.appendChild(pEl);
    });

    UI.documentCanvas.appendChild(pageEl);

    // ── 사이드바 썸네일 ─────────────────────
    const thumb = document.createElement('div');
    thumb.className = `page-thumb ${pageIdx === 0 ? 'active' : ''}`;
    thumb.dataset.page = pageIdx;
    thumb.onclick = () => scrollToPage(pageIdx);

    const preview = document.createElement('div');
    preview.className = 'page-thumb-preview';
    preview.textContent = page.paragraphs
      .slice(0, 5)
      .map(p => p.texts.map(t => t.text).join(''))
      .join('\n')
      .slice(0, 120);

    thumb.appendChild(preview);
    thumb.appendChild(document.createTextNode(`${pageIdx + 1} 페이지`));
    UI.pageThumbnails.appendChild(thumb);
  });

  updateStatusBar();
}

/** 특정 페이지로 스크롤 */
function scrollToPage(pageIdx) {
  const target = document.getElementById(`page-${pageIdx}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    state.currentPage = pageIdx;
  }
  // 썸네일 활성화 업데이트
  document.querySelectorAll('.page-thumb').forEach(t => {
    t.classList.toggle('active', Number(t.dataset.page) === pageIdx);
  });
  updateStatusBar();
}

/* ═══════════════════════════════════════════════
   편집 모드 전환
═══════════════════════════════════════════════ */

function enterEditMode() {
  if (!state.doc) return;

  // 에디터가 아직 초기화되지 않았으면 초기화
  if (!editor._initialized) {
    editor.init();
  }

  // HwpDocument → Quill에 로드
  editor.loadDocument(state.doc);

  // 패널 전환
  UI.viewerPanel.hidden = true;
  UI.editorPanel.hidden = false;
  UI.btnEditMode.hidden = true;
  UI.btnViewMode.hidden = false;

  state.mode = 'edit';
  updateStatusBar();
  editor.focus();
}

function enterViewMode() {
  UI.editorPanel.hidden = true;
  UI.viewerPanel.hidden = false;
  UI.btnViewMode.hidden = true;
  UI.btnEditMode.hidden = false;

  state.mode = 'view';
  updateStatusBar();
}

/* ═══════════════════════════════════════════════
   UI 헬퍼
═══════════════════════════════════════════════ */

function updateUiAfterLoad(file) {
  UI.dropZone.hidden   = true;
  UI.mainContent.hidden = false;
  UI.statusBar.hidden  = false;

  UI.btnEditMode.disabled = false;
  UI.exportGroup.hidden   = false;

  UI.fileName.textContent = file.name;
  UI.statusFileInfo.textContent =
    `${(file.size / 1024).toFixed(1)} KB | ${state.doc.meta.pages}페이지`;
}

function showLoading(msg = '처리 중...') {
  UI.loadingMsg.textContent    = msg;
  UI.loadingOverlay.hidden     = false;
}
function hideLoading() {
  UI.loadingOverlay.hidden = true;
}

function showError(msg) {
  UI.errorMsg.textContent  = msg;
  UI.errorBanner.hidden    = false;
}
function hideError() {
  UI.errorBanner.hidden = true;
}

function updateStatusBar() {
  const total = state.doc?.pages?.length ?? 1;
  UI.statusPageInfo.textContent = `${state.currentPage + 1} / ${total} 페이지`;

  const isEdit = state.mode === 'edit';
  UI.statusMode.textContent  = isEdit ? '편집 모드' : '보기 모드';
  UI.statusMode.className    = `mode-badge ${isEdit ? 'edit' : 'view'}`;
}

/* ═══════════════════════════════════════════════
   이벤트 등록
═══════════════════════════════════════════════ */

// 파일 열기 버튼들
UI.btnOpenFile.onclick  = () => UI.fileInput.click();
UI.btnDropOpen.onclick  = () => UI.fileInput.click();
UI.fileInput.onchange   = e => {
  const file = e.target.files?.[0];
  if (file) processFile(file);
  UI.fileInput.value = ''; // 같은 파일 재선택 허용
};

// 편집 / 보기 모드 전환
UI.btnEditMode.onclick = enterEditMode;
UI.btnViewMode.onclick = enterViewMode;

// 내보내기
UI.btnExportHTML.onclick  = () => exporter?.exportHtml();
UI.btnExportPDF.onclick   = () => exporter?.exportPdf();
UI.btnExportHWPX.onclick  = () => exporter?.exportHwpx();

// 에러 배너 닫기
UI.btnCloseError.onclick = hideError;

// ── 드래그 & 드롭 ───────────────────────────
UI.dropZone.addEventListener('dragenter', e => {
  e.preventDefault();
  UI.dropZone.classList.add('drag-over');
});
UI.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  UI.dropZone.classList.add('drag-over');
});
UI.dropZone.addEventListener('dragleave', e => {
  // dropZone 밖으로 나갈 때만 처리
  if (!UI.dropZone.contains(e.relatedTarget)) {
    UI.dropZone.classList.remove('drag-over');
  }
});
UI.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  UI.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) processFile(file);
});

// 뷰어 패널에서도 드래그&드롭 가능하게 (파일 업로드 후에도)
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.(hwp|hwpx)$/i.test(file.name)) processFile(file);
});

// ── 스크롤 시 현재 페이지 추적 ─────────────
UI.viewerPanel?.addEventListener('scroll', () => {
  if (!state.doc) return;
  const pages = document.querySelectorAll('.hwp-page');
  let closest = 0;
  let minDist = Infinity;

  pages.forEach((el, idx) => {
    const rect = el.getBoundingClientRect();
    const dist = Math.abs(rect.top - 80);
    if (dist < minDist) { minDist = dist; closest = idx; }
  });

  if (closest !== state.currentPage) {
    state.currentPage = closest;
    document.querySelectorAll('.page-thumb').forEach(t => {
      t.classList.toggle('active', Number(t.dataset.page) === closest);
    });
    updateStatusBar();
  }
});

// ── 키보드 단축키 ───────────────────────────
document.addEventListener('keydown', e => {
  // Ctrl+O : 파일 열기
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    UI.fileInput.click();
  }
  // Ctrl+E : 편집/보기 토글
  if (e.ctrlKey && e.key === 'e') {
    e.preventDefault();
    state.mode === 'view' ? enterEditMode() : enterViewMode();
  }
  // Escape : 보기 모드로 복귀
  if (e.key === 'Escape' && state.mode === 'edit') {
    enterViewMode();
  }
});
