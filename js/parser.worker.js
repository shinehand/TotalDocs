/**
 * parser.worker.js — HWP 파싱 Web Worker
 *
 * 파싱 로직을 메인 스레드와 분리해 UI 블로킹을 원천 차단합니다.
 * main thread ↔ Worker 통신: postMessage / onmessage
 */

/* ── HWP 파서 (worker 내 독립 구현) ── */

const HWP_SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];

function u16(b, o) { return (b[o] ?? 0) | ((b[o+1] ?? 0) << 8); }
function u32(b, o) {
  return ((b[o]??0)|((b[o+1]??0)<<8)|((b[o+2]??0)<<16)|((b[o+3]??0)<<24)) >>> 0;
}

function run(text, opts) {
  return Object.assign(
    { text: text||'', bold:false, italic:false, underline:false,
      fontSize:11, fontName:'Malgun Gothic', color:'#000000' },
    opts
  );
}

function paginate(paras, n) {
  if (!paras.length) return [{ index:0, paragraphs:[] }];
  const r = [];
  for (let i=0; i<paras.length; i+=n)
    r.push({ index: r.length, paragraphs: paras.slice(i, i+n) });
  return r;
}

/* ════════════════════════════════════════════════════════
   CFB FAT 유틸리티
════════════════════════════════════════════════════════ */

/**
 * CFB 헤더의 DIFAT 배열로부터 FAT 섹터 체인 맵을 구성합니다.
 * fat[섹터번호] = 다음 섹터번호 (0xFFFFFFFE = 끝, 0xFFFFFFFF = 미사용)
 */
function readFat(b, ss) {
  const nFat = u32(b, 0x28);
  if (nFat === 0) return new Uint32Array(0);
  const entriesPerSec = ss / 4;
  const fat = new Uint32Array(nFat * entriesPerSec);
  const difat = [];
  for (let i = 0; i < 109 && difat.length < nFat; i++) {
    const sec = u32(b, 0x4C + i * 4);
    if (sec >= 0xFFFFFFF8) break;
    difat.push(sec);
  }

  let difatSec = u32(b, 0x44);
  const nDifatSec = u32(b, 0x48);
  let difatRead = 0;
  const visited = new Set();
  while (difat.length < nFat && difatSec < 0xFFFFFFF8 && difatRead < nDifatSec && !visited.has(difatSec)) {
    visited.add(difatSec);
    const base = (difatSec + 1) * ss;
    if (base + ss > b.length) break;
    for (let i = 0; i < entriesPerSec - 1 && difat.length < nFat; i++) {
      const sec = u32(b, base + i * 4);
      if (sec >= 0xFFFFFFF8) continue;
      difat.push(sec);
    }
    difatSec = u32(b, base + (entriesPerSec - 1) * 4);
    difatRead++;
  }

  for (let i = 0; i < difat.length; i++) {
    const fatSec = difat[i];
    const base = (fatSec + 1) * ss;
    if (base + ss > b.length) continue;
    for (let j = 0; j < entriesPerSec; j++) {
      fat[i * entriesPerSec + j] = u32(b, base + j * 4);
    }
  }
  return fat;
}

/** FAT 체인을 따라 일반 스트림(>=miniCutoff) 데이터를 읽습니다. */
function readStreamByFat(b, startSec, streamSz, ss, fat) {
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
}

