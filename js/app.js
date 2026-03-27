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
    await new Promise(r => setTimeout(r, 80));

    if (ext === 'hwpx') return HwpParser._parseHwpx(buffer);
    if (ext === 'hwp')  return await HwpParser._parseHwp5(buffer);
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

  /* ════════════════════════════════════════════
     HWP 5.0 — 3단계 파싱 전략
  ════════════════════════════════════════════ */
  async _parseHwp5(buffer) {
    const b = new Uint8Array(buffer);
    const SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
    if (!SIG.every((v, i) => b[i] === v))
      throw new Error('HWP 시그니처 불일치 — 올바른 HWP 5.0 파일인지 확인하세요.');

    // 전략 0: BodyText/Section 파싱 (전체 텍스트 + 단락 구조)
    let allParas = null;
    try { allParas = await HwpParser._parseBodyText(b); }
    catch(e) { console.warn('[HWP] BodyText 파싱 실패:', e); }

    if (allParas) {
      const cleaned = [];
      let emptyRun = 0;
      for (const p of allParas) {
        const isEmpty = !p.texts.some(t => t.text.trim());
        if (isEmpty) { if (++emptyRun <= 2) cleaned.push(p); }
        else { emptyRun = 0; cleaned.push(p); }
      }
      const pages = HwpParser._paginate(cleaned, 40);
      return { meta: { pages: pages.length }, pages };
    }

    // 전략 1: CFB PrvText 스트림
    let text = null;
    try { text = HwpParser._scanPrvText(b); } catch(e) { console.warn('[HWP] PrvText 오류:', e); }

    // 전략 2: 한글 UTF-16LE 블록 직접 탐색
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

  /* ════════════════════════════════════════════
     CFB FAT 유틸리티
  ════════════════════════════════════════════ */
  _readFat(b, ss) {
    const nFat = HwpParser._u32(b, 0x28);
    if (nFat === 0) return new Uint32Array(0);
    const ePS = ss / 4;
    const fat = new Uint32Array(nFat * ePS);
    for (let i = 0; i < 109 && i < nFat; i++) {
      const fatSec = HwpParser._u32(b, 0x4C + i * 4);
      if (fatSec >= 0xFFFFFFF8) break;
      const base = (fatSec + 1) * ss;
      if (base + ss > b.length) continue;
      for (let j = 0; j < ePS; j++)
        fat[i * ePS + j] = HwpParser._u32(b, base + j * 4);
    }
    return fat;
  },

  _readStreamByFat(b, startSec, streamSz, ss, fat) {
    if (startSec >= 0xFFFFFFF8 || streamSz === 0) return null;
    const result = new Uint8Array(streamSz);
    let written = 0, sec = startSec;
    while (sec < 0xFFFFFFF8 && written < streamSz) {
      const off = (sec + 1) * ss;
      const len = Math.min(ss, streamSz - written);
      if (off + len > b.length) break;
      result.set(b.subarray(off, off + len), written);
      written += len;
      sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
    }
    return result;
  },

  _scanDirEntries(b, names) {
    const queries = names.map(name => {
      const pat = [];
      for (const c of name) { const cc = c.charCodeAt(0); pat.push(cc & 0xFF, cc >> 8); }
      return { name, pat, nameLen: (name.length + 1) * 2 };
    });
    const result = {};
    for (let pos = 512; pos + 128 <= b.length; pos += 128) {
      const nl = HwpParser._u16(b, pos + 64);
      for (const { name, pat, nameLen } of queries) {
        if (nl !== nameLen) continue;
        let ok = true;
        for (let k = 0; k < pat.length; k++) {
          if (b[pos + k] !== pat[k]) { ok = false; break; }
        }
        if (ok) result[name] = {
          startSec: HwpParser._u32(b, pos + 116),
          streamSz: HwpParser._u32(b, pos + 120),
        };
      }
    }
    return result;
  },

  /* ── zlib 압축 해제 ── */
  async _decompressZlib(data) {
    const timeoutMs = 8000;
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('zlib 압축 해제 시간 초과 (8초)')), timeoutMs);
    });

    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    const chunks = [];
    try {
      const decodePromise = (async () => {
        await writer.write(data);
        await writer.close();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      })();

      await Promise.race([decodePromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      try { reader.releaseLock(); } catch {}
      try { writer.releaseLock(); } catch {}
    }

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  },

  /* ── HWP 레코드 파서 (TagID 67 = HWPTAG_PARA_TEXT) ── */
  _parseHwpRecords(data) {
    const paras = [];
    let pos = 0;
    while (pos + 4 <= data.length) {
      const hdr   = HwpParser._u32(data, pos); pos += 4;
      const tagId = hdr & 0x3FF;
      let size    = (hdr >> 20) & 0xFFF;
      if (size === 0xFFF) {
        if (pos + 4 > data.length) break;
        size = HwpParser._u32(data, pos); pos += 4;
      }
      const recEnd = Math.min(pos + size, data.length);
      if (tagId === 67 && size >= 2) {
        const chars = [];
        let i = pos;
        while (i + 2 <= recEnd) {
          const ch = data[i] | (data[i+1] << 8);
          if (ch === 0x000D) { i += 2; break; }
          else if (ch === 0x0009) { chars.push('\t'); i += 2; }
          else if (ch === 0x000A || ch === 0x0006) { chars.push('\n'); i += 2; }
          else if (ch === 0x0002) { chars.push('\n'); i += 2; }
          else if (ch >= 0x0001 && ch <= 0x001F) { i += 32; }
          else if (ch >= 0x0020) { chars.push(String.fromCharCode(ch)); i += 2; }
          else { i += 2; }
        }
        paras.push({ align: 'left', texts: [HwpParser._run(chars.join(''))] });
      }
      pos = recEnd;
    }
    return paras;
  },

  /* ── BodyText/Section 스트림 파싱 ── */
  async _parseBodyText(b) {
    const ss         = (() => { const e = HwpParser._u16(b, 0x1E); return (e>=7&&e<=14)?(1<<e):512; })();
    const miniCutoff = HwpParser._u32(b, 0x38) || 4096;
    const dirStartSec = HwpParser._u32(b, 0x2C);
    if (dirStartSec >= 0xFFFFFFFA) return null;

    const dirBase          = (dirStartSec + 1) * ss;
    const rootStartSec     = HwpParser._u32(b, dirBase + 116);
    const miniContainerOff = rootStartSec < 0xFFFFFFFA ? (rootStartSec + 1) * ss : -1;

    const fat = HwpParser._readFat(b, ss);
    const sectionNames = Array.from({ length: 10 }, (_, i) => 'Section' + i);
    const entries = HwpParser._scanDirEntries(b, ['FileHeader', ...sectionNames]);

    let compressed = true;
    if (entries.FileHeader) {
      const { startSec, streamSz } = entries.FileHeader;
      let fhData;
      if (streamSz < miniCutoff && miniContainerOff > 0) {
        const off = miniContainerOff + startSec * 64;
        fhData = b.slice(off, Math.min(off + streamSz, b.length));
      } else {
        fhData = HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
      }
      if (fhData && fhData.length >= 40) {
        compressed = (fhData[36] & 1) !== 0;
        if (fhData[36] & 2) { console.warn('[HWP] 암호화된 문서'); return null; }
        console.log('[HWP] FileHeader: compressed=%s', compressed);
      }
    }

    const allParas = [];
    for (let sn = 0; sn <= 9; sn++) {
      const entry = entries['Section' + sn];
      if (!entry) break;
      const { startSec, streamSz } = entry;
      if (startSec >= 0xFFFFFFFA || streamSz === 0) break;

      let data;
      if (streamSz < miniCutoff && miniContainerOff > 0) {
        const off = miniContainerOff + startSec * 64;
        if (off + streamSz > b.length) continue;
        data = b.slice(off, off + streamSz);
      } else {
        data = HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
      }
      if (!data || data.length === 0) continue;

      if (compressed) {
        try { data = await HwpParser._decompressZlib(data); }
        catch(e) { console.warn('[HWP] Section' + sn + ' 압축 해제 실패:', e.message); continue; }
      }

      const paras = HwpParser._parseHwpRecords(data);
      allParas.push(...paras);
      console.log('[HWP] Section%d: %d단락', sn, paras.length);
    }

    return allParas.length > 0 ? allParas : null;
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

      // 오프셋 범위 검사 — 잘못된 오프셋이면 즉시 null 반환 (재시도 없음)
      // 재시도 로직이 엉뚱한 데이터를 읽어 깨진 텍스트를 반환하는 문제 방지
      if (off < 0 || off >= b.length) {
        console.warn('[HWP] 오프셋(%d) 범위 초과 (fileLen=%d) → null 반환, _scanKoreanText로 위임', off, b.length);
        return null;
      }
      end = Math.min(off + streamSz, b.length);

      const raw  = b.slice(off, end);
      const text = new TextDecoder('utf-16le').decode(raw);

      // 유효성 검증: 한글 + 출력 가능 문자가 60% 이상이어야 함
      let korean = 0, printable = 0;
      for (const c of text) {
        const cp = c.charCodeAt(0);
        if (cp >= 0xAC00 && cp <= 0xD7A3) { korean++; printable++; }
        else if (cp >= 0x20 || cp === 10 || cp === 13) printable++;
      }
      const ratio = text.length > 0 ? printable / text.length : 0;
      if (ratio < 0.6 || korean < 3) {
        console.warn('[HWP] PrvText 품질 불량 (printable=%.0f%%, korean=%d) → 폐기', ratio*100, korean);
        return null;
      }
      console.log('[HWP] PrvText 추출 성공: %d글자 (한글 %d, 유효율 %.0f%%)', text.length, korean, ratio*100);
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
    let bestStart = -1, bestLen = 0, bestRawLen = 0;
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
      // 최소 100바이트(50글자) 이상 & 한글 비율 20% 이상 블록만 후보
      if (runLen >= 100 && koreanInRun >= runLen / 10) {
        // 한글 비율이 높은 블록 우선 (길이 × 한글비율 점수)
        const score = runLen * (koreanInRun / (runLen / 2));
        if (score > bestLen) { bestStart = runStart; bestLen = score; bestRawLen = runLen; }
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
    const raw = b.slice(bestStart, bestStart + bestRawLen);
    const text = new TextDecoder('utf-16le').decode(raw);
    console.log('[HWP] 한글 텍스트 스캔 성공: 오프셋=%d 길이=%d', bestStart, text.length);
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
    if (typeof window.showSaveFilePicker === 'function') {
      this._saveWithPicker(blob, name).catch(() => {
        this._downloadByAnchor(blob, name);
      });
      return;
    }
    this._downloadByAnchor(blob, name);
  },

  async _saveWithPicker(blob, name) {
    const ext = (name.split('.').pop() || 'bin').toLowerCase();
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{
        description: 'HWP Viewer Export',
        accept: {
          [blob.type || 'application/octet-stream']: [`.${ext}`],
        },
      }],
    });
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

