/**
 * app.js — HWP Web Viewer & Editor (단일 번들, type="module" 없음)
 * import/export 제거 → Chrome 확장 모듈 로딩 문제 원천 차단
 */

/* ═══════════════════════════════════════════════
   HWP PARSER
═══════════════════════════════════════════════ */
const HwpParser = {

  async parse(buffer, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    await new Promise(r => setTimeout(r, 80)); // UI 업데이트 여유

    if (ext === 'hwpx') return HwpParser._parseHwpx(buffer);
    if (ext === 'hwp')  return HwpParser._parseHwp5(buffer);
    throw new Error(`지원하지 않는 형식: .${ext} (.hwp / .hwpx 만 가능)`);
  },

  /* ── HWPX ── */
  async _parseHwpx(buffer) {
    if (typeof JSZip === 'undefined') throw new Error('lib/jszip.min.js 로드 실패');
    const zip = await JSZip.loadAsync(buffer);
    const keys = Object.keys(zip.files)
      .filter(p => /Contents[\\/]section\d+\.xml$/i.test(p)).sort();
    if (!keys.length) throw new Error('HWPX: section 파일 없음');

    const pages = [];
    for (let i = 0; i < keys.length; i++) {
      const xml = await zip.files[keys[i]].async('string');
      pages.push({ index: i, paragraphs: HwpParser._hwpxSection(xml) });
    }
    return { meta: { pages: pages.length }, pages };
  },

  _hwpxSection(xmlStr) {
    let doc;
    try { doc = new DOMParser().parseFromString(xmlStr, 'application/xml'); }
    catch { return [{ align:'left', texts:[HwpParser._run('(XML 오류)')] }]; }

    const ps = Array.from(doc.querySelectorAll('p'));
    if (!ps.length) {
      const raw = doc.documentElement.textContent.trim();
      return raw.split(/\n/).map(l => ({ align:'left', texts:[HwpParser._run(l)] }));
    }
    return ps.map(p => ({
      align: p.getAttribute('align') || 'left',
      texts: [HwpParser._run(p.textContent || '')],
    }));
  },

  /* ── HWP 5.0 ── */
  _parseHwp5(buffer) {
    const b = new Uint8Array(buffer);
    const SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
    if (!SIG.every((v, i) => b[i] === v))
      throw new Error('HWP 시그니처 불일치 — 올바른 HWP 5.0 파일인지 확인하세요.');

    // 전략 1: CFB PrvText 스트림 직접 추출
    let text = null;
    try { text = HwpParser._scanPrvText(b); } catch(e) { console.warn('[HWP] PrvText 오류:', e); }

    // 전략 2: 파일 전체에서 한글 UTF-16LE 블록 직접 탐색 (CFB 구조 무관)
    if (!text) {
      console.log('[HWP] PrvText 실패 → 한글 텍스트 직접 스캔 시도');
      try { text = HwpParser._scanKoreanText(b); } catch(e) { console.warn('[HWP] 텍스트 스캔 오류:', e); }
    }

    if (!text) return HwpParser._fallback();

    const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\x02/g,'\n').split('\n');
    const paras = lines.map(l => ({ align:'left', texts:[HwpParser._run(l)] }));
    const pages = HwpParser._paginate(paras, 35);
    return {
      meta: { pages: pages.length, note: '⚠️ PrvText 텍스트 추출 (서식 미지원)' },
      pages
    };
  },

  _scanPrvText(b) {
    // ─────────────────────────────────────────────────────
    // CFB 헤더 파라미터 읽기
    // ─────────────────────────────────────────────────────
    const exp  = HwpParser._u16(b, 0x1E);
    const ss   = (exp >= 7 && exp <= 14) ? (1 << exp) : 512; // 섹터 크기 (보통 512)

    // 미니 스트림 컷오프 크기: 이 값보다 작은 스트림은 미니 섹터(64 바이트)에 저장
    const miniCutoff = HwpParser._u32(b, 0x38) || 4096;

    // 첫 번째 디렉토리 섹터 위치 (CFB 오프셋 0x2C)
    const dirStartSec = HwpParser._u32(b, 0x2C);
    if (dirStartSec >= 0xFFFFFFFA) return null;
    const dirBase = (dirStartSec + 1) * ss;
    if (dirBase + 128 > b.length) return null;

    // ─────────────────────────────────────────────────────
    // Root Entry (디렉토리 첫 번째 엔트리, 128 바이트)
    //   → startSec/size 로 미니 스트림 컨테이너 위치 파악
    // ─────────────────────────────────────────────────────
    const rootStartSec = HwpParser._u32(b, dirBase + 116);
    const miniContainerOff = (rootStartSec < 0xFFFFFFFA)
      ? (rootStartSec + 1) * ss
      : -1;

    console.log('[HWP] ss=%d miniCutoff=%d dirBase=%d rootStartSec=%d miniContainerOff=%d',
                ss, miniCutoff, dirBase, rootStartSec, miniContainerOff);

    // ─────────────────────────────────────────────────────
    // 파일 전체 128바이트 단위 스캔으로 "PrvText" 디렉토리 엔트리 탐색
    //   디렉토리 섹터가 비연속(FAT 체인)이어도 반드시 찾을 수 있도록
    //   512 바이트(헤더) 이후부터 파일 끝까지 전체 탐색
    // ─────────────────────────────────────────────────────
    const PAT = [0x50,0x00,0x72,0x00,0x76,0x00,0x54,0x00,0x65,0x00,0x78,0x00,0x74,0x00];

    for (let pos = 512; pos + 128 <= b.length; pos += 128) {
      const nl = HwpParser._u16(b, pos + 64);
      // "PrvText" = 7글자 × 2 + null 2바이트 = 16
      if (nl !== 16) continue;

      let ok = true;
      for (let k = 0; k < PAT.length; k++) {
        if (b[pos + k] !== PAT[k]) { ok = false; break; }
      }
      if (!ok) continue;

      const startSec = HwpParser._u32(b, pos + 116);
      const streamSz = HwpParser._u32(b, pos + 120);
      console.log('[HWP] PrvText 발견 pos=%d startSec=%d size=%d', pos, startSec, streamSz);

      if (startSec >= 0xFFFFFFFA || streamSz === 0 || streamSz > 8 * 1024 * 1024) return null;

      let off, end;

      if (streamSz < miniCutoff && miniContainerOff > 0) {
        // ── 미니 스트림 경로 (작은 스트림 — 대부분의 HWP PrvText) ──
        // 미니 섹터는 64 바이트 단위로, 미니 스트림 컨테이너 내부에 저장
        const MINI_SS = 64;
        off = miniContainerOff + startSec * MINI_SS;
        end = off + streamSz;
        console.log('[HWP] 미니 스트림: containerOff=%d miniSec=%d off=%d', miniContainerOff, startSec, off);
      } else {
        // ── 일반 스트림 경로 (큰 스트림) ──
        off = (startSec + 1) * ss;
        end = off + streamSz;
        console.log('[HWP] 일반 스트림: off=%d', off);
      }

      // 오프셋이 범위를 벗어나면 반대 방식으로 재시도
      if (off < 0 || off >= b.length) {
        console.warn('[HWP] 오프셋(%d) 범위 초과 → 반대 방식 재시도', off);
        if (streamSz < miniCutoff) {
          off = (startSec + 1) * ss;  // 미니 실패 → 일반 재시도
        } else {
          off = miniContainerOff > 0 ? miniContainerOff + startSec * 64 : -1; // 일반 실패 → 미니 재시도
        }
        if (off < 0 || off >= b.length) return null;
        end = off + streamSz;
      }
      end = Math.min(end, b.length);

      const raw  = b.slice(off, end);
      const text = new TextDecoder('utf-16le').decode(raw);
      // 유효한 텍스트인지 간단 검증 (절반 이상이 제어문자면 폐기)
      const printable = [...text].filter(c => c.charCodeAt(0) >= 0x20 || c === '\n' || c === '\r').length;
      if (printable < text.length * 0.4) {
        console.warn('[HWP] 디코딩 결과가 이진 데이터처럼 보임 — 폐기 (printable=%d/%d)', printable, text.length);
        return null;
      }
      console.log('[HWP] PrvText 디코딩 완료: %d 글자 (유효율 %d%%)', text.length, Math.round(printable/text.length*100));
      return text;
    }

    console.warn('[HWP] PrvText 엔트리를 찾지 못했습니다.');
    return null;
  },

  /**
   * CFB 구조 파싱 없이 파일 바이트에서 한글 UTF-16LE 텍스트를 직접 탐색.
   * 헤더(512 바이트) 이후를 2 바이트 단위로 슬라이드하며
   * 한글·영문 출력 가능 문자가 연속으로 이어지는 가장 긴 블록을 반환.
   */
  _scanKoreanText(b) {
    let bestStart = -1, bestLen = 0;
    let runStart  = -1, runLen  = 0;
    let koreanInRun = 0;

    const isValidCp = cp =>
      (cp >= 0x20  && cp <= 0x7E)   ||  // ASCII 출력 가능
      (cp >= 0xAC00 && cp <= 0xD7A3)||  // 한글 음절 (가-힣)
      (cp >= 0x1100 && cp <= 0x11FF)||  // 한글 자모
      (cp >= 0x3130 && cp <= 0x318F)||  // 한글 호환 자모
      (cp >= 0x4E00 && cp <= 0x9FFF)||  // 한중일 통합 한자
      cp === 0x000A || cp === 0x000D || cp === 0x0009 || cp === 0x0002;

    const isKorean = cp => cp >= 0xAC00 && cp <= 0xD7A3;

    const flush = () => {
      // 최소 30자 이상이고 한글이 5자 이상인 블록만 후보로
      if (runLen >= 60 && koreanInRun >= 10) {
        if (runLen > bestLen) { bestStart = runStart; bestLen = runLen; }
      }
      runStart = -1; runLen = 0; koreanInRun = 0;
    };

    for (let i = 512; i + 2 <= b.length; i += 2) {
      const cp = b[i] | (b[i + 1] << 8);
      if (isValidCp(cp)) {
        if (runStart < 0) runStart = i;
        runLen += 2;
        if (isKorean(cp)) koreanInRun++;
      } else {
        flush();
      }
    }
    flush();

    if (bestStart < 0) { console.warn('[HWP] 한글 텍스트 블록을 찾지 못했습니다.'); return null; }
    const raw = b.slice(bestStart, bestStart + bestLen);
    const text = new TextDecoder('utf-16le').decode(raw);
    console.log('[HWP] 한글 텍스트 스캔 성공: %d 글자 (한글 %d자)', text.length, koreanInRun);
    return text;
  },

  _fallback() {
    return {
      meta: { pages:1, note:'파싱 실패' },
      pages: [{ index:0, paragraphs:[{ align:'center', texts:[HwpParser._run(
        '⚠️ 이 HWP 파일의 텍스트를 추출하지 못했습니다.\n\n' +
        '원인: 구형 포맷(HWP 2.x~3.x), 암호 보호, 또는 파일 손상\n\n' +
        '해결책: 한글에서 "다른 이름으로 저장 → HWPX" 후 재시도하세요.'
      )] }] }]
    };
  },

  _paginate(paras, n) {
    if (!paras.length) return [{ index:0, paragraphs:[] }];
    const r = [];
    for (let i=0; i<paras.length; i+=n) r.push({ index:r.length, paragraphs:paras.slice(i,i+n) });
    return r;
  },

  _run(text) {
    return { text: text||'', bold:false, italic:false, underline:false,
             fontSize:11, fontName:'Malgun Gothic', color:'#000000' };
  },

  _u16(b, o) { return (b[o]??0) | ((b[o+1]??0)<<8); },
  _u32(b, o) {
    return ( (b[o]??0) | ((b[o+1]??0)<<8) | ((b[o+2]??0)<<16) | ((b[o+3]??0)<<24) ) >>> 0;
  },
};

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
  },

  loadDocument(doc) {
    this.init();
    if (!this.quill) return;
    const ops = [];
    doc.pages.forEach((page, pi) => {
      if (pi > 0) ops.push({ insert: `\n── 페이지 ${pi+1} ──\n`, attributes:{ 'code-block':true } });
      page.paragraphs.forEach(para => {
        para.texts.forEach(run => {
          const a = {};
          if (run.bold)      a.bold      = true;
          if (run.italic)    a.italic    = true;
          if (run.underline) a.underline = true;
          ops.push(Object.keys(a).length ? { insert: run.text||'', attributes:a } : { insert: run.text||'' });
        });
        const pa = {};
        if (para.align && para.align !== 'left') pa.align = para.align;
        ops.push(Object.keys(pa).length ? { insert:'\n', attributes:pa } : { insert:'\n' });
      });
    });
    this.quill.setContents({ ops }, 'silent');
    this.quill.setSelection(0, 0);
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

  exportHtml() {
    const html = this._wrap(HwpEditor.getHtml());
    this._dl(new Blob([html],{type:'text/html;charset=utf-8'}), this.basename+'.html');
  },

  exportPdf() {
    const w = window.open('','_blank','width=900,height=700');
    if (!w) { alert('팝업 차단 해제 후 재시도하세요.'); return; }
    w.document.write(this._wrap(HwpEditor.getHtml()));
    w.document.close();
    w.onload = () => { w.focus(); w.print(); w.onafterprint = ()=>w.close(); };
  },

  async exportHwpx() {
    if (typeof JSZip==='undefined') { alert('JSZip 로드 필요'); return; }
    const zip = new JSZip();
    zip.file('mimetype','application/hwp+zip',{compression:'STORE'});
    zip.folder('Contents').file('section0.xml', this._deltaToXml(HwpEditor.getDelta()));
    zip.folder('META-INF').file('container.xml',
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Contents/section0.xml" media-type="application/xml"/></rootfiles></container>`
    );
    const blob = await zip.generateAsync({type:'blob'});
    this._dl(blob, this.basename+'.hwpx');
  },

  _wrap(body) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${this.basename}</title>
<style>body{font-family:'Malgun Gothic',sans-serif;max-width:860px;margin:0 auto;padding:60px 80px;font-size:14px;line-height:1.75}@media print{body{padding:20mm 25mm}}</style>
</head><body>${body}</body></html>`;
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

  _dl(blob, name) {
    const a = Object.assign(document.createElement('a'), { href:URL.createObjectURL(blob), download:name });
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
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

const state = { doc:null, filename:'', mode:'view', currentPage:0 };

/* ── 파일 처리 ── */
async function processFile(file) {
  if (!/\.(hwp|hwpx)$/i.test(file.name)) {
    showError('지원 형식: .hwp, .hwpx 파일만 가능합니다.');
    return;
  }

  showLoading('파일을 읽는 중...');
  let doc;

  try {
    const buffer = await file.arrayBuffer();
    showLoading(`파싱 중... (${(file.size/1024).toFixed(0)} KB)`);

    try {
      doc = await HwpParser.parse(buffer, file.name);
    } catch (e) {
      console.error('[HWP] 파싱 실패:', e);
      doc = {
        meta: { pages:1, note: '파싱 오류: ' + e.message },
        pages: [{ index:0, paragraphs:[{ align:'left', texts:[{
          text: '⚠️ 파싱 오류: ' + e.message,
          bold:false, italic:false, underline:false, fontSize:12,
          fontName:'Malgun Gothic', color:'#dc2626'
        }] }] }]
      };
    }

    state.doc = doc; state.filename = file.name; state.mode = 'view'; state.currentPage = 0;
    HwpExporter.setFilename(file.name);

    hideLoading();
    renderDocument(doc);
    updateUiAfterLoad(file);

  } catch (err) {
    hideLoading();
    showError('오류: ' + err.message);
    console.error('[APP]', err);
  }
}

/* ── 뷰어 렌더링 ── */
function renderDocument(doc) {
  UI.documentCanvas.innerHTML = '';
  UI.pageThumbnails.innerHTML = '';

  doc.pages.forEach((page, pi) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'hwp-page';
    pageEl.id = 'page-' + pi;

    if (pi === 0 && doc.meta?.note) {
      const n = document.createElement('div');
      n.style.cssText = 'background:#fef9c3;padding:8px 12px;border-radius:4px;font-size:12px;color:#78350f;margin-bottom:16px;white-space:pre-wrap;';
      n.textContent = doc.meta.note;
      pageEl.appendChild(n);
    }

    page.paragraphs.forEach(para => {
      const p = document.createElement('p');
      p.style.textAlign = para.align || 'left';
      if (!para.texts.length || (para.texts.length === 1 && para.texts[0].text === '')) {
        p.innerHTML = '&nbsp;';
      } else {
        para.texts.forEach(run => {
          const s = document.createElement('span');
          s.textContent = run.text;
          if (run.bold)      s.style.fontWeight     = 'bold';
          if (run.italic)    s.style.fontStyle       = 'italic';
          if (run.underline) s.style.textDecoration  = 'underline';
          if (run.fontSize)  s.style.fontSize        = run.fontSize + 'pt';
          if (run.color && run.color !== '#000000') s.style.color = run.color;
          p.appendChild(s);
        });
      }
      pageEl.appendChild(p);
    });

    UI.documentCanvas.appendChild(pageEl);

    // 사이드바 썸네일
    const th = document.createElement('div');
    th.className = 'page-thumb' + (pi === 0 ? ' active' : '');
    th.dataset.page = pi;
    th.onclick = () => scrollToPage(pi);

    const pv = document.createElement('div');
    pv.className = 'page-thumb-preview';
    pv.textContent = page.paragraphs.slice(0,5).map(p=>p.texts.map(t=>t.text).join('')).join('\n').slice(0,120);
    th.appendChild(pv);
    th.appendChild(document.createTextNode((pi+1) + ' 페이지'));
    UI.pageThumbnails.appendChild(th);
  });

  updateStatusBar();
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
  HwpEditor.loadDocument(state.doc);
  UI.viewerPanel.style.display = 'none';
  UI.editorPanel.style.display = 'flex';
  UI.btnEditMode.style.display = 'none';
  UI.btnViewMode.style.display = '';
  state.mode = 'edit';
  updateStatusBar();
  HwpEditor.focus();
}

function enterViewMode() {
  UI.editorPanel.style.display = 'none';
  UI.viewerPanel.style.display = '';
  UI.btnViewMode.style.display = 'none';
  UI.btnEditMode.style.display = '';
  state.mode = 'view';
  updateStatusBar();
}

/* ── UI 헬퍼 ── */
function updateUiAfterLoad(file) {
  UI.dropZone.style.display    = 'none';
  UI.mainContent.style.display = 'flex';
  UI.statusBar.style.display   = 'flex';
  UI.btnEditMode.disabled      = false;
  UI.exportGroup.style.display = 'flex';
  UI.fileName.textContent      = file.name;
  UI.statusFileInfo.textContent = `${(file.size/1024).toFixed(1)} KB | ${state.doc.meta.pages}페이지`;
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
  UI.statusPageInfo.textContent = `${state.currentPage+1} / ${state.doc?.pages?.length??1} 페이지`;
  const e = state.mode === 'edit';
  UI.statusMode.textContent = e ? '편집 모드' : '보기 모드';
  UI.statusMode.className   = 'mode-badge ' + (e ? 'edit' : 'view');
}

/* ── 이벤트 ── */
UI.btnOpenFile.onclick = UI.btnDropOpen.onclick = () => UI.fileInput.click();
UI.fileInput.onchange  = e => { const f=e.target.files?.[0]; if(f) processFile(f); UI.fileInput.value=''; };
UI.btnEditMode.onclick = enterEditMode;
UI.btnViewMode.onclick = enterViewMode;
UI.btnExportHTML.onclick  = () => HwpExporter.exportHtml();
UI.btnExportPDF.onclick   = () => HwpExporter.exportPdf();
UI.btnExportHWPX.onclick  = () => HwpExporter.exportHwpx();
UI.btnCloseError.onclick  = () => { UI.errorBanner.style.display = 'none'; };

UI.dropZone.addEventListener('dragenter', e => { e.preventDefault(); UI.dropZone.classList.add('drag-over'); });
UI.dropZone.addEventListener('dragover',  e => { e.preventDefault(); UI.dropZone.classList.add('drag-over'); });
UI.dropZone.addEventListener('dragleave', e => { if(!UI.dropZone.contains(e.relatedTarget)) UI.dropZone.classList.remove('drag-over'); });
UI.dropZone.addEventListener('drop', e => {
  e.preventDefault(); UI.dropZone.classList.remove('drag-over');
  const f = e.dataTransfer?.files?.[0]; if(f) processFile(f);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if(f && /\.(hwp|hwpx)$/i.test(f.name)) processFile(f);
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
  if (e.key==='Escape' && state.mode==='edit') enterViewMode();
});

console.log('[HWP Viewer] app.js 로드 완료 ✓');