/** MiniFAT 체인을 읽어 miniFat[miniSec] = 다음 miniSec 맵을 구성합니다. */
function readMiniFat(b, ss, fat) {
  const miniFatStartSec = u32(b, 0x3C);
  const nMiniFatSec = u32(b, 0x40);
  if (nMiniFatSec === 0 || miniFatStartSec >= 0xFFFFFFFA) return new Uint32Array(0);

  const entriesPerSec = ss / 4;
  const miniFat = new Uint32Array(nMiniFatSec * entriesPerSec);
  let sec = miniFatStartSec;
  let i = 0;
  const visited = new Set();

  while (sec < 0xFFFFFFF8 && !visited.has(sec) && i < nMiniFatSec) {
    visited.add(sec);
    const base = (sec + 1) * ss;
    if (base + ss > b.length) break;
    for (let j = 0; j < entriesPerSec; j++) {
      miniFat[i * entriesPerSec + j] = u32(b, base + j * 4);
    }
    i++;
    sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  return miniFat;
}

/** MiniFAT 체인을 따라 미니 스트림(<miniCutoff) 데이터를 읽습니다. */
function readStreamByMiniFat(miniStream, startSec, streamSz, miniFat) {
  if (!miniStream || startSec >= 0xFFFFFFF8 || streamSz === 0) return null;
  const miniSS = 64;
  const result = new Uint8Array(streamSz);
  let written = 0, sec = startSec;
  const visited = new Set();

  while (sec < 0xFFFFFFF8 && written < streamSz && !visited.has(sec)) {
    visited.add(sec);
    const off = sec * miniSS;
    const len = Math.min(miniSS, streamSz - written);
    if (off + len > miniStream.length) break;
    result.set(miniStream.subarray(off, off + len), written);
    written += len;
    sec = (miniFat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  return result;
}

/** 이름 목록에 해당하는 CFB 디렉토리 엔트리를 스캔합니다. */
function scanDirEntries(b, names, ss, fat, dirStartSec) {
  // 이름 → UTF-16LE 바이트 배열 + 예상 nameLen 미리 계산
  const queries = names.map(name => {
    const pat = [];
    for (const c of name) { const cc = c.charCodeAt(0); pat.push(cc & 0xFF, cc >> 8); }
    return { name, pat, nameLen: (name.length + 1) * 2 };
  });

  const result = {};
  const found = new Set();
  if (dirStartSec >= 0xFFFFFFFA) return result;

  let sec = dirStartSec;
  const visited = new Set();
  while (sec < 0xFFFFFFF8 && !visited.has(sec)) {
    visited.add(sec);
    const base = (sec + 1) * ss;
    if (base + ss > b.length) break;

    for (let pos = base; pos + 128 <= base + ss; pos += 128) {
      const nl = u16(b, pos + 64);
      for (const { name, pat, nameLen } of queries) {
        if (found.has(name)) continue;
        if (nl !== nameLen) continue;
        let ok = true;
        for (let k = 0; k < pat.length; k++) {
          if (b[pos + k] !== pat[k]) { ok = false; break; }
        }
        if (ok) {
          result[name] = {
            startSec: u32(b, pos + 116),
            streamSz: u32(b, pos + 120),
          };
          found.add(name);
        }
      }
    }

    if (found.size === queries.length) break;
    sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  return result;
}

/* ════════════════════════════════════════════════════════
   zlib 압축 해제 (DecompressionStream API)
════════════════════════════════════════════════════════ */
async function decompressZlib(data) {
  const timeoutMs = 8000;
  let lastError = null;
  for (const mode of ['deflate', 'deflate-raw']) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`zlib 압축 해제 시간 초과 (${Math.floor(timeoutMs / 1000)}초)`)), timeoutMs);
    });

    const ds = new DecompressionStream(mode);
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

      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch (e) {
      lastError = e;
      if (mode === 'deflate-raw') {
        throw new Error(`zlib 압축 해제 실패 (mode=${mode}): ${e?.message || e}`);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      try { reader.releaseLock(); } catch {}
      try { writer.releaseLock(); } catch {}
    }
  }

  throw new Error(`zlib 압축 해제 실패: ${lastError?.message || 'unknown error'}`);
}

/* ════════════════════════════════════════════════════════
   HWP 바이너리 레코드 파서
   TagID 66 = HWPTAG_PARA_HEADER
   TagID 67 = HWPTAG_PARA_TEXT  ← 텍스트 추출 대상
════════════════════════════════════════════════════════ */
function parseHwpRecords(data) {
  const paras = [];
  let pos = 0;

  while (pos + 4 <= data.length) {
    const hdr  = u32(data, pos); pos += 4;
    const tagId = hdr & 0x3FF;
    let size    = (hdr >> 20) & 0xFFF;
    if (size === 0xFFF) {
      if (pos + 4 > data.length) break;
      size = u32(data, pos); pos += 4;
    }
    const recEnd = Math.min(pos + size, data.length);

    if (tagId === 67 && size >= 2) {
      // HWPTAG_PARA_TEXT: UTF-16LE 문자열
      // 인라인 컨트롤(0x01~0x1F): 0x09(탭)·0x0A·0x0D 제외하고 32바이트 블록 차지
      const chars = [];
      let i = pos;
      while (i + 2 <= recEnd) {
        const ch = data[i] | (data[i+1] << 8);
        if (ch === 0x000D) {
          // 단락 끝 마커
          i += 2; break;
        } else if (ch === 0x0009) {
          chars.push('\t'); i += 2;
        } else if (ch === 0x000A || ch === 0x0006) {
          chars.push('\n'); i += 2; // 강제 줄바꿈
        } else if (ch === 0x0002) {
          chars.push('\n'); i += 2; // 섹션/컬럼 나눔
        } else if (ch >= 0x0001 && ch <= 0x001F) {
          // 인라인 컨트롤: 제어 문자(2) + 확장 데이터(30) = 32 바이트
          i += 32;
        } else if (ch >= 0x0020) {
          chars.push(String.fromCharCode(ch));
          i += 2;
        } else {
          i += 2;
        }
      }
      paras.push({ align: 'left', texts: [run(chars.join(''))] });
    }

    pos = recEnd;
  }

  return paras;
}

