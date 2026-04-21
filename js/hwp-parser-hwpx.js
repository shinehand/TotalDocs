/**
 * hwp-parser-hwpx.js — HWPX/OWPML package parser extension
 * hwp-parser.js core가 만든 전역 HwpParser에 기능을 덧붙이는 plain-script 확장 파일입니다.
 */

if (typeof HwpParser === 'undefined') {
  throw new Error('js/hwp-parser.js must be loaded before js/hwp-parser-hwpx.js');
}

Object.assign(HwpParser, {
  /* ── HWPX ── */
  async _parseHwpx(buffer) {
    if (typeof JSZip === 'undefined') throw new Error('lib/jszip.min.js 로드 실패');
    const zip = await JSZip.loadAsync(buffer);
    await HwpParser._hwpxValidatePackage(zip);
    const [header, images] = await Promise.all([
      HwpParser._hwpxParseHeader(zip),
      HwpParser._hwpxParseBinaryMap(zip),
    ]);
    header.images = images;
    const keys = await HwpParser._hwpxSectionKeys(zip);
    if (!keys.length) throw new Error('HWPX: section 파일 없음');

    const pages = [];
    for (let i = 0; i < keys.length; i++) {
      const xml = await zip.files[keys[i]].async('string');
      const sectionData = HwpParser._hwpxSectionData(xml, header);
      const sectionMeta = sectionData.sectionMeta || {};
      const sectionPages = HwpParser._paginate(sectionData.blocks, 46);
      const visibility = sectionMeta.visibility || {};
      const sectionStartPageNum = Math.max(1, Number(sectionMeta.startPageNum) || (pages.length + 1));

      sectionPages.forEach((page, sectionPageIndex) => {
        const headerBlocks = HwpParser._hwpxResolveAreaBlocks(
          sectionData.headerAreas || [],
          sectionPageIndex,
          visibility.hideFirstHeader === '1',
        );
        const footerBlocks = HwpParser._hwpxResolveAreaBlocks(
          sectionData.footerAreas || [],
          sectionPageIndex,
          visibility.hideFirstFooter === '1',
        );
        const pageNumber = sectionStartPageNum + sectionPageIndex;
        const pageNumberBlock = HwpParser._hwpxCreatePageNumberBlock(
          sectionMeta.pageNumber,
          pageNumber,
          visibility.hideFirstPageNum === '1' && sectionPageIndex === 0,
        );

        page.headerBlocks = headerBlocks.map(cloneParagraphBlock);
        page.footerBlocks = [...footerBlocks, ...(pageNumberBlock ? [pageNumberBlock] : [])]
          .map(cloneParagraphBlock);
        page.pageStyle = clonePageStyle(sectionMeta.pageStyle);
        page.pageNumber = pageNumber;
        page.sectionPageIndex = sectionPageIndex;
        page.index = pages.length;
        pages.push(page);
      });
    }

    if (!pages.length || !pages.some(page => page.paragraphs?.length)) {
      const previewText = await HwpParser._hwpxPreviewText(zip);
      if (previewText) {
        const paragraphs = HwpParser._paragraphsFromText(previewText);
        const previewPages = HwpParser._paginate(paragraphs, 42);
        return {
          meta: {
            pages: previewPages.length,
            format: 'hwpx',
            sectionCount: 0,
            resourceCount: Object.keys(images || {}).length,
            note: '⚠️ HWPX 미리보기 텍스트 추출 (일부 도형/표 생략)',
          },
          pages: previewPages,
        };
      }
    }

    return {
      meta: {
        pages: pages.length,
        format: 'hwpx',
        sectionCount: keys.length,
        resourceCount: Object.keys(images || {}).length,
      },
      pages,
    };
  },

  async _hwpxValidatePackage(zip) {
    const mimetypeKey = Object.keys(zip.files).find(p => /^mimetype$/i.test(p));
    if (!mimetypeKey) return;

    const mimetype = (await zip.files[mimetypeKey].async('string')).trim();
    if (!mimetype) return;
    if (!/application\/(hwp\+zip|owpml)/i.test(mimetype)) {
      throw new Error(`HWPX mimetype 불일치: ${mimetype}`);
    }
  },

  _zipFindFile(zip, requestedPath) {
    if (!requestedPath) return null;
    const normalized = String(requestedPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (zip.files[normalized]) return normalized;
    const lower = normalized.toLowerCase();
    return Object.keys(zip.files).find(key => key.replace(/\\/g, '/').toLowerCase() === lower) || null;
  },

  async _hwpxSectionKeys(zip) {
    const naturalKeys = Object.keys(zip.files)
      .filter(p => /Contents[\\/]section\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const ai = Number((a.match(/section(\d+)\.xml$/i) || [])[1] || 0);
        const bi = Number((b.match(/section(\d+)\.xml$/i) || [])[1] || 0);
        return ai - bi;
      });

    const contentKey = HwpParser._zipFindFile(zip, 'Contents/content.hpf');
    if (!contentKey || typeof DOMParser === 'undefined') return naturalKeys;

    try {
      const xml = await zip.files[contentKey].async('string');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror')) return naturalKeys;

      const manifestItems = {};
      Array.from(doc.getElementsByTagName('*')).forEach(node => {
        if (HwpParser._hwpxLocalName(node) !== 'item') return;
        const id = node.getAttribute('id');
        const href = node.getAttribute('href') || node.getAttribute('full-path');
        if (id && href) manifestItems[id] = href;
      });

      const ordered = [];
      Array.from(doc.getElementsByTagName('*')).forEach(node => {
        if (HwpParser._hwpxLocalName(node) !== 'itemref') return;
        const idref = node.getAttribute('idref');
        const href = manifestItems[idref];
        if (!href || !/section\d+\.xml$/i.test(href)) return;
        const fullPath = /^Contents[\\/]/i.test(href) ? href : `Contents/${href}`;
        const key = HwpParser._zipFindFile(zip, fullPath);
        if (key && !ordered.includes(key)) ordered.push(key);
      });

      naturalKeys.forEach(key => {
        if (!ordered.includes(key)) ordered.push(key);
      });
      return ordered.length ? ordered : naturalKeys;
    } catch {
      return naturalKeys;
    }
  },

  async _hwpxPreviewText(zip) {
    const key = Object.keys(zip.files).find(p => /Preview[\\/]PrvText\.txt$/i.test(p));
    if (!key) return '';

    const bytes = await zip.files[key].async('uint8array');
    const tryDecoders = ['utf-8', 'utf-16le', 'utf-16be'];
    for (const encoding of tryDecoders) {
      try {
        const text = new TextDecoder(encoding, { fatal: false }).decode(bytes)
          .replace(/\u0000/g, '')
          .trim();
        if (text.length >= 20) return text;
      } catch {}
    }
    return '';
  },

  async _hwpxParseBinaryMap(zip) {
    const out = {};
    const keys = Object.keys(zip.files).filter(p => /BinData[\\/][^/]+\.(png|jpe?g|gif|bmp|webp)$/i.test(p));
    await Promise.all(keys.map(async key => {
      const match = key.match(/BinData[\\/](.+)\.(png|jpe?g|gif|bmp|webp)$/i);
      if (!match) return;
      const [, name, ext] = match;
      const base64 = await zip.files[key].async('base64');
      const normalizedExt = ext.toLowerCase() === 'jpg' ? 'jpeg' : ext.toLowerCase();
      out[name] = `data:image/${normalizedExt};base64,${base64}`;
    }));
    return out;
  },

  async _hwpxParseHeader(zip) {
    const key = Object.keys(zip.files).find(p => /Contents[\\/]header\.xml$/i.test(p));
    if (!key) {
      return { borderFills: {}, paraProps: {}, charProps: {}, hangulFonts: {} };
    }

    let doc;
    try {
      const xml = await zip.files[key].async('string');
      doc = new DOMParser().parseFromString(xml, 'application/xml');
    } catch {
      return { borderFills: {}, paraProps: {}, charProps: {}, hangulFonts: {} };
    }

    const refs = {
      borderFills: {},
      paraProps: {},
      charProps: {},
      hangulFonts: {},
    };

    const allNodes = Array.from(doc.getElementsByTagName('*'));
    const hangulFontface = allNodes.find(node => (
      HwpParser._hwpxLocalName(node) === 'fontface' && node.getAttribute('lang') === 'HANGUL'
    ));
    HwpParser._hwpxChildren(hangulFontface, 'font').forEach(fontEl => {
      refs.hangulFonts[String(fontEl.getAttribute('id'))] = fontEl.getAttribute('face') || '';
    });

    allNodes.forEach(node => {
      const name = HwpParser._hwpxLocalName(node);
      if (name === 'borderFill') {
        const id = Number(node.getAttribute('id'));
        if (!Number.isFinite(id)) return;

        const parseBorder = (borderNode) => ({
          type: borderNode?.getAttribute?.('type') || 'NONE',
          widthMm: HwpParser._hwpxParseMm(borderNode?.getAttribute?.('width')),
          color: HwpParser._hwpxNormalizeColor(borderNode?.getAttribute?.('color')),
        });
        const fillBrush = HwpParser._hwpxDescendant(node, 'winBrush');
        const gradation = HwpParser._hwpxDescendant(node, 'gradation');
        const gradientColors = HwpParser._hwpxChildren(gradation, 'color')
          .map(colorEl => HwpParser._hwpxNormalizeColor(colorEl.getAttribute('value') || colorEl.textContent || ''))
          .filter(Boolean);
        refs.borderFills[id] = {
          left: parseBorder(HwpParser._hwpxFirstChild(node, 'leftBorder')),
          right: parseBorder(HwpParser._hwpxFirstChild(node, 'rightBorder')),
          top: parseBorder(HwpParser._hwpxFirstChild(node, 'topBorder')),
          bottom: parseBorder(HwpParser._hwpxFirstChild(node, 'bottomBorder')),
          fillColor: HwpParser._hwpxNormalizeColor(fillBrush?.getAttribute?.('faceColor')),
          fillGradient: gradientColors.length >= 2 ? {
            type: gradation?.getAttribute?.('type') || 'LINEAR',
            angle: HwpParser._hwpxAttrNum(gradation, 'angle', 0),
            colors: gradientColors,
          } : null,
        };
        return;
      }

      if (name === 'paraPr') {
        const id = Number(node.getAttribute('id'));
        if (!Number.isFinite(id)) return;
        const alignEl = HwpParser._hwpxFirstChild(node, 'align');
        const marginEl = HwpParser._hwpxDescendant(node, 'margin');
        const lineSpacingEl = HwpParser._hwpxDescendant(node, 'lineSpacing');
        refs.paraProps[id] = {
          align: HwpParser._hwpxMapAlign(alignEl?.getAttribute?.('horizontal')),
          marginLeft: HwpParser._hwpxAttrNum(HwpParser._hwpxDescendant(marginEl, 'left'), 'value', 0),
          marginRight: HwpParser._hwpxAttrNum(HwpParser._hwpxDescendant(marginEl, 'right'), 'value', 0),
          // HWPX 들여쓰기 요소는 'hc:indent'가 아닌 'hc:intent'로 표기된다 (HWPML 스펙).
          textIndent: HwpParser._hwpxAttrNum(HwpParser._hwpxDescendant(marginEl, 'intent'), 'value', 0),
          spacingBefore: HwpParser._hwpxAttrNum(HwpParser._hwpxDescendant(marginEl, 'prev'), 'value', 0),
          spacingAfter: HwpParser._hwpxAttrNum(HwpParser._hwpxDescendant(marginEl, 'next'), 'value', 0),
          lineSpacingType: HwpParser._normalizeLineSpacingType(lineSpacingEl?.getAttribute?.('type')),
          lineSpacing: HwpParser._hwpxAttrNum(lineSpacingEl, 'value', 0),
        };
        return;
      }

      if (name === 'charPr') {
        const id = Number(node.getAttribute('id'));
        if (!Number.isFinite(id)) return;
        const fontRefEl = HwpParser._hwpxFirstChild(node, 'fontRef');
        const underlineEl = HwpParser._hwpxFirstChild(node, 'underline');
        const strikeoutEl = HwpParser._hwpxFirstChild(node, 'strikeout');
        const shadowEl = HwpParser._hwpxFirstChild(node, 'shadow');
        const outlineEl = HwpParser._hwpxFirstChild(node, 'outline');
        const ratioEl = HwpParser._hwpxFirstChild(node, 'ratio');
        const spacingEl = HwpParser._hwpxFirstChild(node, 'spacing');
        const relSzEl = HwpParser._hwpxFirstChild(node, 'relSz');
        const offsetEl = HwpParser._hwpxFirstChild(node, 'offset');
        refs.charProps[id] = {
          fontName: refs.hangulFonts[String(fontRefEl?.getAttribute?.('hangul'))] || '',
          fontSize: HwpParser._hwpxAttrNum(node, 'height', 0) > 0
            ? Math.round((HwpParser._hwpxAttrNum(node, 'height', 0) / 100) * 10) / 10
            : 0,
          color: HwpParser._hwpxNormalizeColor(node.getAttribute('textColor')),
          shadeColor: HwpParser._hwpxNormalizeColor(node.getAttribute('shadeColor')),
          bold: Boolean(HwpParser._hwpxFirstChild(node, 'bold')),
          italic: Boolean(HwpParser._hwpxFirstChild(node, 'italic')),
          underline: (underlineEl?.getAttribute?.('type') || 'NONE') !== 'NONE',
          underlineColor: HwpParser._hwpxNormalizeColor(underlineEl?.getAttribute?.('color')),
          underlineShape: String(underlineEl?.getAttribute?.('shape') || '').trim().toUpperCase(),
          strike: (strikeoutEl?.getAttribute?.('shape') || 'NONE') !== 'NONE',
          strikeColor: HwpParser._hwpxNormalizeColor(strikeoutEl?.getAttribute?.('color')),
          strikeShape: String(strikeoutEl?.getAttribute?.('shape') || '').trim().toUpperCase(),
          outlineType: String(outlineEl?.getAttribute?.('type') || '').trim().toUpperCase(),
          shadowType: String(shadowEl?.getAttribute?.('type') || '').trim().toUpperCase(),
          shadowColor: HwpParser._hwpxNormalizeColor(shadowEl?.getAttribute?.('color')),
          shadowOffsetX: HwpParser._hwpxAttrNum(shadowEl, 'offsetX', 0),
          shadowOffsetY: HwpParser._hwpxAttrNum(shadowEl, 'offsetY', 0),
          scaleX: HwpParser._hwpxCharAttrNum(ratioEl, 100),
          letterSpacing: HwpParser._hwpxCharAttrNum(spacingEl, 0),
          relSize: HwpParser._hwpxCharAttrNum(relSzEl, 100),
          offsetY: HwpParser._hwpxCharAttrNum(offsetEl, 0),
        };
      }
    });

    return refs;
  },

  _hwpxSectionData(xmlStr, header = {}) {
    let doc;
    try { doc = new DOMParser().parseFromString(xmlStr, 'application/xml'); }
    catch {
      return {
        blocks: [{ align:'left', texts:[HwpParser._run('(XML 오류)')] }],
        sectionMeta: {},
        headerAreas: [],
        footerAreas: [],
        headerBlocks: [],
        footerBlocks: [],
      };
    }

    if (doc.querySelector('parsererror')) {
      return {
        blocks: [{ align:'left', texts:[HwpParser._run('(XML 오류)')] }],
        sectionMeta: {},
        headerAreas: [],
        footerAreas: [],
        headerBlocks: [],
        footerBlocks: [],
      };
    }

    const sectionMeta = HwpParser._hwpxSectionMeta(doc.documentElement, header);
    const blocks = HwpParser._hwpxBlocksFromContainer(doc.documentElement, header);
    const headerAreas = HwpParser._hwpxAreaDefs(doc.documentElement, 'header', header);
    const footerAreas = HwpParser._hwpxAreaDefs(doc.documentElement, 'footer', header);
    const headerBlocks = HwpParser._hwpxResolveAreaBlocks(
      headerAreas,
      0,
      sectionMeta.visibility?.hideFirstHeader === '1',
    );
    const footerBlocks = HwpParser._hwpxResolveAreaBlocks(
      footerAreas,
      0,
      sectionMeta.visibility?.hideFirstFooter === '1',
    );
    if (blocks.length) {
      return { blocks, sectionMeta, headerAreas, footerAreas, headerBlocks, footerBlocks };
    }

    const raw = (doc.documentElement.textContent || '').trim();
    return {
      sectionMeta,
      headerAreas,
      footerAreas,
      blocks: raw
        ? raw.split(/\n+/).map(l => HwpParser._createParagraphBlock(l.trim()))
        : [{ align:'left', texts:[HwpParser._run('')] }],
      headerBlocks,
      footerBlocks,
    };
  },

  _hwpxSection(xmlStr, header = {}) {
    return HwpParser._hwpxSectionData(xmlStr, header).blocks;
  },

  /**
   * HWPX hp:t 요소의 텍스트 내용을 추출한다.
   * hp:t 내부에 <hp:fwSpace/> (전각 공백, U+3000) 같은 자식 요소가 있으면
   * textContent만 쓰면 누락되므로 child 노드를 직접 순회해 처리한다.
   * (hp:run이나 hp:compose 같이 hp:t 밖에 있는 요소는 각 호출 지점에서 별도로 처리한다.)
   */
  _hwpxTElementText(tEl) {
    let text = '';
    for (const node of tEl.childNodes || []) {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        text += node.textContent || '';
      } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
        const name = HwpParser._hwpxLocalName(node);
        if (name === 'fwSpace') {
          text += '\u3000'; // 전각 공백 (IDEOGRAPHIC SPACE)
        }
        // 기타 자식 요소는 무시 (hp:run 내부는 이미 처리됨)
      }
    }
    return text || tEl.textContent || '';
  },

  /**
   * HWPX compose 요소를 원문자(①②③...) 유니코드 문자로 변환한다.
   * Hancom HWPX는 원문자를 Private Use Area(PUA) 2-char 시퀀스로 인코딩한다:
   *   첫 번째 문자: 0xF02D7 (외곽 원 모양)
   *   두 번째 문자: 0xF02DF + n (n = 1..20)
   * 이를 Unicode 원문자 U+2460 + (n-1) (① = U+2460)으로 매핑한다.
   * 대응 문자가 없으면 composeText를 그대로 반환한다.
   */
  _hwpxDecodeComposeChar(composeEl) {
    const text = composeEl?.getAttribute?.('composeText') || '';
    if (!text) return '';
    // PUA 원문자: 두 번째 코드포인트가 0xF02E0..0xF02F3 범위이면 ①..⑳ 으로 변환
    const codePoints = [...text].map(ch => ch.codePointAt(0));
    const secondCP = codePoints[1];
    if (Number.isFinite(secondCP) && secondCP >= 0xF02E0 && secondCP <= 0xF02F3) {
      const n = secondCP - 0xF02DF; // 1..20
      if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
    }
    // 원 안에 다른 문자: circleType/composeType 기반 fallback
    // 두 번째 PUA 문자가 없거나 범위 밖이면 composeText를 그대로 쓴다
    return text.replace(/[\uE000-\uF8FF]/gu, '').trim() || text;
  },

  _hwpxLocalName(node) {
    if (!node) return '';
    return node.localName || String(node.nodeName || '').replace(/^.*:/, '');
  },

  _hwpxChildren(node, localName = '') {
    return Array.from(node?.children || []).filter(child => (
      !localName || HwpParser._hwpxLocalName(child) === localName
    ));
  },

  _hwpxFirstChild(node, localName) {
    return HwpParser._hwpxChildren(node, localName)[0] || null;
  },

  _hwpxDescendant(node, localName) {
    return Array.from(node?.getElementsByTagName?.('*') || []).find(child => (
      HwpParser._hwpxLocalName(child) === localName
    )) || null;
  },

  _hwpxAttrNum(node, attr, fallback = 0) {
    const value = Number(node?.getAttribute?.(attr));
    return Number.isFinite(value) ? value : fallback;
  },

  /**
   * HWPX 셀 여백(cellMargin/inMargin) 속성값을 읽는다.
   * 0xFFFFFFFF(-1, signed int32 표현)는 "테이블 기본값 상속"을 의미하므로 0으로 변환한다.
   * 0x80000000 이상 = signed int32로 음수 범위이며 모두 유효하지 않은 값으로 처리한다.
   */
  _hwpxCellMarginVal(node, attr) {
    const value = Number(node?.getAttribute?.(attr));
    // 0x80000000 이상은 signed int32 음수 범위 → "inherit" 또는 미설정을 의미하므로 0 반환
    if (!Number.isFinite(value) || value < 0 || value >= 0x80000000) return 0;
    return value;
  },

  _hwpxCharAttrNum(node, fallback = 0) {
    const attrs = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
    for (const attr of attrs) {
      const value = Number(node?.getAttribute?.(attr));
      if (Number.isFinite(value)) return value;
    }
    return fallback;
  },

  _normalizeObjectRelTo(value, axis = 'horz') {
    const raw = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (!raw) return axis === 'horz' ? 'column' : 'para';
    if (['paper', 'page', 'para', 'column', 'absolute'].includes(raw)) return raw;
    return axis === 'horz' ? 'column' : 'para';
  },

  _normalizeObjectAlign(value, axis = 'horz') {
    const raw = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (!raw) return axis === 'horz' ? 'left' : 'top';
    if (['left', 'center', 'right', 'top', 'bottom', 'inside', 'outside'].includes(raw)) return raw;
    return axis === 'horz' ? 'left' : 'top';
  },

  _normalizeObjectTextWrap(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (['square', 'tight', 'through'].includes(raw)) return raw;
    if (['top-and-bottom', 'topandbottom'].includes(raw)) return 'top-and-bottom';
    if (['behind-text', 'behindtext'].includes(raw)) return 'behind-text';
    if (['in-front-of-text', 'infrontoftext', 'front-of-text'].includes(raw)) return 'in-front-of-text';
    return raw || 'top-and-bottom';
  },

  _normalizeObjectTextFlow(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (['both-sides', 'bothsides'].includes(raw)) return 'both-sides';
    if (['left-only', 'leftonly'].includes(raw)) return 'left-only';
    if (['right-only', 'rightonly'].includes(raw)) return 'right-only';
    if (['largest-only', 'largestonly'].includes(raw)) return 'largest-only';
    return raw || 'both-sides';
  },

  _normalizeObjectSizeRelTo(value, axis = 'width') {
    const raw = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (['paper', 'page', 'column', 'para', 'absolute'].includes(raw)) return raw;
    return axis === 'width' ? 'absolute' : 'absolute';
  },

  _hwpxParseMm(value) {
    const match = String(value || '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  },

  _hwpxNormalizeColor(value) {
    const text = String(value || '').trim();
    if (!text || text.toLowerCase() === 'none') return '';
    const hex = text.replace(/^#/, '');
    if (/^[0-9a-f]{8}$/i.test(hex)) return `#${hex.slice(2)}`;
    if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`;
    return text;
  },

  _hwpxMapAlign(value) {
    switch (String(value || '').toUpperCase()) {
      case 'CENTER': return 'center';
      case 'RIGHT': return 'right';
      case 'JUSTIFY': return 'justify';
      default: return 'left';
    }
  },

  _hwpxMapCellVerticalAlign(value) {
    switch (String(value || '').toUpperCase()) {
      case 'CENTER':
      case 'MIDDLE':
        return 'middle';
      case 'BOTTOM':
        return 'bottom';
      default:
        return 'top';
    }
  },

  _hwpxCleanText(text) {
    return String(text || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  },

  _hwpxSameRunStyle(a, b) {
    if (!a || !b) return false;
    if (a.type === 'image' || b.type === 'image') return false;
    return Boolean(a && b)
      && a.bold === b.bold
      && a.italic === b.italic
      && a.underline === b.underline
      && a.fontSize === b.fontSize
      && a.fontName === b.fontName
      && a.color === b.color
      && a.scaleX === b.scaleX
      && a.letterSpacing === b.letterSpacing
      && a.relSize === b.relSize
      && a.offsetY === b.offsetY;
  },

  _hwpxPushTextRun(runBuffer, text, style = {}) {
    if (!text) return;
    const prev = runBuffer[runBuffer.length - 1];
    if (prev && HwpParser._hwpxSameRunStyle(prev, style)) {
      prev.text += text;
      return;
    }
    runBuffer.push(HwpParser._run(text, style));
  },

  _hwpxTrimRunBuffer(runBuffer) {
    const runs = runBuffer.map(run => ({ ...run }));
    while (runs.length) {
      if (runs[0].type === 'image') break;
      if (String(runs[0].text || '').trim()) break;
      runs.shift();
    }
    while (runs.length) {
      if (runs[runs.length - 1].type === 'image') break;
      if (String(runs[runs.length - 1].text || '').trim()) break;
      runs.pop();
    }
    if (!runs.length) return [];
    if (runs[0].type !== 'image') {
      runs[0].text = String(runs[0].text || '').replace(/^\s+/, '');
    }
    if (runs[runs.length - 1].type !== 'image') {
      runs[runs.length - 1].text = String(runs[runs.length - 1].text || '').replace(/\s+$/, '');
    }
    return runs.filter(run => run.type === 'image' || run.text);
  },

  _createStyledParagraphBlock(texts, align = 'left', blockOpts = {}) {
    return {
      type: 'paragraph',
      align,
      ...blockOpts,
      texts: (texts || []).length
        ? texts.map(run => HwpParser._run(run.text || '', run))
        : [HwpParser._run('')],
    };
  },

  _withObjectLayout(block, objectInfo = {}) {
    if (!block) return block;
    return {
      ...block,
      align: objectInfo?.align || block.align || 'left',
      inline: objectInfo?.inline ?? block.inline ?? false,
      affectLineSpacing: objectInfo?.affectLineSpacing ?? block.affectLineSpacing ?? false,
      vertRelTo: objectInfo?.vertRelTo || block.vertRelTo || 'para',
      vertAlign: objectInfo?.vertAlign || block.vertAlign || 'top',
      horzRelTo: objectInfo?.horzRelTo || block.horzRelTo || 'column',
      horzAlign: objectInfo?.horzAlign || block.horzAlign || block.align || 'left',
      offsetX: Number(objectInfo?.horzOffset ?? block.offsetX) || 0,
      offsetY: Number(objectInfo?.vertOffset ?? block.offsetY) || 0,
      flowWithText: objectInfo?.flowWithText ?? block.flowWithText ?? false,
      allowOverlap: objectInfo?.allowOverlap ?? block.allowOverlap ?? false,
      holdAnchorAndSO: objectInfo?.holdAnchorAndSO ?? block.holdAnchorAndSO ?? false,
      widthRelTo: objectInfo?.widthRelTo || block.widthRelTo || 'absolute',
      heightRelTo: objectInfo?.heightRelTo || block.heightRelTo || 'absolute',
      sizeProtected: objectInfo?.sizeProtected ?? block.sizeProtected ?? false,
      textWrap: objectInfo?.textWrap || block.textWrap || 'top-and-bottom',
      textFlow: objectInfo?.textFlow || block.textFlow || 'both-sides',
      zOrder: Number(objectInfo?.zOrder ?? block.zOrder) || 0,
      outMargin: Array.isArray(objectInfo?.margin)
        ? [...objectInfo.margin]
        : (Array.isArray(block.outMargin) ? [...block.outMargin] : []),
    };
  },

  _hwpxParseObjectLayout(node) {
    const posEl = HwpParser._hwpxFirstChild(node, 'pos');
    const sizeEl = HwpParser._hwpxFirstChild(node, 'sz');
    const outMarginEl = HwpParser._hwpxFirstChild(node, 'outMargin');
    // hp:pic 계열은 <hp:pos> 대신 <hp:offset x="..." y="..."/> 로 위치를 지정한다.
    const offsetEl = posEl ? null : HwpParser._hwpxFirstChild(node, 'offset');
    const horzOffsetRaw = posEl
      ? HwpParser._hwpxAttrNum(posEl, 'horzOffset', 0)
      : HwpParser._hwpxAttrNum(offsetEl, 'x', 0);
    const vertOffsetRaw = posEl
      ? HwpParser._hwpxAttrNum(posEl, 'vertOffset', 0)
      : HwpParser._hwpxAttrNum(offsetEl, 'y', 0);
    // HWPUNIT offset은 부호 있는 32-bit 값으로 저장되므로 wrap-around 처리한다.
    // XML에서 읽으면 Number("4294965716") 같은 큰 양수로 파싱되므로,
    // >>> 0 으로 unsigned 32-bit 범위로 강제한 뒤 0x7FFFFFFF 초과 시 2^32 빼서 음수로 변환한다.
    // 예: 4294965716 → 0xFFFFFB14 → -1260 HWPUNIT (= -16.8px @ 96DPI, 앵커 좌측)
    const toSignedU32 = v => (v >>> 0) > 0x7FFFFFFF ? (v >>> 0) - 0x100000000 : v;
    return {
      inline: posEl?.getAttribute?.('treatAsChar') === '1',
      affectLineSpacing: posEl?.getAttribute?.('affectLSpacing') === '1',
      vertRelTo: HwpParser._normalizeObjectRelTo(posEl?.getAttribute?.('vertRelTo'), 'vert'),
      vertAlign: HwpParser._normalizeObjectAlign(posEl?.getAttribute?.('vertAlign'), 'vert'),
      horzRelTo: HwpParser._normalizeObjectRelTo(posEl?.getAttribute?.('horzRelTo'), 'horz'),
      horzAlign: HwpParser._normalizeObjectAlign(posEl?.getAttribute?.('horzAlign'), 'horz'),
      vertOffset: toSignedU32(vertOffsetRaw),
      horzOffset: toSignedU32(horzOffsetRaw),
      flowWithText: posEl?.getAttribute?.('flowWithText') === '1',
      allowOverlap: posEl?.getAttribute?.('allowOverlap') === '1',
      holdAnchorAndSO: posEl?.getAttribute?.('holdAnchorAndSO') === '1',
      widthRelTo: HwpParser._normalizeObjectSizeRelTo(sizeEl?.getAttribute?.('widthRelTo'), 'width'),
      heightRelTo: HwpParser._normalizeObjectSizeRelTo(sizeEl?.getAttribute?.('heightRelTo'), 'height'),
      sizeProtected: sizeEl?.getAttribute?.('protect') === '1',
      textWrap: HwpParser._normalizeObjectTextWrap(node?.getAttribute?.('textWrap')),
      textFlow: HwpParser._normalizeObjectTextFlow(node?.getAttribute?.('textFlow')),
      zOrder: HwpParser._hwpxAttrNum(node, 'zOrder', 0),
      margin: [
        HwpParser._hwpxAttrNum(outMarginEl, 'left', 0),
        HwpParser._hwpxAttrNum(outMarginEl, 'right', 0),
        HwpParser._hwpxAttrNum(outMarginEl, 'top', 0),
        HwpParser._hwpxAttrNum(outMarginEl, 'bottom', 0),
      ],
    };
  },

  _hwpxPictureBlock(picEl, header = {}) {
    const imgEl = HwpParser._hwpxDescendant(picEl, 'img');
    const curSizeEl = HwpParser._hwpxFirstChild(picEl, 'curSz');
    const orgSizeEl = HwpParser._hwpxFirstChild(picEl, 'orgSz');
    const objectInfo = HwpParser._hwpxParseObjectLayout(picEl);
    const ref = imgEl?.getAttribute?.('binaryItemIDRef') || '';
    const src = header?.images?.[ref] || '';
    if (!src) return null;
    // curSz가 0,0 이면 렌더링 크기가 없으므로 orgSz(원본 크기)로 fallback.
    // 한 dimension만 0이면 aspect ratio 일관성을 위해 양쪽 모두 orgSz를 사용한다.
    const curW = HwpParser._hwpxAttrNum(curSizeEl, 'width', 0);
    const curH = HwpParser._hwpxAttrNum(curSizeEl, 'height', 0);
    const orgW = HwpParser._hwpxAttrNum(orgSizeEl, 'width', 0);
    const orgH = HwpParser._hwpxAttrNum(orgSizeEl, 'height', 0);
    const useCurSz = curW > 0 && curH > 0;
    const width = useCurSz ? curW : orgW;
    const height = useCurSz ? curH : orgH;

    return HwpParser._withObjectLayout({
      type: 'image',
      src,
      alt: ref || 'image',
      width,
      height,
      sourceFormat: 'hwpx',
      description: HwpParser._hwpxFirstChild(picEl, 'shapeComment')?.textContent?.trim?.() || '',
    }, objectInfo);
  },

  _hwpxInlineImageRun(picEl, header = {}) {
    const imageBlock = HwpParser._hwpxPictureBlock(picEl, header);
    if (!imageBlock) return null;
    return {
      ...imageBlock,
      inline: true,
      text: '',
    };
  },

  _hwpxParagraphHasText(pEl) {
    return HwpParser._hwpxChildren(pEl, 'run').some(runEl => (
      HwpParser._hwpxChildren(runEl).some(child => {
        const name = HwpParser._hwpxLocalName(child);
        if (name === 'lineBreak' || name === 'tab') return true;
        if (name === 'compose') return Boolean(HwpParser._hwpxDecodeComposeChar(child));
        return name === 't' && Boolean((child.textContent || '').trim());
      })
    ));
  },

  _hwpxParagraphLineMetrics(pEl) {
    const lineSegArray = HwpParser._hwpxFirstChild(pEl, 'linesegarray');
    const lineSegs = HwpParser._hwpxChildren(lineSegArray, 'lineseg')
      .map(lineEl => {
        const height = Math.max(
          HwpParser._hwpxAttrNum(lineEl, 'vertsize', 0),
          HwpParser._hwpxAttrNum(lineEl, 'textheight', 0),
          HwpParser._hwpxAttrNum(lineEl, 'spacing', 0),
        );
        return Number.isFinite(height) ? height : 0;
      })
      .filter(height => height > 0 && height <= 14400);

    if (!lineSegs.length) return {};

    const totalHeight = lineSegs.reduce((sum, height) => sum + height, 0);
    const avgHeight = totalHeight / lineSegs.length;
    return {
      lineHeightPx: Math.max(11, Math.min(96, Math.round(avgHeight / 75))),
      layoutHeightPx: Math.max(0, Math.min(480, Math.round(totalHeight / 75))),
    };
  },

  _hwpxTextFromRun(runEl) {
    let text = '';
    HwpParser._hwpxChildren(runEl).forEach(child => {
      const name = HwpParser._hwpxLocalName(child);
      if (name === 't') {
        text += HwpParser._hwpxTElementText(child);
      } else if (name === 'lineBreak') {
        text += '\n';
      } else if (name === 'tab') {
        text += '\t';
      } else if (name === 'compose') {
        text += HwpParser._hwpxDecodeComposeChar(child);
      }
    });
    return text;
  },

  _hwpxBlocksFromContainer(container, header = {}) {
    const blocks = [];
    HwpParser._hwpxChildren(container).forEach(child => {
      const name = HwpParser._hwpxLocalName(child);
      if (name === 'p') {
        blocks.push(...HwpParser._hwpxParagraphBlocks(child, header));
      } else if (name === 'tbl') {
        blocks.push(...HwpParser._hwpxTableBlocks(child, header));
      }
    });
    return blocks;
  },

  _hwpxSectionMeta(container, header = {}) {
    const secPrEl = HwpParser._hwpxDescendant(container, 'secPr');
    const visibilityEl = HwpParser._hwpxFirstChild(secPrEl, 'visibility');
    const pagePrEl = HwpParser._hwpxFirstChild(secPrEl, 'pagePr');
    const marginEl = HwpParser._hwpxFirstChild(pagePrEl, 'margin');
    const pageNumEl = Array.from(container?.getElementsByTagName?.('*') || []).find(node => (
      HwpParser._hwpxLocalName(node) === 'pageNum'
    ));
    const newNumEl = Array.from(container?.getElementsByTagName?.('*') || []).find(node => (
      HwpParser._hwpxLocalName(node) === 'newNum' && node.getAttribute('numType') === 'PAGE'
    ));
    const pageBorderFills = HwpParser._hwpxChildren(secPrEl, 'pageBorderFill').map(borderEl => {
      const offsetEl = HwpParser._hwpxFirstChild(borderEl, 'offset');
      const borderFillId = HwpParser._hwpxAttrNum(borderEl, 'borderFillIDRef', 0);
      return {
        type: String(borderEl.getAttribute('type') || 'BOTH').toUpperCase(),
        borderFillId,
        borderStyle: header?.borderFills?.[borderFillId] || null,
        offset: {
          left: HwpParser._hwpxAttrNum(offsetEl, 'left', 0),
          right: HwpParser._hwpxAttrNum(offsetEl, 'right', 0),
          top: HwpParser._hwpxAttrNum(offsetEl, 'top', 0),
          bottom: HwpParser._hwpxAttrNum(offsetEl, 'bottom', 0),
        },
      };
    });
    return {
      visibility: visibilityEl ? Array.from(visibilityEl.attributes || []).reduce((acc, attr) => {
        acc[attr.name] = attr.value;
        return acc;
      }, {}) : {},
      pageStyle: {
        sourceFormat: 'hwpx',
        width: HwpParser._hwpxAttrNum(pagePrEl, 'width', 0),
        height: HwpParser._hwpxAttrNum(pagePrEl, 'height', 0),
        landscape: String(pagePrEl?.getAttribute?.('landscape') || '').toUpperCase(),
        margins: {
          left: HwpParser._hwpxAttrNum(marginEl, 'left', 0),
          right: HwpParser._hwpxAttrNum(marginEl, 'right', 0),
          top: HwpParser._hwpxAttrNum(marginEl, 'top', 0),
          bottom: HwpParser._hwpxAttrNum(marginEl, 'bottom', 0),
          header: HwpParser._hwpxAttrNum(marginEl, 'header', 0),
          footer: HwpParser._hwpxAttrNum(marginEl, 'footer', 0),
        },
        pageBorderFills,
      },
      pageNumber: pageNumEl ? {
        position: pageNumEl.getAttribute('pos') || '',
        formatType: pageNumEl.getAttribute('formatType') || 'DIGIT',
        sideChar: pageNumEl.getAttribute('sideChar') || '',
      } : null,
      startPageNum: Number(newNumEl?.getAttribute?.('num')) || 1,
    };
  },

  _hwpxAreaDefs(container, areaName, header = {}) {
    return Array.from(container?.getElementsByTagName?.('*') || [])
      .filter(node => HwpParser._hwpxLocalName(node) === areaName)
      .map(areaEl => {
        const subListEl = HwpParser._hwpxFirstChild(areaEl, 'subList');
        const blocks = subListEl
          ? HwpParser._hwpxBlocksFromContainer(subListEl, header)
            .filter(block => HwpParser._blockHasVisualContent(block))
          : [];
        return {
          applyPageType: String(areaEl.getAttribute('applyPageType') || 'BOTH').toUpperCase(),
          blocks,
        };
      })
      .filter(area => area.blocks.length);
  },

  _hwpxResolveAreaBlocks(areaDefs, pageIndex, hideFirst = false) {
    if (hideFirst && pageIndex === 0) return [];
    return (areaDefs || [])
      .filter(area => HwpParser._matchesPageScope(area.applyPageType, pageIndex))
      .flatMap(area => area.blocks || []);
  },

  _hwpxAreaBlocks(container, areaName, header = {}) {
    return HwpParser._hwpxResolveAreaBlocks(
      HwpParser._hwpxAreaDefs(container, areaName, header),
      0,
      false,
    );
  },

  _matchesPageScope(applyPageType, pageIndex) {
    const type = String(applyPageType || 'BOTH').toUpperCase();
    const pageNo = pageIndex + 1;
    if (type === 'EVEN') return pageNo % 2 === 0;
    if (type === 'ODD') return pageNo % 2 === 1;
    if (type === 'FIRST' || type === 'FIRST_PAGE') return pageIndex === 0;
    return true;
  },

  _parseHwpHeaderFooterApplyPageType(controlBody) {
    const MIN_CONTROL_BODY_BYTES = 8;
    const HEADER_FOOTER_SCOPE_MASK = 0x3;
    if (!controlBody || controlBody.length < MIN_CONTROL_BODY_BYTES) return 'BOTH';
    const attr = HwpParser._u32(controlBody, 4);
    const scope = attr & HEADER_FOOTER_SCOPE_MASK;
    if (scope === 1) return 'EVEN';
    if (scope === 2) return 'ODD';
    return 'BOTH';
  },

  _resolveHwpHeaderFooterBlocks(areaDefs, fallbackBlocks, pageIndex, hideFirst = false) {
    if (hideFirst && pageIndex === 0) return [];
    if (!Array.isArray(areaDefs) || !areaDefs.length) {
      return Array.isArray(fallbackBlocks) ? fallbackBlocks : [];
    }
    return areaDefs
      .filter(area => HwpParser._matchesPageScope(area.applyPageType, pageIndex))
      .flatMap(area => area.blocks || []);
  },

  _hwpxPageNumAlign(position) {
    const pos = String(position || '').toUpperCase();
    if (pos.includes('RIGHT')) return 'right';
    if (pos.includes('LEFT')) return 'left';
    return 'center';
  },

  // HWP secd tag-76: HWPTAG_PAGE_NUM_PARA — 쪽 번호 자동 배치 위치/형식
  // offset 0: DWORD attr (bits 0-3: 위치, bits 4-7: 형식)
  // offset 4: WCHAR sideChar (장식 문자, optional)
  _parseHwpPageNumMeta(body) {
    if (!body || body.length < 4) return null;
    const attr = HwpParser._u32(body, 0);
    const posCode = attr & 0xF;
    if (posCode === 0) return null; // 없음 — 쪽번호 자동배치 비활성
    const formatCode = (attr >> 4) & 0xF;
    const sideChar = body.length >= 6
      ? HwpParser._decodeHwpUtf16String(body, 4, 1).replace(/\u0000/g, '').trim()
      : '';
    // offset 6: WORD startPageNumber (일부 HWP 버전에만 존재)
    const startPageNum = body.length >= 8 ? HwpParser._u16(body, 6) : 0;
    return {
      position: HwpParser._hwpPageNumPositionCode(posCode),
      formatType: formatCode === 0 ? 'DIGIT' : 'OTHER',
      sideChar,
      startPageNum: startPageNum > 0 ? startPageNum : 1,
    };
  },

  _hwpPageNumPositionCode(code) {
    switch (code) {
      case 1:  return 'BOTTOM_LEFT';
      case 2:  return 'BOTTOM_CENTER';
      case 3:  return 'BOTTOM_RIGHT';
      case 4:  return 'TOP_LEFT';
      case 5:  return 'TOP_CENTER';
      case 6:  return 'TOP_RIGHT';
      case 7:  return 'OUTER_BOTTOM';
      case 8:  return 'INNER_BOTTOM';
      case 9:  return 'OUTER_TOP';
      case 10: return 'INNER_TOP';
      default: return 'BOTTOM_CENTER';
    }
  },

  _hwpxCreatePageNumberBlock(pageNumberMeta, pageNumber, hidden = false) {
    if (!pageNumberMeta || hidden) return null;
    if (String(pageNumberMeta.formatType || 'DIGIT').toUpperCase() !== 'DIGIT') return null;

    const sideChar = String(pageNumberMeta.sideChar || '').trim();
    const text = sideChar
      ? `${sideChar} ${pageNumber} ${sideChar}`
      : String(pageNumber);

    return {
      type: 'paragraph',
      align: HwpParser._hwpxPageNumAlign(pageNumberMeta.position),
      role: 'page-number',
      texts: [HwpParser._run(text, {
        fontSize: 10,
        fontName: 'Malgun Gothic',
        color: '#475569',
      })],
    };
  },

  _hwpxParagraphBlocks(pEl, header = {}) {
    const paraInfo = header?.paraProps?.[Number(pEl.getAttribute('paraPrIDRef') || 0)] || {};
    const paragraphLayout = HwpParser._hwpxParagraphLineMetrics(pEl);
    const blockInfo = { ...paraInfo, ...paragraphLayout };
    const align = paraInfo.align || pEl.getAttribute('align') || 'left';
    const blocks = [];
    let runBuffer = [];
    const paragraphHasText = HwpParser._hwpxParagraphHasText(pEl);

    const flushText = () => {
      const normalizedRuns = HwpParser._hwpxTrimRunBuffer(runBuffer);
      const cleaned = normalizedRuns.map(run => run.text || '').join('');
      if (cleaned.trim()) {
        const block = HwpParser._createStyledParagraphBlock(normalizedRuns, align, blockInfo);
        const primaryRun = (block.texts || []).find(run => (
          run.type !== 'image' && String(run.text || '').trim()
        )) || {};
        if (primaryRun.bold && (primaryRun.fontSize || 0) >= 18 && cleaned.length <= 60) {
          block.align = 'center';
          block.marginLeft = 0;
          block.textIndent = 0;
          block.spacingAfter = Math.max(block.spacingAfter || 0, 180);
        }
        blocks.push(block);
      }
      runBuffer = [];
    };

    HwpParser._hwpxChildren(pEl, 'run').forEach(runEl => {
      const charInfo = header?.charProps?.[Number(runEl.getAttribute('charPrIDRef') || 0)] || null;
      HwpParser._hwpxChildren(runEl).forEach(child => {
        const name = HwpParser._hwpxLocalName(child);
        if (name === 'tbl') {
          flushText();
          blocks.push(...HwpParser._hwpxTableBlocks(child, header));
        } else if (name === 'pic') {
          const imageBlock = HwpParser._hwpxPictureBlock(child, header);
          const canInlineImage = imageBlock && paragraphHasText && imageBlock.inline;
          if (canInlineImage) {
            const imageRun = HwpParser._hwpxInlineImageRun(child, header);
            if (imageRun) runBuffer.push(imageRun);
            return;
          }
          flushText();
          if (imageBlock) blocks.push(imageBlock);
        } else if (name === 't') {
          HwpParser._hwpxPushTextRun(runBuffer, HwpParser._hwpxTElementText(child), charInfo || {});
        } else if (name === 'compose') {
          // 원문자 (①②③...) - PUA 인코딩을 Unicode 원문자로 변환
          const circleChar = HwpParser._hwpxDecodeComposeChar(child);
          if (circleChar) HwpParser._hwpxPushTextRun(runBuffer, circleChar, charInfo || {});
        } else if (name === 'lineBreak') {
          HwpParser._hwpxPushTextRun(runBuffer, '\n', charInfo || {});
        } else if (name === 'tab') {
          HwpParser._hwpxPushTextRun(runBuffer, '\t', charInfo || {});
        }
      });
    });

    flushText();
    return blocks;
  },

  _hwpxTableBlocks(tblEl, header = {}) {
    const rowEls = HwpParser._hwpxChildren(tblEl, 'tr');
    const cells = [];
    const objectInfo = HwpParser._hwpxParseObjectLayout(tblEl);
    // Table-level default inner margin (used when a cell has hasMargin="0")
    const tblInMarginEl = HwpParser._hwpxFirstChild(tblEl, 'inMargin');

    rowEls.forEach((trEl, rowIndex) => {
      HwpParser._hwpxChildren(trEl, 'tc').forEach((tcEl, cellIndex) => {
        const addrEl = HwpParser._hwpxFirstChild(tcEl, 'cellAddr');
        const spanEl = HwpParser._hwpxFirstChild(tcEl, 'cellSpan');
        const sizeEl = HwpParser._hwpxFirstChild(tcEl, 'cellSz');
        // Use per-cell margin when hasMargin="1", otherwise fall back to table inMargin
        const hasOwnMargin = tcEl.getAttribute?.('hasMargin') === '1';
        const marginEl = hasOwnMargin
          ? HwpParser._hwpxFirstChild(tcEl, 'cellMargin')
          : tblInMarginEl || HwpParser._hwpxFirstChild(tcEl, 'cellMargin');
        const subListEl = HwpParser._hwpxFirstChild(tcEl, 'subList');
        const blocks = subListEl ? HwpParser._hwpxBlocksFromContainer(subListEl, header) : [];
        const contentHeight = HwpParser._hwpxAttrNum(subListEl, 'textHeight', 0);
        const contentWidth = HwpParser._hwpxAttrNum(subListEl, 'textWidth', 0);
        const cellHeight = HwpParser._hwpxAttrNum(sizeEl, 'height', 0);

        const cell = {
          paragraphCount: blocks.length,
          col: HwpParser._hwpxAttrNum(addrEl, 'colAddr', cellIndex),
          row: HwpParser._hwpxAttrNum(addrEl, 'rowAddr', rowIndex),
          colSpan: Math.max(1, HwpParser._hwpxAttrNum(spanEl, 'colSpan', 1)),
          rowSpan: Math.max(1, HwpParser._hwpxAttrNum(spanEl, 'rowSpan', 1)),
          width: HwpParser._hwpxAttrNum(sizeEl, 'width', 0),
          height: Math.max(cellHeight, contentHeight),
          contentHeight,
          contentWidth,
          verticalAlign: HwpParser._hwpxMapCellVerticalAlign(
            subListEl?.getAttribute?.('vertAlign') || tcEl?.getAttribute?.('vertAlign') || '',
          ),
          padding: [
            HwpParser._hwpxCellMarginVal(marginEl, 'left'),
            HwpParser._hwpxCellMarginVal(marginEl, 'right'),
            HwpParser._hwpxCellMarginVal(marginEl, 'top'),
            HwpParser._hwpxCellMarginVal(marginEl, 'bottom'),
          ],
          borderFillId: HwpParser._hwpxAttrNum(tcEl, 'borderFillIDRef', 0),
          borderStyle: header?.borderFills?.[HwpParser._hwpxAttrNum(tcEl, 'borderFillIDRef', 0)] || null,
          paragraphs: blocks.length ? blocks : [HwpParser._createParagraphBlock('')],
          sourceFormat: 'hwpx',
        };

        cells.push(cell);
      });
    });

    const repeatHeader = HwpParser._hwpxAttrNum(tblEl, 'repeatHeader', 0);
    const table = HwpParser._hwpxNormalizeTableMetrics(HwpParser._withObjectLayout(HwpParser._buildTableBlock({
      rowCount: Math.max(rowEls.length, HwpParser._hwpxAttrNum(tblEl, 'rowCnt', rowEls.length)),
      colCount: HwpParser._hwpxAttrNum(tblEl, 'colCnt', 0),
      cellSpacing: HwpParser._hwpxAttrNum(tblEl, 'cellSpacing', 0),
      numHeaderRows: repeatHeader > 0 ? repeatHeader : 0,
      sourceFormat: 'hwpx',
    }, cells), objectInfo));

    if (!table || !HwpParser._blockHasVisualContent(table)) {
      return [];
    }

    return [table];
  },

  _hwpxMeaningfulCells(row) {
    return (row?.cells || []).filter(cell => (
      HwpParser._cellHasVisualContent(cell)
    ));
  },

  _hwpxShouldFlattenTable(table) {
    const meaningfulRows = (table.rows || [])
      .map(row => HwpParser._hwpxMeaningfulCells(row))
      .filter(cells => cells.length);
    if (!meaningfulRows.length) return true;
    if (HwpParser._tableHasVisualStyles(table)) return false;

    return meaningfulRows.every(cells => cells.length <= 1);
  },

  _hwpxIsWideFlowCell(cell, colCount) {
    const text = HwpParser._cellText(cell).trim();
    const spanRatio = colCount > 0 ? ((cell?.colSpan || 1) / colCount) : 1;
    return spanRatio >= 0.72 || text.length >= 42 || /\n/.test(text);
  },

  _hwpxIsSectionHeadingCells(cells, colCount) {
    if (cells.length !== 2) return false;
    const first = HwpParser._cellText(cells[0]).replace(/\s+/g, '').trim();
    const second = HwpParser._cellText(cells[1]).replace(/\s+/g, ' ').trim();
    if (!first || !second) return false;

    const looksLikeOrdinal = /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/.test(first)
      || /^[0-9]+$/.test(first)
      || /^[가-힣A-Za-z]$/.test(first);
    const coveredCols = cells.reduce((sum, cell) => sum + (Number(cell.colSpan) || 1), 0);
    return looksLikeOrdinal
      && first.length <= 4
      && second.length <= 90
      && coveredCols >= Math.max(2, colCount - 1);
  },

  _hwpxShouldLinearizeTable(table) {
    if (HwpParser._tableHasVisualStyles(table)) return false;

    const meaningfulRows = (table.rows || [])
      .map(row => ({ row, cells: HwpParser._hwpxMeaningfulCells(row) }))
      .filter(entry => entry.cells.length);
    if (meaningfulRows.length < 6 || (table.colCount || 0) < 3) return false;

    let flowRows = 0;
    let headingRows = 0;
    let denseRows = 0;

    meaningfulRows.forEach(({ cells }) => {
      if (cells.length === 1 && HwpParser._hwpxIsWideFlowCell(cells[0], table.colCount || 1)) {
        flowRows += 1;
        return;
      }
      if (HwpParser._hwpxIsSectionHeadingCells(cells, table.colCount || 1)) {
        headingRows += 1;
        return;
      }
      denseRows += 1;
    });

    return denseRows <= Math.max(4, Math.floor(meaningfulRows.length * 0.2))
      && (flowRows + headingRows) >= Math.ceil(meaningfulRows.length * 0.65);
  },

  _hwpxTableToFlowBlocks(table) {
    const blocks = [];
    let pendingStart = -1;

    const flushPendingTable = (endRow) => {
      if (pendingStart < 0 || endRow <= pendingStart) return;
      const chunk = HwpParser._sliceTableBlock(table, pendingStart, endRow);
      if (chunk && HwpParser._blockText(chunk).trim()) blocks.push(chunk);
      pendingStart = -1;
    };

    (table.rows || []).forEach((row, rowIndex) => {
      const meaningfulCells = HwpParser._hwpxMeaningfulCells(row);
      if (!meaningfulCells.length) {
        flushPendingTable(rowIndex);
        return;
      }

      if (meaningfulCells.length === 1 && HwpParser._hwpxIsWideFlowCell(meaningfulCells[0], table.colCount || 1)) {
        flushPendingTable(rowIndex);
        meaningfulCells[0].paragraphs.forEach(block => {
          if (!HwpParser._blockText(block).trim()) return;
          blocks.push(cloneParagraphBlock(block));
        });
        return;
      }

      if (HwpParser._hwpxIsSectionHeadingCells(meaningfulCells, table.colCount || 1)) {
        flushPendingTable(rowIndex);
        const headingText = meaningfulCells
          .map(cell => HwpParser._cellText(cell).replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ');
        if (headingText) blocks.push(HwpParser._createParagraphBlock(headingText));
        return;
      }

      if (pendingStart < 0) pendingStart = rowIndex;
    });

    flushPendingTable((table.rows || []).length);
    return blocks;
  },

  _hwpxEstimateCellWeight(cell) {
    const blocks = cell?.paragraphs || [];
    const explicitHeight = Math.max(Number(cell?.height) || 0, Number(cell?.contentHeight) || 0);
    const heightWeight = explicitHeight > 0
      ? Math.max(1, Math.min(20, Math.round(explicitHeight / 420)))
      : 0;
    if (!blocks.length) return Math.max(1, heightWeight || 1);

    const total = blocks.reduce((sum, block) => {
      if (block.type === 'table') {
        return sum + Math.max(3, Math.min(16, (block.rowCount || 1) * 2));
      }

      const text = HwpParser._blockText(block).trim();
      if (!text) return sum;
      const lines = text.split(/\n+/).filter(Boolean);
      const charCount = lines.reduce((count, line) => count + line.length, 0);
      const wrappedLines = Math.max(lines.length, Math.ceil(charCount / 44));
      return sum + wrappedLines;
    }, 0);

    return Math.max(heightWeight, Math.max(1, Math.min(20, total || 1)));
  },

  _hwpxEstimateRowWeight(row) {
    const meaningfulCells = HwpParser._hwpxMeaningfulCells(row);
    if (!meaningfulCells.length) return 1;

    const weight = meaningfulCells.reduce((max, cell) => (
      Math.max(max, HwpParser._hwpxEstimateCellWeight(cell))
    ), 1);
    return Math.max(1, Math.min(20, weight));
  },

  _hwpxNormalizeTableMetrics(table) {
    if (!table) return table;
    table.sourceFormat = 'hwpx';
    table.hwpxRowHeights = (table.rows || []).map(row => (
      (row.cells || []).reduce((max, cell) => Math.max(
        max,
        Number(cell?.height) || 0,
        Number(cell?.contentHeight) || 0,
      ), 0)
    ));
    table.rowHeights = (table.rows || []).map(row => HwpParser._hwpxEstimateRowWeight(row));
    return table;
  },


});
