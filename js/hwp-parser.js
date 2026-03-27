/**
 * hwp-parser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HWP 5.0 / HWPX 파일을 파싱하여 뷰어가 소비할 수 있는 공통 문서 모델로 변환.
 *
 * HWP 5.0 구조 개요
 * ─────────────────
 *  HWP 파일은 OLE Compound Document (CFB) 형식으로,
 *  내부에 여러 스트림(Stream)이 ZIP처럼 압축되어 있습니다.
 *
 *  주요 스트림:
 *   • FileHeader        → 파일 버전, 암호화 여부 등 플래그
 *   • DocInfo           → 문서 전역 설정 (용지 크기, 여백 등) — zlib 압축
 *   • BodyText/Section0 → 실제 본문 데이터 — zlib 압축 + HWP 레코드 스트림
 *   • BinData/*         → 내장 이미지/OLE 오브젝트
 *   • PrvText           → 일반 텍스트 미리보기 (UTF-16LE)
 *
 *  이 모듈은 두 가지 전략을 사용합니다:
 *   1) HWPX (.hwpx) → JSZip으로 ZIP 언패킹 후 XML 파싱 (권장 경로)
 *   2) HWP 5.0 (.hwp) → CFB 파싱 → PrvText 스트림으로 텍스트 추출 (폴백)
 *      * 브라우저에서 CFB 전체 파싱은 상당한 구현량이 필요하므로,
 *        여기서는 PrvText(일반 텍스트 미리보기) 스트림을 직접 추출하는
 *        경량 구현을 제공합니다. 완전한 서식 재현이 필요하면
 *        hahnlee/hwp.js 라이브러리를 번들링해 사용하세요.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ═══════════════════════════════════════════════════════════
   공통 문서 모델 (Document Model)
   ═══════════════════════════════════════════════════════════
   HwpDocument {
     meta: { title, author, pages, created, modified }
     pages: HwpPage[]
   }
   HwpPage {
     index: number
     paragraphs: HwpParagraph[]
   }
   HwpParagraph {
     texts: HwpTextRun[]
     align: 'left'|'center'|'right'|'justify'
   }
   HwpTextRun {
     text: string
     bold, italic, underline: boolean
     fontSize: number   (pt)
     fontName: string
     color: string      (hex)
   }
═══════════════════════════════════════════════════════════ */

export class HwpParser {
  /**
   * @param {ArrayBuffer} buffer
   * @param {string} filename
   * @returns {Promise<HwpDocument>}
   */
  static async parse(buffer, filename) {
    const ext = filename.split('.').pop().toLowerCase();

    if (ext === 'hwpx') {
      return HwpParser._parseHwpx(buffer);
    }
    if (ext === 'hwp') {
      return HwpParser._parseHwp5(buffer);
    }
    throw new Error(`지원하지 않는 파일 형식입니다: .${ext}`);
  }