/* ════════════════════════════════════════════════════════
   전략 0: BodyText/Section 스트림 직접 파싱 (최우선)
════════════════════════════════════════════════════════ */
async function parseBodyText(b) {
  self.postMessage({ type: 'progress', msg: 'BodyText 섹션 탐색 중...' });

  const ss          = (() => { const e = u16(b, 0x1E); return (e>=7&&e<=14)?(1<<e):512; })();
  const miniCutoff  = u32(b, 0x38) || 4096;
  const dirStartSec = u32(b, 0x2C);
  if (dirStartSec >= 0xFFFFFFFA) return null;

  const dirBase         = (dirStartSec + 1) * ss;
  const rootStartSec    = u32(b, dirBase + 116);
  const rootStreamSz    = u32(b, dirBase + 120);
  const miniContainerOff = rootStartSec < 0xFFFFFFFA ? (rootStartSec + 1) * ss : -1;

  const fat = readFat(b, ss);
  const miniFat = readMiniFat(b, ss, fat);
  const miniStream = (rootStartSec < 0xFFFFFFFA && rootStreamSz > 0)
    ? readStreamByFat(b, rootStartSec, rootStreamSz, ss, fat)
    : null;

  // 우선 자주 쓰는 구간(Section0~9)만 빠르게 스캔
  let sectionNames = Array.from({ length: 10 }, (_, i) => 'Section' + i);
  let entries = scanDirEntries(b, ['FileHeader', ...sectionNames], ss, fat, dirStartSec);
  // 9번 섹션까지 존재하면 그때만 확장 스캔
  if (entries.Section9) {
    sectionNames = Array.from({ length: 100 }, (_, i) => 'Section' + i);
    entries = scanDirEntries(b, ['FileHeader', ...sectionNames], ss, fat, dirStartSec);
  }

  // FileHeader → 압축/암호화 플래그 확인
  let compressed = true;
  if (entries.FileHeader) {
    const { startSec, streamSz } = entries.FileHeader;
    let fhData;
    if (streamSz < miniCutoff && miniContainerOff > 0) {
      fhData = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    } else {
      fhData = readStreamByFat(b, startSec, streamSz, ss, fat);
    }
    if (fhData && fhData.length >= 40) {
      compressed = (fhData[36] & 1) !== 0;
      const encrypted = (fhData[36] & 2) !== 0;
      if (encrypted) {
        self.postMessage({ type: 'progress', msg: '암호화된 문서입니다 — 복호화 불가' });
        return null;
      }
    }
  }

  let sectionNumbers = Object.keys(entries)
    .filter(name => /^Section\d+$/.test(name))
    .map(name => Number(name.slice(7)))
    .sort((a, b) => a - b);
  if (sectionNumbers.length === 0 && !entries.Section9) {
    sectionNames = Array.from({ length: 100 }, (_, i) => 'Section' + i);
    entries = scanDirEntries(b, ['FileHeader', ...sectionNames], ss, fat, dirStartSec);
    sectionNumbers = Object.keys(entries)
      .filter(name => /^Section\d+$/.test(name))
      .map(name => Number(name.slice(7)))
      .sort((a, b) => a - b);
  }

  // Section 파싱
  const allParas = [];
  for (const sn of sectionNumbers) {
    const entry = entries['Section' + sn];
    if (!entry) continue;

    const { startSec, streamSz } = entry;
    if (startSec >= 0xFFFFFFFA || streamSz === 0) continue;

    self.postMessage({ type: 'progress', msg: `Section${sn} 읽는 중... (${(streamSz/1024).toFixed(0)} KB)` });

    let data;
    if (streamSz < miniCutoff && miniContainerOff > 0) {
      data = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    } else {
      data = readStreamByFat(b, startSec, streamSz, ss, fat);
    }
    if (!data || data.length === 0) continue;

    if (compressed) {
      try {
        data = await decompressZlib(data);
      } catch (e) {
        console.warn('[Worker] Section' + sn + ' 압축 해제 실패:', e.message);
        // 현재 섹션은 원본 레코드로도 파싱 시도
        const rawParas = parseHwpRecords(data);
        if (rawParas.length > 0) {
          allParas.push(...rawParas);
          self.postMessage({ type: 'progress', msg: `Section${sn}: ${rawParas.length}개 단락 완료(raw)` });
        }
        continue;
      }
    }

    const paras = parseHwpRecords(data);
    allParas.push(...paras);
    self.postMessage({ type: 'progress', msg: `Section${sn}: ${paras.length}개 단락 완료` });
  }

  return allParas.length > 0 ? allParas : null;
}

