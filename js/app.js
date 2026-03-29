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
          lineSpacing: HwpParser._hwpxAttrNum(lineSpacingEl, 'value', 0),
        };
        return;
      }

      if (name === 'charPr') {
        const id = Number(node.getAttribute('id'));
        if (!Number.isFinite(id)) return;
        const fontRefEl = HwpParser._hwpxFirstChild(node, 'fontRef');
        const underlineEl = HwpParser._hwpxFirstChild(node, 'underline');
        refs.charProps[id] = {
          fontName: refs.hangulFonts[String(fontRefEl?.getAttribute?.('hangul'))] || '',
          fontSize: HwpParser._hwpxAttrNum(node, 'height', 0) > 0
            ? Math.round((HwpParser._hwpxAttrNum(node, 'height', 0) / 100) * 10) / 10
            : 0,
          color: HwpParser._hwpxNormalizeColor(node.getAttribute('textColor')),
          bold: Boolean(HwpParser._hwpxFirstChild(node, 'bold')),
          italic: Boolean(HwpParser._hwpxFirstChild(node, 'italic')),
          underline: (underlineEl?.getAttribute?.('type') || 'NONE') !== 'NONE',
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
      && a.color === b.color;
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

  _hwpxPictureBlock(picEl, header = {}) {
    const imgEl = HwpParser._hwpxDescendant(picEl, 'img');
    const curSizeEl = HwpParser._hwpxFirstChild(picEl, 'curSz');
    const orgSizeEl = HwpParser._hwpxFirstChild(picEl, 'orgSz');
    const sizeEl = HwpParser._hwpxFirstChild(picEl, 'sz') || curSizeEl || orgSizeEl;
    const posEl = HwpParser._hwpxFirstChild(picEl, 'pos');
    const ref = imgEl?.getAttribute?.('binaryItemIDRef') || '';
    const src = header?.images?.[ref] || '';
    if (!src) return null;
    const width = HwpParser._hwpxAttrNum(sizeEl, 'width',
      HwpParser._hwpxAttrNum(curSizeEl, 'width', HwpParser._hwpxAttrNum(orgSizeEl, 'width', 0)));
    const height = HwpParser._hwpxAttrNum(sizeEl, 'height',
      HwpParser._hwpxAttrNum(curSizeEl, 'height', HwpParser._hwpxAttrNum(orgSizeEl, 'height', 0)));

    return {
      type: 'image',
      src,
      alt: ref || 'image',
      width,
      height,
      align: HwpParser._hwpxMapAlign(posEl?.getAttribute?.('horzAlign') || 'LEFT'),
      inline: posEl?.getAttribute?.('treatAsChar') === '1',
      offsetX: HwpParser._hwpxAttrNum(posEl, 'horzOffset', 0),
      offsetY: HwpParser._hwpxAttrNum(posEl, 'vertOffset', 0),
    };
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
          const canInlineImage = imageBlock && paragraphHasText && (
            imageBlock.inline
            || (imageBlock.width > 0 && imageBlock.width <= 9000 && imageBlock.height <= 5000)
          );
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

    const table = HwpParser._hwpxNormalizeTableMetrics(HwpParser._buildTableBlock({
      rowCount: Math.max(rowEls.length, HwpParser._hwpxAttrNum(tblEl, 'rowCnt', rowEls.length)),
      colCount: HwpParser._hwpxAttrNum(tblEl, 'colCnt', 0),
      cellSpacing: HwpParser._hwpxAttrNum(tblEl, 'cellSpacing', 0),
      sourceFormat: 'hwpx',
    }, cells));

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
      ? Math.max(1, Math.min(14, Math.round(explicitHeight / 420)))
      : 0;
    if (!blocks.length) return Math.max(1, heightWeight || 1);

    const total = blocks.reduce((sum, block) => {
      if (block.type === 'table') {
        return sum + Math.max(3, Math.min(10, (block.rowCount || 1) * 2));
      }

      const text = HwpParser._blockText(block).trim();
      if (!text) return sum;
      const lines = text.split(/\n+/).filter(Boolean);
      const charCount = lines.reduce((count, line) => count + line.length, 0);
      const wrappedLines = Math.max(lines.length, Math.ceil(charCount / 44));
      return sum + wrappedLines;
    }, 0);

    return Math.max(heightWeight, Math.max(1, Math.min(14, total || 1)));
  },

  _hwpxEstimateRowWeight(row) {
    const meaningfulCells = HwpParser._hwpxMeaningfulCells(row);
    if (!meaningfulCells.length) return 1;

    const weight = meaningfulCells.reduce((max, cell) => (
      Math.max(max, HwpParser._hwpxEstimateCellWeight(cell))
    ), 1);
    return Math.max(1, Math.min(14, weight));
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
      .filter(([name]) => /^BIN\d+\.(png|jpe?g|gif|bmp|webp)$/i.test(name))
      .sort((a, b) => {
        const ai = Number((a[0].match(/^BIN(\d+)/i) || [])[1] || 0);
        const bi = Number((b[0].match(/^BIN(\d+)/i) || [])[1] || 0);
        return ai - bi;
      });

    const images = {};
    const ordered = [];
    const byId = {};

    for (const [name, entry] of binEntries) {
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
      const numericId = Number((name.match(/^BIN(\d+)/i) || [])[1] || 0);
      const imageEntry = { id: numericId, name, src };
      images[name] = src;
      ordered.push(imageEntry);
      if (numericId > 0) {
        byId[numericId] = imageEntry;
      }
    }

    return { images, ordered, byId };
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
    const fontSizeRaw = HwpParser._u32(body, 42);
    return {
      fontName: faceNames[faceId] || '',
      fontSize: fontSizeRaw > 0 ? Math.round((fontSizeRaw / 100) * 10) / 10 : 0,
      color: HwpParser._hwpColorRefToCss(HwpParser._u32(body, 52)),
      bold: Boolean(attr & (1 << 1)),
      italic: Boolean(attr & 1),
      underline: ((attr >> 2) & 0x3) !== 0,
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

  _parseHwpParaShape(body) {
    if (!body || body.length < 26) return null;
    const attr = HwpParser._u32(body, 0);
    const modernLineSpacing = body.length >= 54 ? HwpParser._u32(body, 50) : 0;
    const legacyLineSpacing = body.length >= 28 ? HwpParser._u32(body, 24) : 0;
    return {
      align: HwpParser._hwpAlignFromAttr(attr),
      marginLeft: HwpParser._i32(body, 4),
      textIndent: HwpParser._i32(body, 12),
      spacingBefore: HwpParser._i32(body, 16),
      spacingAfter: HwpParser._i32(body, 20),
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
      lineHeightPx: hwpPageUnitToPx(avgHeight, 11, 42, 0),
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
      textIndent: paraStyle?.textIndent ?? 0,
      spacingBefore: paraStyle?.spacingBefore ?? 0,
      spacingAfter: paraStyle?.spacingAfter ?? 0,
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

  async _parseHwpDocInfoStream(data, compressedHint) {
    const attempts = [{ mode: 'raw', bytes: data }];
    try {
      attempts.push({ mode: 'deflated', bytes: await HwpParser._decompressZlib(data) });
    } catch (e) {
      if (compressedHint) {
        console.warn('[HWP] DocInfo 압축 해제 실패:', e.message);
      }
    }

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

  _pickHwpDisplayMetric(...candidates) {
    const positives = candidates
      .map(value => Number(value) || 0)
      .filter(value => value > 0);
    if (!positives.length) return 0;
    return Math.min(...positives);
  },

  _firstPositiveMetric(...candidates) {
    for (const candidate of candidates) {
      const value = Number(candidate) || 0;
      if (value > 0) return value;
    }
    return 0;
  },

  _parseHwpGsoBlock(ctrlBody, pictureBody, docInfo = null) {
    if (!pictureBody?.length) return null;
    const imageRef = HwpParser._resolveHwpBinaryImage(docInfo, pictureBody);
    if (!imageRef?.src) return null;

    const width = HwpParser._firstPositiveMetric(
      HwpParser._u32(ctrlBody, 16),
      HwpParser._u32(pictureBody, 52),
      HwpParser._u32(pictureBody, 20),
      HwpParser._u32(pictureBody, 28),
      0,
    );
    const height = HwpParser._firstPositiveMetric(
      HwpParser._u32(ctrlBody, 20),
      HwpParser._u32(pictureBody, 56),
      HwpParser._u32(pictureBody, 32),
      HwpParser._u32(pictureBody, 40),
      0,
    );

    return {
      type: 'image',
      src: imageRef.src,
      alt: imageRef.name || 'image',
      width,
      height,
      align: 'left',
      inline: false,
      offsetX: 0,
      offsetY: 0,
      sourceFormat: 'hwp',
    };
  },

  _parseGsoControl(data, startPos, ctrlLevel, ctrlBody, docInfo = null) {
    let pos = startPos;
    let pictureBody = null;

    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (rec.level <= ctrlLevel) break;
      if (rec.tagId === 85 && !pictureBody) {
        pictureBody = rec.body;
      }
      pos = rec.nextPos;
    }

    return {
      block: HwpParser._parseHwpGsoBlock(ctrlBody, pictureBody, docInfo),
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

    const columnWidths = Array.from({ length: colCount }, () => 0);
    const sortedCells = cells
      .filter(cell => cell.col < colCount && cell.row < rowCount)
      .sort((a, b) => (a.row - b.row) || (a.col - b.col));

    for (const cell of sortedCells) {
      const unitWidth = cell.width > 0 ? cell.width / Math.max(1, cell.colSpan) : 0;
      for (let c = cell.col; c < Math.min(colCount, cell.col + cell.colSpan); c++) {
        columnWidths[c] = Math.max(columnWidths[c], unitWidth);
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

  _parseTableControl(data, startPos, ctrlLevel, docInfo = null) {
    let pos = startPos;
    let tableInfo = null;
    const cells = [];

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
            const { block, nextPos } = HwpParser._parseTableControl(data, next.nextPos, next.level, docInfo);
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
      block: HwpParser._buildTableBlock(tableInfo, cells),
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
          const { block, nextPos } = HwpParser._parseTableControl(data, rec.nextPos, rec.level, docInfo);
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
  async _extractSectionParas(data, compressedHint, sectionName, docInfo = null) {
    const attempts = [];
    const pushAttempt = (mode, bytes) => {
      if (!bytes || bytes.length === 0) return;
      attempts.push({ mode, bytes });
    };

    if (compressedHint) {
      try {
        pushAttempt('deflated', await HwpParser._decompressZlib(data));
      } catch (e) {
        console.warn(`[HWP] ${sectionName} 압축 해제 실패:`, e.message);
        pushAttempt('raw', data);
      }
    } else {
      pushAttempt('raw', data);
      try {
        pushAttempt('deflated', await HwpParser._decompressZlib(data));
      } catch {}
    }

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
        if (fhData[36] & 2) { console.warn('[HWP] 암호화된 문서'); return null; }
        console.log('[HWP] FileHeader: compressed=%s', compressed);
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
        docInfo = await HwpParser._parseHwpDocInfoStream(docInfoData, compressed);
      }
    }

    const allEntries = HwpParser._scanAllDirEntries(b, ss, fat, dirStartSec);
    const hwpImages = await HwpParser._parseHwpBinaryMap(b, allEntries, ss, fat, miniCutoff, miniStream, miniFat);
    docInfo.images = hwpImages.images;
    docInfo.binImages = hwpImages.ordered;
    docInfo.binImagesById = hwpImages.byId;
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
      const parsed = await HwpParser._extractSectionParas(data, compressed, 'Section' + sn, docInfo);
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
        fontSize:11, fontName:'Malgun Gothic', color:'#000000' },
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
    return format === 'hwpx';
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
      showError('현재 파일 덮어쓰기는 HWPX 파일만 지원합니다. 다른 이름으로 저장을 사용해 주세요.');
      return false;
    }

    const blob = await this.buildHwpxBlob();
    const handle = await this._saveWithPicker(blob, state.filename, {
      handle: state.fileHandle,
      description: 'HWPX 문서',
      accept: {
        'application/hwp+zip': ['.hwpx'],
        'application/octet-stream': ['.hwpx'],
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

    if (format === 'hwpx') {
      const blob = await this.buildHwpxBlob();
      await this._saveWithPicker(blob, name, {
        description: 'HWPX 문서',
        accept: {
          'application/hwp+zip': ['.hwpx'],
          'application/octet-stream': ['.hwpx'],
        },
      });
      return true;
    }

    showError('현재는 .hwp 바이너리 저장을 지원하지 않습니다. HWPX로 저장해 주세요.');
    return false;
  },

  _wrap(body) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${this.basename}</title>
<style>
body{font-family:'HCR Batang','함초롬바탕','Noto Serif KR','Malgun Gothic',serif;max-width:860px;margin:0 auto;padding:60px 80px;font-size:14px;line-height:1.68}
.hwp-page{background:#fff;padding:0 0 24px;margin-bottom:24px;break-after:page;display:flex;flex-direction:column;min-height:980px}
.hwp-page-header{flex:0 0 auto}
.hwp-page-body{flex:1 1 auto}
.hwp-page-footer{margin-top:auto;padding-top:18px}
.hwp-page p{margin:0 0 4px;white-space:pre-wrap}
.hwp-page-number{font-size:12px;letter-spacing:0.08em;color:#475569}
.hwp-inline-image{display:inline-block;vertical-align:middle;margin-right:10px}
.hwp-table-wrap{margin:10px 0 16px;overflow-x:auto}
.hwp-table{width:100%;border-collapse:collapse;table-layout:fixed;background:#fff;font-size:12.7px;outline:1.5px solid #374151;outline-offset:-1px}
.hwp-table[data-source-format="hwpx"]{outline:none}
.hwp-table-cell{border:1px solid #6b7280;padding:4px 6px;vertical-align:top;font-size:12.7px;line-height:1.32;white-space:normal}
.hwp-table-paragraph{margin:0;min-height:1.1em;line-height:1.22}
.hwp-table-paragraph+.hwp-table-paragraph{margin-top:3px}
.hwp-image-block{margin:10px 0;text-align:center}
.hwp-image-block[data-align="left"]{text-align:left}
.hwp-image-block[data-align="right"]{text-align:right}
.hwp-image-block[data-inline="true"]{margin:4px 0 8px}
.hwp-image{max-width:100%;height:auto;display:inline-block}
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
    return '현재 파일 덮어쓰기는 HWPX 파일만 지원합니다. 다른 이름으로 저장을 사용해 주세요.';
  }
  return '';
}

function getSaveAsDisabledReason(format = UI.saveAsFormat?.value || 'hwpx') {
  if (!state.doc) return '저장할 문서가 없습니다.';
  if (state.documentLocked) return state.documentLockReason || '현재 문서는 저장할 수 없습니다.';
  if (format === 'hwp') return '현재는 .hwp 바이너리 저장을 지원하지 않습니다. HWPX를 사용해 주세요.';
  if (format === 'pdf' && state.mode === 'edit' && state.hasUnsavedChanges) {
    return '';
  }
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

  UI.btnEditMode.disabled = !state.doc || locked;
  UI.btnSaveCurrent.disabled = Boolean(saveCurrentReason);
  UI.btnSaveAs.disabled = Boolean(saveAsReason);

  UI.btnEditMode.title = title;
  UI.btnSaveCurrent.title = saveCurrentReason || '';
  UI.btnSaveAs.title = saveAsReason || '';
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
  if (ext === 'hwpx') {
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
  if (!/\.(hwp|hwpx)$/i.test(file.name)) {
    showError('지원 형식: .hwp, .hwpx 파일만 가능합니다.');
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
  if (run.bold)      span.style.fontWeight = 'bold';
  if (run.italic)    span.style.fontStyle = 'italic';
  if (run.underline) span.style.textDecoration = 'underline';
  if (run.fontSize)  span.style.fontSize = run.fontSize + 'pt';
  if (run.fontName)  span.style.fontFamily = `'${run.fontName}', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif`;
  if (run.color && run.color !== '#000000') span.style.color = run.color;
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
    p.style.paddingLeft = `${hwpSignedUnitToPx(para.marginLeft, -40, 140, 1 / 60, 0)}px`;
  }
  if (Number.isFinite(para.textIndent) && !['center', 'right'].includes(p.style.textAlign)) {
    p.style.textIndent = `${hwpSignedUnitToPx(para.textIndent, -60, 80, 1 / 60, 0)}px`;
  }
  if (Number.isFinite(para.spacingBefore) && para.spacingBefore > 0) {
    p.style.marginTop = `${hwpSignedUnitToPx(para.spacingBefore, 0, 40, 1 / 100, 0)}px`;
  }
  if (Number.isFinite(para.spacingAfter) && para.spacingAfter > 0) {
    p.style.marginBottom = `${hwpSignedUnitToPx(para.spacingAfter, 0, 40, 1 / 100, 4)}px`;
  }
  if (Number.isFinite(para.lineSpacing) && para.lineSpacing > 0) {
    p.style.lineHeight = `${Math.max(1, Math.min(2.2, para.lineSpacing / 100))}`;
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
  wrap.dataset.align = block.align || 'center';
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
  if (!treatLargeOffsetAsRightAligned) {
    applyImageOffsetStyles(img, block, false);
  }

  wrap.appendChild(img);
  parent.appendChild(wrap);
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

  appendParagraphBlock(parent, block);
}

function getCellTextInline(cell) {
  return HwpParser._cellText(cell).replace(/\s+/g, ' ').trim();
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

function applyImageOffsetStyles(el, imageLike, inline = false) {
  const offsetX = Number(imageLike?.offsetX) || 0;
  const offsetY = Number(imageLike?.offsetY) || 0;
  if (offsetX > 0) {
    const leftPx = hwpPageUnitToPx(offsetX, 0, inline ? 420 : 520, 0);
    if (leftPx > 0) el.style.marginLeft = `${leftPx}px`;
  }
  if (offsetY > 0) {
    const topPx = hwpPageUnitToPx(offsetY, 0, 120, 0);
    if (topPx > 0) el.style.marginTop = `${topPx}px`;
  }
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

function appendTableBlock(parent, tableBlock, tableContext = {}) {
  const {
    pageIndex = Number(parent?.dataset?.pageIndex ?? 0),
    tableIndex = 0,
    isFirstTableOnFirstPage = pageIndex === 0 && tableIndex === 0,
  } = tableContext;

  const wrap = document.createElement('div');
  wrap.className = 'hwp-table-wrap';
  wrap.dataset.kind = 'hwp-table';
  wrap.dataset.pageIndex = String(pageIndex);
  wrap.dataset.tableIndex = String(tableIndex);
  if (isFirstTableOnFirstPage) wrap.dataset.layout = 'first-page-primary';

  const table = document.createElement('table');
  table.className = 'hwp-table';
  table.dataset.rows = String(tableBlock.rowCount || 0);
  table.dataset.cols = String(tableBlock.colCount || 0);
  table.dataset.pageIndex = String(pageIndex);
  table.dataset.tableIndex = String(tableIndex);
  if (tableBlock.sourceFormat) table.dataset.sourceFormat = tableBlock.sourceFormat;
  if (isFirstTableOnFirstPage) table.dataset.layout = 'first-page-primary';

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
  const rowsToRender = isFirstTableOnFirstPage
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
    const rowLooksLikeTopSpacer = isFirstTableOnFirstPage
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
        ? hwpUnitToPx(explicitHwpxRowHeight, 0, 180, 1 / 50, 0)
        : hwpUnitToPx(rowHeight, 24, 180, 12, 0))
      : hwpUnitToPx(rowHeight, 28, 320, 5.4, 0);
    const cellHeightPx = isHwpxTable
      ? hwpUnitToPx(maxCellHeight, 0, 120, 1 / 50, 0)
      : hwpUnitToPx(maxCellHeight, 24, 300, 1 / 170, 0);
    const contentHeightPx = isHwpxTable
      ? hwpUnitToPx(maxContentHeight, 0, 120, 1 / 50, 0)
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
      const explicitCellRole = cell.syntheticRole || '';
      const isTitleLabelCell = /등\s*록\s*신\s*청\s*서/.test(text);
      const isOptionCell = rowLooksLikeTitle && /고엽제후유/.test(text);
      const isCombinedTitleBlock = isTitleLabelCell && isOptionCell;
      const isPeriodCell = /처리기간|20\s*일|90\s*일/.test(text);
      const isMetaCell = /접수번호|접수일시/.test(text);
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
      else if (isFieldLabelCell) td.dataset.role = 'field-label';
      else if (isFieldInlineNoteCell) td.dataset.role = 'field-inline-note';
      else td.dataset.role = 'body';
      td.dataset.rowRole = tr.dataset.rowRole || 'body';
      if (isFirstTableOnFirstPage && td.dataset.role === 'title-block' && td.rowSpan > 2) {
        td.rowSpan = 2;
        td.dataset.rowSpan = '2';
      }

      const cellVerticalAlign = cell.verticalAlign || (shouldMiddleCell ? 'middle' : 'top');
      td.style.verticalAlign = cellVerticalAlign;

      const [padL, padR, padT, padB] = cell.padding || [];
      const hasPaddingInfo = [padL, padR, padT, padB].some(v => Number(v) > 0);
      let topPx = 6;
      let rightPx = 8;
      let bottomPx = 6;
      let leftPx = 8;
      if (hasPaddingInfo) {
        if (isHwpxTable) {
          topPx = hwpUnitToPx(padT, 3, 18, 1 / 90, 6);
          rightPx = hwpUnitToPx(padR, 4, 20, 1 / 90, 8);
          bottomPx = hwpUnitToPx(padB, 3, 18, 1 / 90, 6);
          leftPx = hwpUnitToPx(padL, 4, 20, 1 / 90, 8);
        } else {
          topPx = hwpUnitToPx(padT, 4, 30, 1 / 22, 6);
          rightPx = hwpUnitToPx(padR, 6, 36, 1 / 22, 8);
          bottomPx = hwpUnitToPx(padB, 4, 30, 1 / 22, 6);
          leftPx = hwpUnitToPx(padL, 6, 36, 1 / 22, 8);
        }
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
        topPx = 6; rightPx = 8; bottomPx = 6; leftPx = 8;
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

      const shouldRenderTitleGrid = isFirstTableOnFirstPage
        && td.dataset.role === 'title-block'
        && /등\s*록\s*신\s*청\s*서/.test(text);
      if (shouldRenderTitleGrid) {
        renderApplicationTitleCell(content, cell);
        td.appendChild(content);
        tr.appendChild(td);
        return;
      }

      const paragraphs = cell.paragraphs?.length
        ? cell.paragraphs
        : [HwpParser._createParagraphBlock('')];
      paragraphs.forEach((para, paraIndex) => {
        if (para?.type === 'table') {
          const nestedMount = document.createElement('div');
          nestedMount.className = 'hwp-table-nested';
          content.appendChild(nestedMount);
          appendTableBlock(nestedMount, para, {
            pageIndex,
            tableIndex: `${tableIndex}-${row.index}-${cell.col}-${paraIndex}`,
            isFirstTableOnFirstPage: false,
          });
          return;
        }

        if (para?.type === 'image') {
          appendImageBlock(content, para, 'hwp-image-inline');
          return;
        }

        let paraRole = 'cell-body';
        if (td.dataset.role === 'field-label') paraRole = 'field-label';
        else if (td.dataset.role === 'field-inline-note') paraRole = 'field-inline-note';
        else if (isTitleLabelCell) paraRole = 'title-label';
        else if (isOptionCell) paraRole = 'title-option-item';
        else if (isPeriodCell) paraRole = 'process-period';
        else if (shouldCenterCell) paraRole = 'cell-centered';

        const forceCenter = isTitleLabelCell || isOptionCell || (shouldCenterCell && !isPeriodCell) || (paraIndex === 0 && rowLooksLikeTitle);
        const paragraphClass = `hwp-table-paragraph${forceCenter ? ' hwp-table-paragraph-centered' : ''}`;
        appendParagraphBlock(content, para, paragraphClass, {
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
  if(f && /\.(hwp|hwpx)$/i.test(f.name)) processFile(f, { fileHandle: null, fileSource: 'drop' });
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
  if (e.key==='Escape' && state.mode==='edit') enterViewMode();
});

console.log('[HWP Viewer] app.js 로드 완료 ✓');

/* ── 페이지 로드 시 URL 파라미터 자동 처리 ── */
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  // Chrome 확장 컨텍스트에서만 실행
  autoLoadFromParams().catch(e => console.error('[APP] autoLoad 오류:', e));
}