  /* ──────────────────────────────────────────────
     HWPX 파싱 (ZIP + XML)
  ────────────────────────────────────────────── */
  static async _parseHwpx(buffer) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip 라이브러리가 로드되지 않았습니다.');
    }

    const zip   = await JSZip.loadAsync(buffer);
    const pages = [];

    // HWPX 내부 경로: Contents/section0.xml, section1.xml …
    const sectionFiles = Object.keys(zip.files)
      .filter(p => /Contents\/section\d+\.xml$/i.test(p))
      .sort();

    if (sectionFiles.length === 0) {
      throw new Error('HWPX 파일에서 본문 섹션을 찾을 수 없습니다.');
    }

    for (let i = 0; i < sectionFiles.length; i++) {
      const xmlStr = await zip.files[sectionFiles[i]].async('string');
      const pageParagraphs = HwpParser._parseHwpxSection(xmlStr);
      // 섹션을 페이지로 1:1 매핑 (단순화)
      pages.push({ index: i, paragraphs: pageParagraphs });
    }

    // 메타 정보
    let meta = { title: '', author: '', pages: pages.length };
    const headerFile = zip.files['Contents/header.xml']
                    || zip.files['content.opf'];
    if (headerFile) {
      const hXml = await headerFile.async('string');
      meta = { ...meta, ...HwpParser._extractHwpxMeta(hXml) };
    }

    return { meta, pages };
  }

  /**
   * HWPX 섹션 XML에서 단락 배열 추출
   * @param {string} xmlStr
   * @returns {HwpParagraph[]}
   */
  static _parseHwpxSection(xmlStr) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(xmlStr, 'application/xml');
    const paras  = doc.querySelectorAll('p, hp\\:p');
    const result = [];

    paras.forEach(p => {
      const align = HwpParser._getXmlAttr(p, 'align') || 'left';
      const texts = [];

      // 텍스트 런 <run> 또는 <t> 요소
      const runs = p.querySelectorAll('run, t, hp\\:run, hp\\:t');
      if (runs.length > 0) {
        runs.forEach(run => {
          const charPr = run.querySelector('charPr, hp\\:charPr');
          texts.push({
            text:      run.textContent,
            bold:      HwpParser._getXmlAttr(charPr, 'bold') === '1',
            italic:    HwpParser._getXmlAttr(charPr, 'italic') === '1',
            underline: HwpParser._getXmlAttr(charPr, 'underline') === '1',
            fontSize:  parseFloat(HwpParser._getXmlAttr(charPr, 'size') || '1000') / 100,
            fontName:  HwpParser._getXmlAttr(charPr, 'fontRef') || 'Malgun Gothic',
            color:     HwpParser._getXmlAttr(charPr, 'color') || '#000000',
          });
        });
      } else {
        // fallback: 원시 텍스트
        const raw = p.textContent.trim();
        if (raw) texts.push(HwpParser._defaultRun(raw));
      }

      if (texts.length > 0 || p.textContent.trim() === '') {
        result.push({ align, texts: texts.length ? texts : [HwpParser._defaultRun('')] });
      }
    });

    return result.length ? result : [{ align: 'left', texts: [HwpParser._defaultRun('(빈 섹션)')] }];
  }

  static _extractHwpxMeta(xml) {
    const doc    = new DOMParser().parseFromString(xml, 'application/xml');
    const get    = (tag) => doc.querySelector(tag)?.textContent?.trim() || '';
    return { title: get('title') || get('dc\\:title'), author: get('creator') || get('dc\\:creator') };
  }

  /* ──────────────────────────────────────────────
     HWP 5.0 파싱 (CFB + PrvText 폴백)
  ────────────────────────────────────────────── */
  static async _parseHwp5(buffer) {
    const bytes = new Uint8Array(buffer);

    // 1) OLE CFB 시그니처 확인: D0 CF 11 E0 A1 B1 1A E1
    const CFB_SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
    const valid   = CFB_SIG.every((b, i) => bytes[i] === b);
    if (!valid) throw new Error('유효한 HWP 파일이 아닙니다 (CFB 시그니처 없음).');

    // 2) PrvText 스트림 추출 (UTF-16LE 일반 텍스트)
    const prvText = HwpParser._extractPrvText(bytes);

    if (!prvText) {
      // 3) PrvText 없으면 BodyText 스트림에서 직접 파싱 시도
      return HwpParser._parseBodyTextFallback(bytes);
    }

    // PrvText → 단락 분리 → 페이지로 묶기
    const lines      = prvText.split(/\r?\n|\r/);
    const paragraphs = lines.map(line => ({
      align: 'left',
      texts: [HwpParser._defaultRun(line)],
    }));

    // 30줄씩 1페이지로 단순 분할
    const pages = HwpParser._chunkIntoPages(paragraphs, 30);
    return {
      meta: { title: '', author: '', pages: pages.length, note: 'PrvText 기반 (서식 제한)' },
      pages,
    };
  }

  /**
   * CFB 바이트 배열에서 PrvText 스트림을 찾아 UTF-16LE 디코딩
   * CFB 섹터를 완전 순회하지 않고, 디렉토리 엔트리에서 "PrvText" 이름으로
   * 스트림 위치를 찾는 경량 구현입니다.
   */
  static _extractPrvText(bytes) {
    // CFB 헤더에서 섹터 크기(512 or 4096) 읽기
    const sectorSizeExp = HwpParser._readUint16LE(bytes, 30);  // 섹터 크기 지수
    const sectorSize    = 1 << sectorSizeExp;                  // 보통 512

    // 디렉토리 섹터 번호 (오프셋 0x30)
    const dirSector = HwpParser._readUint32LE(bytes, 0x30);
    if (dirSector === 0xFFFFFFFE) return null;

    // 디렉토리 섹터 위치 (섹터 번호 → 파일 오프셋)
    const dirOffset = (dirSector + 1) * sectorSize;

    // 디렉토리 엔트리 탐색 (각 128 바이트)
    const maxEntries = sectorSize / 128;
    for (let i = 0; i < maxEntries * 8; i++) {          // 최대 8개 섹터 탐색
      const base = dirOffset + i * 128;
      if (base + 128 > bytes.length) break;

      // 이름 길이 (오프셋 64, uint16LE)
      const nameLen = HwpParser._readUint16LE(bytes, base + 64);
      if (nameLen === 0 || nameLen > 64) continue;

      // 이름 디코딩 (UTF-16LE)
      let name = '';
      for (let c = 0; c < (nameLen - 2) / 2; c++) {
        name += String.fromCharCode(HwpParser._readUint16LE(bytes, base + c * 2));
      }

      if (name === 'PrvText') {
        // 스트림 시작 섹터 (오프셋 116)
        const startSector = HwpParser._readUint32LE(bytes, base + 116);
        // 스트림 크기 (오프셋 120)
        const streamSize  = HwpParser._readUint32LE(bytes, base + 120);

        if (startSector === 0xFFFFFFFE || streamSize === 0) return null;

        const streamOffset = (startSector + 1) * sectorSize;
        if (streamOffset + streamSize > bytes.length) return null;

        // UTF-16LE → JS string
        const streamBytes = bytes.slice(streamOffset, streamOffset + streamSize);
        return new TextDecoder('utf-16le').decode(streamBytes);
      }
    }
    return null;
  }

  /**
   * PrvText를 찾지 못했을 때 최소한의 텍스트를 추출하는 폴백
   * (실제 BodyText 파싱은 복잡하므로 안내 메시지만 반환)
   */
  static _parseBodyTextFallback(_bytes) {
    return {
      meta: { title: '', author: '', pages: 1, note: '파싱 제한' },
      pages: [{
        index: 0,
        paragraphs: [{
          align: 'center',
          texts: [HwpParser._defaultRun(
            '⚠️ 이 HWP 파일의 본문을 브라우저에서 완전히 파싱할 수 없습니다.\n' +
            '완전한 렌더링을 위해서는 서버사이드 변환 또는 hwp.js 번들 빌드가 필요합니다.'
          )],
        }],
      }],
    };
  }

  /* ── 유틸리티 ─────────────────────────────────── */
  static _defaultRun(text) {
    return { text, bold: false, italic: false, underline: false,
             fontSize: 10, fontName: 'Malgun Gothic', color: '#000000' };
  }

  static _chunkIntoPages(paragraphs, perPage) {
    const pages = [];
    for (let i = 0; i < paragraphs.length; i += perPage) {
      pages.push({ index: pages.length, paragraphs: paragraphs.slice(i, i + perPage) });
    }
    return pages.length ? pages : [{ index: 0, paragraphs }];
  }

  static _getXmlAttr(el, attr) {
    if (!el) return null;
    // HWPX 네임스페이스 포함 속성 처리
    return el.getAttribute(attr)
        || el.getAttribute(`hp:${attr}`)
        || el.getAttribute(`hwp:${attr}`)
        || null;
  }

  static _readUint16LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  static _readUint32LE(bytes, offset) {
    return (bytes[offset]
          | (bytes[offset + 1] << 8)
          | (bytes[offset + 2] << 16)
          | (bytes[offset + 3] << 24)) >>> 0;
  }
}