/* ════════════════════════════════════════════════════════
   전략 1: CFB PrvText 스트림 추출
════════════════════════════════════════════════════════ */
function scanPrvText(b) {
  const exp  = u16(b, 0x1E);
  const ss   = (exp >= 7 && exp <= 14) ? (1 << exp) : 512;
  const miniCutoff = u32(b, 0x38) || 4096;

  const dirStartSec = u32(b, 0x2C);
  if (dirStartSec >= 0xFFFFFFFA) return null;
  const dirBase = (dirStartSec + 1) * ss;
  if (dirBase + 128 > b.length) return null;

  const rootStartSec = u32(b, dirBase + 116);
  const rootStreamSz = u32(b, dirBase + 120);
  const miniContainerOff = (rootStartSec < 0xFFFFFFFA) ? (rootStartSec + 1) * ss : -1;
  const fat = readFat(b, ss);
  const miniFat = readMiniFat(b, ss, fat);
  const miniStream = (rootStartSec < 0xFFFFFFFA && rootStreamSz > 0)
    ? readStreamByFat(b, rootStartSec, rootStreamSz, ss, fat)
    : null;

  self.postMessage({ type:'progress', msg:`PrvText CFB 스캔 중... ss=${ss}` });
  const entries = scanDirEntries(b, ['PrvText'], ss, fat, dirStartSec);
  const prv = entries.PrvText;
  if (!prv) return null;

  const { startSec, streamSz } = prv;
  if (startSec >= 0xFFFFFFFA || streamSz === 0 || streamSz > 8 * 1024 * 1024) return null;

  let raw;
  if (streamSz < miniCutoff && miniContainerOff > 0) {
    raw = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
  } else {
    raw = readStreamByFat(b, startSec, streamSz, ss, fat);
  }
  if (!raw || raw.length === 0) return null;

  const text = new TextDecoder('utf-16le').decode(raw);
  let korean = 0, printable = 0;
  for (const c of text) {
    const cp = c.charCodeAt(0);
    if (cp >= 0xAC00 && cp <= 0xD7A3) { korean++; printable++; }
    else if (cp >= 0x20 || cp === 10 || cp === 13) printable++;
  }
  if (text.length === 0 || printable / text.length < 0.6 || korean < 3) return null;

  self.postMessage({ type:'progress', msg:`PrvText 추출 성공 (${text.length}글자)` });
  return text;
}

/* ════════════════════════════════════════════════════════
   전략 2: 한글 UTF-16LE 블록 직접 스캔
════════════════════════════════════════════════════════ */
function scanKoreanText(b) {
  self.postMessage({ type:'progress', msg:'한글 텍스트 직접 스캔 중...' });

  const isValid = cp =>
    (cp >= 0x20  && cp <= 0x7E)    ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0x1100 && cp <= 0x11FF) ||
    (cp >= 0x3130 && cp <= 0x318F) ||
    cp === 10 || cp === 13 || cp === 9 || cp === 2;

  let bestStart = -1, bestScore = 0, bestRawLen = 0;
  let runStart  = -1, runLen = 0, koreanInRun = 0;

  const flush = () => {
    if (runLen >= 100 && koreanInRun >= runLen / 10) {
      const score = runLen * (koreanInRun / (runLen / 2));
      if (score > bestScore) {
        bestStart = runStart; bestScore = score; bestRawLen = runLen;
      }
    }
    runStart = -1; runLen = 0; koreanInRun = 0;
  };

  for (let i = 512; i + 2 <= b.length; i += 2) {
    const cp = b[i] | (b[i+1] << 8);
    if (isValid(cp)) {
      if (runStart < 0) runStart = i;
      runLen += 2;
      if (cp >= 0xAC00 && cp <= 0xD7A3) koreanInRun++;
    } else { flush(); }
  }
  flush();

  if (bestStart < 0) return null;
  const text = new TextDecoder('utf-16le').decode(b.slice(bestStart, bestStart + bestRawLen));
  self.postMessage({ type:'progress', msg:`한글 스캔 성공 (${text.length}글자)` });
  return text;
}

