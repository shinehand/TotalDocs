/**
 * hwp-parser.js  (v3 — 안정 재작성)
 * ─────────────────────────────────────────────────────────────────────────────
 * HWP 5.0 / HWPX 파일을 파싱하여 공통 HwpDocument 모델로 변환합니다.
 *
 * HWP 5.0 전략:
 *   CFB(OLE) 컨테이너에서 "PrvText" 스트림을 찾아 UTF-16LE 텍스트를 추출.
 *   PrvText 는 한글 워드프로세서가 빠른 미리보기 용도로 저장하는 일반 텍스트.
 *   서식은 없지만 내용 확인·편집에는 충분합니다.
 *
 *   핵심 알고리즘: FAT 체인 순회 없이 바이트 패턴 직접 스캔
 *     → "PrvText"(UTF-16LE) 패턴을 파일 전체에서 선형 탐색
 *     → 찾으면 해당 128 바이트 CFB 디렉토리 엔트리에서 스트림 위치 독취
 *     → 스트림 섹터 순차 독취 (PrvText는 보통 연속 배치)
 *
 * HWPX 전략:
 *   JSZip 으로 ZIP 언팩 → Contents/section*.xml XML 파싱
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class HwpParser {
  /**
   * @param {ArrayBuffer} buffer
   * @param {string}      filename
   * @returns {Promise<HwpDocument>}
   */
  static async parse(buffer, filename) {
    const ext = filename.split('.').pop().toLowerCase();

    // UI 업데이트 후 파싱 시작 (메인 스레드 블로킹 방지)
    await new Promise(r => setTimeout(r, 60));

    // 30초 타임아웃
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('파싱 시간 초과(30초). 파일이 너무 크거나 손상됐을 수 있습니다.')), 30_000)
    );

    const work = (async () => {
      if (ext === 'hwpx') return HwpParser._parseHwpx(buffer);
      if (ext === 'hwp')  return HwpParser._parseHwp5(buffer);
      throw new Error(`지원하지 않는 파일 형식입니다: .${ext}`);
    })();

    return Promise.race([work, timeout]);
  }

  /* ═══════════════════════════════════════════════════════════
     HWPX (.hwpx) — ZIP + XML
  ═══════════════════════════════════════════════════════════ */
  static async _parseHwpx(buffer) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip 라이브러리를 찾을 수 없습니다. lib/jszip.min.js 가 로드됐는지 확인하세요.');
    }

    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch (e) {
      throw new Error(`HWPX ZIP 열기 실패: ${e.message}`);
    }

    const sectionFiles = Object.keys(zip.files)
      .filter(p => /Contents[\\/]section\d+\.xml$/i.test(p))
      .sort();

    if (sectionFiles.length === 0) {
      throw new Error('HWPX 파일에서 본문 섹션(Contents/section*.xml)을 찾을 수 없습니다.');
    }

    const pages = [];
    for (let i = 0; i < sectionFiles.length; i++) {
      const xmlStr = await zip.files[sectionFiles[i]].async('string');
      pages.push({ index: i, paragraphs: HwpParser._parseHwpxSection(xmlStr) });
    }

    return {
      meta: { title: '', author: '', pages: pages.length },
      pages,
    };
  }

  static _parseHwpxSection(xmlStr) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    } catch (e) {
      return [{ align: 'left', texts: [HwpParser._run('(XML 파싱 오류)')] }];
    }

    const paras  = Array.from(doc.querySelectorAll('p, hp\\:p, hh\\:p'));
    const result = [];

    for (const p of paras) {
      const align = p.getAttribute('align') || 'left';
      const runs  = Array.from(p.querySelectorAll('run, t, hp\\:run, hp\\:t, hh\\:run, hh\\:t'));
      const texts = [];

      if (runs.length > 0) {
        for (const run of runs) {
          const charPr = run.querySelector('charPr, hp\\:charPr, hh\\:charPr');
          const attr   = (el, a) => el?.getAttribute(a) || el?.getAttribute(`hp:${a}`) || null;
          texts.push({
            text:      run.textContent || '',
            bold:      attr(charPr, 'bold') === '1',
            italic:    attr(charPr, 'italic') === '1',
            underline: attr(charPr, 'underline') === '1',
            fontSize:  parseFloat(attr(charPr, 'size') || '1000') / 100,
            fontName:  attr(charPr, 'fontRef') || 'Malgun Gothic',
            color:     attr(charPr, 'color') || '#000000',
          });
        }
      } else {
        const raw = p.textContent.trim();
        texts.push(HwpParser._run(raw));
      }

      result.push({ align, texts });
    }

    return result.length
      ? result
      : [{ align: 'left', texts: [HwpParser._run('')] }];
  }

  /* ═══════════════════════════════════════════════════════════
     HWP 5.0 — CFB 컨테이너 + PrvText 바이트 스캔
  ═══════════════════════════════════════════════════════════ */
  static _parseHwp5(buffer) {
    const bytes = new Uint8Array(buffer);

    // 1) OLE CFB 시그니처 확인
    const SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
    if (!SIG.every((b, i) => bytes[i] === b)) {
      throw new Error('유효한 HWP 파일이 아닙니다 (CFB 시그니처 불일치).');
    }

    // 2) 암호화 여부 간단 확인 (FileHeader 스트림의 플래그 비트 0)
    //    정확한 확인은 복잡하므로 일단 PrvText 추출을 시도.

    // 3) PrvText 바이트 스캔
    let prvText = null;
    try {
      prvText = HwpParser._scanPrvText(bytes);
    } catch (e) {
      console.warn('[HWP] PrvText 스캔 실패:', e);
    }

    if (!prvText) {
      return HwpParser._fallbackDoc();
    }

    // 4) 텍스트 → 단락 → 페이지 변환
    // HWP PrvText 구분자:
    //   0x000D 0x000A = 줄바꿈 (CRLF)
    //   0x000D       = 단락 끝
    //   0x0002       = 강제 줄바꿈
    const lines = prvText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\x02/g, '\n')
      .split('\n');

    const paragraphs = lines.map(line => ({
      align: 'left',
      texts: [HwpParser._run(line)],
    }));

    const pages = HwpParser._paginateParagraphs(paragraphs, 35);

    return {
      meta: {
        title:  '',
        author: '',
        pages:  pages.length,
        note:   'PrvText 기반 텍스트 뷰 (서식 미지원 — 원본 서식 보존 편집은 HWPX 저장 후 사용)',
      },
      pages,
    };
  }

  /**
   * CFB 파일에서 "PrvText" 이름의 디렉토리 엔트리를 선형 스캔으로 찾고
   * 스트림 데이터를 UTF-16LE로 반환합니다.
   *
   * 원리:
   *   CFB 디렉토리 엔트리(128 바이트)의 첫 필드가 이름(UTF-16LE).
   *   → 파일 전체에서 "PrvText" UTF-16LE 패턴을 탐색.
   *   → 찾은 위치가 엔트리 시작점이므로, +116/+120 오프셋으로 스트림 정보 독취.
   *
   * @param {Uint8Array} bytes
   * @returns {string|null}
   */
  static _scanPrvText(bytes) {
    // "PrvText" → UTF-16LE 바이트 배열
    const NAME_BYTES = [
      0x50,0x00, // P
      0x72,0x00, // r
      0x76,0x00, // v
      0x54,0x00, // T
      0x65,0x00, // e
      0x78,0x00, // x
      0x74,0x00, // t
    ];
    const NL = NAME_BYTES.length; // 14

    // CFB 헤더에서 섹터 크기 읽기 (오프셋 0x1E)
    const sectorSizeExp = HwpParser._u16(bytes, 0x1E);
    const sectorSize    = (sectorSizeExp >= 7 && sectorSizeExp <= 14)
      ? (1 << sectorSizeExp)
      : 512;

    // CFB 헤더는 512 바이트. 디렉토리 섹터는 그 뒤에 위치.
    // 선형 스캔: 512 바이트 이후부터 패턴 검색 (128 바이트 단위로 이동)
    const startOffset = 512; // 헤더 스킵

    for (let pos = startOffset; pos + 128 <= bytes.length; pos += 128) {
      // 이름 길이 필드 (엔트리 오프셋 64, uint16LE)
      const nameLen = HwpParser._u16(bytes, pos + 64);
      if (nameLen !== 16) continue; // "PrvText" = 7글자 * 2 + 2(null) = 16 바이트

      // 패턴 매칭
      let match = true;
      for (let k = 0; k < NL; k++) {
        if (bytes[pos + k] !== NAME_BYTES[k]) { match = false; break; }
      }
      if (!match) continue;

      // 스트림 시작 섹터 (엔트리 오프셋 116)
      const startSector = HwpParser._u32(bytes, pos + 116);
      // 스트림 크기 (엔트리 오프셋 120)
      const streamSize  = HwpParser._u32(bytes, pos + 120);

      console.log(`[HWP] PrvText 발견 — pos=${pos} startSector=${startSector} size=${streamSize}`);

      if (startSector >= 0xFFFFFFFA) {
        console.warn('[HWP] PrvText: 잘못된 시작 섹터');
        return null;
      }
      if (streamSize === 0 || streamSize > 8 * 1024 * 1024) {
        console.warn('[HWP] PrvText: 비정상 스트림 크기', streamSize);
        return null;
      }

      // 섹터 오프셋 계산: (섹터 번호 + 1) * sectorSize
      const streamStart = (startSector + 1) * sectorSize;
      if (streamStart + streamSize > bytes.length) {
        // 섹터가 파일 끝을 넘어가면 파일 끝까지만 읽기
        const available = bytes.slice(streamStart, bytes.length);
        if (available.length === 0) return null;
        return new TextDecoder('utf-16le').decode(available);
      }

      const streamData = bytes.slice(streamStart, streamStart + streamSize);
      const text = new TextDecoder('utf-16le').decode(streamData);
      console.log(`[HWP] PrvText 추출 완료 — ${text.length}글자`);
      return text;
    }

    console.warn('[HWP] PrvText 스트림을 찾지 못했습니다.');
    return null;
  }

  /* ── 유틸리티 ─────────────────────────────── */

  static _fallbackDoc() {
    return {
      meta: { title: '', author: '', pages: 1, note: '파싱 제한' },
      pages: [{
        index: 0,
        paragraphs: [{
          align: 'center',
          texts: [HwpParser._run(
            '⚠️ 이 HWP 파일의 텍스트를 추출할 수 없습니다.\n\n' +
            '가능한 원인:\n' +
            '• 파일이 암호로 보호되어 있음\n' +
            '• HWP 2.x / 3.x 구형 포맷 (5.0 이상만 지원)\n' +
            '• 파일이 손상됨\n\n' +
            '해결책: 한글 워드프로세서에서 파일을 열고 "다른 이름으로 저장 → HWPX" 후 재시도하세요.'
          )],
        }],
      }],
    };
  }

  static _paginateParagraphs(paragraphs, perPage) {
    if (paragraphs.length === 0) return [{ index: 0, paragraphs: [] }];
    const pages = [];
    for (let i = 0; i < paragraphs.length; i += perPage) {
      pages.push({ index: pages.length, paragraphs: paragraphs.slice(i, i + perPage) });
    }
    return pages;
  }

  static _run(text) {
    return {
      text:      text || '',
      bold:      false,
      italic:    false,
      underline: false,
      fontSize:  11,
      fontName:  'Malgun Gothic',
      color:     '#000000',
    };
  }

  static _u16(bytes, offset) {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  }

  static _u32(bytes, offset) {
    return (
      ((bytes[offset]     ?? 0)       ) |
      ((bytes[offset + 1] ?? 0) <<  8 ) |
      ((bytes[offset + 2] ?? 0) << 16 ) |
      ((bytes[offset + 3] ?? 0) << 24 )
    ) >>> 0;
  }

  // 하위 호환 별칭
  static _readUint16LE(b, o) { return HwpParser._u16(b, o); }
  static _readUint32LE(b, o) { return HwpParser._u32(b, o); }
}
