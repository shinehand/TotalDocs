/**
 * hwp-parser.js — HWP / HWPX / OWPML 파서
 * (app.js 에서 분리됨 — Chrome 확장 plain-script 로딩, type="module" 없음)
 * 의존: pako.min.js, jszip.min.js (viewer.html 에서 먼저 로드)
 */

/* ═══════════════════════════════════════════════
   HWP PARSER
═══════════════════════════════════════════════ */
const HwpParser = {

  async parse(buffer, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    await new Promise(r => setTimeout(r, 80));

    if (ext === 'hwpx' || ext === 'owpml') return HwpParser._parseHwpx(buffer);
    if (ext === 'hwp')  return await HwpParser._parseHwp5(buffer);
    throw new Error(`지원하지 않는 형식: .${ext} (.hwp / .hwpx / .owpml 만 가능)`);
  },

  /* ── HWPX ── */
  async _parseHwpx(buffer) {
    if (typeof JSZip === 'undefined') throw new Error('lib/jszip.min.js 로드 실패');
    const zip = await JSZip.loadAsync(buffer);
    const [header, images] = await Promise.all([
      HwpParser._hwpxParseHeader(zip),
      HwpParser._hwpxParseBinaryMap(zip),
    ]);
    header.images = images;
    const keys = Object.keys(zip.files)
      .filter(p => /Contents[\\/]section\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const ai = Number((a.match(/section(\d+)\.xml$/i) || [])[1] || 0);
        const bi = Number((b.match(/section(\d+)\.xml$/i) || [])[1] || 0);
        return ai - bi;
      });
    if (!keys.length) throw new Error('HWPX: section 파일 없음');

    const pages = [];
    for (let i = 0; i < keys.length; i++) {
      const xml = await zip.files[keys[i]].async('string');
      const sectionData = HwpParser._hwpxSectionData(xml, header);
      const sectionPages = HwpParser._paginate(sectionData.blocks, 46);
      const sectionMeta = sectionData.sectionMeta || {};
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
            note: '⚠️ HWPX 미리보기 텍스트 추출 (일부 도형/표 생략)',
          },
          pages: previewPages,
        };
      }
    }

    return { meta: { pages: pages.length }, pages };
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
          textIndent: HwpParser._hwpxAttrNum(HwpParser._hwpxDescendant(marginEl, 'indent'), 'value', 0),
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
          bold: Boolean(HwpParser._hwpxFirstChild(node, 'bold')),
          italic: Boolean(HwpParser._hwpxFirstChild(node, 'italic')),
          underline: (underlineEl?.getAttribute?.('type') || 'NONE') !== 'NONE',
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
    return {
      inline: posEl?.getAttribute?.('treatAsChar') === '1',
      affectLineSpacing: posEl?.getAttribute?.('affectLSpacing') === '1',
      vertRelTo: HwpParser._normalizeObjectRelTo(posEl?.getAttribute?.('vertRelTo'), 'vert'),
      vertAlign: HwpParser._normalizeObjectAlign(posEl?.getAttribute?.('vertAlign'), 'vert'),
      horzRelTo: HwpParser._normalizeObjectRelTo(posEl?.getAttribute?.('horzRelTo'), 'horz'),
      horzAlign: HwpParser._normalizeObjectAlign(posEl?.getAttribute?.('horzAlign'), 'horz'),
      vertOffset: HwpParser._hwpxAttrNum(posEl, 'vertOffset', 0),
      horzOffset: HwpParser._hwpxAttrNum(posEl, 'horzOffset', 0),
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
    const sizeEl = HwpParser._hwpxFirstChild(picEl, 'sz') || curSizeEl || orgSizeEl;
    const objectInfo = HwpParser._hwpxParseObjectLayout(picEl);
    const ref = imgEl?.getAttribute?.('binaryItemIDRef') || '';
    const src = header?.images?.[ref] || '';
    if (!src) return null;
    const width = HwpParser._hwpxAttrNum(sizeEl, 'width',
      HwpParser._hwpxAttrNum(curSizeEl, 'width', HwpParser._hwpxAttrNum(orgSizeEl, 'width', 0)));
    const height = HwpParser._hwpxAttrNum(sizeEl, 'height',
      HwpParser._hwpxAttrNum(curSizeEl, 'height', HwpParser._hwpxAttrNum(orgSizeEl, 'height', 0)));

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
        return name === 't' && Boolean((child.textContent || '').trim());
      })
    ));
  },

  _hwpxTextFromRun(runEl) {
    let text = '';
    HwpParser._hwpxChildren(runEl).forEach(child => {
      const name = HwpParser._hwpxLocalName(child);
      if (name === 't') {
        text += child.textContent || '';
      } else if (name === 'lineBreak') {
        text += '\n';
      } else if (name === 'tab') {
        text += '\t';
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
      .filter(area => HwpParser._hwpxPageTypeMatches(area.applyPageType, pageIndex))
      .flatMap(area => area.blocks || []);
  },

  _hwpxAreaBlocks(container, areaName, header = {}) {
    return HwpParser._hwpxResolveAreaBlocks(
      HwpParser._hwpxAreaDefs(container, areaName, header),
      0,
      false,
    );
  },

  _hwpxPageTypeMatches(applyPageType, pageIndex) {
    const type = String(applyPageType || 'BOTH').toUpperCase();
    const pageNo = pageIndex + 1;
    if (type === 'EVEN') return pageNo % 2 === 0;
    if (type === 'ODD') return pageNo % 2 === 1;
    if (type === 'FIRST' || type === 'FIRST_PAGE') return pageIndex === 0;
    return true;
  },

  _hwpxPageNumAlign(position) {
    const pos = String(position || '').toUpperCase();
    if (pos.includes('RIGHT')) return 'right';
    if (pos.includes('LEFT')) return 'left';
    return 'center';
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
    const align = paraInfo.align || pEl.getAttribute('align') || 'left';
    const blocks = [];
    let runBuffer = [];
    const paragraphHasText = HwpParser._hwpxParagraphHasText(pEl);

    const flushText = () => {
      const normalizedRuns = HwpParser._hwpxTrimRunBuffer(runBuffer);
      const cleaned = normalizedRuns.map(run => run.text || '').join('');
      if (cleaned.trim()) {
        const block = HwpParser._createStyledParagraphBlock(normalizedRuns, align, paraInfo);
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
          HwpParser._hwpxPushTextRun(runBuffer, child.textContent || '', charInfo || {});
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

    rowEls.forEach((trEl, rowIndex) => {
      HwpParser._hwpxChildren(trEl, 'tc').forEach((tcEl, cellIndex) => {
        const addrEl = HwpParser._hwpxFirstChild(tcEl, 'cellAddr');
        const spanEl = HwpParser._hwpxFirstChild(tcEl, 'cellSpan');
        const sizeEl = HwpParser._hwpxFirstChild(tcEl, 'cellSz');
        const marginEl = HwpParser._hwpxFirstChild(tcEl, 'cellMargin');
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
            HwpParser._hwpxAttrNum(marginEl, 'left', 0),
            HwpParser._hwpxAttrNum(marginEl, 'right', 0),
            HwpParser._hwpxAttrNum(marginEl, 'top', 0),
            HwpParser._hwpxAttrNum(marginEl, 'bottom', 0),
          ],
          borderFillId: HwpParser._hwpxAttrNum(tcEl, 'borderFillIDRef', 0),
          borderStyle: header?.borderFills?.[HwpParser._hwpxAttrNum(tcEl, 'borderFillIDRef', 0)] || null,
          paragraphs: blocks.length ? blocks : [HwpParser._createParagraphBlock('')],
          sourceFormat: 'hwpx',
        };

        cells.push(cell);
      });
    });

    const table = HwpParser._hwpxNormalizeTableMetrics(HwpParser._withObjectLayout(HwpParser._buildTableBlock({
      rowCount: Math.max(rowEls.length, HwpParser._hwpxAttrNum(tblEl, 'rowCnt', rowEls.length)),
      colCount: HwpParser._hwpxAttrNum(tblEl, 'colCnt', 0),
      cellSpacing: HwpParser._hwpxAttrNum(tblEl, 'cellSpacing', 0),
      sourceFormat: 'hwpx',
    }, cells), objectInfo));

    if (!table || !HwpParser._blockHasVisualContent(table)) {
      return [];
    }

    if (HwpParser._hwpxShouldFlattenTable(table)) {
      return HwpParser._hwpxTableToFlowBlocks(table);
    }

    if (HwpParser._hwpxShouldLinearizeTable(table)) {
      return HwpParser._hwpxTableToFlowBlocks(table);
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

  /* ════════════════════════════════════════════
     HWP 5.0 — 3단계 파싱 전략
  ════════════════════════════════════════════ */
  async _parseHwp5(buffer) {
    const b = new Uint8Array(buffer);
    const SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
    if (!SIG.every((v, i) => b[i] === v))
      throw new Error('HWP 시그니처 불일치 — 올바른 HWP 5.0 파일인지 확인하세요.');

    // 전략 0: BodyText/Section 파싱 (전체 텍스트 + 단락 구조)
    let parsedBody = null;
    try { parsedBody = await HwpParser._parseBodyText(b); }
    catch(e) { console.warn('[HWP] BodyText 파싱 실패:', e); }

    if (parsedBody?.paragraphs?.length) {
      const cleaned = [];
      let emptyRun = 0;
      for (const p of parsedBody.paragraphs) {
        const isEmpty = !HwpParser._blockText(p).trim();
        if (isEmpty) { if (++emptyRun <= 2) cleaned.push(p); }
        else { emptyRun = 0; cleaned.push(p); }
      }
      const pages = HwpParser._paginate(cleaned, 48);
      if (pages.length) {
        if (parsedBody.headerBlocks?.length) {
          pages[0].headerBlocks = parsedBody.headerBlocks.map(cloneParagraphBlock);
        }
        if (parsedBody.footerBlocks?.length) {
          pages[0].footerBlocks = parsedBody.footerBlocks.map(cloneParagraphBlock);
        }
        if (parsedBody.pageStyle) {
          pages.forEach(page => { page.pageStyle = parsedBody.pageStyle; });
        }
      }
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
    const paras = lines.map(line => HwpParser._createParagraphBlock(line));
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
    const nFat = HwpParser._u32(b, 0x2C);
    const ePS = ss / 4;
    const difat = [];
    for (let i = 0; i < 109 && difat.length < nFat; i++) {
      const sec = HwpParser._u32(b, 0x4C + i * 4);
      if (sec >= 0xFFFFFFF8) break;
      difat.push(sec);
    }

    // 일부 HWP는 csectFat(nFat)가 0인데도 헤더 DIFAT에 실제 FAT 섹터를 기록합니다.
    // 이런 문서는 헤더 DIFAT에 적힌 섹터 수를 신뢰해야 디렉터리 체인을 끝까지 읽을 수 있습니다.
    if (nFat === 0) {
      for (let i = difat.length; i < 109; i++) {
        const sec = HwpParser._u32(b, 0x4C + i * 4);
        if (sec >= 0xFFFFFFF8) break;
        difat.push(sec);
      }
    }
    const fatSectorCount = Math.max(nFat, difat.length);
    if (fatSectorCount === 0) return new Uint32Array(0);
    const fat = new Uint32Array(fatSectorCount * ePS);

    let difatSec = HwpParser._u32(b, 0x44);
    const nDifatSec = HwpParser._u32(b, 0x48);
    let difatRead = 0;
    const visited = new Set();
    while (difat.length < fatSectorCount && difatSec < 0xFFFFFFF8 && difatRead < nDifatSec && !visited.has(difatSec)) {
      visited.add(difatSec);
      const base = (difatSec + 1) * ss;
      if (base + ss > b.length) break;
      for (let i = 0; i < ePS - 1 && difat.length < fatSectorCount; i++) {
        const sec = HwpParser._u32(b, base + i * 4);
        if (sec >= 0xFFFFFFF8) continue;
        difat.push(sec);
      }
      difatSec = HwpParser._u32(b, base + (ePS - 1) * 4);
      difatRead++;
    }

    for (let i = 0; i < fatSectorCount; i++) {
      const fatSec = difat[i];
      if (fatSec == null) break;
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
    if (written === 0) return null;
    return written === streamSz ? result : result.slice(0, written);
  },

  _readMiniFat(b, ss, fat) {
    const miniFatStartSec = HwpParser._u32(b, 0x3C);
    const nMiniFatSec = HwpParser._u32(b, 0x40);
    if (nMiniFatSec === 0 || miniFatStartSec >= 0xFFFFFFFA) return new Uint32Array(0);

    const ePS = ss / 4;
    const miniFat = new Uint32Array(nMiniFatSec * ePS);
    let sec = miniFatStartSec;
    let i = 0;
    const visited = new Set();

    while (sec < 0xFFFFFFF8 && !visited.has(sec) && i < nMiniFatSec) {
      visited.add(sec);
      const base = (sec + 1) * ss;
      if (base + ss > b.length) break;
      for (let j = 0; j < ePS; j++)
        miniFat[i * ePS + j] = HwpParser._u32(b, base + j * 4);
      i++;
      sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
    }
    return miniFat;
  },

  _readStreamByMiniFat(miniStream, startSec, streamSz, miniFat) {
    if (!miniStream || startSec >= 0xFFFFFFF8 || streamSz === 0) return null;
    const MINI_SS = 64;
    const result = new Uint8Array(streamSz);
    let written = 0, sec = startSec;
    const visited = new Set();
    while (sec < 0xFFFFFFF8 && written < streamSz && !visited.has(sec)) {
      visited.add(sec);
      const off = sec * MINI_SS;
      const len = Math.min(MINI_SS, streamSz - written);
      if (off + len > miniStream.length) break;
      result.set(miniStream.subarray(off, off + len), written);
      written += len;
      sec = (miniFat[sec] ?? 0xFFFFFFFE) >>> 0;
    }
    if (written === 0) return null;
    return written === streamSz ? result : result.slice(0, written);
  },

  _scanDirEntries(b, names, ss, fat, dirStartSec) {
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
        const nl = HwpParser._u16(b, pos + 64);
        for (const { name, pat, nameLen } of queries) {
          if (found.has(name)) continue;
          if (nl !== nameLen) continue;
          let ok = true;
          for (let k = 0; k < pat.length; k++) {
            if (b[pos + k] !== pat[k]) { ok = false; break; }
          }
          if (ok) {
            result[name] = {
              startSec: HwpParser._u32(b, pos + 116),
              streamSz: HwpParser._u32(b, pos + 120),
            };
            found.add(name);
          }
        }
      }

      if (found.size === queries.length) break;
      sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
    }
    return result;
  },

  _scanAllDirEntries(b, ss, fat, dirStartSec) {
    const result = {};
    if (dirStartSec >= 0xFFFFFFFA) return result;

    let sec = dirStartSec;
    const visited = new Set();
    while (sec < 0xFFFFFFF8 && !visited.has(sec)) {
      visited.add(sec);
      const base = (sec + 1) * ss;
      if (base + ss > b.length) break;

      for (let pos = base; pos + 128 <= base + ss; pos += 128) {
        const nl = HwpParser._u16(b, pos + 64);
        if (!nl) continue;
        const name = new TextDecoder('utf-16le')
          .decode(b.slice(pos, pos + Math.max(0, nl - 2)))
          .replace(/\u0000/g, '');
        if (!name) continue;
        result[name] = {
          startSec: HwpParser._u32(b, pos + 116),
          streamSz: HwpParser._u32(b, pos + 120),
        };
      }

      sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
    }
    return result;
  },

  _readEntryStream(b, entry, ss, fat, miniCutoff, miniStream, miniFat) {
    if (!entry) return null;
    const { startSec, streamSz } = entry;
    if (streamSz < miniCutoff && miniStream) {
      return HwpParser._readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    }
    return HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
  },

  _bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  },

  _detectImageMime(bytes, filename = '') {
    if (!bytes?.length) return '';
    const ext = String(filename).split('.').pop().toLowerCase();
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'image/webp';
    }
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'webp') return 'image/webp';
    return '';
  },

  async _parseHwpBinaryMap(b, allEntries, ss, fat, miniCutoff, miniStream, miniFat) {
    const binEntries = Object.entries(allEntries || {})
      .filter(([name]) => /^BIN\d+\./i.test(name))
      .sort((a, b) => {
        const ai = Number((a[0].match(/^BIN(\d+)/i) || [])[1] || 0);
        const bi = Number((b[0].match(/^BIN(\d+)/i) || [])[1] || 0);
        return ai - bi;
      });

    const images = {};
    const ordered = [];
    const byId = {};
    const allById = {};

    for (const [name, entry] of binEntries) {
      const numericId = Number((name.match(/^BIN(\d+)/i) || [])[1] || 0);
      const baseEntry = {
        id: numericId,
        name,
        size: Number(entry?.streamSz) || 0,
      };
      if (numericId > 0) {
        allById[numericId] = baseEntry;
      }

      if (!/\.(png|jpe?g|gif|bmp|webp)$/i.test(name)) continue;

      let bytes = HwpParser._readEntryStream(b, entry, ss, fat, miniCutoff, miniStream, miniFat);
      if (!bytes?.length) continue;

      let mime = HwpParser._detectImageMime(bytes, name);
      if (!mime) {
        try {
          bytes = await HwpParser._decompressZlib(bytes);
          mime = HwpParser._detectImageMime(bytes, name);
        } catch {}
      }
      if (!mime) continue;

      const src = `data:${mime};base64,${HwpParser._bytesToBase64(bytes)}`;
      const imageEntry = { ...baseEntry, src, mime };
      images[name] = src;
      ordered.push(imageEntry);
      if (numericId > 0) {
        byId[numericId] = imageEntry;
        allById[numericId] = imageEntry;
      }
    }

    return { images, ordered, byId, allById };
  },

  _hwpRotl8(value, shift) {
    return ((value << shift) | (value >> (8 - shift))) & 0xFF;
  },

  _hwpGfMul(a, b) {
    let aa = a & 0xFF;
    let bb = b & 0xFF;
    let out = 0;
    while (bb > 0) {
      if (bb & 1) out ^= aa;
      aa = (aa << 1) ^ ((aa & 0x80) ? 0x11B : 0);
      aa &= 0xFF;
      bb >>= 1;
    }
    return out & 0xFF;
  },

  _hwpGfPow(base, exponent) {
    let out = 1;
    let value = base & 0xFF;
    let exp = exponent >>> 0;
    while (exp > 0) {
      if (exp & 1) out = HwpParser._hwpGfMul(out, value);
      value = HwpParser._hwpGfMul(value, value);
      exp >>>= 1;
    }
    return out & 0xFF;
  },

  _hwpAesTables() {
    if (HwpParser.__hwpAesTables) return HwpParser.__hwpAesTables;

    const sbox = new Uint8Array(256);
    const invSbox = new Uint8Array(256);
    const rcon = new Uint8Array(10);

    let r = 1;
    for (let i = 0; i < rcon.length; i++) {
      rcon[i] = r;
      r = HwpParser._hwpGfMul(r, 2);
    }

    for (let i = 0; i < 256; i++) {
      const inv = i === 0 ? 0 : HwpParser._hwpGfPow(i, 254);
      const value = (
        inv
        ^ HwpParser._hwpRotl8(inv, 1)
        ^ HwpParser._hwpRotl8(inv, 2)
        ^ HwpParser._hwpRotl8(inv, 3)
        ^ HwpParser._hwpRotl8(inv, 4)
        ^ 0x63
      ) & 0xFF;
      sbox[i] = value;
      invSbox[value] = i;
    }

    HwpParser.__hwpAesTables = { sbox, invSbox, rcon };
    return HwpParser.__hwpAesTables;
  },

  _hwpAesExpandKey(keyBytes) {
    const key = keyBytes instanceof Uint8Array ? keyBytes : new Uint8Array(keyBytes || []);
    if (key.length !== 16) {
      throw new Error('AES-128 키 길이가 올바르지 않습니다.');
    }

    const { sbox, rcon } = HwpParser._hwpAesTables();
    const expanded = new Uint8Array(176);
    expanded.set(key);

    let generated = 16;
    let rconIndex = 0;
    const temp = new Uint8Array(4);

    while (generated < expanded.length) {
      temp.set(expanded.slice(generated - 4, generated));
      if (generated % 16 === 0) {
        const first = temp[0];
        temp[0] = sbox[temp[1]] ^ rcon[rconIndex++];
        temp[1] = sbox[temp[2]];
        temp[2] = sbox[temp[3]];
        temp[3] = sbox[first];
      }
      for (let i = 0; i < 4; i++) {
        expanded[generated] = expanded[generated - 16] ^ temp[i];
        generated += 1;
      }
    }

    return expanded;
  },

  _hwpAesAddRoundKey(state, roundKeys, offset) {
    for (let i = 0; i < 16; i++) {
      state[i] ^= roundKeys[offset + i];
    }
  },

  _hwpAesInvShiftRows(state) {
    const copy = state.slice();
    state[0] = copy[0];   state[4] = copy[4];   state[8] = copy[8];   state[12] = copy[12];
    state[1] = copy[13];  state[5] = copy[1];   state[9] = copy[5];   state[13] = copy[9];
    state[2] = copy[10];  state[6] = copy[14];  state[10] = copy[2];  state[14] = copy[6];
    state[3] = copy[7];   state[7] = copy[11];  state[11] = copy[15]; state[15] = copy[3];
  },

  _hwpAesInvSubBytes(state, invSbox) {
    for (let i = 0; i < 16; i++) {
      state[i] = invSbox[state[i]];
    }
  },

  _hwpAesInvMixColumns(state) {
    for (let col = 0; col < 4; col++) {
      const offset = col * 4;
      const s0 = state[offset];
      const s1 = state[offset + 1];
      const s2 = state[offset + 2];
      const s3 = state[offset + 3];
      state[offset] = (
        HwpParser._hwpGfMul(s0, 14)
        ^ HwpParser._hwpGfMul(s1, 11)
        ^ HwpParser._hwpGfMul(s2, 13)
        ^ HwpParser._hwpGfMul(s3, 9)
      ) & 0xFF;
      state[offset + 1] = (
        HwpParser._hwpGfMul(s0, 9)
        ^ HwpParser._hwpGfMul(s1, 14)
        ^ HwpParser._hwpGfMul(s2, 11)
        ^ HwpParser._hwpGfMul(s3, 13)
      ) & 0xFF;
      state[offset + 2] = (
        HwpParser._hwpGfMul(s0, 13)
        ^ HwpParser._hwpGfMul(s1, 9)
        ^ HwpParser._hwpGfMul(s2, 14)
        ^ HwpParser._hwpGfMul(s3, 11)
      ) & 0xFF;
      state[offset + 3] = (
        HwpParser._hwpGfMul(s0, 11)
        ^ HwpParser._hwpGfMul(s1, 13)
        ^ HwpParser._hwpGfMul(s2, 9)
        ^ HwpParser._hwpGfMul(s3, 14)
      ) & 0xFF;
    }
  },

  _hwpAesDecryptBlock(block, expandedKey) {
    const { invSbox } = HwpParser._hwpAesTables();
    const state = new Uint8Array(block);

    HwpParser._hwpAesAddRoundKey(state, expandedKey, 160);
    for (let round = 9; round >= 1; round--) {
      HwpParser._hwpAesInvShiftRows(state);
      HwpParser._hwpAesInvSubBytes(state, invSbox);
      HwpParser._hwpAesAddRoundKey(state, expandedKey, round * 16);
      HwpParser._hwpAesInvMixColumns(state);
    }
    HwpParser._hwpAesInvShiftRows(state);
    HwpParser._hwpAesInvSubBytes(state, invSbox);
    HwpParser._hwpAesAddRoundKey(state, expandedKey, 0);
    return state;
  },

  _hwpAesEcbDecrypt(data, keyBytes) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    const expandedKey = HwpParser._hwpAesExpandKey(keyBytes);
    const alignedLength = bytes.length - (bytes.length % 16);
    const out = new Uint8Array(bytes.length);

    for (let offset = 0; offset < alignedLength; offset += 16) {
      const block = HwpParser._hwpAesDecryptBlock(bytes.slice(offset, offset + 16), expandedKey);
      out.set(block, offset);
    }
    if (alignedLength < bytes.length) {
      out.set(bytes.slice(alignedLength), alignedLength);
    }
    return out;
  },

  _hwpBuildDistributeRandomBytes(seed) {
    const out = new Uint8Array(256);
    let written = 0;
    let state = seed >>> 0;
    const nextRand = () => {
      state = (Math.imul(state, 214013) + 2531011) >>> 0;
      return (state >>> 16) & 0x7FFF;
    };

    while (written < out.length) {
      const value = nextRand() & 0xFF;
      const repeat = (nextRand() & 0x0F) + 1;
      for (let i = 0; i < repeat && written < out.length; i++) {
        out[written++] = value;
      }
    }
    return out;
  },

  _extractHwpDistributeKeyData(distributeBody) {
    if (!distributeBody || distributeBody.length < 256) return null;
    const seed = HwpParser._u32(distributeBody, 0);
    const randomBytes = HwpParser._hwpBuildDistributeRandomBytes(seed);
    const merged = new Uint8Array(256);
    for (let i = 0; i < merged.length; i++) {
      merged[i] = randomBytes[i] ^ distributeBody[i];
    }
    const offset = (seed & 0x0F) + 4;
    if (offset + 82 > merged.length) return null;
    const hashBytes = merged.slice(offset, offset + 80);
    return {
      seed,
      offset,
      hashBytes,
      aesKey: hashBytes.slice(0, 16),
      optionFlags: HwpParser._u16(merged, offset + 80),
    };
  },

  _unwrapHwpDistributedStream(data) {
    const rec = HwpParser._readRecord(data, 0);
    if (!rec || rec.tagId !== 28 || rec.body.length < 256) return null;
    const keyData = HwpParser._extractHwpDistributeKeyData(rec.body);
    if (!keyData?.aesKey?.length) return null;
    const payload = data.slice(rec.nextPos);
    return {
      bytes: HwpParser._hwpAesEcbDecrypt(payload, keyData.aesKey),
      optionFlags: keyData.optionFlags,
      keyData,
    };
  },

  async _buildHwpRecordAttempts(data, options = {}) {
    const { compressedHint = false, distributedHint = false } = options || {};
    const attempts = [];
    const seen = new Set();
    const pushAttempt = (mode, bytes) => {
      if (!bytes || bytes.length === 0) return;
      const signature = `${bytes.length}:${Array.from(bytes.slice(0, 16)).join(',')}`;
      if (seen.has(signature)) return;
      seen.add(signature);
      attempts.push({ mode, bytes });
    };

    const tryInflate = async (label, bytes) => {
      try {
        pushAttempt(label, await HwpParser._decompressZlib(bytes));
      } catch {}
    };

    pushAttempt('raw', data);
    if (compressedHint) {
      await tryInflate('deflated', data);
    } else {
      await tryInflate('deflated', data);
    }

    if (distributedHint) {
      const rawDistributed = HwpParser._unwrapHwpDistributedStream(data);
      if (rawDistributed?.bytes?.length) {
        pushAttempt('distributed', rawDistributed.bytes);
        await tryInflate('distributed+deflated', rawDistributed.bytes);
      }

      try {
        const deflated = await HwpParser._decompressZlib(data);
        const deflatedDistributed = HwpParser._unwrapHwpDistributedStream(deflated);
        if (deflatedDistributed?.bytes?.length) {
          pushAttempt('deflated+distributed', deflatedDistributed.bytes);
        }
      } catch {}
    }

    return attempts;
  },

  /* ── zlib 압축 해제 ── */
  async _decompressZlib(data) {
    if (typeof pako !== 'undefined') {
      try {
        return pako.inflateRaw(data);
      } catch (rawErr) {
        try {
          return pako.inflate(data);
        } catch (wrappedErr) {
          throw new Error(`zlib 압축 해제 실패: ${rawErr?.message || wrappedErr?.message || wrappedErr || rawErr}`);
        }
      }
    }

    if (typeof DecompressionStream === 'undefined') {
      throw new Error('압축 해제 라이브러리를 찾을 수 없습니다.');
    }

    const timeoutMs = 8000;
    let lastError = null;
    for (const mode of ['deflate', 'deflate-raw']) {
      let timeoutId = null;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`zlib 압축 해제 시간 초과 (${Math.floor(timeoutMs / 1000)}초)`)), timeoutMs);
      });

      try {
        const ds = new DecompressionStream(mode);
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        const chunks = [];

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
      }
    }

    throw new Error(`zlib 압축 해제 실패: ${lastError?.message || 'unknown error'}`);
  },

  _isInlineOrExtendedControl(ch) {
    return (
      ch === 0x0001 ||
      ch === 0x0002 ||
      (ch >= 0x0003 && ch <= 0x0009) ||
      (ch >= 0x000B && ch <= 0x0017)
    );
  },

  _decodeParaText(data, start, end) {
    const chars = [];
    let i = start;

    while (i + 2 <= end) {
      const ch = data[i] | (data[i + 1] << 8);

      if (ch === 0x000D) {
        i += 2;
        break;
      }

      if (ch === 0x0009) {
        chars.push('\t');
        i += 16;
        continue;
      }

      if (ch === 0x000A) {
        chars.push('\n');
        i += 2;
        continue;
      }

      if (ch === 0x0018) {
        chars.push('-');
        i += 2;
        continue;
      }

      if (ch === 0x001E || ch === 0x001F) {
        chars.push(' ');
        i += 2;
        continue;
      }

      if (HwpParser._isInlineOrExtendedControl(ch)) {
        i += 16;
        continue;
      }

      if (ch >= 0x0020) chars.push(String.fromCharCode(ch));
      i += 2;
    }

    return chars.join('');
  },

  _hwpBorderTypeName(typeId) {
    switch (Number(typeId)) {
      case 0: return 'SOLID';
      case 1: return 'LONG_DASH';
      case 2: return 'DOT';
      case 3: return 'DASH_DOT';
      case 4: return 'DASH_DOT_DOT';
      case 5: return 'LONG_DASH';
      case 6: return 'DOT';
      case 7:
      case 8:
      case 9:
      case 10:
        return 'DOUBLE';
      case 11:
      case 12:
      case 13:
      case 14:
      case 15:
      case 16:
        return 'SOLID';
      default:
        return 'NONE';
    }
  },

  _hwpBorderWidthMm(widthId) {
    const widths = [
      0.1, 0.12, 0.15, 0.2,
      0.25, 0.3, 0.4, 0.5,
      0.6, 0.7, 1.0, 1.5,
      2.0, 3.0, 4.0, 5.0,
    ];
    return widths[Number(widthId)] || 0.1;
  },

  _hwpColorRefToCss(value) {
    const color = Number(value);
    if (!Number.isFinite(color)) return '';
    const r = color & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = (color >> 16) & 0xFF;
    return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  },

  _parseHwpFillInfo(body, offset = 32) {
    if (!body || offset + 4 > body.length) {
      return { fillColor: '', fillGradient: null };
    }

    const fillType = HwpParser._u32(body, offset);
    let pos = offset + 4;
    let fillColor = '';
    let fillGradient = null;

    if ((fillType & 0x00000001) && pos + 12 <= body.length) {
      fillColor = HwpParser._hwpColorRefToCss(HwpParser._u32(body, pos));
      pos += 12;
    }

    if ((fillType & 0x00000004) && pos + 12 <= body.length) {
      const angle = HwpParser._i16(body, pos + 2);
      const colorCount = Math.max(0, HwpParser._u16(body, pos + 10));
      pos += 12;

      if (colorCount > 2 && pos + (colorCount * 4) <= body.length) {
        pos += colorCount * 4;
      }

      const colors = [];
      for (let i = 0; i < colorCount && pos + 4 <= body.length; i++, pos += 4) {
        const color = HwpParser._hwpColorRefToCss(HwpParser._u32(body, pos));
        if (color) colors.push(color);
      }

      if (colors.length >= 2) {
        fillGradient = { type: 'LINEAR', angle, colors };
      } else if (!fillColor && colors[0]) {
        fillColor = colors[0];
      }
    }

    return { fillColor, fillGradient };
  },

  _parseHwpBorderFill(body) {
    if (!body || body.length < 32) return null;

    const lineTypes = [body[2], body[3], body[4], body[5]];
    const lineWidths = [body[6], body[7], body[8], body[9]];
    const lineColors = [
      HwpParser._u32(body, 10),
      HwpParser._u32(body, 14),
      HwpParser._u32(body, 18),
      HwpParser._u32(body, 22),
    ];
    const fill = HwpParser._parseHwpFillInfo(body, 32);
    const toBorder = index => ({
      type: HwpParser._hwpBorderTypeName(lineTypes[index]),
      widthMm: HwpParser._hwpBorderWidthMm(lineWidths[index]),
      color: HwpParser._hwpColorRefToCss(lineColors[index]),
    });

    return {
      left: toBorder(0),
      right: toBorder(1),
      top: toBorder(2),
      bottom: toBorder(3),
      fillColor: fill.fillColor,
      fillGradient: fill.fillGradient,
    };
  },

  _parseHwpFaceName(body) {
    if (!body || body.length < 3) return '';
    const nameLength = HwpParser._u16(body, 1);
    if (!nameLength) return '';
    const end = Math.min(body.length, 3 + (nameLength * 2));
    return new TextDecoder('utf-16le')
      .decode(body.slice(3, end))
      .replace(/\u0000/g, '')
      .trim();
  },

  _parseHwpCharShape(body, faceNames = {}) {
    if (!body || body.length < 56) return null;
    const attr = HwpParser._u32(body, 46);
    const faceId = HwpParser._u16(body, 0);
    const scaleX = body[14] ?? 100;
    const letterSpacing = (body[21] ?? 0) << 24 >> 24;
    const relSize = body[28] ?? 100;
    const offsetY = (body[35] ?? 0) << 24 >> 24;
    const fontSizeRaw = HwpParser._u32(body, 42);
    return {
      fontName: faceNames[faceId] || '',
      fontSize: fontSizeRaw > 0 ? Math.round((fontSizeRaw / 100) * 10) / 10 : 0,
      color: HwpParser._hwpColorRefToCss(HwpParser._u32(body, 52)),
      bold: Boolean(attr & (1 << 1)),
      italic: Boolean(attr & 1),
      underline: ((attr >> 2) & 0x3) !== 0,
      scaleX,
      letterSpacing,
      relSize,
      offsetY,
    };
  },

  _hwpAlignFromAttr(attr) {
    switch ((Number(attr) >> 2) & 0x7) {
      case 0: return 'justify';
      case 1: return 'left';
      case 2: return 'right';
      case 3: return 'center';
      case 4:
      case 5:
        return 'justify';
      default:
        return 'left';
    }
  },

  _normalizeLineSpacingType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (['percent', 'percentage', 'ratio', 'char', 'chars', 'character', 'relative'].includes(raw)) return 'percent';
    if (['fixed', 'fixed-value', 'fixedvalue'].includes(raw)) return 'fixed';
    if (['space-only', 'spaceonly', 'margin', 'margins-only', 'betweenlines', 'between-lines', 'only-margin'].includes(raw)) return 'space-only';
    if (['minimum', 'minimum-value', 'minimumvalue', 'at-least', 'at_least', 'min'].includes(raw)) return 'minimum';
    return raw;
  },

  _hwpLineSpacingTypeFromCode(code) {
    switch (Number(code)) {
      case 0: return 'percent';
      case 1: return 'fixed';
      case 2: return 'space-only';
      case 3: return 'minimum';
      default: return '';
    }
  },

  _parseHwpParaShape(body) {
    if (!body || body.length < 26) return null;
    const attr = HwpParser._u32(body, 0);
    const modernAttr = body.length >= 46 ? HwpParser._u32(body, 42) : 0;
    const modernLineSpacing = body.length >= 54 ? HwpParser._u32(body, 50) : 0;
    const legacyLineSpacing = body.length >= 28 ? HwpParser._u32(body, 24) : 0;
    return {
      align: HwpParser._hwpAlignFromAttr(attr),
      marginLeft: HwpParser._i32(body, 4),
      marginRight: HwpParser._i32(body, 8),
      textIndent: HwpParser._i32(body, 12),
      spacingBefore: HwpParser._i32(body, 16),
      spacingAfter: HwpParser._i32(body, 20),
      tabDefId: body.length >= 30 ? HwpParser._u16(body, 28) : 0,
      paraHeadId: body.length >= 32 ? HwpParser._u16(body, 30) : 0,
      borderFillId: body.length >= 34 ? HwpParser._u16(body, 32) : 0,
      headShapeType: ['none', 'outline', 'number', 'bullet'][(attr >> 23) & 0x3] || 'none',
      headShapeLevel: Math.max(1, ((attr >> 25) & 0x7) + 1),
      lineSpacingType: modernLineSpacing
        ? HwpParser._hwpLineSpacingTypeFromCode(modernAttr & 0x1F)
        : HwpParser._hwpLineSpacingTypeFromCode(attr & 0x3),
      lineSpacing: modernLineSpacing || legacyLineSpacing || 0,
    };
  },

  _parseHwpTabDef(body) {
    if (!body || body.length < 6) return null;
    const attr = HwpParser._u32(body, 0);
    const count = Math.max(0, HwpParser._i16(body, 4));
    const tabs = [];
    let offset = 6;
    for (let i = 0; i < count && offset + 8 <= body.length; i++, offset += 8) {
      tabs.push({
        position: HwpParser._i32(body, offset),
        kind: ['left', 'right', 'center', 'decimal'][body[offset + 4] || 0] || 'left',
        leader: body[offset + 5] || 0,
      });
    }
    return {
      attr,
      autoLeftTab: Boolean(attr & 1),
      autoRightTab: Boolean(attr & (1 << 1)),
      tabs,
    };
  },

  _parseHwpNumbering(body) {
    if (!body || body.length < 10) return null;
    let offset = 8;
    const formats = [];
    for (let i = 0; i < 7 && offset + 2 <= body.length; i++) {
      const len = HwpParser._u16(body, offset);
      offset += 2;
      formats.push(HwpParser._decodeHwpUtf16String(body, offset, len));
      offset += len * 2;
    }
    const start = offset + 2 <= body.length ? HwpParser._u16(body, offset) : 1;
    if (offset + 2 <= body.length) offset += 2;
    const starts = [];
    for (let i = 0; i < 7 && offset + 4 <= body.length; i++, offset += 4) {
      starts.push(HwpParser._u32(body, offset));
    }
    return {
      formats,
      start,
      starts,
    };
  },

  _parseHwpBullet(body) {
    if (!body || body.length < 10) return null;
    return {
      bulletChar: HwpParser._decodeHwpUtf16String(body, 8, 1) || '•',
      imageBulletId: body.length >= 14 ? HwpParser._i32(body, 10) : 0,
      checkBulletChar: body.length >= 20 ? HwpParser._decodeHwpUtf16String(body, 18, 1) : '',
    };
  },

  _parseHwpStyle(body) {
    if (!body || body.length < 12) return null;
    let offset = 0;
    const localNameLen = HwpParser._u16(body, offset);
    offset += 2;
    const name = HwpParser._decodeHwpUtf16String(body, offset, localNameLen);
    offset += localNameLen * 2;
    const hasEnglishNameLen = offset + 2 <= body.length;
    const enNameLen = hasEnglishNameLen ? HwpParser._u16(body, offset) : 0;
    offset += hasEnglishNameLen ? 2 : 0;
    const englishName = HwpParser._decodeHwpUtf16String(body, offset, enNameLen);
    offset += enNameLen * 2;
    const attr = body[offset] || 0;
    offset += 1;
    const nextStyleId = body[offset] || 0;
    offset += 1;
    const hasLangId = offset + 2 <= body.length;
    const langId = hasLangId ? HwpParser._i16(body, offset) : 0;
    offset += hasLangId ? 2 : 0;
    const hasParaShapeId = offset + 2 <= body.length;
    const paraShapeId = hasParaShapeId ? HwpParser._u16(body, offset) : 0;
    offset += hasParaShapeId ? 2 : 0;
    const charShapeId = offset + 2 <= body.length ? HwpParser._u16(body, offset) : 0;
    return {
      name,
      englishName,
      attr,
      kind: (attr & 0x7) === 1 ? 'character' : 'paragraph',
      nextStyleId,
      langId,
      paraShapeId,
      charShapeId,
    };
  },

  _resolveHwpDocInfoRef(collection, id, allowPlusOne = false) {
    const key = Number(id);
    if (!collection || !Number.isFinite(key) || key < 0) return null;
    if (collection[key]) return collection[key];
    if (allowPlusOne && collection[key + 1]) return collection[key + 1];
    return null;
  },

  _resolveHwpParagraphStyle(paraState = {}, docInfo = null) {
    const style = HwpParser._resolveHwpDocInfoRef(docInfo?.styles, paraState?.styleId, true);
    const styleParaShape = HwpParser._resolveHwpDocInfoRef(docInfo?.paraShapes, style?.paraShapeId, true);
    const directParaShape = HwpParser._resolveHwpDocInfoRef(docInfo?.paraShapes, paraState?.paraShapeId, false);
    return {
      style,
      paraStyle: {
        ...(styleParaShape || {}),
        ...(directParaShape || {}),
      },
      baseCharStyle: HwpParser._resolveHwpDocInfoRef(docInfo?.charShapes, style?.charShapeId, true) || {},
    };
  },

  _resolveHwpParagraphListInfo(paraStyle = {}, docInfo = null) {
    const kind = paraStyle?.headShapeType || 'none';
    const level = Math.max(1, Number(paraStyle?.headShapeLevel) || 1);
    const listId = Number(paraStyle?.paraHeadId) || 0;
    if (kind === 'bullet') {
      const bullet = HwpParser._resolveHwpDocInfoRef(docInfo?.bullets, listId, true);
      return {
        kind,
        level,
        listId,
        marker: bullet?.bulletChar || bullet?.checkBulletChar || '•',
      };
    }
    if (kind === 'number') {
      const numbering = HwpParser._resolveHwpDocInfoRef(docInfo?.numberings, listId, true);
      return {
        kind,
        level,
        listId,
        format: numbering?.formats?.[level - 1] || numbering?.formats?.[0] || '',
        start: numbering?.starts?.[level - 1] || numbering?.start || 1,
      };
    }
    return null;
  },

  _parseHwpParaHeader(body) {
    if (!body || body.length < 18) {
      return { paraShapeId: 0, charShapes: [] };
    }
    return {
      paraShapeId: HwpParser._u16(body, 8),
      styleId: body[10] ?? 0,
      splitFlags: body[11] ?? 0,
      charShapeCount: HwpParser._u16(body, 12),
      charShapes: [],
    };
  },

  _parseHwpParaCharShape(body) {
    const ranges = [];
    if (!body || body.length < 8) return ranges;

    for (let offset = 0; offset + 8 <= body.length; offset += 8) {
      ranges.push({
        start: HwpParser._u32(body, offset),
        charShapeId: HwpParser._u32(body, offset + 4),
      });
    }

    return ranges;
  },

  _parseHwpParaLineSeg(body) {
    const segments = [];
    if (!body || body.length < 36) return segments;

    for (let offset = 0; offset + 36 <= body.length; offset += 36) {
      const height = HwpParser._i32(body, offset + 8);
      const textHeight = HwpParser._i32(body, offset + 12);
      const lineSpacing = HwpParser._i32(body, offset + 20);
      if (height <= 0 && textHeight <= 0) continue;
      segments.push({
        height,
        textHeight,
        lineSpacing,
      });
    }

    return segments;
  },

  _hwpCellVerticalAlign(listFlags) {
    switch ((Number(listFlags) >> 5) & 0x3) {
      case 1: return 'middle';
      case 2: return 'bottom';
      default: return 'top';
    }
  },

  _summarizeHwpLineSegs(lineSegs = []) {
    const saneSegs = lineSegs.filter(seg => {
      const height = Math.max(Number(seg?.height) || 0, Number(seg?.textHeight) || 0);
      return height >= 400 && height <= 6000;
    });
    if (!saneSegs.length) {
      return { lineHeightPx: 0, layoutHeightPx: 0 };
    }

    const heights = saneSegs.map(seg => Math.max(Number(seg.height) || 0, Number(seg.textHeight) || 0));
    const totalHeight = heights.reduce((sum, value) => sum + value, 0);
    const avgHeight = totalHeight / heights.length;
    // HWPUNIT (1/7200 inch) → px at 96 DPI: 1/75 scale
    return {
      lineHeightPx: Math.max(11, Math.min(56, Math.round(avgHeight / 75))),
      layoutHeightPx: Math.max(12, Math.min(320, Math.round(totalHeight / 75))),
    };
  },

  _buildHwpTextRuns(text, charShapes = [], docInfo = null, baseStyle = {}) {
    const sourceText = String(text || '');
    const normalizedRanges = Array.isArray(charShapes)
      ? charShapes
        .filter(range => Number.isFinite(range?.start) && Number.isFinite(range?.charShapeId))
        .sort((a, b) => a.start - b.start)
      : [];

    if (!normalizedRanges.length) {
      return [HwpParser._run(sourceText, baseStyle)];
    }

    if (normalizedRanges[0].start !== 0) {
      normalizedRanges.unshift({
        start: 0,
        charShapeId: normalizedRanges[0].charShapeId,
      });
    }

    const runs = [];
    for (let i = 0; i < normalizedRanges.length; i++) {
      const current = normalizedRanges[i];
      const nextStart = i + 1 < normalizedRanges.length
        ? normalizedRanges[i + 1].start
        : sourceText.length;
      const safeStart = Math.max(0, Math.min(sourceText.length, current.start));
      const safeEnd = Math.max(safeStart, Math.min(sourceText.length, nextStart));
      const runText = sourceText.slice(safeStart, safeEnd);
      if (!runText && sourceText.length) continue;
      runs.push(HwpParser._run(runText, {
        ...baseStyle,
        ...(docInfo?.charShapes?.[current.charShapeId] || {}),
      }));
    }

    return runs.length ? runs : [HwpParser._run(sourceText, baseStyle)];
  },

  _createHwpParagraphBlock(text, paraState = {}, docInfo = null) {
    const { style, paraStyle, baseCharStyle } = HwpParser._resolveHwpParagraphStyle(paraState, docInfo);
    const lineMetrics = HwpParser._summarizeHwpLineSegs(paraState?.lineSegs || []);
    return {
      type: 'paragraph',
      align: paraStyle?.align || 'left',
      marginLeft: paraStyle?.marginLeft ?? 0,
      marginRight: paraStyle?.marginRight ?? 0,
      textIndent: paraStyle?.textIndent ?? 0,
      spacingBefore: paraStyle?.spacingBefore ?? 0,
      spacingAfter: paraStyle?.spacingAfter ?? 0,
      lineSpacingType: paraStyle?.lineSpacingType || '',
      lineSpacing: paraStyle?.lineSpacing ?? 0,
      styleId: paraState?.styleId ?? 0,
      styleName: style?.name || style?.englishName || '',
      tabDefId: paraStyle?.tabDefId ?? 0,
      listInfo: HwpParser._resolveHwpParagraphListInfo(paraStyle, docInfo),
      lineHeightPx: lineMetrics.lineHeightPx,
      layoutHeightPx: lineMetrics.layoutHeightPx,
      texts: HwpParser._buildHwpTextRuns(text, paraState?.charShapes || [], docInfo, baseCharStyle),
    };
  },

  _parseHwpDocInfoRecords(data) {
    const faceNames = {};
    const borderFills = {};
    const charShapes = {};
    const tabDefs = {};
    const numberings = {};
    const bullets = {};
    const paraShapes = {};
    const styles = {};
    let faceNameId = 1;
    let borderFillId = 1;
    let charShapeId = 1;
    let tabDefId = 1;
    let numberingId = 1;
    let bulletId = 1;
    let paraShapeId = 1;
    let styleId = 1;
    let pos = 0;

    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (rec.tagId === 19) {
        const faceName = HwpParser._parseHwpFaceName(rec.body);
        if (faceName) {
          faceNames[faceNameId] = faceName;
        }
        faceNameId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 20) {
        const borderFill = HwpParser._parseHwpBorderFill(rec.body);
        if (borderFill) {
          borderFills[borderFillId] = borderFill;
        }
        borderFillId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 21) {
        const charShape = HwpParser._parseHwpCharShape(rec.body, faceNames);
        if (charShape) {
          charShapes[charShapeId] = charShape;
        }
        charShapeId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 22) {
        const tabDef = HwpParser._parseHwpTabDef(rec.body);
        if (tabDef) {
          tabDefs[tabDefId] = tabDef;
        }
        tabDefId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 23) {
        const numbering = HwpParser._parseHwpNumbering(rec.body);
        if (numbering) {
          numberings[numberingId] = numbering;
        }
        numberingId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 24) {
        const bullet = HwpParser._parseHwpBullet(rec.body);
        if (bullet) {
          bullets[bulletId] = bullet;
        }
        bulletId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 25) {
        const paraShape = HwpParser._parseHwpParaShape(rec.body);
        if (paraShape) {
          paraShapes[paraShapeId] = paraShape;
        }
        paraShapeId += 1;
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 26) {
        const style = HwpParser._parseHwpStyle(rec.body);
        if (style) {
          styles[styleId] = style;
        }
        styleId += 1;
      }
      pos = rec.nextPos;
    }

    return {
      faceNames,
      borderFills,
      charShapes,
      tabDefs,
      numberings,
      bullets,
      paraShapes,
      styles,
      faceNameCount: faceNameId - 1,
      borderFillCount: borderFillId - 1,
      charShapeCount: charShapeId - 1,
      tabDefCount: tabDefId - 1,
      numberingCount: numberingId - 1,
      bulletCount: bulletId - 1,
      paraShapeCount: paraShapeId - 1,
      styleCount: styleId - 1,
    };
  },

  async _parseHwpDocInfoStream(data, streamOptions = {}) {
    const normalizedOptions = typeof streamOptions === 'object'
      ? streamOptions
      : { compressedHint: Boolean(streamOptions) };
    const { compressedHint = false, distributedHint = false } = normalizedOptions;
    const attempts = await HwpParser._buildHwpRecordAttempts(data, { compressedHint, distributedHint });

    let best = {
      faceNames: {},
      borderFills: {},
      charShapes: {},
      tabDefs: {},
      numberings: {},
      bullets: {},
      paraShapes: {},
      styles: {},
      faceNameCount: 0,
      borderFillCount: 0,
      charShapeCount: 0,
      tabDefCount: 0,
      numberingCount: 0,
      bulletCount: 0,
      paraShapeCount: 0,
      styleCount: 0,
    };
    let bestMode = 'raw';
    for (const attempt of attempts) {
      if (!attempt.bytes?.length) continue;
      const parsed = HwpParser._parseHwpDocInfoRecords(attempt.bytes);
      const score = (parsed.faceNameCount || 0)
        + (parsed.borderFillCount || 0)
        + (parsed.charShapeCount || 0)
        + (parsed.tabDefCount || 0)
        + (parsed.numberingCount || 0)
        + (parsed.bulletCount || 0)
        + (parsed.paraShapeCount || 0)
        + (parsed.styleCount || 0);
      const bestScore = (best.faceNameCount || 0)
        + (best.borderFillCount || 0)
        + (best.charShapeCount || 0)
        + (best.tabDefCount || 0)
        + (best.numberingCount || 0)
        + (best.bulletCount || 0)
        + (best.paraShapeCount || 0)
        + (best.styleCount || 0);
      if (score > bestScore) {
        best = parsed;
        bestMode = attempt.mode;
      }
    }

    if ((best.borderFillCount || 0) > 0 || (best.charShapeCount || 0) > 0 || (best.paraShapeCount || 0) > 0 || (best.styleCount || 0) > 0) {
      console.log(
        '[HWP] DocInfo: borderFill=%d charShape=%d tabDef=%d numbering=%d bullet=%d paraShape=%d style=%d (%s)',
        best.borderFillCount || 0,
        best.charShapeCount || 0,
        best.tabDefCount || 0,
        best.numberingCount || 0,
        best.bulletCount || 0,
        best.paraShapeCount || 0,
        best.styleCount || 0,
        bestMode,
      );
    }

    return best;
  },

  _nextHwpBinaryImage(docInfo = null) {
    if (!docInfo?.binImages?.length) return null;
    const index = docInfo.binImageCursor || 0;
    const image = docInfo.binImages[index] || null;
    if (image) {
      docInfo.binImageCursor = index + 1;
    }
    return image;
  },

  _parseHwpPictureBinId(pictureBody, docInfo = null) {
    if (!pictureBody || pictureBody.length < 72) return 0;

    const candidates = [
      HwpParser._u32be(pictureBody, 68),
      HwpParser._u16be(pictureBody, 70),
      pictureBody[71] || 0,
    ].filter(value => Number.isFinite(value) && value > 0);

    if (docInfo?.binImagesById) {
      const matched = candidates.find(value => docInfo.binImagesById[value]);
      if (matched) return matched;
    }

    return candidates[0] || 0;
  },

  _resolveHwpBinaryImage(docInfo = null, pictureBody = null) {
    const binId = HwpParser._parseHwpPictureBinId(pictureBody, docInfo);
    if (binId > 0 && docInfo?.binImagesById?.[binId]) {
      return docInfo.binImagesById[binId];
    }
    return HwpParser._nextHwpBinaryImage(docInfo);
  },

  _resolveHwpBinaryEntry(docInfo = null, binId = 0) {
    if (!binId || binId <= 0) return null;
    return docInfo?.binEntriesById?.[binId] || null;
  },

  _firstPositiveMetric(...candidates) {
    for (const candidate of candidates) {
      const value = Number(candidate) || 0;
      if (value > 0) return value;
    }
    return 0;
  },

  _decodeHwpUtf16String(body, offset, charLength) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeChars = Math.max(0, Number(charLength) || 0);
    if (!body || safeChars <= 0 || safeOffset >= body.length) return '';
    const byteLength = Math.min(body.length - safeOffset, safeChars * 2);
    if (byteLength <= 0) return '';
    return new TextDecoder('utf-16le')
      .decode(body.slice(safeOffset, safeOffset + byteLength))
      .replace(/\u0000/g, '')
      .trim();
  },

  _hwpObjectRelTo(axis, code = 0) {
    const idx = Number(code) || 0;
    if (axis === 'vert') {
      return ['paper', 'page', 'para'][idx] || 'para';
    }
    return ['paper', 'page', 'column', 'para'][idx] || 'column';
  },

  _hwpObjectAlign(axis, code = 0) {
    const idx = Number(code) || 0;
    if (axis === 'vert') {
      return ['top', 'center', 'bottom', 'inside', 'outside'][idx] || 'top';
    }
    return ['left', 'center', 'right', 'inside', 'outside'][idx] || 'left';
  },

  _hwpObjectTextWrap(code = 0) {
    return ['square', 'tight', 'through', 'top-and-bottom', 'behind-text', 'in-front-of-text'][Number(code) || 0]
      || 'top-and-bottom';
  },

  _hwpObjectTextFlow(code = 0) {
    return ['both-sides', 'left-only', 'right-only', 'largest-only'][Number(code) || 0]
      || 'both-sides';
  },

  _hwpObjectSizeRelTo(axis, code = 0) {
    if (axis === 'height') {
      return ['paper', 'page', 'absolute'][Number(code) || 0] || 'absolute';
    }
    return ['paper', 'page', 'column', 'para', 'absolute'][Number(code) || 0] || 'absolute';
  },

  _parseHwpSecDef(body) {
    // HWPTAG_SEC_DEF (tag 78): 섹션 정의 레코드 — 최소 36바이트 (4+4+4+4+4+4+4+4+4 = 36)
    // offset 0: attributes, 4: paperWidth, 8: paperHeight, 12-35: margins (left/right/top/bottom/header/footer)
    if (!body || body.length < 36) return null;
    const paperWidth  = HwpParser._i32(body, 4);
    const paperHeight = HwpParser._i32(body, 8);
    if (paperWidth <= 0 || paperHeight <= 0) return null;
    return {
      sourceFormat: 'hwp',
      width:  paperWidth,
      height: paperHeight,
      margins: {
        left:   HwpParser._i32(body, 12),
        right:  HwpParser._i32(body, 16),
        top:    HwpParser._i32(body, 20),
        bottom: HwpParser._i32(body, 24),
        header: HwpParser._i32(body, 28),
        footer: HwpParser._i32(body, 32),
      },
    };
  },

  _parseHwpObjectCommon(ctrlBody) {
    if (!ctrlBody || ctrlBody.length < 46) return null;
    const attr = HwpParser._u32(ctrlBody, 4);
    const descLen = HwpParser._u16(ctrlBody, 44);
    const vertRelTo = HwpParser._hwpObjectRelTo('vert', (attr >> 3) & 0x3);
    const horzRelTo = HwpParser._hwpObjectRelTo('horz', (attr >> 8) & 0x3);
    return {
      controlId: HwpParser._ctrlId(ctrlBody),
      attr,
      vertOffset: HwpParser._i32(ctrlBody, 8),
      horzOffset: HwpParser._i32(ctrlBody, 12),
      width: HwpParser._u32(ctrlBody, 16),
      height: HwpParser._u32(ctrlBody, 20),
      zOrder: HwpParser._i32(ctrlBody, 24),
      margin: [
        HwpParser._u16(ctrlBody, 28),
        HwpParser._u16(ctrlBody, 30),
        HwpParser._u16(ctrlBody, 32),
        HwpParser._u16(ctrlBody, 34),
      ],
      instanceId: HwpParser._u32(ctrlBody, 36),
      preventPageBreak: HwpParser._i32(ctrlBody, 40),
      description: HwpParser._decodeHwpUtf16String(ctrlBody, 46, descLen),
      inline: Boolean(attr & 1),
      affectLineSpacing: Boolean(attr & (1 << 2)),
      vertRelTo,
      vertAlign: HwpParser._hwpObjectAlign('vert', (attr >> 5) & 0x7),
      horzRelTo,
      horzAlign: HwpParser._hwpObjectAlign('horz', (attr >> 10) & 0x7),
      align: HwpParser._hwpObjectAlign('horz', (attr >> 10) & 0x7),
      flowWithText: Boolean((attr >> 13) & 0x1),
      allowOverlap: Boolean((attr >> 14) & 0x1),
      widthRelTo: HwpParser._hwpObjectSizeRelTo('width', (attr >> 15) & 0x7),
      heightRelTo: HwpParser._hwpObjectSizeRelTo('height', (attr >> 18) & 0x3),
      sizeProtected: Boolean((attr >> 20) & 0x1),
      textWrap: HwpParser._hwpObjectTextWrap((attr >> 21) & 0x7),
      textFlow: HwpParser._hwpObjectTextFlow((attr >> 24) & 0x3),
      numberingCategory: (attr >> 26) & 0x7,
    };
  },

  _createHwpObjectTextBlock(type, objectInfo, text, runOpts = {}, extra = {}) {
    const content = String(text || '').trim();
    return HwpParser._withObjectLayout({
      type,
      width: Number(objectInfo?.width) || 0,
      height: Number(objectInfo?.height) || 0,
      description: objectInfo?.description || '',
      sourceFormat: 'hwp',
      texts: [HwpParser._run(content || (type === 'equation' ? '[수식]' : '[OLE 개체]'), runOpts)],
      ...extra,
    }, objectInfo);
  },

  _parseHwpEquationBlock(objectInfo, equationBody) {
    if (!equationBody || equationBody.length < 6) return null;

    const scriptLen = HwpParser._u16(equationBody, 4);
    const script = HwpParser._decodeHwpUtf16String(equationBody, 6, scriptLen);
    let offset = 6 + (scriptLen * 2);

    const fontSize = equationBody.length >= offset + 4 ? HwpParser._u32(equationBody, offset) : 0;
    offset += equationBody.length >= offset + 4 ? 4 : 0;
    const color = equationBody.length >= offset + 4
      ? HwpParser._hwpColorRefToCss(HwpParser._u32(equationBody, offset))
      : '';
    offset += equationBody.length >= offset + 4 ? 4 : 0;
    const baseline = equationBody.length >= offset + 2 ? HwpParser._u16(equationBody, offset) : 0;
    offset += equationBody.length >= offset + 2 ? 2 : 0;

    let version = '';
    let fontName = '';
    if (offset < equationBody.length) {
      const tailText = new TextDecoder('utf-16le')
        .decode(equationBody.slice(offset))
        .replace(/\u0000+/g, '\n')
        .split('\n')
        .map(part => part.trim())
        .filter(Boolean);
      [version = '', fontName = ''] = tailText;
    }

    const runOpts = {
      color: color || '#111827',
    };
    if (fontName) runOpts.fontName = fontName;
    if (fontSize > 0) {
      runOpts.fontSize = Math.max(11, Math.min(28, Math.round(fontSize / 100)));
    }

    return HwpParser._createHwpObjectTextBlock(
      'equation',
      objectInfo,
      script || '[수식]',
      runOpts,
      {
        script,
        equationVersion: version,
        equationFontName: fontName,
        equationFontSize: fontSize,
        baseline,
      },
    );
  },

  _parseHwpOleBlock(objectInfo, oleBody, docInfo = null, extras = {}) {
    if (!oleBody || oleBody.length < 24) return null;

    const attr = HwpParser._u16(oleBody, 0);
    const extentX = HwpParser._i32(oleBody, 2);
    const extentY = HwpParser._i32(oleBody, 6);
    const binId = HwpParser._u16(oleBody, 10);
    const binaryEntry = HwpParser._resolveHwpBinaryEntry(docInfo, binId);

    let label = '[OLE 개체]';
    if (extras?.hasChartData) label = '[차트]';
    else if (extras?.hasVideoData) label = '[동영상]';
    else if (binaryEntry?.name) label = `[OLE] ${binaryEntry.name}`;

    return HwpParser._createHwpObjectTextBlock(
      'ole',
      {
        ...objectInfo,
        width: HwpParser._firstPositiveMetric(objectInfo?.width, extentX, 0),
        height: HwpParser._firstPositiveMetric(objectInfo?.height, extentY, 0),
      },
      label,
      {},
      {
        oleAttr: attr,
        oleBinId: binId,
        binaryName: binaryEntry?.name || '',
        hasChartData: Boolean(extras?.hasChartData),
        hasVideoData: Boolean(extras?.hasVideoData),
      },
    );
  },

  _parseHwpGsoBlock(objectInfo, pictureBody, docInfo = null) {
    if (!pictureBody?.length) return null;
    const imageRef = HwpParser._resolveHwpBinaryImage(docInfo, pictureBody);
    if (!imageRef?.src) return null;

    const width = HwpParser._firstPositiveMetric(
      objectInfo?.width,
      HwpParser._u32(pictureBody, 52),
      HwpParser._u32(pictureBody, 20),
      HwpParser._u32(pictureBody, 28),
      0,
    );
    const height = HwpParser._firstPositiveMetric(
      objectInfo?.height,
      HwpParser._u32(pictureBody, 56),
      HwpParser._u32(pictureBody, 32),
      HwpParser._u32(pictureBody, 40),
      0,
    );

    return HwpParser._withObjectLayout({
      type: 'image',
      src: imageRef.src,
      alt: objectInfo?.description || imageRef.name || 'image',
      width,
      height,
      sourceFormat: 'hwp',
    }, objectInfo);
  },

  _parseGsoControl(data, startPos, ctrlLevel, ctrlBody, docInfo = null) {
    let pos = startPos;
    const objectInfo = HwpParser._parseHwpObjectCommon(ctrlBody);
    let pictureBody = null;
    let equationBody = null;
    let oleBody = null;
    let hasChartData = false;
    let hasVideoData = false;

    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (rec.level <= ctrlLevel) break;
      if (rec.tagId === 85 && !pictureBody) {
        pictureBody = rec.body;
      } else if (rec.tagId === 88 && !equationBody) {
        equationBody = rec.body;
      } else if (rec.tagId === 84 && !oleBody) {
        oleBody = rec.body;
      } else if (rec.tagId === 95) {
        hasChartData = true;
      } else if (rec.tagId === 98) {
        hasVideoData = true;
      }
      pos = rec.nextPos;
    }

    let block = null;
    if (equationBody) {
      block = HwpParser._parseHwpEquationBlock(objectInfo, equationBody);
    } else if (pictureBody) {
      block = HwpParser._parseHwpGsoBlock(objectInfo, pictureBody, docInfo);
    } else if (oleBody) {
      block = HwpParser._parseHwpOleBlock(objectInfo, oleBody, docInfo, { hasChartData, hasVideoData });
    }

    return {
      block,
      nextPos: pos,
    };
  },

  _createParagraphBlock(text, align = 'left', runOpts = {}, blockOpts = {}) {
    return {
      type: 'paragraph',
      align,
      ...blockOpts,
      texts: [HwpParser._run(text, runOpts)],
    };
  },

  _readRecord(data, pos) {
    if (pos + 4 > data.length) return null;

    const hdr = HwpParser._u32(data, pos);
    pos += 4;

    const tagId = hdr & 0x3FF;
    const level = (hdr >> 10) & 0x3FF;
    let size = (hdr >> 20) & 0xFFF;

    if (size === 0xFFF) {
      if (pos + 4 > data.length) return null;
      size = HwpParser._u32(data, pos);
      pos += 4;
    }

    const end = Math.min(pos + size, data.length);
    return {
      tagId,
      level,
      size,
      startPos: pos,
      nextPos: end,
      body: data.subarray(pos, end),
    };
  },

  _ctrlId(body) {
    if (!body || body.length < 4) return '';
    return String.fromCharCode(body[3], body[2], body[1], body[0]);
  },

  _skipControlSubtree(data, startPos, ctrlLevel) {
    let pos = startPos;
    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (rec.level <= ctrlLevel) break;
      pos = rec.nextPos;
    }
    return pos;
  },

  _parseTableInfo(body) {
    if (!body || body.length < 18) return null;

    const rowCount = HwpParser._u16(body, 4);
    const colCount = HwpParser._u16(body, 6);
    const cellSpacing = HwpParser._u16(body, 8);
    const rowHeights = [];

    let off = 18;
    for (let i = 0; i < rowCount && off + 2 <= body.length; i++, off += 2) {
      rowHeights.push(HwpParser._u16(body, off));
    }

    return {
      rowCount,
      colCount,
      cellSpacing,
      rowHeights,
    };
  },

  _parseTableCell(body) {
    if (!body || body.length < 34) return null;
    const listFlags = HwpParser._u32(body, 2);

    return {
      paragraphCount: Math.max(0, HwpParser._u16(body, 0)),
      listFlags,
      verticalAlign: HwpParser._hwpCellVerticalAlign(listFlags),
      col: HwpParser._u16(body, 8),
      row: HwpParser._u16(body, 10),
      colSpan: Math.max(1, HwpParser._u16(body, 12)),
      rowSpan: Math.max(1, HwpParser._u16(body, 14)),
      width: HwpParser._u32(body, 16),
      height: HwpParser._u32(body, 20),
      padding: [
        HwpParser._u16(body, 24),
        HwpParser._u16(body, 26),
        HwpParser._u16(body, 28),
        HwpParser._u16(body, 30),
      ],
      borderFillId: HwpParser._u16(body, 32),
      paragraphs: [],
    };
  },

  _cellText(cell) {
    if (!cell?.paragraphs?.length) return '';
    return cell.paragraphs
      .map(block => HwpParser._blockText(block))
      .filter(Boolean)
      .join('\n');
  },

  _borderStyleHasVisuals(borderStyle) {
    if (!borderStyle) return false;
    if (borderStyle.fillColor || borderStyle.fillGradient) return true;
    return ['left', 'right', 'top', 'bottom'].some(side => (
      String(borderStyle?.[side]?.type || '').toUpperCase() !== 'NONE'
    ));
  },

  _cellHasVisualContent(cell) {
    if (!cell) return false;
    if (HwpParser._borderStyleHasVisuals(cell.borderStyle)) return true;
    return (cell.paragraphs || []).some(block => HwpParser._blockHasVisualContent(block));
  },

  _tableHasVisualStyles(table) {
    return (table?.rows || []).some(row => (
      (row.cells || []).some(cell => HwpParser._borderStyleHasVisuals(cell.borderStyle))
    ));
  },

  _blockHasVisualContent(block) {
    if (!block) return false;
    if (block.type === 'image') return Boolean(block.src);
    if (block.type === 'table') {
      return (block.rows || []).some(row => (
        (row.cells || []).some(cell => (
          HwpParser._cellHasVisualContent(cell)
        ))
      ));
    }
    return Boolean(HwpParser._blockText(block).trim());
  },

  _blockText(block) {
    if (!block) return '';

    if (block.type === 'table') {
      return (block.rows || [])
        .map(row => (row.cells || []).map(cell => HwpParser._cellText(cell)).join(' '))
        .join('\n');
    }

    if (block.type === 'image') {
      return '[이미지]';
    }

    if (block.type === 'equation') {
      return (block.texts || []).map(run => run.text || '').join('') || '[수식]';
    }

    if (block.type === 'ole') {
      return (block.texts || []).map(run => run.text || '').join('') || '[OLE 개체]';
    }

    return (block.texts || []).map(run => run.text || '').join('');
  },

  _estimateBlockWeight(block) {
    if (!block) return 1;
    if (block.type === 'table') {
      return (block.rows || []).reduce(
        (sum, row) => sum + HwpParser._tableRowWeight(block, row.index),
        0,
      );
    }
    if (block.type === 'image') {
      if (block.inline) return 1;
      return Math.max(1, Math.min(6, Math.round((Number(block.height) || 1200) / 1000)));
    }
    if (block.type === 'equation' || block.type === 'ole') {
      return block.inline ? 1 : 2;
    }
    return 1;
  },

  _tableRowWeight(tableBlock, rowIndex) {
    const rowHeight = tableBlock?.rowHeights?.[rowIndex];
    if (tableBlock?.sourceFormat === 'hwpx') {
      return Math.max(1, rowHeight || 1);
    }
    return Math.max(1, rowHeight || 4);
  },

  _isSafeTableBreak(tableBlock, rowIndex) {
    return !(tableBlock.rows || []).some(row => (row.cells || []).some(cell => (
      cell.row <= rowIndex && (cell.row + cell.rowSpan - 1) > rowIndex
    )));
  },

  _sliceTableBlock(tableBlock, startRow, endRow) {
    const rows = Array.from({ length: endRow - startRow }, (_, index) => ({ index, cells: [] }));
    const sourceRows = (tableBlock.rows || []).slice(startRow, endRow);

    sourceRows.forEach((sourceRow, offset) => {
      (sourceRow.cells || []).forEach(cell => {
        const nextCell = {
          ...cell,
          row: cell.row - startRow,
          paragraphs: (cell.paragraphs || []).map(cloneParagraphBlock),
        };
        rows[offset].cells.push(nextCell);
      });
    });

    return {
      ...tableBlock,
      rowCount: rows.length,
      rows,
      rowHeights: (tableBlock.rowHeights || []).slice(startRow, endRow),
      estimatedParagraphs: rows.reduce(
        (sum, row) => sum + row.cells.reduce(
          (cellSum, cell) => cellSum + Math.max(1, (cell.paragraphs || []).length),
          0,
        ),
        0,
      ),
      texts: [HwpParser._run('')],
    };
  },

  _splitTableBlock(tableBlock, maxWeight) {
    if (tableBlock.type !== 'table' || tableBlock.rowCount <= 1) {
      return [tableBlock];
    }

    const chunks = [];
    let startRow = 0;

    while (startRow < tableBlock.rowCount) {
      let endRow = startRow;
      let weight = 0;
      let lastSafeBreak = -1;

      while (endRow < tableBlock.rowCount) {
        weight += HwpParser._tableRowWeight(tableBlock, endRow);
        if (HwpParser._isSafeTableBreak(tableBlock, endRow)) {
          lastSafeBreak = endRow + 1;
        }
        endRow += 1;

        if (weight >= maxWeight && lastSafeBreak > startRow) {
          endRow = lastSafeBreak;
          break;
        }
      }

      if (endRow <= startRow) {
        endRow = startRow + 1;
      }

      chunks.push(HwpParser._sliceTableBlock(tableBlock, startRow, endRow));
      startRow = endRow;
    }

    return chunks;
  },

  _buildTableBlock(tableInfo, cells) {
    if (!cells.length) return null;

    const rowCount = Math.max(
      tableInfo?.rowCount || 0,
      ...cells.map(cell => cell.row + cell.rowSpan),
    );
    const colCount = Math.max(
      tableInfo?.colCount || 0,
      ...cells.map(cell => cell.col + cell.colSpan),
    );

    const sortedCells = cells
      .filter(cell => cell.col < colCount && cell.row < rowCount)
      .sort((a, b) => (a.row - b.row) || (a.col - b.col));

    const columnWidths = Array.from({ length: colCount }, () => 0);

    // 병합 셀보다 실제 단일 셀 폭을 먼저 기준으로 잡아야 양식표 비율이 덜 흔들린다.
    for (const cell of sortedCells) {
      if ((cell.colSpan || 1) !== 1 || !(cell.width > 0)) continue;
      columnWidths[cell.col] = Math.max(columnWidths[cell.col], cell.width);
    }

    // 병합 셀은 "균등 분배"가 아니라 아직 비어 있는 열을 채우는 보정용으로만 사용한다.
    for (const cell of sortedCells) {
      const span = Math.max(1, cell.colSpan || 1);
      if (span === 1 || !(cell.width > 0)) continue;

      const start = Math.max(0, cell.col);
      const end = Math.min(colCount, cell.col + span);
      const indices = [];
      let existing = 0;
      for (let c = start; c < end; c++) {
        indices.push(c);
        existing += columnWidths[c] || 0;
      }

      if (!indices.length) continue;
      if (existing <= 0) {
        const unitWidth = cell.width / indices.length;
        indices.forEach(c => { columnWidths[c] = Math.max(columnWidths[c], unitWidth); });
        continue;
      }

      if (cell.width <= existing) continue;

      const deficit = cell.width - existing;
      const zeroCols = indices.filter(c => !(columnWidths[c] > 0));
      if (zeroCols.length) {
        const unitWidth = deficit / zeroCols.length;
        zeroCols.forEach(c => { columnWidths[c] = Math.max(columnWidths[c], unitWidth); });
        continue;
      }

      const basis = indices.reduce((sum, c) => sum + (columnWidths[c] || 0), 0) || indices.length;
      indices.forEach(c => {
        const ratio = (columnWidths[c] || 0) > 0 ? ((columnWidths[c] || 0) / basis) : (1 / indices.length);
        columnWidths[c] += deficit * ratio;
      });
    }

    if (!columnWidths.every(width => width > 0)) {
      const known = columnWidths.filter(width => width > 0);
      const fallbackWidth = known.length
        ? (known.reduce((sum, width) => sum + width, 0) / known.length)
        : 1;
      for (let c = 0; c < columnWidths.length; c++) {
        if (!(columnWidths[c] > 0)) columnWidths[c] = fallbackWidth;
      }
    }

    if (!columnWidths.some(Boolean)) {
      columnWidths.fill(1);
    }

    const rows = Array.from({ length: rowCount }, (_, index) => ({ index, cells: [] }));
    for (const cell of sortedCells) {
      rows[cell.row].cells.push(cell);
    }

    const estimatedParagraphs = cells.reduce(
      (sum, cell) => sum + Math.max(1, cell.paragraphs.length),
      0,
    );

    return {
      type: 'table',
      align: 'left',
      rowCount,
      colCount,
      rows,
      columnWidths,
      cellSpacing: tableInfo?.cellSpacing || 0,
      rowHeights: tableInfo?.rowHeights || [],
      estimatedParagraphs,
      sourceFormat: tableInfo?.sourceFormat || '',
      texts: [HwpParser._run('')],
    };
  },

  _parseTableControl(data, startPos, ctrlLevel, docInfo = null, controlBody = null) {
    let pos = startPos;
    let tableInfo = null;
    const cells = [];
    const objectInfo = HwpParser._parseHwpObjectCommon(controlBody);

    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (rec.level <= ctrlLevel) break;

      if (rec.level === ctrlLevel + 1 && rec.tagId === 77) {
        tableInfo = HwpParser._parseTableInfo(rec.body);
        pos = rec.nextPos;
        continue;
      }

      if (rec.level === ctrlLevel + 1 && rec.tagId === 72) {
        const cell = HwpParser._parseTableCell(rec.body);
        pos = rec.nextPos;

        if (!cell) continue;

        const paragraphs = [];
        let currentText = null;
        let currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
        const pushParagraph = () => {
          if (currentText === null) return;
          paragraphs.push(HwpParser._createHwpParagraphBlock(currentText, currentParaState, docInfo));
          currentText = null;
          currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
        };

      while (pos < data.length) {
        const next = HwpParser._readRecord(data, pos);
        if (!next) break;
        if (next.level <= ctrlLevel) break;
        if (next.level === ctrlLevel + 1 && next.tagId === 72) break;

        if (next.tagId === 71) {
          const nestedCtrlId = HwpParser._ctrlId(next.body);
          if (nestedCtrlId === 'tbl ') {
            pushParagraph();
            const { block, nextPos } = HwpParser._parseTableControl(data, next.nextPos, next.level, docInfo, next.body);
            if (block) paragraphs.push(block);
            pos = nextPos;
            continue;
          }
          if (nestedCtrlId === 'gso ') {
            pushParagraph();
            const { block, nextPos } = HwpParser._parseGsoControl(data, next.nextPos, next.level, next.body, docInfo);
            if (block) paragraphs.push(block);
            pos = nextPos;
            continue;
          }
          pos = HwpParser._skipControlSubtree(data, next.nextPos, next.level);
          continue;
        }

        if (next.level === ctrlLevel + 1 && next.tagId === 66) {
          pushParagraph();
          currentText = '';
          currentParaState = HwpParser._parseHwpParaHeader(next.body);
            currentParaState.lineSegs = [];
            pos = next.nextPos;
            continue;
          }

          if (next.tagId === 68) {
            currentParaState.charShapes = HwpParser._parseHwpParaCharShape(next.body);
            pos = next.nextPos;
            continue;
          }

          if (next.tagId === 69) {
            currentParaState.lineSegs = HwpParser._parseHwpParaLineSeg(next.body);
            pos = next.nextPos;
            continue;
          }

          if (next.tagId === 67) {
            if (currentText === null) currentText = '';
            currentText += HwpParser._decodeParaText(next.body, 0, next.body.length);
          }

          pos = next.nextPos;
        }

        pushParagraph();
        if (!paragraphs.length) {
          paragraphs.push(HwpParser._createParagraphBlock(''));
        }

        cell.paragraphs = paragraphs;
        cell.borderStyle = docInfo?.borderFills?.[cell.borderFillId] || null;
        cells.push(cell);
        continue;
      }

      pos = rec.nextPos;
    }

    return {
      block: HwpParser._withObjectLayout(HwpParser._buildTableBlock(tableInfo, cells), objectInfo),
      nextPos: pos,
    };
  },

  _parseHwpBlockRange(data, startPos = 0, docInfo = null, stopLevel = null, extras = null) {
    const paras = [];
    let pos = startPos;
    let currentText = null;
    let currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
    const pushParagraph = () => {
      if (currentText === null) return;
      paras.push(HwpParser._createHwpParagraphBlock(currentText, currentParaState, docInfo));
      currentText = null;
      currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
    };

    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (stopLevel !== null && rec.level <= stopLevel) break;

      if (rec.tagId === 71) {
        const controlId = HwpParser._ctrlId(rec.body);
        if (controlId === 'tbl ') {
          pushParagraph();
          const { block, nextPos } = HwpParser._parseTableControl(data, rec.nextPos, rec.level, docInfo, rec.body);
          if (block) paras.push(block);
          pos = nextPos;
          continue;
        }
        if (controlId === 'gso ') {
          pushParagraph();
          const { block, nextPos } = HwpParser._parseGsoControl(data, rec.nextPos, rec.level, rec.body, docInfo);
          if (block) paras.push(block);
          pos = nextPos;
          continue;
        }
        if (controlId === 'head' || controlId === 'foot') {
          pushParagraph();
          const subtree = HwpParser._parseHwpBlockRange(data, rec.nextPos, docInfo, rec.level, null);
          const target = controlId === 'head' ? extras?.headerBlocks : extras?.footerBlocks;
          if (target && subtree.blocks.length) {
            target.push(...subtree.blocks);
          }
          pos = subtree.nextPos;
          continue;
        }

        if (controlId === 'secd') {
          pushParagraph();
          if (extras && !extras.sectionMeta) {
            let scanPos = rec.nextPos;
            while (scanPos < data.length) {
              const sub = HwpParser._readRecord(data, scanPos);
              if (!sub) break;
              if (sub.level <= rec.level) break;
              if (sub.tagId === 78) {
                const secDef = HwpParser._parseHwpSecDef(sub.body);
                if (secDef) extras.sectionMeta = secDef;
                break;
              }
              scanPos = sub.nextPos;
            }
          }
          pos = HwpParser._skipControlSubtree(data, rec.nextPos, rec.level);
          continue;
        }

        pushParagraph();
        const subtree = HwpParser._parseHwpBlockRange(data, rec.nextPos, docInfo, rec.level, null);
        if (subtree.blocks.length) {
          paras.push(...subtree.blocks);
          pos = subtree.nextPos;
          continue;
        }
        pos = HwpParser._skipControlSubtree(data, rec.nextPos, rec.level);
        continue;
      }

      if (rec.tagId === 66) {
        pushParagraph();
        currentText = '';
        currentParaState = HwpParser._parseHwpParaHeader(rec.body);
        currentParaState.lineSegs = [];
        pos = rec.nextPos;
        continue;
      }

      if (rec.tagId === 68) {
        currentParaState.charShapes = HwpParser._parseHwpParaCharShape(rec.body);
        pos = rec.nextPos;
        continue;
      }

      if (rec.tagId === 69) {
        currentParaState.lineSegs = HwpParser._parseHwpParaLineSeg(rec.body);
        pos = rec.nextPos;
        continue;
      }

      if (rec.tagId === 67 && rec.size >= 2) {
        if (currentText === null) currentText = '';
        currentText += HwpParser._decodeParaText(rec.body, 0, rec.body.length);
      }

      pos = rec.nextPos;
    }

    pushParagraph();
    return { blocks: paras, nextPos: pos };
  },

  /* ── HWP 레코드 파서 (TagID 67 = HWPTAG_PARA_TEXT) ── */
  _parseHwpRecords(data, docInfo = null, extras = null) {
    return HwpParser._parseHwpBlockRange(data, 0, docInfo, null, extras).blocks;
  },

  _scoreParas(paras) {
    return paras.reduce((sum, para) => (
      sum + HwpParser._blockText(para).replace(/\s+/g, '').length
    ), 0);
  },

  _paragraphsFromText(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\x02/g, '\n')
      .split('\n')
      .map(line => HwpParser._createParagraphBlock(line));
  },

  /**
   * BodyText 구조 레코드 파싱이 실패했을 때 UTF-16LE 텍스트 덩어리를 휴리스틱하게 복구합니다.
   * 한글이 1글자 이상 포함된 연속 블록만 후보로 삼아, 바이너리 노이즈보다 실제 본문을 우선 선택합니다.
   */
  _scanUtf16TextBlock(data, startOffset = 0, minRawLen = 20) {
    let bestStart = -1, bestScore = 0, bestRawLen = 0;
    let runStart = -1, runLen = 0, koreanInRun = 0;

    const isValidCp = cp =>
      (cp >= 0x20  && cp <= 0x7E)   ||
      (cp >= 0xAC00 && cp <= 0xD7A3)||
      (cp >= 0x1100 && cp <= 0x11FF)||
      (cp >= 0x3130 && cp <= 0x318F)||
      (cp >= 0x4E00 && cp <= 0x9FFF)||
      cp === 0x000A || cp === 0x000D || cp === 0x0009 || cp === 0x0002;

    const flush = () => {
      if (runLen >= minRawLen && koreanInRun > 0) {
        const score = runLen * (1 + koreanInRun / Math.max(runLen / 2, 1));
        if (score > bestScore) {
          bestStart = runStart;
          bestScore = score;
          bestRawLen = runLen;
        }
      }
      runStart = -1;
      runLen = 0;
      koreanInRun = 0;
    };

    for (let i = startOffset; i + 2 <= data.length; i += 2) {
      const cp = data[i] | (data[i + 1] << 8);
      if (isValidCp(cp)) {
        if (runStart < 0) runStart = i;
        runLen += 2;
        if (cp >= 0xAC00 && cp <= 0xD7A3) koreanInRun++;
      } else {
        flush();
      }
    }
    flush();

    if (bestStart < 0) return null;
    return new TextDecoder('utf-16le').decode(data.slice(bestStart, bestStart + bestRawLen));
  },

  /**
   * 섹션 스트림을 raw/deflated 양쪽으로 시도한 뒤, 구조 레코드가 안 맞으면 UTF-16 텍스트 블록 복구까지 수행합니다.
   * 그래도 유의미한 본문을 찾지 못한 경우에만 빈 결과를 반환해 상위 단계에서 PrvText fallback 으로 넘어가게 합니다.
   */
  async _extractSectionParas(data, compressedHint, sectionName, docInfo = null, distributedHint = false) {
    const attempts = await HwpParser._buildHwpRecordAttempts(data, { compressedHint, distributedHint });

    let bestParas = [];
    let bestHeaderBlocks = [];
    let bestFooterBlocks = [];
    let bestSectionMeta = null;
    let bestScore = 0;

    for (const { mode, bytes } of attempts) {
      const extras = { headerBlocks: [], footerBlocks: [], sectionMeta: null };
      const paras = HwpParser._parseHwpRecords(bytes, docInfo, extras);
      const score = HwpParser._scoreParas(paras);
      if (score > bestScore) {
        bestScore = score;
        bestParas = paras;
        bestHeaderBlocks = extras.headerBlocks;
        bestFooterBlocks = extras.footerBlocks;
        bestSectionMeta = extras.sectionMeta || null;
      }
      if (score > 0) {
        console.log('[HWP] %s: %d단락 (%s)', sectionName, paras.length, mode);
      }
    }

    if (bestScore > 0) {
      return {
        paras: bestParas,
        headerBlocks: bestHeaderBlocks,
        footerBlocks: bestFooterBlocks,
        sectionMeta: bestSectionMeta,
      };
    }

    for (const { mode, bytes } of attempts) {
      const text = HwpParser._scanUtf16TextBlock(bytes, 0, 20);
      if (!text) continue;
      const paras = HwpParser._paragraphsFromText(text);
      const score = HwpParser._scoreParas(paras);
      if (score > 0) {
        console.warn('[HWP] %s: 구조 파싱 실패 → 텍스트 블록 복구 (%s)', sectionName, mode);
        return { paras, headerBlocks: [], footerBlocks: [], sectionMeta: null };
      }
    }

    return { paras: [], headerBlocks: [], footerBlocks: [], sectionMeta: null };
  },

  /* ── BodyText/Section 스트림 파싱 ── */
  async _parseBodyText(b) {
    const ss         = (() => { const e = HwpParser._u16(b, 0x1E); return (e>=7&&e<=14)?(1<<e):512; })();
    const miniCutoff = HwpParser._u32(b, 0x38) || 4096;
    const dirStartSec = HwpParser._u32(b, 0x30);
    if (dirStartSec >= 0xFFFFFFFA) return null;

    const dirBase          = (dirStartSec + 1) * ss;
    const rootStartSec     = HwpParser._u32(b, dirBase + 116);
    const rootStreamSz     = HwpParser._u32(b, dirBase + 120);
    const miniContainerOff = rootStartSec < 0xFFFFFFFA ? (rootStartSec + 1) * ss : -1;

    const fat = HwpParser._readFat(b, ss);
    const miniFat = HwpParser._readMiniFat(b, ss, fat);
    const miniStream = (rootStartSec < 0xFFFFFFFA && rootStreamSz > 0)
      ? HwpParser._readStreamByFat(b, rootStartSec, rootStreamSz, ss, fat)
      : null;
    let sectionNames = Array.from({ length: 10 }, (_, i) => 'Section' + i);
    let entries = HwpParser._scanDirEntries(b, ['FileHeader', 'DocInfo', ...sectionNames], ss, fat, dirStartSec);
    if (entries.Section9) {
      sectionNames = Array.from({ length: 100 }, (_, i) => 'Section' + i);
      entries = HwpParser._scanDirEntries(b, ['FileHeader', 'DocInfo', ...sectionNames], ss, fat, dirStartSec);
    }

    let compressed = true;
    let distributed = false;
    if (entries.FileHeader) {
      const { startSec, streamSz } = entries.FileHeader;
      let fhData;
      if (streamSz < miniCutoff && miniContainerOff > 0) {
        fhData = HwpParser._readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
      } else {
        fhData = HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
      }
      if (fhData && fhData.length >= 40) {
        compressed = (fhData[36] & 1) !== 0;
        distributed = (fhData[36] & 4) !== 0;
        if ((fhData[36] & 2) && !distributed) {
          console.warn('[HWP] 암호화된 문서');
          return null;
        }
        console.log('[HWP] FileHeader: compressed=%s distributed=%s', compressed, distributed);
      }
    }

    const docInfoEntry = entries.DocInfo;
    let docInfo = { borderFills: {}, borderFillCount: 0 };
    if (docInfoEntry) {
      const { startSec, streamSz } = docInfoEntry;
      let docInfoData;
      if (streamSz < miniCutoff && miniContainerOff > 0) {
        docInfoData = HwpParser._readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
      } else {
        docInfoData = HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
      }
      if (docInfoData?.length) {
        docInfo = await HwpParser._parseHwpDocInfoStream(docInfoData, {
          compressedHint: compressed,
          distributedHint: distributed,
        });
      }
    }

    const allEntries = HwpParser._scanAllDirEntries(b, ss, fat, dirStartSec);
    const hwpImages = await HwpParser._parseHwpBinaryMap(b, allEntries, ss, fat, miniCutoff, miniStream, miniFat);
    docInfo.images = hwpImages.images;
    docInfo.binImages = hwpImages.ordered;
    docInfo.binImagesById = hwpImages.byId;
    docInfo.binEntriesById = hwpImages.allById;
    docInfo.binImageCursor = 0;

    let sectionNumbers = Object.keys(entries)
      .filter(name => /^Section\d+$/.test(name))
      .map(name => Number(name.slice(7)))
      .sort((a, b) => a - b);
    if (sectionNumbers.length === 0 && !entries.Section9) {
      sectionNames = Array.from({ length: 100 }, (_, i) => 'Section' + i);
      entries = HwpParser._scanDirEntries(b, ['FileHeader', 'DocInfo', ...sectionNames], ss, fat, dirStartSec);
      sectionNumbers = Object.keys(entries)
        .filter(name => /^Section\d+$/.test(name))
        .map(name => Number(name.slice(7)))
        .sort((a, b) => a - b);
    }

    const allParas = [];
    let headerBlocks = [];
    let footerBlocks = [];
    let pageStyle = null;
    for (const sn of sectionNumbers) {
      const entry = entries['Section' + sn];
      if (!entry) continue;
      const { startSec, streamSz } = entry;
      if (startSec >= 0xFFFFFFFA || streamSz === 0) continue;

      let data;
      if (streamSz < miniCutoff && miniContainerOff > 0) {
        data = HwpParser._readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
      } else {
        data = HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
      }
      if (!data || data.length === 0) continue;
      const parsed = await HwpParser._extractSectionParas(
        data,
        compressed,
        'Section' + sn,
        docInfo,
        distributed,
      );
      allParas.push(...(parsed?.paras || []));
      if (!headerBlocks.length && parsed?.headerBlocks?.length) {
        headerBlocks = parsed.headerBlocks;
      }
      if (!footerBlocks.length && parsed?.footerBlocks?.length) {
        footerBlocks = parsed.footerBlocks;
      }
      if (!pageStyle && parsed?.sectionMeta) {
        pageStyle = parsed.sectionMeta;
      }
    }

    return allParas.length > 0 ? {
      paragraphs: allParas,
      headerBlocks,
      footerBlocks,
      pageStyle,
    } : null;
  },

  _scanPrvText(b) {
    // ─────────────────────────────────────────────────────
    // CFB 헤더 파라미터 읽기
    // ─────────────────────────────────────────────────────
    const exp  = HwpParser._u16(b, 0x1E);
    const ss   = (exp >= 7 && exp <= 14) ? (1 << exp) : 512; // 섹터 크기 (보통 512)

    // 미니 스트림 컷오프 크기: 이 값보다 작은 스트림은 미니 섹터(64 바이트)에 저장
    const miniCutoff = HwpParser._u32(b, 0x38) || 4096;

    // 첫 번째 디렉토리 섹터 위치 (CFB 오프셋 0x30)
    const dirStartSec = HwpParser._u32(b, 0x30);
    if (dirStartSec >= 0xFFFFFFFA) return null;
    const dirBase = (dirStartSec + 1) * ss;
    if (dirBase + 128 > b.length) return null;

    // ─────────────────────────────────────────────────────
    // Root Entry (디렉토리 첫 번째 엔트리, 128 바이트)
    //   → startSec/size 로 미니 스트림 컨테이너 위치 파악
    // ─────────────────────────────────────────────────────
    const rootStartSec = HwpParser._u32(b, dirBase + 116);
    const rootStreamSz = HwpParser._u32(b, dirBase + 120);
    const miniContainerOff = (rootStartSec < 0xFFFFFFFA)
      ? (rootStartSec + 1) * ss
      : -1;
    const fat = HwpParser._readFat(b, ss);
    const miniFat = HwpParser._readMiniFat(b, ss, fat);
    const miniStream = (rootStartSec < 0xFFFFFFFA && rootStreamSz > 0)
      ? HwpParser._readStreamByFat(b, rootStartSec, rootStreamSz, ss, fat)
      : null;

    console.log('[HWP] ss=%d miniCutoff=%d dirBase=%d rootStartSec=%d miniContainerOff=%d',
                ss, miniCutoff, dirBase, rootStartSec, miniContainerOff);

    const entries = HwpParser._scanDirEntries(b, ['PrvText'], ss, fat, dirStartSec);
    const entry = entries.PrvText;
    if (!entry) {
      console.warn('[HWP] PrvText 엔트리를 찾지 못했습니다.');
      return null;
    }

    const { startSec, streamSz } = entry;
    if (startSec >= 0xFFFFFFFA || streamSz === 0 || streamSz > 8 * 1024 * 1024) return null;

    let raw;
    if (streamSz < miniCutoff && miniContainerOff > 0) {
      raw = HwpParser._readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    } else {
      raw = HwpParser._readStreamByFat(b, startSec, streamSz, ss, fat);
    }
    if (!raw || raw.length === 0) return null;

    const text = new TextDecoder('utf-16le').decode(raw);
    let korean = 0, printable = 0;
    for (const c of text) {
      const cp = c.charCodeAt(0);
      if (cp >= 0xAC00 && cp <= 0xD7A3) { korean++; printable++; }
      else if (cp >= 0x20 || cp === 10 || cp === 13) printable++;
    }
    const ratio = text.length > 0 ? printable / text.length : 0;
    if (ratio < 0.6 || korean < 3) {
      console.warn('[HWP] PrvText 품질 불량 (printable=%.0f%%, korean=%d) → 폐기', ratio * 100, korean);
      return null;
    }
    console.log('[HWP] PrvText 추출 성공: %d글자 (한글 %d, 유효율 %.0f%%)', text.length, korean, ratio * 100);
    return text;
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
        fontSize:11, fontName:'Malgun Gothic', color:'#000000',
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