/* ════════════════════════════════════════════════════════
   HWPX (ZIP + XML) 파싱
════════════════════════════════════════════════════════ */
async function parseHwpx(buffer) {
  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip을 Worker에서 사용할 수 없습니다. 메인 스레드에서 파싱합니다.');
  }
  const zip   = await JSZip.loadAsync(buffer);
  const keys  = Object.keys(zip.files)
    .filter(p => /Contents[\\/]section\d+\.xml$/i.test(p)).sort();
  if (!keys.length) throw new Error('HWPX: 섹션 없음');

  const pages = [];
  for (let i = 0; i < keys.length; i++) {
    const xml  = await zip.files[keys[i]].async('string');
    const doc  = new DOMParser().parseFromString(xml, 'application/xml');
    const ps   = Array.from(doc.querySelectorAll('p'));
    const paras = ps.length
      ? ps.map(p => ({ align: p.getAttribute('align')||'left', texts:[run(p.textContent||'')] }))
      : [{ align:'left', texts:[run(doc.documentElement.textContent.trim())] }];
    pages.push({ index: i, paragraphs: paras });
  }
  return { meta:{ pages:pages.length }, pages };
}

/* ════════════════════════════════════════════════════════
   메시지 수신 → 파싱 실행
════════════════════════════════════════════════════════ */
self.onmessage = async ({ data }) => {
  const { buffer, filename } = data;
  const ext = filename.split('.').pop().toLowerCase();

  try {
    let doc;

    if (ext === 'hwpx') {
      try {
        importScripts('../lib/jszip.min.js');
        doc = await parseHwpx(buffer);
      } catch(e) {
        self.postMessage({ type:'fallback_main', reason: e.message });
        return;
      }
    } else {
      // HWP 5.0
      const b = new Uint8Array(buffer);
      if (!HWP_SIG.every((v,i) => b[i] === v)) {
        throw new Error('HWP 시그니처 불일치');
      }

      // ── 전략 0: BodyText/Section 스트림 파싱 (전체 텍스트 + 단락 구조) ──
      let allParas = null;
      try {
        allParas = await parseBodyText(b);
      } catch(e) {
        console.warn('[Worker] BodyText 파싱 실패:', e.message);
      }

      if (allParas) {
        // 빈 단락 정리 (연속 빈 줄 2개 초과 → 1개로 압축)
        const cleaned = [];
        let emptyRun = 0;
        for (const p of allParas) {
          const isEmpty = !p.texts.some(t => t.text.trim());
          if (isEmpty) { if (++emptyRun <= 2) cleaned.push(p); }
          else { emptyRun = 0; cleaned.push(p); }
        }
        const pages = paginate(cleaned, 40);
        doc = { meta: { pages: pages.length }, pages };
        self.postMessage({ type: 'done', doc });
        return;
      }

      // ── 전략 1: PrvText ──
      let text = null;
      try { text = scanPrvText(b); }     catch(e) { console.warn(e); }

      // ── 전략 2: 한글 블록 스캔 ──
      if (!text) {
        try { text = scanKoreanText(b); } catch(e) { console.warn(e); }
      }

      if (!text) {
        doc = {
          meta: { pages:1, note:'파싱 실패' },
          pages:[{ index:0, paragraphs:[{ align:'center', texts:[run(
            '⚠️ 이 HWP 파일의 텍스트를 추출하지 못했습니다.\n\n' +
            '해결책: 한글에서 "다른 이름으로 저장 → HWPX" 후 재시도하세요.'
          )] }] }]
        };
      } else {
        const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\x02/g,'\n').split('\n');
        const paras = lines.map(l => ({ align:'left', texts:[run(l)] }));
        const pages = paginate(paras, 35);
        doc = { meta:{ pages:pages.length, note:'⚠️ PrvText 텍스트 추출 (서식 미지원)' }, pages };
      }
    }

    self.postMessage({ type:'done', doc });

  } catch(err) {
    self.postMessage({ type:'error', message: err.message });
  }
};
