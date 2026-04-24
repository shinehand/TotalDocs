/**
 * hwp-parser.js — HWP / HWPX / OWPML 파서
 * (app.js 에서 분리됨 — Chrome 확장 plain-script 로딩, type="module" 없음)
 * 의존: pako.min.js, jszip.min.js (viewer.html 에서 먼저 로드)
 */

/* ═══════════════════════════════════════════════
   HWP PARSER
═══════════════════════════════════════════════ */
const HwpParser = {

  async parse(buffer, filename = '') {
    const format = HwpParser._detectFormat(buffer, filename);
    await new Promise(r => setTimeout(r, 80));

    if (format === 'hwpx') return HwpParser._parseHwpx(buffer);
    if (format === 'owpml') return HwpParser._parseOwpmlXml(buffer);
    if (format === 'hwp5') return await HwpParser._parseHwp5(buffer);

    const ext = String(filename || '').split('.').pop().toLowerCase();
    throw new Error(`지원하지 않는 형식: ${ext ? `.${ext}` : 'unknown'} (.hwp / .hwpx / .owpml 만 가능)`);
  },

  _detectFormat(buffer, filename = '') {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
    const ext = String(filename || '').split('.').pop().toLowerCase();

    if (HwpParser._isOleCompound(b)) return 'hwp5';
    if (HwpParser._isZipPackage(b)) return 'hwpx';
    if (HwpParser._looksLikeXml(b)) return 'owpml';

    if (ext === 'hwp' || ext === 'hwt') return 'hwp5';
    if (ext === 'hwpx' || ext === 'hwtx') return 'hwpx';
    if (ext === 'owpml' || ext === 'xml' || ext === 'hml') return 'owpml';
    return '';
  },

  _isOleCompound(b) {
    const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    return b?.length >= sig.length && sig.every((v, i) => b[i] === v);
  },

  _isZipPackage(b) {
    return b?.length >= 4
      && b[0] === 0x50
      && b[1] === 0x4B
      && (
        (b[2] === 0x03 && b[3] === 0x04)
        || (b[2] === 0x05 && b[3] === 0x06)
        || (b[2] === 0x07 && b[3] === 0x08)
      );
  },

  _looksLikeXml(b) {
    if (!b?.length) return false;
    let offset = 0;
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) offset = 3;
    while (offset < b.length && [0x09, 0x0A, 0x0D, 0x20].includes(b[offset])) offset += 1;
    return b[offset] === 0x3C;
  },

  _decodeTextBuffer(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(b.slice(2));
    }
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(b.slice(2));
    }
    return new TextDecoder('utf-8').decode(b);
  },

  _parseOwpmlXml(buffer) {
    if (typeof DOMParser === 'undefined') {
      throw new Error('OWPML XML 파싱에는 DOMParser가 필요합니다.');
    }

    const xml = HwpParser._decodeTextBuffer(buffer);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('OWPML XML 파싱 실패');
    }

    const blocks = HwpParser._owpmlBlocksFromXml(doc);
    const pages = HwpParser._paginate(blocks.length ? blocks : [HwpParser._createParagraphBlock('')], 46);
    return {
      meta: { pages: pages.length, format: 'owpml' },
      pages,
    };
  },

  _owpmlBlocksFromXml(doc) {
    const blocks = [];
    const allNodes = Array.from(doc.getElementsByTagName('*'));
    const paragraphNodes = allNodes.filter(node => {
      const name = HwpParser._hwpxLocalName(node).toLowerCase();
      if (name !== 'p') return false;
      let parent = node.parentElement;
      while (parent) {
        if (HwpParser._hwpxLocalName(parent).toLowerCase() === 'p') return false;
        parent = parent.parentElement;
      }
      return true;
    });

    paragraphNodes.forEach(pEl => {
      const hpBlocks = HwpParser._hwpxParagraphBlocks(pEl, {});
      if (hpBlocks.length) {
        blocks.push(...hpBlocks);
        return;
      }

      const text = Array.from(pEl.getElementsByTagName('*'))
        .filter(node => ['t', 'text', 'char'].includes(HwpParser._hwpxLocalName(node).toLowerCase()))
        .map(node => node.textContent || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) blocks.push(HwpParser._createParagraphBlock(text));
    });

    if (!blocks.length) {
      const rawText = (doc.documentElement?.textContent || '').replace(/\s+/g, ' ').trim();
      if (rawText) blocks.push(HwpParser._createParagraphBlock(rawText));
    }
    return blocks;
  },

  /* HWPX/OWPML package parser methods live in js/hwp-parser-hwpx.js */

  /* ════════════════════════════════════════════
     HWP 5.0 — 3단계 파싱 전략
  ════════════════════════════════════════════ */
  async _parseHwp5(buffer) {
    const b = new Uint8Array(buffer);
    if (!HwpParser._isOleCompound(b)) {
      throw new Error('HWP 시그니처 불일치 — 올바른 HWP 5.0 파일인지 확인하세요.');
    }

    // 전략 0: BodyText/Section 파싱 (전체 텍스트 + 단락 구조)
    let parsedBody = null;
    try { parsedBody = await HwpParser._parseBodyText(b); }
    catch(e) {
      if (HwpParser._isUnsupportedHwpSecurityError(e)) throw e;
      console.warn('[HWP] BodyText 파싱 실패:', e);
    }

    if (parsedBody?.paragraphs?.length) {
      if (parsedBody.sections?.length) {
        const pages = [];
        parsedBody.sections.forEach((section, sectionIndex) => {
          const sectionPages = HwpParser._paginateSectionBlocks(
            section.paragraphs || [],
            48,
            section.pageStyle,
          );
          sectionPages.forEach((page, sectionPageIndex) => {
            const sectionVisibility = section.pageStyle?.visibility || {};
            const resolvedHeaderBlocks = HwpParser._resolveHwpHeaderFooterBlocks(
              section.headerAreas,
              section.headerBlocks,
              sectionPageIndex,
              sectionVisibility.hideFirstHeader === '1',
            );
            const resolvedFooterBlocks = HwpParser._resolveHwpHeaderFooterBlocks(
              section.footerAreas,
              section.footerBlocks,
              sectionPageIndex,
              sectionVisibility.hideFirstFooter === '1',
            );
            // secd startPageNum이 설정된 경우 해당 섹션의 시작 번호를 사용, 없으면 누적 번호
            const sectionBasePageNum = Number(section.pageStyle?.startPageNum) > 0
              ? Number(section.pageStyle.startPageNum)
              : pages.length + 1;
            const pageNumber = sectionBasePageNum + sectionPageIndex;
            // secd tag-76 기반 자동 쪽번호 — 섹션에 명시적 footer가 없을 때만 추가해 중복을 막는다.
            const pageNumMeta = section.pageStyle?.pageNumber;
            const hideFirstPageNum = sectionVisibility.hideFirstPageNum === '1';
            const autoPageNumBlock = (!resolvedFooterBlocks.length && !resolvedHeaderBlocks.length)
              ? HwpParser._hwpxCreatePageNumberBlock(pageNumMeta, pageNumber, hideFirstPageNum && sectionPageIndex === 0)
              : null;
            const isTopNum = String(pageNumMeta?.position || '').toUpperCase().includes('TOP');
            page.headerBlocks = [
              ...resolvedHeaderBlocks.map(cloneParagraphBlock),
              ...(autoPageNumBlock && isTopNum ? [autoPageNumBlock] : []),
            ];
            page.footerBlocks = [
              ...resolvedFooterBlocks.map(cloneParagraphBlock),
              ...(autoPageNumBlock && !isTopNum ? [autoPageNumBlock] : []),
            ];
            page.pageStyle = clonePageStyle(section.pageStyle);
            page.sectionIndex = sectionIndex;
            page.sectionOrder = section.order ?? sectionIndex;
            page.sectionPageIndex = sectionPageIndex;
            page.index = pages.length;
            pages.push(page);
          });
        });
        return {
          meta: {
            pages: pages.length,
            format: 'hwp5',
            version: parsedBody.fileHeader?.version || '',
            sectionCount: parsedBody.documentProperties?.sectionCount || parsedBody.sections.length || 1,
            resourceCount: parsedBody.resourceSummary?.imageCount || 0,
            binDataRefCount: parsedBody.resourceSummary?.binDataRefCount || 0,
          },
          pages,
        };
      }

      const pages = HwpParser._paginateSectionBlocks(
        parsedBody.paragraphs,
        48,
        parsedBody.pageStyle,
      );
      if (pages.length) {
        pages.forEach((page, pageIndex) => {
          const bodyVisibility = parsedBody.pageStyle?.visibility || {};
          const resolvedHeaderBlocks = HwpParser._resolveHwpHeaderFooterBlocks(
            parsedBody.headerAreas,
            parsedBody.headerBlocks,
            pageIndex,
            bodyVisibility.hideFirstHeader === '1',
          );
          const resolvedFooterBlocks = HwpParser._resolveHwpHeaderFooterBlocks(
            parsedBody.footerAreas,
            parsedBody.footerBlocks,
            pageIndex,
            bodyVisibility.hideFirstFooter === '1',
          );
          page.headerBlocks = resolvedHeaderBlocks.map(cloneParagraphBlock);
          page.footerBlocks = resolvedFooterBlocks.map(cloneParagraphBlock);
          // secd tag-76 기반 자동 쪽번호 — 섹션에 명시적 header/footer가 없을 때만 추가
          const pageNumMeta = parsedBody.pageStyle?.pageNumber;
          const hideFirstPageNum = bodyVisibility.hideFirstPageNum === '1';
          if (pageNumMeta && !resolvedFooterBlocks.length && !resolvedHeaderBlocks.length) {
            const startPageNum = Number(parsedBody.pageStyle?.startPageNum) > 0
              ? Number(parsedBody.pageStyle.startPageNum) : 1;
            const autoPageNumBlock = HwpParser._hwpxCreatePageNumberBlock(
              pageNumMeta, startPageNum + pageIndex, hideFirstPageNum && pageIndex === 0,
            );
            if (autoPageNumBlock) {
              const isTopNum = String(pageNumMeta.position || '').toUpperCase().includes('TOP');
              if (isTopNum) {
                page.headerBlocks = [autoPageNumBlock];
              } else {
                page.footerBlocks = [autoPageNumBlock];
              }
            }
          }
        });
        if (parsedBody.pageStyle) {
          pages.forEach(page => { page.pageStyle = parsedBody.pageStyle; });
        }
      }
      return {
        meta: {
          pages: pages.length,
          format: 'hwp5',
          version: parsedBody.fileHeader?.version || '',
          sectionCount: parsedBody.documentProperties?.sectionCount || 1,
          resourceCount: parsedBody.resourceSummary?.imageCount || 0,
          binDataRefCount: parsedBody.resourceSummary?.binDataRefCount || 0,
        },
        pages,
      };
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
    const paras = lines.map(line => HwpParser._createParagraphBlock(line));
    const pages = HwpParser._paginate(paras, 35);
    return {
      meta: { pages: pages.length, note: '⚠️ PrvText 텍스트 추출 (서식 미지원)' },
      pages
    };
  },

  /* HWP5 record/body parser methods live in js/hwp-parser-hwp5-records.js */
  /* HWP5 OLE/CFB container and resource methods live in js/hwp-parser-hwp5-container.js */

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

  _cleanBlocksForPagination(blocks = []) {
    const cleaned = [];
    let emptyRun = 0;
    for (const block of blocks || []) {
      const isEmpty = !HwpParser._blockText(block).trim();
      if (isEmpty) {
        if (++emptyRun <= 2) cleaned.push(block);
        continue;
      }
      emptyRun = 0;
      cleaned.push(block);
    }
    return cleaned;
  },

  _paginateSectionBlocks(blocks, fallbackWeight = 46, pageStyle = null) {
    const cleaned = HwpParser._cleanBlocksForPagination(blocks);
    // pageStyle이 있으면 실제 페이지 콘텐츠 높이를 기반으로 budget을 재보정한다.
    // HWPUNIT(1/7200 inch) 기준: content = height - top - bottom - header - footer
    // 1 weight unit ≈ 표준 12pt 행 높이(≈1500 HWPUNIT) ≈ 20px(@96 DPI)
    let budget = fallbackWeight;
    if (pageStyle && Number(pageStyle.height) > 0) {
      const margins = pageStyle.margins || {};
      const contentHwpu = Number(pageStyle.height)
        - (Number(margins.top) || 0)
        - (Number(margins.bottom) || 0)
        - (pageStyle.sourceFormat === 'hwp' ? 0 : ((Number(margins.header) || 0) + (Number(margins.footer) || 0)));
      if (contentHwpu > 0) {
        const HWPUNIT_PER_WEIGHT = pageStyle.sourceFormat === 'hwpx' ? 2250 : 1500;
        budget = Math.max(16, Math.min(200, Math.round(contentHwpu / HWPUNIT_PER_WEIGHT)));
      }
    }
    return HwpParser._paginate(cleaned, budget);
  },

  _paginate(paras, n) {
    if (!paras.length) return [{ index:0, paragraphs:[] }];
    const expanded = paras.flatMap(para => (
      para.type === 'table'
        ? HwpParser._splitTableBlock(para, Math.max(16, n - 4))
        : [para]
    ));
    const pages = [];
    let current = [];
    let currentWeight = 0;

    for (const para of expanded) {
      const weight = Math.max(1, HwpParser._estimateBlockWeight(para));
      if (current.length && currentWeight + weight > n) {
        pages.push({ index: pages.length, paragraphs: current });
        current = [];
        currentWeight = 0;
      }
      current.push(para);
      currentWeight += weight;
    }

    if (current.length) {
      pages.push({ index: pages.length, paragraphs: current });
    }

    return pages;
  },

  _run(text, opts = {}) {
    return Object.assign(
      { text: text||'', bold:false, italic:false, underline:false,
        fontSize:11, fontName:'Malgun Gothic', fontNameLatin:'', color:'#000000',
        shadeColor:'', underlineColor:'', underlineShape:'',
        strike:false, strikeColor:'', strikeShape:'',
        superscript:false, subscript:false,
        shadowType:'', shadowColor:'', shadowOffsetX:0, shadowOffsetY:0,
        outlineType:'',
        scaleX:100, letterSpacing:0, relSize:100, offsetY:0 },
      opts
    );
  },

  _u16(b, o) { return (b[o]??0) | ((b[o+1]??0)<<8); },
  _u16be(b, o) { return ((b[o]??0) << 8) | (b[o+1]??0); },
  _i16(b, o) {
    const value = HwpParser._u16(b, o);
    return value > 0x7FFF ? value - 0x10000 : value;
  },
  _i32(b, o) {
    const value = HwpParser._u32(b, o);
    return value > 0x7FFFFFFF ? value - 0x100000000 : value;
  },
  _u32(b, o) {
    return ( (b[o]??0) | ((b[o+1]??0)<<8) | ((b[o+2]??0)<<16) | ((b[o+3]??0)<<24) ) >>> 0;
  },
  _u32be(b, o) {
    return (((b[o]??0) << 24) | ((b[o+1]??0) << 16) | ((b[o+2]??0) << 8) | (b[o+3]??0)) >>> 0;
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.HwpParser = HwpParser;
}

/* ── 파서/렌더러 공통 clone 유틸 (worker에서도 사용됨) ── */

function clonePageStyle(pageStyle) {
  if (!pageStyle) return null;
  return {
    ...pageStyle,
    margins: pageStyle.margins ? { ...pageStyle.margins } : undefined,
    pageBorderFills: Array.isArray(pageStyle.pageBorderFills)
      ? pageStyle.pageBorderFills.map(def => ({
        ...def,
        offset: def?.offset ? { ...def.offset } : undefined,
      }))
      : undefined,
  };
}

function cloneParagraphBlock(para) {
  if (para?.type === 'table') {
    return {
      ...(para || {}),
      rows: (para.rows || []).map(row => ({
        ...row,
        cells: (row.cells || []).map(cell => cloneTableCell(cell)),
      })),
      columnWidths: Array.isArray(para.columnWidths) ? [...para.columnWidths] : para.columnWidths,
      rowHeights: Array.isArray(para.rowHeights) ? [...para.rowHeights] : para.rowHeights,
      texts: ((para?.texts) || []).map(run => ({ ...run })),
    };
  }

  return {
    ...(para || HwpParser._createParagraphBlock('')),
    texts: ((para?.texts) || []).map(run => ({ ...run })),
  };
}

function cloneTableCell(cell, overrides = {}) {
  const paragraphs = overrides.paragraphs
    ? overrides.paragraphs.map(cloneParagraphBlock)
    : (cell?.paragraphs || []).map(cloneParagraphBlock);
  const padding = Array.isArray(cell?.padding) ? [...cell.padding] : cell?.padding;
  return {
    ...(cell || {}),
    ...overrides,
    padding,
    paragraphs,
  };
}
