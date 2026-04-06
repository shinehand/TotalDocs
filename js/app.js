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
      lineSpacingType: modernLineSpacing
        ? HwpParser._hwpLineSpacingTypeFromCode(modernAttr & 0x1F)
        : HwpParser._hwpLineSpacingTypeFromCode(attr & 0x3),
      lineSpacing: modernLineSpacing || legacyLineSpacing || 0,
    };
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
    return {
      lineHeightPx: hwpPageUnitToPx(avgHeight, 11, 56, 0),
      layoutHeightPx: hwpPageUnitToPx(totalHeight, 12, 320, 0),
    };
  },

  _buildHwpTextRuns(text, charShapes = [], docInfo = null) {
    const sourceText = String(text || '');
    const normalizedRanges = Array.isArray(charShapes)
      ? charShapes
        .filter(range => Number.isFinite(range?.start) && Number.isFinite(range?.charShapeId))
        .sort((a, b) => a.start - b.start)
      : [];

    if (!normalizedRanges.length) {
      return [HwpParser._run(sourceText)];
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
      runs.push(HwpParser._run(runText, docInfo?.charShapes?.[current.charShapeId] || {}));
    }

    return runs.length ? runs : [HwpParser._run(sourceText)];
  },

  _createHwpParagraphBlock(text, paraState = {}, docInfo = null) {
    const paraStyle = docInfo?.paraShapes?.[paraState?.paraShapeId] || null;
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
      lineHeightPx: lineMetrics.lineHeightPx,
      layoutHeightPx: lineMetrics.layoutHeightPx,
      texts: HwpParser._buildHwpTextRuns(text, paraState?.charShapes || [], docInfo),
    };
  },

  _parseHwpDocInfoRecords(data) {
    const faceNames = {};
    const borderFills = {};
    const charShapes = {};
    const paraShapes = {};
    let faceNameId = 1;
    let borderFillId = 1;
    let charShapeId = 1;
    let paraShapeId = 1;
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
      if (rec.tagId === 25) {
        const paraShape = HwpParser._parseHwpParaShape(rec.body);
        if (paraShape) {
          paraShapes[paraShapeId] = paraShape;
        }
        paraShapeId += 1;
      }
      pos = rec.nextPos;
    }

    return {
      faceNames,
      borderFills,
      charShapes,
      paraShapes,
      faceNameCount: faceNameId - 1,
      borderFillCount: borderFillId - 1,
      charShapeCount: charShapeId - 1,
      paraShapeCount: paraShapeId - 1,
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
      paraShapes: {},
      faceNameCount: 0,
      borderFillCount: 0,
      charShapeCount: 0,
      paraShapeCount: 0,
    };
    let bestMode = 'raw';
    for (const attempt of attempts) {
      if (!attempt.bytes?.length) continue;
      const parsed = HwpParser._parseHwpDocInfoRecords(attempt.bytes);
      const score = (parsed.faceNameCount || 0)
        + (parsed.borderFillCount || 0)
        + (parsed.charShapeCount || 0)
        + (parsed.paraShapeCount || 0);
      const bestScore = (best.faceNameCount || 0)
        + (best.borderFillCount || 0)
        + (best.charShapeCount || 0)
        + (best.paraShapeCount || 0);
      if (score > bestScore) {
        best = parsed;
        bestMode = attempt.mode;
      }
    }

    if ((best.borderFillCount || 0) > 0 || (best.charShapeCount || 0) > 0 || (best.paraShapeCount || 0) > 0) {
      console.log(
        '[HWP] DocInfo: borderFill=%d charShape=%d paraShape=%d (%s)',
        best.borderFillCount || 0,
        best.charShapeCount || 0,
        best.paraShapeCount || 0,
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
    let bestScore = 0;

    for (const { mode, bytes } of attempts) {
      const extras = { headerBlocks: [], footerBlocks: [] };
      const paras = HwpParser._parseHwpRecords(bytes, docInfo, extras);
      const score = HwpParser._scoreParas(paras);
      if (score > bestScore) {
        bestScore = score;
        bestParas = paras;
        bestHeaderBlocks = extras.headerBlocks;
        bestFooterBlocks = extras.footerBlocks;
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
      };
    }

    for (const { mode, bytes } of attempts) {
      const text = HwpParser._scanUtf16TextBlock(bytes, 0, 20);
      if (!text) continue;
      const paras = HwpParser._paragraphsFromText(text);
      const score = HwpParser._scoreParas(paras);
      if (score > 0) {
        console.warn('[HWP] %s: 구조 파싱 실패 → 텍스트 블록 복구 (%s)', sectionName, mode);
        return { paras, headerBlocks: [], footerBlocks: [] };
      }
    }

    return { paras: [], headerBlocks: [], footerBlocks: [] };
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
    }

    return allParas.length > 0 ? {
      paragraphs: allParas,
      headerBlocks,
      footerBlocks,
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
    w.document.write(this._wrap(getCurrentDocumentHtml()));
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

    const sync = syncEditStateFromEditor();
    if (!sync?.hasChanges) {
      applyDocumentActionState();
      return false;
    }

    const format = getFilenameExtension(state.filename);
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
      return true;
    }

    showError('현재는 .hwp 바이너리 저장을 지원하지 않습니다. HWPX 또는 OWPML로 저장해 주세요.');
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
      (page.headerBlocks || []).forEach(block => appendBlockByType(headerEl, block, { pageIndex: pi, tableIndexRef }));
      page.paragraphs.forEach(block => appendBlockByType(bodyEl, block, { pageIndex: pi, tableIndexRef }));
      (page.footerBlocks || []).forEach(block => appendBlockByType(footerEl, block, { pageIndex: pi, tableIndexRef }));

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
  pageThumbnails: $('pageThumbnails'),
  statusBar:      $('statusBar'),
  statusPageInfo: $('statusPageInfo'),
  statusFileInfo: $('statusFileInfo'),
  statusMode:     $('statusMode'),
  fileName:       $('fileName'),
};

const state = {
  doc: null,
  filename: '',
  mode: 'view',
  currentPage: 0,
  renderedPages: 1,
  editedDoc: null,
  editedHtml: '',
  editedDelta: null,
  editBaseline: '',
  hasUnsavedChanges: false,
  documentLocked: false,
  documentLockReason: '',
  fileHandle: null,
  fileSource: '',
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
  UI.statusFileInfo.textContent = `${(sizeBytes/1024).toFixed(1)} KB | ${state.doc?.meta?.pages || state.renderedPages || 1}페이지`;
}

function getSaveCurrentDisabledReason() {
  if (!state.doc) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if (state.mode !== 'edit') return '편집 모드에서 수정한 뒤 저장할 수 있습니다.';
  if (!state.hasUnsavedChanges) return '저장할 편집 내용이 없습니다.';
  if (!HwpExporter.canOverwriteFormat(getFilenameExtension(state.filename))) {
    return '현재 파일 덮어쓰기는 HWPX/OWPML 파일만 지원합니다. 다른 이름으로 저장을 사용해 주세요.';
  }
  return '';
}

function getSaveAsDisabledReason(format = UI.saveAsFormat?.value || 'hwpx') {
  if (!state.doc) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if (format === 'hwp') return '현재는 .hwp 바이너리 저장을 지원하지 않습니다. HWPX 또는 OWPML을 사용해 주세요.';
  if (format === 'pdf' && state.mode === 'edit' && state.hasUnsavedChanges) {
    return '';
  }
  return '';
}

function getPrintDisabledReason() {
  if (!state.doc) return '인쇄할 문서가 없습니다.';
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

  UI.btnEditMode.disabled = !state.doc || locked;
  UI.btnSaveCurrent.disabled = Boolean(saveCurrentReason);
  UI.btnSaveAs.disabled = Boolean(saveAsReason);
  UI.btnPrint.disabled = Boolean(printReason);

  UI.btnEditMode.title = title;
  UI.btnSaveCurrent.title = saveCurrentReason || '';
  UI.btnSaveAs.title = saveAsReason || '';
  UI.btnPrint.title = printReason || '';
  if (UI.saveAsFormat) UI.saveAsFormat.title = saveAsReason || '';
}