/* ── Web Worker 파싱 ── */
function parseWithWorker(buffer, filename) {
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
        : 'js/parser.worker.js';
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
    // 원본 buffer는 detatch되지 않아 worker 타임아웃/실패 시 메인 스레드 fallback 파싱에 그대로 사용됩니다.
    const workerBuffer = buffer.slice(0);
    worker.postMessage({ buffer: workerBuffer, filename }, [workerBuffer]);
  });
}

/* ── 버퍼 처리 (공통 코어) ── */
async function processBuffer(buffer, filename, sizeBytes) {
  showLoading(`파싱 중... (${(sizeBytes/1024).toFixed(0)} KB)`);
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
        meta: { pages:1, note: '파싱 오류: ' + e2.message },
        pages: [{ index:0, paragraphs:[{ align:'left', texts:[{
          text: '⚠️ 파싱 오류: ' + e2.message,
          bold:false, italic:false, underline:false, fontSize:12,
          fontName:'Malgun Gothic', color:'#dc2626'
        }] }] }]
      };
    }
  }

  state.doc = doc; state.filename = filename; state.mode = 'view'; state.currentPage = 0;
  HwpExporter.setFilename(filename);
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
async function processFile(file) {
  if (!/\.(hwp|hwpx)$/i.test(file.name)) {
    showError('지원 형식: .hwp, .hwpx 파일만 가능합니다.');
    return;
  }

  showLoading('파일을 읽는 중...');
  try {
    const buffer = await file.arrayBuffer();
    await processBuffer(buffer, file.name, file.size);
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

function renderHWP(data) {
  renderDocument(data);
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
function updateUiAfterLoad(filename, sizeBytes) {
  UI.dropZone.style.display    = 'none';
  UI.mainContent.style.display = 'flex';
  UI.statusBar.style.display   = 'flex';
  UI.btnEditMode.disabled      = false;
  UI.exportGroup.style.display = 'flex';
  UI.fileName.textContent      = filename;
  UI.statusFileInfo.textContent = `${(sizeBytes/1024).toFixed(1)} KB | ${state.doc.meta.pages}페이지`;
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

/* ── 페이지 로드 시 URL 파라미터 자동 처리 ── */
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  // Chrome 확장 컨텍스트에서만 실행
  autoLoadFromParams().catch(e => console.error('[APP] autoLoad 오류:', e));
}