function ensureDocumentActionAllowed(actionLabel) {
  if (!state.doc) {
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

/* ── 버퍼 처리 (공통 코어) ── */
async function processBuffer(buffer, filename, sizeBytes, options = {}) {
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
  state.filename = filename;
  state.mode = 'view';
  state.currentPage = 0;
  state.renderedPages = doc.pages?.length || 1;
  state.editedDoc = null;
  state.editedHtml = '';
  state.editedDelta = null;
  state.editBaseline = '';
  state.hasUnsavedChanges = false;
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
function appendRunSpan(parent, run) {
  if (run.type === 'image' && run.src) {
    const img = document.createElement('img');
    img.className = 'hwp-inline-image';
    img.src = run.src;
    img.alt = run.alt || 'image';
    const isHwpImage = run.sourceFormat === 'hwp';
    const widthPx = isHwpImage
      ? hwpUnitToPx(run.width, 12, 240, 1 / 75, 18)
      : hwpUnitToPx(run.width, 12, 180, 1 / 26, 18);
    const heightPx = isHwpImage
      ? hwpUnitToPx(run.height, 12, 180, 1 / 75, 12)
      : hwpUnitToPx(run.height, 12, 180, 1 / 26, 12);
    if (widthPx) img.style.width = `${widthPx}px`;
    if (heightPx) img.style.height = `${heightPx}px`;
    if ((Number(run.offsetX) || 0) > 20000) {
      img.style.display = 'block';
      img.style.marginLeft = 'auto';
      img.style.marginRight = '0';
    } else {
      applyImageOffsetStyles(img, run, true);
    }
    parent.appendChild(img);
    return;
  }

  const span = document.createElement('span');
  span.textContent = run.text;
  const effectiveFontSize = resolveRunFontSize(run);
  if (run.bold)      span.style.fontWeight = 'bold';
  if (run.italic)    span.style.fontStyle = 'italic';
  if (run.underline) span.style.textDecoration = 'underline';
  if (effectiveFontSize > 0) span.style.fontSize = `${effectiveFontSize}pt`;
  if (run.fontName)  span.style.fontFamily = `'${run.fontName}', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif`;
  if (run.color && run.color !== '#000000') span.style.color = run.color;
  if (Number.isFinite(run.letterSpacing) && run.letterSpacing !== 0) {
    const letterSpacing = Math.max(-0.5, Math.min(0.5, run.letterSpacing / 100));
    span.style.letterSpacing = `${letterSpacing}em`;
  }
  if (Number.isFinite(run.offsetY) && run.offsetY !== 0) {
    span.style.position = 'relative';
    span.style.top = `${Math.max(-1, Math.min(1, run.offsetY / 100))}em`;
  }
  if (Number.isFinite(run.scaleX) && run.scaleX > 0 && run.scaleX !== 100) {
    span.style.display = 'inline-block';
    span.style.transformOrigin = 'left center';
    span.style.fontStretch = `${Math.max(50, Math.min(200, run.scaleX))}%`;
    span.style.transform = `scaleX(${Math.max(0.5, Math.min(2, run.scaleX / 100))})`;
  }
  parent.appendChild(span);
}

function appendParagraphBlock(parent, para, className = '', options = {}) {
  const {
    alignOverride = '',
    role = '',
    rowRole = '',
    cellRole = '',
  } = options;
  const effectiveRole = role || para?.role || '';
  const p = document.createElement('p');
  p.className = className;
  if (effectiveRole) p.dataset.role = effectiveRole;
  if (rowRole) p.dataset.rowRole = rowRole;
  if (cellRole) p.dataset.cellRole = cellRole;

  const textContent = (para.texts || []).map(run => run.text || '').join('');
  p.style.textAlign = alignOverride || para.align || 'left';
  if (/[\n\t]| {2,}/.test(textContent)) {
    p.style.whiteSpace = 'pre-wrap';
    p.style.tabSize = '4';
  }
  if (Number.isFinite(para.marginLeft) && !['center', 'right'].includes(p.style.textAlign)) {
    p.style.paddingLeft = `${Math.max(0, hwpSignedPageUnitToPx(para.marginLeft, -24, 220, 0))}px`;
  }
  if (Number.isFinite(para.marginRight) && para.marginRight > 0) {
    p.style.paddingRight = `${hwpSignedPageUnitToPx(para.marginRight, 0, 220, 0)}px`;
  }
  if (Number.isFinite(para.textIndent) && !['center', 'right'].includes(p.style.textAlign)) {
    p.style.textIndent = `${hwpSignedPageUnitToPx(para.textIndent, -120, 160, 0)}px`;
  }
  if (Number.isFinite(para.spacingBefore) && para.spacingBefore > 0) {
    p.style.marginTop = `${hwpPageUnitToPx(para.spacingBefore, 0, 56, 0)}px`;
  }
  if (Number.isFinite(para.spacingAfter) && para.spacingAfter > 0) {
    p.style.marginBottom = `${hwpPageUnitToPx(para.spacingAfter, 0, 56, 4)}px`;
  }
  const resolvedLineHeight = resolveParagraphLineHeight(para);
  if (resolvedLineHeight) {
    p.style.lineHeight = resolvedLineHeight;
  } else if (Number.isFinite(para.lineHeightPx) && para.lineHeightPx > 0) {
    p.style.lineHeight = `${para.lineHeightPx}px`;
  }
  if (Number.isFinite(para.layoutHeightPx) && para.layoutHeightPx > 0) {
    p.style.minHeight = `${para.layoutHeightPx}px`;
  }

  if (/^\s*※\s*본적\s*:/.test(textContent)) {
    p.classList.add('hwp-origin-label');
    p.style.fontWeight = '600';
    p.style.marginBottom = '16px';
  }

  if (effectiveRole === 'title-label') {
    p.style.textAlign = 'center';
    p.style.fontWeight = '500';
    p.style.letterSpacing = '0.01em';
    p.style.lineHeight = '1.06';
  } else if (effectiveRole === 'title-option-item') {
    p.style.textAlign = 'left';
    p.style.lineHeight = '1.04';
  } else if (effectiveRole === 'process-period') {
    p.style.textAlign = 'center';
    p.style.fontWeight = '600';
    p.style.lineHeight = '1.18';
  } else if (effectiveRole === 'field-label') {
    p.style.fontWeight = '400';
    p.style.lineHeight = '1.12';
    p.style.whiteSpace = 'nowrap';
  } else if (effectiveRole === 'field-inline-note') {
    p.style.textAlign = 'center';
    p.style.lineHeight = '1.12';
  } else if (effectiveRole === 'stacked-label') {
    p.style.textAlign = 'center';
    p.style.lineHeight = '1.06';
    p.style.whiteSpace = 'pre-line';
    p.style.letterSpacing = '-0.01em';
  } else if (effectiveRole === 'page-number') {
    p.classList.add('hwp-page-number');
    p.style.textAlign = para.align || 'center';
    p.style.fontSize = '12px';
    p.style.letterSpacing = '0.08em';
    p.style.color = '#475569';
    p.style.marginBottom = '0';
  }

  const normalizedProcessText = effectiveRole === 'process-period'
    ? textContent.replace(/(\d+)\s+일/g, '$1일')
    : textContent;
  const hasRenderableRuns = (para.texts || []).some(run => (
    run.type === 'image' || String(run.text || '') !== ''
  ));

  if (!hasRenderableRuns) {
    p.innerHTML = '&nbsp;';
  } else if (effectiveRole === 'process-period' && normalizedProcessText && normalizedProcessText !== textContent) {
    p.textContent = normalizedProcessText;
  } else {
    para.texts.forEach(run => appendRunSpan(p, run));
  }

  parent.appendChild(p);
}

function appendImageBlock(parent, block, className = '') {
  const wrap = document.createElement('div');
  wrap.className = `hwp-image-block${className ? ` ${className}` : ''}`;
  wrap.dataset.align = block.horzAlign || block.align || 'center';
  if (block.inline) wrap.dataset.inline = 'true';
  const treatLargeOffsetAsRightAligned = (Number(block.offsetX) || 0) > 20000
    && (block.align || 'left') === 'left';
  if (treatLargeOffsetAsRightAligned) {
    wrap.dataset.align = 'right';
  }

  const img = document.createElement('img');
  img.className = 'hwp-image';
  img.src = block.src;
  img.alt = block.alt || 'image';

  const isHwpImage = block.sourceFormat === 'hwp';
  const widthPx = isHwpImage
    ? hwpUnitToPx(block.width, 24, 720, 1 / 75, 0)
    : hwpUnitToPx(block.width, 24, 720, 1 / 26, 0);
  const heightPx = isHwpImage
    ? hwpUnitToPx(block.height, 24, 960, 1 / 75, 0)
    : hwpUnitToPx(block.height, 24, 960, 1 / 26, 0);
  if (widthPx) img.style.width = `${widthPx}px`;
  if (heightPx) img.style.maxHeight = `${heightPx}px`;
  if (block.inline && !treatLargeOffsetAsRightAligned) {
    applyImageOffsetStyles(img, block, false);
  }

  wrap.appendChild(img);
  parent.appendChild(wrap);
  registerPlacedBlock(wrap, img, block);
}

function appendObjectTextBlock(parent, block, kind = 'equation', className = '') {
  const wrap = document.createElement('div');
  wrap.className = `hwp-object-block hwp-${kind}-block${className ? ` ${className}` : ''}`;
  wrap.dataset.align = block.horzAlign || block.align || 'left';
  if (block.inline) wrap.dataset.inline = 'true';

  const box = document.createElement('div');
  box.className = `hwp-${kind}`;
  box.textContent = HwpParser._blockText(block).trim() || (kind === 'equation' ? '[수식]' : '[OLE 개체]');

  if (kind === 'equation') {
    const firstRun = (block.texts || [])[0] || {};
    if (firstRun.fontName) {
      box.style.fontFamily = `'${firstRun.fontName}', 'Cambria Math', 'Times New Roman', serif`;
    }
    if (firstRun.color && firstRun.color !== '#000000') {
      box.style.color = firstRun.color;
    }
    if (firstRun.fontSize) {
      box.style.fontSize = `${Math.max(13, Math.min(28, Number(firstRun.fontSize) || 14))}pt`;
    }
  }

  const widthPx = block.sourceFormat === 'hwp'
    ? hwpUnitToPx(block.width, 48, 720, 1 / 75, 0)
    : 0;
  if (widthPx > 0) {
    box.style.maxWidth = `${widthPx}px`;
  }
  if (block.inline) {
    applyImageOffsetStyles(box, block, false);
  }

  if (block.description) {
    box.title = block.description;
  }

  wrap.appendChild(box);
  parent.appendChild(wrap);
  registerPlacedBlock(wrap, box, block);
}

function appendBlockByType(parent, block, context = {}) {
  const {
    pageIndex = Number(parent?.dataset?.pageIndex ?? 0),
    tableIndexRef = { value: 0 },
  } = context;

  if (block.type === 'table') {
    appendTableBlock(parent, block, {
      pageIndex,
      tableIndex: tableIndexRef.value,
      isFirstTableOnFirstPage: pageIndex === 0 && tableIndexRef.value === 0,
    });
    tableIndexRef.value += 1;
    return;
  }

  if (block.type === 'image') {
    appendImageBlock(parent, block);
    return;
  }

  if (block.type === 'equation') {
    appendObjectTextBlock(parent, block, 'equation');
    return;
  }

  if (block.type === 'ole') {
    appendObjectTextBlock(parent, block, 'ole');
    return;
  }

  appendParagraphBlock(parent, block);
}

function getCellTextInline(cell) {
  return HwpParser._cellText(cell).replace(/\s+/g, ' ').trim();
}

function getStackedHangulLabelLines(text) {
  const tokens = String(text || '')
    .replace(/\n+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 4 || tokens.length > 8) return null;
  if (!tokens.every(token => /^[가-힣]$/.test(token))) return null;

  const lines = [];
  for (let i = 0; i < tokens.length; i += 2) {
    lines.push(tokens.slice(i, i + 2).join(' '));
  }
  return lines.filter(Boolean);
}

function getParagraphText(para) {
  return (para?.texts || []).map(run => run.text || '').join('');
}

function hwpUnitToPx(value, minPx, maxPx, scale, fallbackPx = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallbackPx;
  const px = Math.round(num * scale);
  return Math.max(minPx, Math.min(maxPx, px));
}

function hwpSignedUnitToPx(value, minPx, maxPx, scale, fallbackPx = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallbackPx;
  const px = Math.round(num * scale);
  return Math.max(minPx, Math.min(maxPx, px));
}

function hwpPageUnitToPx(value, minPx, maxPx, fallbackPx = 0) {
  return hwpUnitToPx(value, minPx, maxPx, 1 / 106, fallbackPx);
}

function hwpSignedPageUnitToPx(value, minPx, maxPx, fallbackPx = 0) {
  return hwpSignedUnitToPx(value, minPx, maxPx, 1 / 106, fallbackPx);
}

function objectUnitScale(block, kind = 'size') {
  if (block?.sourceFormat === 'hwpx') {
    return kind === 'position' ? (1 / 75) : (1 / 26);
  }
  return 1 / 75;
}

function objectUnitToPx(block, value, minPx, maxPx, fallbackPx = 0, kind = 'size') {
  return hwpUnitToPx(value, minPx, maxPx, objectUnitScale(block, kind), fallbackPx);
}

function objectSignedUnitToPx(block, value, minPx, maxPx, fallbackPx = 0, kind = 'size') {
  return hwpSignedUnitToPx(value, minPx, maxPx, objectUnitScale(block, kind), fallbackPx);
}

function resolveRunFontSize(run) {
  const baseFontSize = Math.max(0, Number(run?.fontSize) || 0);
  const relSize = Number.isFinite(Number(run?.relSize)) && Number(run?.relSize) > 0
    ? Number(run.relSize) / 100
    : 1;
  return baseFontSize > 0 ? Math.round(baseFontSize * relSize * 10) / 10 : 0;
}

function paragraphBaseFontPx(para) {
  const fontPt = Math.max(
    10.5,
    ...(para?.texts || []).map(run => Math.max(0, resolveRunFontSize(run))),
  );
  return fontPt * (96 / 72);
}

function resolveParagraphLineHeight(para) {
  const spacing = Number(para?.lineSpacing) || 0;
  if (spacing <= 0) return '';

  const type = HwpParser._normalizeLineSpacingType(para?.lineSpacingType) || 'percent';
  const baseFontPx = paragraphBaseFontPx(para);

  if (type === 'fixed') {
    const px = hwpPageUnitToPx(spacing, 0, 140, 0);
    return px > 0 ? `${px}px` : '';
  }

  if (type === 'minimum') {
    const minPx = hwpPageUnitToPx(spacing, 0, 140, 0);
    return `${Math.max(Math.round(baseFontPx * 1.2), minPx)}px`;
  }

  if (type === 'space-only') {
    const extraPx = hwpPageUnitToPx(spacing, 0, 80, 0);
    return `${Math.max(Math.round(baseFontPx * 1.2), Math.round(baseFontPx + extraPx))}px`;
  }

  return `${Math.max(1, Math.min(4, spacing / 100))}`;
}

function applyImageOffsetStyles(el, imageLike, inline = false) {
  const offsetX = Number(imageLike?.offsetX) || 0;
  const offsetY = Number(imageLike?.offsetY) || 0;
  const translateX = hwpSignedUnitToPx(offsetX, inline ? -280 : -520, inline ? 280 : 520, 1 / 106, 0);
  const translateY = hwpSignedUnitToPx(offsetY, -120, 120, 1 / 106, 0);
  if (!translateX && !translateY) return;
  el.style.transform = `translate(${translateX}px, ${translateY}px)`;
}

function hasPlacedBlockMetadata(block) {
  return Boolean(block) && (
    block.inline !== undefined
    || block.horzRelTo
    || block.vertRelTo
    || block.textWrap
    || Number(block.offsetX)
    || Number(block.offsetY)
    || Number(block.zOrder)
  );
}

function objectMarginPx(block) {
  const margin = Array.isArray(block?.outMargin) && block.outMargin.length >= 4
    ? block.outMargin
    : (Array.isArray(block?.margin) ? block.margin : []);
  return {
    left: objectUnitToPx(block, margin[0], 0, 96, 0, 'position'),
    right: objectUnitToPx(block, margin[1], 0, 96, 0, 'position'),
    top: objectUnitToPx(block, margin[2], 0, 96, 0, 'position'),
    bottom: objectUnitToPx(block, margin[3], 0, 96, 0, 'position'),
  };
}

function objectOffsetPx(block) {
  return {
    x: objectSignedUnitToPx(block, block?.offsetX, -720, 720, 0, 'position'),
    y: objectSignedUnitToPx(block, block?.offsetY, -720, 720, 0, 'position'),
  };
}

function measureElementSize(el, axis = 'width') {
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (axis === 'height') {
    return Math.max(el.clientHeight || 0, el.scrollHeight || 0, rect.height || 0);
  }
  return Math.max(el.clientWidth || 0, el.scrollWidth || 0, rect.width || 0);
}

function resolvePlacedBlockContext(wrap) {
  return {
    pageEl: wrap.closest('.hwp-page'),
    areaEl: wrap.closest('.hwp-page-header, .hwp-page-body, .hwp-page-footer'),
    cellContentEl: wrap.closest('.hwp-table-cell-content'),
    parentEl: wrap.parentElement,
  };
}

function resolvePositionBasisElement(wrap, block, axis = 'horz', context = resolvePlacedBlockContext(wrap)) {
  const relTo = HwpParser._normalizeObjectRelTo(
    axis === 'horz' ? block?.horzRelTo : block?.vertRelTo,
    axis,
  );
  if (relTo === 'paper' || relTo === 'page') {
    return context.pageEl || context.areaEl || context.parentEl || wrap.parentElement;
  }
  if (relTo === 'column') {
    return context.areaEl || context.parentEl || context.pageEl || wrap.parentElement;
  }
  return context.cellContentEl || context.parentEl || context.areaEl || context.pageEl || wrap.parentElement;
}

function resolveSizeBasisElement(wrap, block, axis = 'width', context = resolvePlacedBlockContext(wrap)) {
  const relTo = HwpParser._normalizeObjectSizeRelTo(
    axis === 'width' ? block?.widthRelTo : block?.heightRelTo,
    axis,
  );
  if (relTo === 'paper') {
    return context.pageEl || context.areaEl || context.parentEl || wrap.parentElement;
  }
  if (relTo === 'page') {
    return context.areaEl || context.pageEl || context.parentEl || wrap.parentElement;
  }
  if (relTo === 'column') {
    return context.areaEl || context.parentEl || context.pageEl || wrap.parentElement;
  }
  if (relTo === 'para') {
    return context.cellContentEl || context.parentEl || context.areaEl || context.pageEl || wrap.parentElement;
  }
  return context.parentEl || context.areaEl || context.pageEl || wrap.parentElement;
}

function resolveRelativeMetricRatio(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= 400) return value / 100;
  if (value <= 4000) return value / 1000;
  return value / 10000;
}

function resolveObjectMetricPx(wrap, block, axis = 'width', context = resolvePlacedBlockContext(wrap)) {
  const value = Number(axis === 'width' ? block?.width : block?.height);
  if (!Number.isFinite(value) || value <= 0) return 0;

  const relTo = HwpParser._normalizeObjectSizeRelTo(
    axis === 'width' ? block?.widthRelTo : block?.heightRelTo,
    axis,
  );
  if (relTo === 'absolute') {
    return axis === 'width'
      ? objectUnitToPx(block, value, 24, 960, 0)
      : objectUnitToPx(block, value, 24, 1280, 0);
  }

  const basisEl = resolveSizeBasisElement(wrap, block, axis, context);
  const basisSize = measureElementSize(basisEl, axis);
  const ratio = resolveRelativeMetricRatio(value);
  if (!basisSize || !ratio) return 0;
  const px = Math.round(basisSize * ratio);
  return Math.max(24, Math.min(axis === 'width' ? 960 : 1280, px));
}

function applyPlacedBlockSizing(wrap, contentEl, block) {
  // HWP/HWPX 개체는 절대값뿐 아니라 페이지/본문/문단 기준 상대 크기를 함께 쓴다.
  const context = resolvePlacedBlockContext(wrap);
  const widthPx = resolveObjectMetricPx(wrap, block, 'width', context);
  const heightPx = resolveObjectMetricPx(wrap, block, 'height', context);

  wrap.style.width = '';
  wrap.style.maxWidth = '';
  wrap.style.minHeight = '';

  if (widthPx > 0) {
    if (block?.type === 'table') {
      wrap.style.width = `${widthPx}px`;
      wrap.style.maxWidth = '100%';
      contentEl.style.width = '100%';
    } else if (contentEl.tagName === 'IMG') {
      contentEl.style.width = `${widthPx}px`;
      contentEl.style.maxWidth = `${widthPx}px`;
    } else {
      contentEl.style.width = `${widthPx}px`;
      contentEl.style.maxWidth = `${widthPx}px`;
    }
  }

  if (heightPx > 0) {
    if (contentEl.tagName === 'IMG') {
      contentEl.style.maxHeight = `${heightPx}px`;
    } else if (block?.type === 'table') {
      wrap.style.minHeight = `${heightPx}px`;
    } else {
      contentEl.style.minHeight = `${heightPx}px`;
    }
  }
}

function offsetWithinAncestor(sourceEl, ancestorEl) {
  if (!sourceEl || !ancestorEl || sourceEl === ancestorEl) {
    return { left: 0, top: 0 };
  }
  const sourceRect = sourceEl.getBoundingClientRect();
  const ancestorRect = ancestorEl.getBoundingClientRect();
  return {
    left: sourceRect.left - ancestorRect.left,
    top: sourceRect.top - ancestorRect.top,
  };
}

function resolvePlacementAnchorElement(wrap, block, context = resolvePlacedBlockContext(wrap)) {
  const horzRelTo = HwpParser._normalizeObjectRelTo(block?.horzRelTo, 'horz');
  const vertRelTo = HwpParser._normalizeObjectRelTo(block?.vertRelTo, 'vert');
  if (['paper', 'page'].includes(horzRelTo) || ['paper', 'page'].includes(vertRelTo)) {
    return context.pageEl || context.areaEl || context.parentEl || wrap.parentElement;
  }
  return context.cellContentEl || context.parentEl || context.areaEl || context.pageEl || wrap.parentElement;
}

function registerPlacedBlock(wrap, contentEl, block) {
  if (!wrap || !contentEl || !hasPlacedBlockMetadata(block) || block.inline) return;
  wrap.dataset.hwpPlacedBlock = '1';
  wrap.__hwpBlock = block;
  wrap.__hwpContentEl = contentEl;
  if (contentEl.tagName === 'IMG' && !contentEl.complete) {
    contentEl.addEventListener('load', () => {
      const pageEl = wrap.closest('.hwp-page');
      if (pageEl) applyDeferredObjectLayouts(pageEl);
    }, { once: true });
  }
}

function resetPlacedBlockStyles(wrap) {
  wrap.style.position = '';
  wrap.style.left = '';
  wrap.style.top = '';
  wrap.style.right = '';
  wrap.style.bottom = '';
  wrap.style.width = '';
  wrap.style.maxWidth = '';
  wrap.style.minHeight = '';
  wrap.style.zIndex = '';
  wrap.style.float = '';
  wrap.style.clear = '';
  wrap.style.transform = '';
  wrap.style.margin = '';
  wrap.style.marginLeft = '';
  wrap.style.marginRight = '';
  wrap.style.marginTop = '';
  wrap.style.marginBottom = '';
  wrap.style.overflow = '';
}

function resolveAlignedCoordinate(align, containerSize, objectSize, axis = 'horz') {
  const normalized = HwpParser._normalizeObjectAlign(align, axis);
  if (normalized === 'center') {
    return Math.max(0, (containerSize - objectSize) / 2);
  }
  if (normalized === 'right' || normalized === 'bottom' || normalized === 'outside') {
    return Math.max(0, containerSize - objectSize);
  }
  return 0;
}

function shouldAbsolutePlaceBlock(block) {
  if (!block || block.inline) return false;
  const wrapMode = HwpParser._normalizeObjectTextWrap(block.textWrap);
  const horzRelTo = HwpParser._normalizeObjectRelTo(block.horzRelTo, 'horz');
  const vertRelTo = HwpParser._normalizeObjectRelTo(block.vertRelTo, 'vert');
  return ['paper', 'page'].includes(horzRelTo)
    || ['paper', 'page'].includes(vertRelTo)
    || ['behind-text', 'in-front-of-text'].includes(wrapMode)
    || Boolean(block.allowOverlap && !block.flowWithText);
}

function applyPlacedBlockFlowStyles(wrap, block) {
  const margins = objectMarginPx(block);
  const offsets = objectOffsetPx(block);
  const wrapMode = HwpParser._normalizeObjectTextWrap(block.textWrap);
  const horzAlign = HwpParser._normalizeObjectAlign(block.horzAlign || block.align, 'horz');
  const textFlow = HwpParser._normalizeObjectTextFlow(block.textFlow);

  wrap.style.margin = `${margins.top}px ${margins.right}px ${margins.bottom}px ${margins.left}px`;
  if (wrapMode === 'top-and-bottom') {
    wrap.style.clear = 'both';
  }
  if (['square', 'tight', 'through'].includes(wrapMode)) {
    const flowSide = textFlow === 'left-only'
      ? 'right'
      : textFlow === 'right-only'
        ? 'left'
        : ((horzAlign === 'right' || horzAlign === 'outside') ? 'right' : horzAlign);

    if (flowSide === 'right' || flowSide === 'outside') {
      wrap.style.float = 'right';
      if (!margins.left) wrap.style.marginLeft = '12px';
    } else if (flowSide === 'center') {
      wrap.style.marginLeft = 'auto';
      wrap.style.marginRight = 'auto';
    } else {
      wrap.style.float = 'left';
      if (!margins.right) wrap.style.marginRight = '12px';
    }
  } else if (horzAlign === 'right' || horzAlign === 'outside') {
    wrap.style.marginLeft = 'auto';
  } else if (horzAlign === 'center') {
    wrap.style.marginLeft = 'auto';
    wrap.style.marginRight = 'auto';
  }

  if (offsets.x || offsets.y) {
    wrap.style.transform = `translate(${offsets.x}px, ${offsets.y}px)`;
  }
}

function applyPlacedBlockAbsoluteStyles(wrap, contentEl, block) {
  const context = resolvePlacedBlockContext(wrap);
  const anchorEl = resolvePlacementAnchorElement(wrap, block, context);
  if (!anchorEl) return;

  // page/paper 기준 개체는 실제 DOM 부모도 페이지 앵커로 옮겨야 좌표계가 맞는다.
  if (wrap.parentElement !== anchorEl) {
    anchorEl.appendChild(wrap);
  }

  const contentRect = contentEl.getBoundingClientRect();
  const margins = objectMarginPx(block);
  const offsets = objectOffsetPx(block);
  const horzAlign = HwpParser._normalizeObjectAlign(block.horzAlign || block.align, 'horz');
  const vertAlign = HwpParser._normalizeObjectAlign(block.vertAlign, 'vert');
  const horzBasisEl = resolvePositionBasisElement(wrap, block, 'horz', context);
  const vertBasisEl = resolvePositionBasisElement(wrap, block, 'vert', context);
  const horzBasisOffset = offsetWithinAncestor(horzBasisEl, anchorEl);
  const vertBasisOffset = offsetWithinAncestor(vertBasisEl, anchorEl);
  const anchorWidth = Math.max(measureElementSize(horzBasisEl, 'width'), contentRect.width);
  const anchorHeight = Math.max(measureElementSize(vertBasisEl, 'height'), contentRect.height);
  const objectWidth = Math.max(contentRect.width, contentEl.scrollWidth || 0, 24);
  const objectHeight = Math.max(contentRect.height, contentEl.scrollHeight || 0, 24);

  let left = horzBasisOffset.left + resolveAlignedCoordinate(horzAlign, anchorWidth, objectWidth, 'horz') + offsets.x;
  let top = vertBasisOffset.top + resolveAlignedCoordinate(vertAlign, anchorHeight, objectHeight, 'vert') + offsets.y;
  left += margins.left;
  top += margins.top;
  if (horzAlign === 'right' || horzAlign === 'outside') left -= margins.right;
  if (vertAlign === 'bottom' || vertAlign === 'outside') top -= margins.bottom;

  wrap.style.position = 'absolute';
  wrap.style.left = `${Math.round(left)}px`;
  wrap.style.top = `${Math.round(top)}px`;
  wrap.style.margin = '0';
  wrap.style.float = 'none';
  wrap.style.clear = 'none';
  wrap.style.transform = '';
  wrap.style.overflow = 'visible';
  wrap.style.zIndex = `${Math.max(1, 100 + (Number(block.zOrder) || 0))}`;
  if (anchorEl.style.position !== 'relative' && anchorEl.style.position !== 'absolute') {
    anchorEl.style.position = 'relative';
  }
}

function applyDeferredObjectLayouts(root = document) {
  const scope = root instanceof Element || root instanceof Document ? root : document;
  scope.querySelectorAll('[data-hwp-placed-block="1"]').forEach(wrap => {
    const block = wrap.__hwpBlock;
    const contentEl = wrap.__hwpContentEl || wrap.firstElementChild;
    if (!block || !contentEl) return;
    resetPlacedBlockStyles(wrap);
    applyPlacedBlockSizing(wrap, contentEl, block);
    applyPlacedBlockFlowStyles(wrap, block);
    if (shouldAbsolutePlaceBlock(block)) {
      applyPlacedBlockAbsoluteStyles(wrap, contentEl, block);
    }
  });
}

function hwpxGradientToCss(fillGradient) {
  if (!fillGradient?.colors?.length) return '';
  const colors = fillGradient.colors.filter(Boolean);
  if (colors.length < 2) return '';
  const angle = Number.isFinite(Number(fillGradient.angle))
    ? (90 - Number(fillGradient.angle))
    : 90;
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`;
}

function resolveHwpxPageBorder(pageStyle, pageIndex) {
  const defs = pageStyle?.pageBorderFills || [];
  if (!defs.length) return null;
  const pageNo = pageIndex + 1;
  return defs.find(def => def.type === 'FIRST' && pageNo === 1)
    || defs.find(def => def.type === 'FIRST_PAGE' && pageNo === 1)
    || defs.find(def => def.type === 'ODD' && pageNo % 2 === 1)
    || defs.find(def => def.type === 'EVEN' && pageNo % 2 === 0)
    || defs.find(def => def.type === 'BOTH')
    || defs[0]
    || null;
}

function applyPageStyle(pageEl, page, pageIndex) {
  const pageStyle = page?.pageStyle;
  if (!pageStyle || pageStyle.sourceFormat !== 'hwpx') return;

  const pageBorder = resolveHwpxPageBorder(pageStyle, pageIndex);
  const borderOffset = pageBorder?.offset || {};
  const margins = pageStyle.margins || {};

  pageEl.dataset.sourceFormat = 'hwpx';
  pageEl.style.width = `${hwpPageUnitToPx(pageStyle.width, 680, 860, 794)}px`;
  pageEl.style.minHeight = `${hwpPageUnitToPx(pageStyle.height, 980, 1280, 1123)}px`;
  pageEl.style.paddingTop = `${hwpPageUnitToPx((margins.top || 0) + (borderOffset.top || 0), 22, 72, 28)}px`;
  pageEl.style.paddingRight = `${hwpPageUnitToPx((margins.right || 0) + (borderOffset.right || 0), 28, 96, 54)}px`;
  pageEl.style.paddingBottom = `${hwpPageUnitToPx((margins.bottom || 0) + (borderOffset.bottom || 0), 24, 80, 30)}px`;
  pageEl.style.paddingLeft = `${hwpPageUnitToPx((margins.left || 0) + (borderOffset.left || 0), 28, 96, 56)}px`;

  const borderStyle = pageBorder?.borderStyle;
  if (borderStyle) {
    [
      ['Left', borderStyle.left],
      ['Right', borderStyle.right],
      ['Top', borderStyle.top],
      ['Bottom', borderStyle.bottom],
    ].forEach(([side, spec]) => {
      const cssType = hwpxBorderTypeToCss(spec?.type);
      if (cssType === 'none') return;
      pageEl.style[`border${side}Style`] = cssType;
      pageEl.style[`border${side}Width`] = hwpxBorderWidthToPx(spec?.widthMm);
      if (spec?.color) pageEl.style[`border${side}Color`] = spec.color;
    });

    const gradient = hwpxGradientToCss(borderStyle.fillGradient);
    if (gradient) {
      pageEl.style.background = gradient;
    } else if (borderStyle.fillColor) {
      pageEl.style.backgroundColor = borderStyle.fillColor;
    }
  }
}

function hwpxBorderTypeToCss(type) {
  switch (String(type || '').toUpperCase()) {
    case 'SOLID': return 'solid';
    case 'DASH':
    case 'LONG_DASH':
    case 'DASH_DOT':
    case 'DASH_DOT_DOT':
      return 'dashed';
    case 'DOT':
      return 'dotted';
    case 'DOUBLE':
    case 'DOUBLE_SLIM':
      return 'double';
    default:
      return 'none';
  }
}

function hwpxBorderWidthToPx(widthMm) {
  const mm = Number(widthMm);
  if (!Number.isFinite(mm) || mm <= 0) return '0px';
  return `${Math.max(0.8, Math.min(4, Math.round(mm * 3.78 * 10) / 10))}px`;
}

function applyCellBorderStyle(td, cell) {
  const borderStyle = cell?.borderStyle;
  if (!borderStyle) return;

  [
    ['Left', borderStyle.left],
    ['Right', borderStyle.right],
    ['Top', borderStyle.top],
    ['Bottom', borderStyle.bottom],
  ].forEach(([side, spec]) => {
    const cssType = hwpxBorderTypeToCss(spec?.type);
    if (cssType === 'none') {
      td.style[`border${side}`] = 'none';
      return;
    }
    td.style[`border${side}Style`] = cssType;
    td.style[`border${side}Width`] = hwpxBorderWidthToPx(spec?.widthMm);
    if (spec?.color) td.style[`border${side}Color`] = spec.color;
  });

  const gradient = hwpxGradientToCss(borderStyle.fillGradient);
  if (gradient) {
    td.style.background = gradient;
  } else if (borderStyle.fillColor) {
    td.style.backgroundColor = borderStyle.fillColor;
  }
}

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

function buildSyntheticRow(baseRow, cells, syntheticRowRole = 'body') {
  let colCursor = 0;
  return {
    ...(baseRow || {}),
    syntheticRowRole,
    cells: cells.map(cell => {
      const next = cloneTableCell(cell, {
        row: baseRow?.index ?? 0,
        col: colCursor,
      });
      colCursor += Number(next.colSpan) || 1;
      return next;
    }),
  };
}

function scaleSpans(total, bases) {
  const safeTotal = Math.max(1, Number(total) || bases.reduce((sum, base) => sum + base, 0) || 1);
  const baseSum = bases.reduce((sum, base) => sum + base, 0) || 1;
  const spans = bases.map((base, index) => {
    if (index === bases.length - 1) return 0;
    return Math.max(1, Math.round((safeTotal * base) / baseSum));
  });
  const used = spans.reduce((sum, span) => sum + span, 0);
  spans[spans.length - 1] = Math.max(1, safeTotal - used);
  return spans;
}

function createSyntheticTextCell(baseCell, text, colSpan, syntheticRole = 'body') {
  return cloneTableCell(baseCell, {
    colSpan,
    syntheticRole,
    paragraphs: [HwpParser._createParagraphBlock(text)],
  });
}

function createSyntheticParagraphCell(baseCell, lines, colSpan, syntheticRole = 'body') {
  return cloneTableCell(baseCell, {
    colSpan,
    syntheticRole,
    paragraphs: (lines || ['']).map(line => HwpParser._createParagraphBlock(line)),
  });
}

function createSyntheticBlankCell(baseCell, colSpan, syntheticRole = 'field-input') {
  return cloneTableCell(baseCell, {
    colSpan,
    syntheticRole,
    paragraphs: [HwpParser._createParagraphBlock('')],
  });
}

function normalizeApplicationFormRows(tableBlock, rows) {
  if (!rows?.length) return rows || [];

  const normalizedRows = [];
  rows.forEach(row => {
    const cells = [...(row.cells || [])].sort((a, b) => a.col - b.col);
    if (!cells.length) return;

    const rowText = cells.map(cell => getCellTextInline(cell)).join(' ');
    const totalSpan = cells.reduce((sum, cell) => sum + (Number(cell.colSpan) || 1), 0);

    if (/①/.test(rowText) && /②/.test(rowText) && /③/.test(rowText) && cells.length >= 6) {
      const upperSpans = scaleSpans(totalSpan, [4, 10, 8, 10]);
      const lowerSpans = scaleSpans(totalSpan, [4, 18, 10]);
      normalizedRows.push(
        buildSyntheticRow(row, [
          createSyntheticTextCell(cells[0], '①성명', upperSpans[0], 'field-label'),
          createSyntheticBlankCell(cells[1], upperSpans[1]),
          createSyntheticTextCell(cells[2], '②주민등록번호', upperSpans[2], 'field-label'),
          createSyntheticBlankCell(cells[3], upperSpans[3]),
        ], 'person-form-upper'),
      );
      normalizedRows.push(
        buildSyntheticRow(row, [
          createSyntheticTextCell(cells[4], '③주소', lowerSpans[0], 'field-label'),
          createSyntheticBlankCell(cells[1], lowerSpans[1]),
          cloneTableCell(cells[5], {
            colSpan: lowerSpans[2],
            syntheticRole: 'field-inline-note',
          }),
        ], 'person-form-lower'),
      );
      return;
    }

    if (/④/.test(rowText) && /⑤/.test(rowText) && /⑥/.test(rowText) && /⑦/.test(rowText) && cells.length >= 8) {
      const rowSpans = scaleSpans(totalSpan, [4, 12, 4, 12]);
      normalizedRows.push(
        buildSyntheticRow(row, [
          createSyntheticTextCell(cells[0], '④입대일자', rowSpans[0], 'field-label'),
          createSyntheticBlankCell(cells[1], rowSpans[1]),
          createSyntheticTextCell(cells[2], '⑤계급', rowSpans[2], 'field-label'),
          createSyntheticBlankCell(cells[3], rowSpans[3]),
        ], 'military-form-upper'),
      );
      normalizedRows.push(
        buildSyntheticRow(row, [
          createSyntheticTextCell(cells[4], '⑥군별', rowSpans[0], 'field-label'),
          createSyntheticBlankCell(cells[5], rowSpans[1]),
          createSyntheticTextCell(cells[6], '⑦군번', rowSpans[2], 'field-label'),
          createSyntheticBlankCell(cells[7], rowSpans[3]),
        ], 'military-form-lower'),
      );
      return;
    }

    if (/⑧질병명/.test(rowText) && cells.length >= 5) {
      const diseaseSpans = scaleSpans(totalSpan, [4, 9, 9, 10]);
      normalizedRows.push(
        buildSyntheticRow(row, [
          createSyntheticTextCell(cells[0], '⑧질병명', diseaseSpans[0], 'field-label'),
          cloneTableCell(cells[1], { colSpan: diseaseSpans[1] }),
          cloneTableCell(cells[2], { colSpan: diseaseSpans[2] }),
          cloneTableCell(cells[3], { colSpan: diseaseSpans[3] }),
        ], 'body'),
      );
      return;
    }

    if (/⑬/.test(rowText) && /⑭/.test(rowText) && /⑮/.test(rowText) && cells.length >= 6) {
      const familyHeaderSpans = scaleSpans(totalSpan, [8, 4, 9, 3, 3, 5]);
      normalizedRows.push(
        buildSyntheticRow(row, [
          createSyntheticParagraphCell(cells[0], ['⑬고엽제후유(의)증', '환자 등과의 관계'], familyHeaderSpans[0], 'field-label'),
          createSyntheticTextCell(cells[1], '⑭성명', familyHeaderSpans[1], 'field-label'),
          createSyntheticTextCell(cells[2], '⑮주민등록번호', familyHeaderSpans[2], 'field-label'),
          createSyntheticTextCell(cells[3], '학 력', familyHeaderSpans[3], 'field-label'),
          createSyntheticTextCell(cells[4], '직 업', familyHeaderSpans[4], 'field-label'),
          createSyntheticTextCell(cells[5], '월소득(천원)', familyHeaderSpans[5], 'field-label'),
        ], 'body'),
      );
      return;
    }

    normalizedRows.push(row);
  });

  return normalizedRows;
}

function getTableBlockText(tableBlock) {
  return (tableBlock?.rows || [])
    .flatMap(row => row.cells || [])
    .map(cell => getCellTextInline(cell))
    .filter(Boolean)
    .join(' ');
}

function shouldUsePrimaryFormLayout(tableBlock) {
  const tableText = getTableBlockText(tableBlock);
  if (!tableText) return false;
  if (/등\s*록\s*신\s*청\s*서/.test(tableText)) return true;
  return /접수번호|접수일시|처리기간/.test(tableText)
    && /①/.test(tableText)
    && /②/.test(tableText)
    && /③/.test(tableText);
}

function getCompositeHeaderCellModel(tableBlock, row, cell, rowVisualIndex) {
  if (rowVisualIndex !== 0) return null;
  if ((Number(cell?.colSpan) || 1) < Math.max(2, Number(tableBlock?.colCount) || 0)) return null;

  const paragraphs = cell?.paragraphs || [];
  const nestedTables = paragraphs.filter(para => para?.type === 'table');
  if (nestedTables.length !== 1) return null;

  const titleParagraphs = paragraphs
    .filter(para => para?.type !== 'table')
    .filter(para => getParagraphText(para).trim());
  if (!titleParagraphs.length || titleParagraphs.length > 3) return null;

  const titleText = titleParagraphs
    .map(getParagraphText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!titleText || titleText.length > 24 || /등록신청서/.test(titleText)) return null;

  const approvalText = getTableBlockText(nestedTables[0]).replace(/\s+/g, ' ').trim();
  if (!/결\s*재|담\s*임|교\s*무|교\s*감|전\s*결|검\s*토|승\s*인|원\s*장|부\s*장|과\s*장|팀\s*장/.test(approvalText)) {
    return null;
  }

  return {
    titleParagraphs,
    approvalTable: nestedTables[0],
  };
}

function renderApplicationTitleCell(parent, cell) {
  const rawLines = (cell?.paragraphs || [])
    .map(getParagraphText)
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const options = [];
  rawLines.forEach(line => {
    if (/등\s*록\s*신\s*청\s*서/.test(line)) {
      const cleaned = line.replace(/등\s*록\s*신\s*청\s*서/g, '').trim();
      if (cleaned) options.push(cleaned);
      return;
    }
    options.push(line);
  });

  const grid = document.createElement('div');
  grid.className = 'hwp-form-title-grid';

  const label = document.createElement('p');
  label.className = 'hwp-form-title-label';
  label.textContent = '등록신청서';
  grid.appendChild(label);

  const optionList = document.createElement('div');
  optionList.className = 'hwp-form-title-options';
  options.forEach(text => {
    const line = document.createElement('p');
    line.className = 'hwp-form-title-option';
    line.textContent = text.replace(/□\s*/g, '□ ').replace(/\s+/g, ' ').trim();
    optionList.appendChild(line);
  });
  grid.appendChild(optionList);

  parent.appendChild(grid);
}

function renderCompositeHeaderCell(parent, model, tableContext) {
  const layout = document.createElement('div');
  layout.className = 'hwp-form-header-layout';

  const title = document.createElement('div');
  title.className = 'hwp-form-header-title';
  model.titleParagraphs.forEach(para => {
    appendParagraphBlock(title, para, 'hwp-table-paragraph', {
      alignOverride: 'center',
      role: 'form-header-title',
      rowRole: 'body',
      cellRole: 'form-header',
    });
  });
  layout.appendChild(title);

  const approval = document.createElement('div');
  approval.className = 'hwp-form-header-approval';
  appendTableBlock(approval, model.approvalTable, {
    pageIndex: tableContext.pageIndex,
    tableIndex: `${tableContext.tableIndex}-header-${tableContext.rowIndex}-${tableContext.colIndex}`,
    isFirstTableOnFirstPage: false,
  });
  layout.appendChild(approval);

  parent.appendChild(layout);
}

function appendTableBlock(parent, tableBlock, tableContext = {}) {
  const {
    pageIndex = Number(parent?.dataset?.pageIndex ?? 0),
    tableIndex = 0,
    isFirstTableOnFirstPage = pageIndex === 0 && tableIndex === 0,
  } = tableContext;
  const usePrimaryFormLayout = isFirstTableOnFirstPage && shouldUsePrimaryFormLayout(tableBlock);

  const wrap = document.createElement('div');
  wrap.className = 'hwp-table-wrap';
  wrap.dataset.kind = 'hwp-table';
  wrap.dataset.pageIndex = String(pageIndex);
  wrap.dataset.tableIndex = String(tableIndex);
  if (usePrimaryFormLayout) wrap.dataset.layout = 'first-page-primary';

  const table = document.createElement('table');
  table.className = 'hwp-table';
  table.dataset.rows = String(tableBlock.rowCount || 0);
  table.dataset.cols = String(tableBlock.colCount || 0);
  table.dataset.pageIndex = String(pageIndex);
  table.dataset.tableIndex = String(tableIndex);
  if (tableBlock.sourceFormat) table.dataset.sourceFormat = tableBlock.sourceFormat;
  if (usePrimaryFormLayout) table.dataset.layout = 'first-page-primary';
  const cellSpacingPx = hwpPageUnitToPx(tableBlock.cellSpacing, 0, 48, 0);
  if (cellSpacingPx > 0) {
    wrap.dataset.cellSpacing = String(tableBlock.cellSpacing || 0);
    table.dataset.cellSpacing = String(tableBlock.cellSpacing || 0);
    table.style.borderCollapse = 'separate';
    table.style.borderSpacing = `${cellSpacingPx}px`;
    table.style.outlineOffset = '0';
  }

  if (tableBlock.columnWidths?.length) {
    const colgroup = document.createElement('colgroup');
    const totalWidth = tableBlock.columnWidths.reduce((sum, width) => sum + width, 0) || tableBlock.columnWidths.length;
    tableBlock.columnWidths.forEach(width => {
      const col = document.createElement('col');
      col.dataset.kind = 'hwp-table-col';
      col.style.width = `${((width || 1) / totalWidth) * 100}%`;
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);
  }

  const tbody = document.createElement('tbody');
  const rowsToRender = usePrimaryFormLayout
    ? normalizeApplicationFormRows(tableBlock, tableBlock.rows || [])
    : (tableBlock.rows || []);

  rowsToRender.forEach((row, rowVisualIndex) => {
    const cells = [...(row.cells || [])].sort((a, b) => a.col - b.col);
    if (!cells.length) return;

    const rowTexts = cells.map(cell => getCellTextInline(cell)).filter(Boolean).join(' ');
    const rowLooksLikeTitle = rowVisualIndex === 0 && /등\s*록\s*신\s*청\s*서/.test(rowTexts);
    const rowLooksLikeOptions = rowVisualIndex === 0 && /고엽제후유/.test(rowTexts);
    const rowLooksLikeMeta = /접수번호|접수일시|처리기간/.test(rowTexts);
    const rowLooksLikePersonForm = /①성\s*명|②주민등록번호|③주\s*소/.test(rowTexts);
    const rowLooksLikeTopSpacer = usePrimaryFormLayout
      && rowVisualIndex <= 2
      && cells.length === 1
      && !rowTexts
      && (Number(cells[0].colSpan) || 1) <= 2;
    if (rowLooksLikeTopSpacer) return;

    const tr = document.createElement('tr');
    tr.className = 'hwp-table-row';
    tr.dataset.rowIndex = String(row.index);
    tr.dataset.rowVisualIndex = String(rowVisualIndex);
    if (row.syntheticRowRole) tr.dataset.rowRole = row.syntheticRowRole;
    else if (rowLooksLikeTitle) tr.dataset.rowRole = 'title';
    else if (rowLooksLikeMeta) tr.dataset.rowRole = 'meta';
    else if (rowLooksLikePersonForm) tr.dataset.rowRole = 'person-form';
    else tr.dataset.rowRole = 'body';

    const rowHeight = tableBlock.rowHeights?.[row.index];
    const maxCellHeight = cells.reduce((max, cell) => Math.max(max, Number(cell.height) || 0), 0);
    const maxContentHeight = cells.reduce((max, cell) => Math.max(max, Number(cell.contentHeight) || 0), 0);
    const maxParagraphLines = cells.reduce((max, cell) => Math.max(max, cell.paragraphs?.length || 1), 1);
    const isHwpxTable = tableBlock.sourceFormat === 'hwpx';
    const explicitHwpxRowHeight = isHwpxTable
      ? Number(tableBlock.hwpxRowHeights?.[row.index]) || 0
      : 0;
    const rowHeightPx = isHwpxTable
      ? (explicitHwpxRowHeight > 0
        ? hwpPageUnitToPx(explicitHwpxRowHeight, 0, 280, 0)
        : hwpUnitToPx(rowHeight, 24, 280, 12, 0))
      : hwpPageUnitToPx(rowHeight, 0, 320, 0);
    const cellHeightPx = isHwpxTable
      ? hwpPageUnitToPx(maxCellHeight, 0, 200, 0)
      : hwpPageUnitToPx(maxCellHeight, 0, 300, 0);
    const contentHeightPx = isHwpxTable
      ? hwpPageUnitToPx(maxContentHeight, 0, 200, 0)
      : 0;
    let minRowHeight = Math.max(30, rowHeightPx, cellHeightPx, contentHeightPx);
    if (rowLooksLikeTitle) {
      const titleBase = rowLooksLikeOptions ? 108 : 94;
      const lineBonus = Math.max(0, maxParagraphLines - 1) * 14;
      const firstTableBonus = isFirstTableOnFirstPage ? 8 : 0;
      minRowHeight = Math.max(minRowHeight, Math.min(180, titleBase + lineBonus + firstTableBonus));
    } else if (rowLooksLikeMeta) {
      minRowHeight = Math.max(minRowHeight, 36);
    } else if (rowLooksLikePersonForm) {
      minRowHeight = Math.max(minRowHeight, 42);
    }
    tr.style.minHeight = `${minRowHeight}px`;
    tr.style.height = `${minRowHeight}px`;

    cells.forEach(cell => {
      const td = document.createElement('td');
      td.className = 'hwp-table-cell';
      td.dataset.row = String(cell.row ?? row.index);
      td.dataset.col = String(cell.col ?? 0);
      td.dataset.rowSpan = String(cell.rowSpan || 1);
      td.dataset.colSpan = String(cell.colSpan || 1);
      if (cell.colSpan > 1) td.colSpan = cell.colSpan;
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      applyCellBorderStyle(td, cell);

      const text = getCellTextInline(cell);
      const rawText = HwpParser._cellText(cell);
      const explicitCellRole = cell.syntheticRole || '';
      const isTitleLabelCell = /등\s*록\s*신\s*청\s*서/.test(text);
      const isOptionCell = rowLooksLikeTitle && /고엽제후유/.test(text);
      const isCombinedTitleBlock = isTitleLabelCell && isOptionCell;
      const isPeriodCell = /처리기간|20\s*일|90\s*일/.test(text);
      const isMetaCell = /접수번호|접수일시/.test(text);
      const stackedLabelLines = getStackedHangulLabelLines(rawText);
      // "결 석 종 류" 같은 세로 라벨은 원문 공백 패턴을 살려 2글자씩 줄바꿈해 준다.
      const isStackedLabelCell = !explicitCellRole
        && !isTitleLabelCell
        && !isOptionCell
        && !isPeriodCell
        && !isMetaCell
        && (cell.colSpan || 1) === 1
        && (cell.rowSpan || 1) === 1
        && (cell.col || 0) === 0
        && Boolean(stackedLabelLines);
      const isFieldLabelCell = explicitCellRole === 'field-label'
        || /^[①-⑳⑴-⒇<]\s*/.test(text)
        || /^(학\s*력|직\s*업|월\s*소득)/.test(text);
      const isFieldInlineNoteCell = explicitCellRole === 'field-inline-note'
        || /전화|휴대폰/.test(text);
      const isTitleRowMainCell = rowLooksLikeTitle
        && (isTitleLabelCell || isOptionCell || (cell.colSpan || 1) >= Math.max(2, Math.floor((tableBlock.colCount || 2) / 2)));
      const shouldCenterCell = isTitleLabelCell || isOptionCell || isCombinedTitleBlock || isTitleRowMainCell;
      const shouldMiddleCell = rowLooksLikeTitle || rowLooksLikeMeta || shouldCenterCell || (cell.rowSpan || 1) > 1;

      if (shouldCenterCell) td.classList.add('hwp-table-cell-centered');
      if (explicitCellRole) td.dataset.role = explicitCellRole;
      else if (isCombinedTitleBlock) td.dataset.role = 'title-block';
      else if (isTitleLabelCell) td.dataset.role = 'title-label';
      else if (isOptionCell) td.dataset.role = 'title-options';
      else if (isPeriodCell) td.dataset.role = 'process-period';
      else if (isMetaCell) td.dataset.role = 'meta';
      else if (isStackedLabelCell) td.dataset.role = 'stacked-label';
      else if (isFieldLabelCell) td.dataset.role = 'field-label';
      else if (isFieldInlineNoteCell) td.dataset.role = 'field-inline-note';
      else td.dataset.role = 'body';
      td.dataset.rowRole = tr.dataset.rowRole || 'body';
      const compositeHeaderModel = getCompositeHeaderCellModel(tableBlock, row, cell, rowVisualIndex);
      if (compositeHeaderModel) td.dataset.role = 'form-header';

      if (usePrimaryFormLayout && td.dataset.role === 'title-block' && td.rowSpan > 2) {
        td.rowSpan = 2;
        td.dataset.rowSpan = '2';
      }

      const cellVerticalAlign = isStackedLabelCell
        ? 'middle'
        : (cell.verticalAlign || (shouldMiddleCell ? 'middle' : 'top'));
      td.style.verticalAlign = cellVerticalAlign;

      const [padL, padR, padT, padB] = cell.padding || [];
      const hasPaddingInfo = [padL, padR, padT, padB].some(v => Number(v) > 0);
      let topPx = 3;
      let rightPx = 4;
      let bottomPx = 3;
      let leftPx = 4;
      if (hasPaddingInfo) {
        topPx = hwpPageUnitToPx(padT, 0, 18, 0);
        rightPx = hwpPageUnitToPx(padR, 0, 20, 0);
        bottomPx = hwpPageUnitToPx(padB, 0, 18, 0);
        leftPx = hwpPageUnitToPx(padL, 0, 20, 0);
      } else if (rowLooksLikeTitle) {
        if (isTitleLabelCell) {
          topPx = 16; rightPx = 10; bottomPx = 16; leftPx = 10;
        } else if (isOptionCell) {
          topPx = 16; rightPx = 18; bottomPx = 16; leftPx = 18;
        } else if (isPeriodCell) {
          topPx = 12; rightPx = 10; bottomPx = 12; leftPx = 10;
        } else {
          topPx = 14; rightPx = 12; bottomPx = 14; leftPx = 12;
        }
      } else if (rowLooksLikeMeta) {
        topPx = 8; rightPx = 10; bottomPx = 8; leftPx = 10;
      } else if (rowLooksLikePersonForm) {
        topPx = 7; rightPx = 8; bottomPx = 7; leftPx = 8;
      } else {
        topPx = 3; rightPx = 4; bottomPx = 3; leftPx = 4;
      }
      td.style.padding = `${topPx}px ${rightPx}px ${bottomPx}px ${leftPx}px`;
      if (rowLooksLikeTitle) td.style.height = `${minRowHeight}px`;

      const content = document.createElement('div');
      content.className = 'hwp-table-cell-content';
      content.dataset.role = td.dataset.role || 'body';
      content.dataset.rowRole = tr.dataset.rowRole || 'body';
      if (rowLooksLikeTitle) {
        const innerHeight = Math.max(48, minRowHeight - topPx - bottomPx);
        content.style.minHeight = `${innerHeight}px`;
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.justifyContent = 'center';
        if (isTitleLabelCell || isOptionCell || shouldCenterCell) {
          content.style.alignItems = 'center';
        } else {
          content.style.alignItems = 'stretch';
        }
      }
      if (isOptionCell) content.style.gap = '8px';

      const shouldRenderTitleGrid = usePrimaryFormLayout
        && td.dataset.role === 'title-block'
        && /등\s*록\s*신\s*청\s*서/.test(text);
      if (shouldRenderTitleGrid) {
        renderApplicationTitleCell(content, cell);
        td.appendChild(content);
        tr.appendChild(td);
        return;
      }

      if (compositeHeaderModel) {
        renderCompositeHeaderCell(content, compositeHeaderModel, {
          pageIndex,
          tableIndex,
          rowIndex: row.index,
          colIndex: cell.col ?? 0,
        });
        td.appendChild(content);
        tr.appendChild(td);
        return;
      }

      const paragraphs = cell.paragraphs?.length
        ? cell.paragraphs
        : [HwpParser._createParagraphBlock('')];
      paragraphs.forEach((para, paraIndex) => {
        let paragraphToRender = para;
        if (isStackedLabelCell && stackedLabelLines && paraIndex === 0 && para?.type !== 'table') {
          const sourceRun = (para.texts || []).find(run => String(run.text || '').trim()) || (para.texts || [])[0] || {};
          paragraphToRender = {
            ...para,
            texts: [HwpParser._run(stackedLabelLines.join('\n'), { ...sourceRun })],
          };
        }

        if (paragraphToRender?.type === 'table') {
          const nestedMount = document.createElement('div');
          nestedMount.className = 'hwp-table-nested';
          content.appendChild(nestedMount);
          appendTableBlock(nestedMount, paragraphToRender, {
            pageIndex,
            tableIndex: `${tableIndex}-${row.index}-${cell.col}-${paraIndex}`,
            isFirstTableOnFirstPage: false,
          });
          return;
        }

        if (paragraphToRender?.type === 'image') {
          appendImageBlock(content, paragraphToRender, 'hwp-image-inline');
          return;
        }

        if (paragraphToRender?.type === 'equation') {
          appendObjectTextBlock(content, paragraphToRender, 'equation', 'hwp-object-inline');
          return;
        }

        if (paragraphToRender?.type === 'ole') {
          appendObjectTextBlock(content, paragraphToRender, 'ole', 'hwp-object-inline');
          return;
        }

        let paraRole = 'cell-body';
        if (td.dataset.role === 'field-label') paraRole = 'field-label';
        else if (td.dataset.role === 'field-inline-note') paraRole = 'field-inline-note';
        else if (td.dataset.role === 'stacked-label') paraRole = 'stacked-label';
        else if (isTitleLabelCell) paraRole = 'title-label';
        else if (isOptionCell) paraRole = 'title-option-item';
        else if (isPeriodCell) paraRole = 'process-period';
        else if (shouldCenterCell) paraRole = 'cell-centered';

        const forceCenter = isTitleLabelCell || isOptionCell || (shouldCenterCell && !isPeriodCell) || (paraIndex === 0 && rowLooksLikeTitle);
        const paragraphClass = `hwp-table-paragraph${forceCenter ? ' hwp-table-paragraph-centered' : ''}`;
        appendParagraphBlock(content, paragraphToRender, paragraphClass, {
          alignOverride: forceCenter ? 'center' : '',
          role: paraRole,
          rowRole: tr.dataset.rowRole || '',
          cellRole: td.dataset.role || '',
        });
      });

      td.appendChild(content);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  parent.appendChild(wrap);
  registerPlacedBlock(wrap, table, tableBlock);
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
    (page.headerBlocks || []).forEach(block => appendBlockByType(headerEl, block, { pageIndex: pi, tableIndexRef }));
    page.paragraphs.forEach(block => appendBlockByType(bodyEl, block, { pageIndex: pi, tableIndexRef }));
    (page.footerBlocks || []).forEach(block => appendBlockByType(footerEl, block, { pageIndex: pi, tableIndexRef }));

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
}

function renderHWP(data) {
  renderDocument(data);
  state.currentPage = 0;
  UI.viewerPanel.scrollTop = 0;
  UI.documentCanvas.scrollTop = 0;
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page === 0));
  updateStatusBar();
}

function getCurrentDocumentHtml() {
  if (state.mode === 'edit') return HwpEditor.getHtml();
  if (state.editedDoc) return HwpExporter.buildDocumentHtml(state.editedDoc);
  if (state.doc) return HwpExporter.buildDocumentHtml(state.doc);
  return UI.documentCanvas.innerHTML;
}

function getCurrentDocumentDelta() {
  if (state.mode === 'edit') return HwpEditor.getDelta();
  if (state.editedDelta) return state.editedDelta;
  return state.doc ? HwpEditor.buildDocumentDelta(state.doc) : { ops: [] };
}

function syncEditStateFromEditor(options = {}) {
  const { markSaved = false } = options;
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
  document.getElementById('page-' + pi)?.scrollIntoView({ behavior:'smooth', block:'start' });
  state.currentPage = pi;
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.toggle('active', +t.dataset.page === pi));
  updateStatusBar();
}

/* ── 편집 모드 ── */
function enterEditMode() {
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
  HwpEditor.focus();
}

function enterViewMode() {
  syncEditStateFromEditor();

  UI.editorPanel.style.display = 'none';
  UI.viewerPanel.style.display = '';
  UI.btnViewMode.style.display = 'none';
  UI.btnEditMode.style.display = '';
  state.mode = 'view';
  if (state.editedDoc) renderHWP(state.editedDoc);
  else renderHWP(state.doc);
  updateStatusBar();
}

/* ── UI 헬퍼 ── */
function updateUiAfterLoad(filename, sizeBytes) {
  UI.dropZone.style.display    = 'none';
  UI.mainContent.style.display = 'flex';
  UI.statusBar.style.display   = 'flex';
  UI.exportGroup.style.display = 'flex';
  setCurrentFilename(filename);
  updateFileInfoFromSize(sizeBytes);
  UI.errorBanner.style.display = 'none';
  applyDocumentActionState();
  if (state.documentLocked) {
    showError(state.documentLockReason);
  }
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
  UI.statusPageInfo.textContent = `${state.currentPage+1} / ${state.renderedPages || state.doc?.pages?.length || 1} 페이지`;
  const e = state.mode === 'edit';
  UI.statusMode.textContent = e ? '편집 모드' : '보기 모드';
  UI.statusMode.className   = 'mode-badge ' + (e ? 'edit' : 'view');
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
});

console.log('[HWP Viewer] app.js 로드 완료 ✓');

/* ── 페이지 로드 시 URL 파라미터 자동 처리 ── */
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  // Chrome 확장 컨텍스트에서만 실행
  autoLoadFromParams().catch(e => console.error('[APP] autoLoad 오류:', e));
}
