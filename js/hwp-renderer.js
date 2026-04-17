/**
 * hwp-renderer.js — HWP / HWPX DOM 렌더러
 * (app.js 에서 분리됨 — Chrome 확장 plain-script 로딩, type="module" 없음)
 * 의존: hwp-parser.js (먼저 로드), state / UI (app.js 에서 정의)
 */

/* ── 뷰어 렌더링 ── */
function textDecorationStyleFromShape(shape = '') {
  switch (String(shape || '').trim().toUpperCase()) {
    case 'DOT':
    case 'DOTTED':
      return 'dotted';
    case 'DASH':
    case 'DASHED':
    case 'LONG_DASH':
    case 'LONG-DASH':
    case 'DASH_DOT':
    case 'DASH-DOT':
    case 'DASH_DOT_DOT':
    case 'DASH-DOT-DOT':
      return 'dashed';
    case 'DOUBLE':
      return 'double';
    default:
      return 'solid';
  }
}

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
  const decorationLines = [];
  if (run.bold)      span.style.fontWeight = 'bold';
  if (run.italic)    span.style.fontStyle = 'italic';
  if (run.underline) decorationLines.push('underline');
  if (run.strike) decorationLines.push('line-through');
  if (effectiveFontSize > 0) span.style.fontSize = `${effectiveFontSize}pt`;
  if (run.fontName)  span.style.fontFamily = `'${run.fontName}', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif`;
  if (run.color && run.color !== '#000000') span.style.color = run.color;
  if (decorationLines.length) {
    span.style.textDecorationLine = decorationLines.join(' ');
    span.style.textDecorationStyle = textDecorationStyleFromShape(run.underlineShape || run.strikeShape || '');
    const decorationColor = run.underline
      ? (run.underlineColor || run.strikeColor || '')
      : (run.strikeColor || '');
    if (decorationColor) span.style.textDecorationColor = decorationColor;
  }
  if (run.shadeColor) {
    span.style.backgroundColor = run.shadeColor;
  }
  if (Number.isFinite(run.letterSpacing) && run.letterSpacing !== 0) {
    const letterSpacing = Math.max(-0.5, Math.min(0.5, run.letterSpacing / 100));
    span.style.letterSpacing = `${letterSpacing}em`;
  }
  if (run.superscript) {
    span.style.verticalAlign = 'super';
    span.style.fontSize = `${Math.max(7, Math.round(effectiveFontSize * 0.85 * 10) / 10)}pt`;
  } else if (run.subscript) {
    span.style.verticalAlign = 'sub';
    span.style.fontSize = `${Math.max(7, Math.round(effectiveFontSize * 0.85 * 10) / 10)}pt`;
  }
  if (Number.isFinite(run.offsetY) && run.offsetY !== 0) {
    span.style.position = 'relative';
    span.style.top = `${Math.max(-1, Math.min(1, run.offsetY / 100))}em`;
  }
  if (run.shadowType && run.shadowType !== 'NONE' && run.shadowColor) {
    const shadowX = Math.max(-4, Math.min(4, Math.round((Number(run.shadowOffsetX) || 0) / 4)));
    const shadowY = Math.max(-4, Math.min(4, Math.round((Number(run.shadowOffsetY) || 0) / 4)));
    span.style.textShadow = `${shadowX}px ${shadowY}px 0 ${run.shadowColor}`;
  }
  if (Number.isFinite(run.scaleX) && run.scaleX > 0 && run.scaleX !== 100) {
    span.style.display = 'inline-block';
    span.style.transformOrigin = 'left center';
    span.style.fontStretch = `${Math.max(50, Math.min(200, run.scaleX))}%`;
    span.style.transform = `scaleX(${Math.max(0.5, Math.min(2, run.scaleX / 100))})`;
  }
  parent.appendChild(span);
}

function resolveParagraphListMarker(para, listStateRef = null) {
  const listInfo = para?.listInfo;
  if (!listInfo) return '';
  if (listInfo.kind === 'bullet') {
    return String(listInfo.marker || '•').trim() || '•';
  }

  const state = listStateRef || {};
  const key = `${listInfo.kind}:${listInfo.listId || 0}`;
  const level = Math.max(1, Number(listInfo.level) || 1);
  const counters = Array.isArray(state[key]) ? [...state[key]] : [];
  const start = Math.max(1, Number(listInfo.start) || 1);
  const currentValue = Math.max(start, (counters[level - 1] || (start - 1)) + 1);
  counters[level - 1] = currentValue;
  counters.length = level;
  state[key] = counters;

  const joined = counters.join('.');
  const format = String(listInfo.format || '').trim();
  const marker = format
    ? format.replace(/\^N/g, `${joined}.`).replace(/\^n/g, joined).replace(/\^\^/g, '^').trim()
    : `${currentValue}.`;
  return marker || `${currentValue}.`;
}

// 번호/글머리표 marker는 한 자리 목록도 너무 좁아 보이지 않게 1.8em을 최소로 두고,
// 2~3자리 다단계 번호(`10.2.`, `12.3.4.`)도 본문 첫 글자와 겹치지 않도록 4.2em 안에서 늘린다.
const LIST_MARKER_MIN_WIDTH_EM = 1.8;
const LIST_MARKER_MAX_WIDTH_EM = 4.2;
const LIST_MARKER_BASE_WIDTH_EM = 1.4;
const LIST_MARKER_CHAR_WIDTH_EM = 0.16;

// 짧은 다열 표 첫 행은 보통 compact header 성격이 강해서 가운데 정렬 대상으로 본다.
const COMPACT_TABLE_HEADER_MIN_CELLS = 3;
const COMPACT_TABLE_HEADER_MAX_CELLS = 6;
const COMPACT_TABLE_HEADER_MAX_TEXT_LENGTH = 18;
const TITLE_CELL_MIN_CONTENT_HEIGHT_PX = 48;
const COMPACT_CELL_MIN_CONTENT_HEIGHT_PX = 24;

// rowspan 라벨은 compact header와 같은 길이 제한을 쓰되 줄 수만 더 엄격하게 본다.
const GROUPED_ROW_LABEL_MAX_TEXT_LENGTH = COMPACT_TABLE_HEADER_MAX_TEXT_LENGTH;
const GROUPED_ROW_LABEL_MAX_LINES = 3;

function calculateListMarkerWidth(markerLength) {
  return Math.max(
    LIST_MARKER_MIN_WIDTH_EM,
    Math.min(LIST_MARKER_MAX_WIDTH_EM, LIST_MARKER_BASE_WIDTH_EM + (markerLength * LIST_MARKER_CHAR_WIDTH_EM)),
  );
}

function appendParagraphBlock(parent, para, className = '', options = {}) {
  const {
    alignOverride = '',
    role = '',
    rowRole = '',
    cellRole = '',
    listStateRef = null,
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
    p.style.paddingLeft = `${Math.max(0, hwpSignedUnitToPx(para.marginLeft, -34, 310, 1 / 75, 0))}px`;
  }
  if (Number.isFinite(para.marginRight) && para.marginRight > 0) {
    p.style.paddingRight = `${hwpUnitToPx(para.marginRight, 0, 310, 1 / 75, 0)}px`;
  }
  if (Number.isFinite(para.textIndent) && !['center', 'right'].includes(p.style.textAlign)) {
    p.style.textIndent = `${hwpSignedUnitToPx(para.textIndent, -170, 226, 1 / 75, 0)}px`;
  }
  if (Number.isFinite(para.spacingBefore) && para.spacingBefore > 0) {
    p.style.marginTop = `${hwpUnitToPx(para.spacingBefore, 0, 80, 1 / 75, 0)}px`;
  }
  if (Number.isFinite(para.spacingAfter) && para.spacingAfter > 0) {
    p.style.marginBottom = `${hwpUnitToPx(para.spacingAfter, 0, 80, 1 / 75, 4)}px`;
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
  const listMarker = resolveParagraphListMarker(para, listStateRef);
  let contentTarget = p;
  if (listMarker) {
    p.classList.add('hwp-list-paragraph');
    p.style.display = 'flex';
    p.style.alignItems = 'flex-start';
    p.style.columnGap = '0.35em';

    const markerEl = document.createElement('span');
    markerEl.className = 'hwp-list-marker';
    markerEl.textContent = listMarker;
    markerEl.style.display = 'inline-block';
    markerEl.style.flex = '0 0 auto';
    markerEl.style.minWidth = `${calculateListMarkerWidth(listMarker.length)}em`;
    markerEl.style.whiteSpace = 'nowrap';
    p.appendChild(markerEl);

    const contentEl = document.createElement('span');
    contentEl.className = 'hwp-paragraph-content';
    contentEl.style.display = 'inline-block';
    contentEl.style.flex = '1 1 auto';
    contentEl.style.minWidth = '0';
    p.appendChild(contentEl);
    contentTarget = contentEl;
  }

  if (!hasRenderableRuns) {
    contentTarget.innerHTML = '&nbsp;';
  } else if (effectiveRole === 'process-period' && normalizedProcessText && normalizedProcessText !== textContent) {
    contentTarget.textContent = normalizedProcessText;
  } else {
    para.texts.forEach(run => appendRunSpan(contentTarget, run));
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
    listStateRef = null,
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

  appendParagraphBlock(parent, block, '', { listStateRef });
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

function isCompactTableHeaderRow(rowVisualIndex, cells) {
  if (
    rowVisualIndex !== 0
    || cells.length < COMPACT_TABLE_HEADER_MIN_CELLS
    || cells.length > COMPACT_TABLE_HEADER_MAX_CELLS
  ) {
    return false;
  }
  return cells.every(cell => {
    const text = getCellTextInline(cell);
    if (!text || text.length > COMPACT_TABLE_HEADER_MAX_TEXT_LENGTH) return false;
    if ((cell.rowSpan || 1) !== 1) return false;
    return !(cell.paragraphs || []).some(block => block?.type === 'table');
  });
}

function isGroupedRowLabelCell(cell, text, rawText) {
  const normalized = String(text || '').replace(/\s+/g, '').trim();
  if ((cell?.rowSpan || 1) <= 1) return false;
  if ((cell?.colSpan || 1) !== 1) return false;
  if ((cell?.col || 0) > 1) return false;
  if (!normalized || normalized.length > GROUPED_ROW_LABEL_MAX_TEXT_LENGTH) return false;
  // 현재 실샘플의 그룹 라벨은 숫자가 없는 범주명(예: 출석인정결석, 질병으로 인한 결석)이라
  // 숫자가 섞인 텍스트는 번호/세부 항목 본문일 가능성이 높다고 보고 후보에서 제외한다.
  if (/[0-9]/.test(normalized)) return false;
  if ((cell?.paragraphs || []).some(block => block?.type === 'table')) return false;
  const lineCount = String(rawText || text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .length;
  return lineCount <= GROUPED_ROW_LABEL_MAX_LINES;
}

function resolveCellVerticalAlign(cell, options = {}) {
  const {
    isStackedLabelCell = false,
    isGroupedLabelCell = false,
    rowLooksLikeCompactHeader = false,
    shouldMiddleCell = false,
  } = options;
  if (isStackedLabelCell || isGroupedLabelCell) return 'middle';
  if (cell?.verticalAlign === 'top' && (rowLooksLikeCompactHeader || shouldMiddleCell)) return 'middle';
  return cell?.verticalAlign || (shouldMiddleCell ? 'middle' : 'top');
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
    const px = hwpUnitToPx(spacing, 0, 200, 1 / 75, 0);
    return px > 0 ? `${px}px` : '';
  }

  if (type === 'minimum') {
    const minPx = hwpUnitToPx(spacing, 0, 200, 1 / 75, 0);
    return `${Math.max(Math.round(baseFontPx * 1.2), minPx)}px`;
  }

  if (type === 'space-only') {
    const extraPx = hwpUnitToPx(spacing, 0, 112, 1 / 75, 0);
    return `${Math.max(Math.round(baseFontPx * 1.2), Math.round(baseFontPx + extraPx))}px`;
  }

  return `${Math.max(1, Math.min(4, spacing / 100))}`;
}

function applyImageOffsetStyles(el, imageLike, inline = false) {
  const offsetX = Number(imageLike?.offsetX) || 0;
  const offsetY = Number(imageLike?.offsetY) || 0;
  const translateX = hwpSignedUnitToPx(offsetX, inline ? -280 : -520, inline ? 280 : 520, 1 / 75, 0);
  const translateY = hwpSignedUnitToPx(offsetY, -120, 120, 1 / 75, 0);
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
  if (!pageStyle) return;

  if (pageStyle.sourceFormat === 'hwp') {
    const margins = pageStyle.margins || {};
    // HWP 단위: HWPUNIT = 1/7200 inch, 96 DPI 기준 1/75 px
    const HWP_SCALE = 1 / 75;
    pageEl.dataset.sourceFormat = 'hwp';
    if (pageStyle.width > 0) {
      pageEl.style.width = `${Math.max(680, Math.min(860, Math.round(pageStyle.width * HWP_SCALE)))}px`;
    }
    if (pageStyle.height > 0) {
      pageEl.style.minHeight = `${Math.max(980, Math.min(1300, Math.round(pageStyle.height * HWP_SCALE)))}px`;
    }
    if (margins.top > 0) {
      pageEl.style.paddingTop = `${Math.max(22, Math.min(120, Math.round(margins.top * HWP_SCALE)))}px`;
    }
    if (margins.right > 0) {
      pageEl.style.paddingRight = `${Math.max(22, Math.min(120, Math.round(margins.right * HWP_SCALE)))}px`;
    }
    if (margins.bottom > 0) {
      pageEl.style.paddingBottom = `${Math.max(22, Math.min(120, Math.round(margins.bottom * HWP_SCALE)))}px`;
    }
    if (margins.left > 0) {
      pageEl.style.paddingLeft = `${Math.max(22, Math.min(120, Math.round(margins.left * HWP_SCALE)))}px`;
    }
    return;
  }

  if (pageStyle.sourceFormat !== 'hwpx') return;

  const pageBorder = resolveHwpxPageBorder(pageStyle, pageIndex);
  const borderOffset = pageBorder?.offset || {};
  const margins = pageStyle.margins || {};

  // HWP·HWPX 모두 HWPUNIT (1/7200 inch) 기준: 96 DPI 환산 스케일 = 1/75
  const HWPX_SCALE = 1 / 75;
  pageEl.dataset.sourceFormat = 'hwpx';
  if (pageStyle.width > 0) {
    pageEl.style.width = `${Math.max(680, Math.min(860, Math.round(pageStyle.width * HWPX_SCALE)))}px`;
  }
  if (pageStyle.height > 0) {
    pageEl.style.minHeight = `${Math.max(980, Math.min(1300, Math.round(pageStyle.height * HWPX_SCALE)))}px`;
  }
  const topVal = (margins.top || 0) + (borderOffset.top || 0);
  if (topVal > 0) {
    pageEl.style.paddingTop = `${Math.max(22, Math.min(120, Math.round(topVal * HWPX_SCALE)))}px`;
  }
  const rightVal = (margins.right || 0) + (borderOffset.right || 0);
  if (rightVal > 0) {
    pageEl.style.paddingRight = `${Math.max(22, Math.min(120, Math.round(rightVal * HWPX_SCALE)))}px`;
  }
  const bottomVal = (margins.bottom || 0) + (borderOffset.bottom || 0);
  if (bottomVal > 0) {
    pageEl.style.paddingBottom = `${Math.max(22, Math.min(120, Math.round(bottomVal * HWPX_SCALE)))}px`;
  }
  const leftVal = (margins.left || 0) + (borderOffset.left || 0);
  if (leftVal > 0) {
    pageEl.style.paddingLeft = `${Math.max(22, Math.min(120, Math.round(leftVal * HWPX_SCALE)))}px`;
  }

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
    listStateRef = null,
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
  const isHwpxTable = tableBlock.sourceFormat === 'hwpx';
  // HWP·HWPX 모두 HWPUNIT (1/7200 inch) 기준 단위 사용 확인됨 (실제 HWPX XML 분석 기준)
  // 96 DPI 환산 스케일 = 1/75 (1 HWPUNIT = 96/7200 ≈ 1/75 px)
  const TABLE_UNIT_SCALE = 1 / 75;
  const cellSpacingPx = Math.max(0, Math.min(48, Math.round((Number(tableBlock.cellSpacing) || 0) * TABLE_UNIT_SCALE)));
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
    const rowLooksLikeCompactHeader = isCompactTableHeaderRow(rowVisualIndex, cells);
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
    else if (rowLooksLikeCompactHeader) tr.dataset.rowRole = 'header';
    else if (rowLooksLikePersonForm) tr.dataset.rowRole = 'person-form';
    else tr.dataset.rowRole = 'body';

    const rowHeight = tableBlock.rowHeights?.[row.index];
    const maxCellHeight = cells.reduce((max, cell) => Math.max(max, Number(cell.height) || 0), 0);
    const maxContentHeight = cells.reduce((max, cell) => Math.max(max, Number(cell.contentHeight) || 0), 0);
    const maxParagraphLines = cells.reduce((max, cell) => Math.max(max, cell.paragraphs?.length || 1), 1);
    const explicitHwpxRowHeight = isHwpxTable
      ? Number(tableBlock.hwpxRowHeights?.[row.index]) || 0
      : 0;
    const rowHeightPx = isHwpxTable
      ? (explicitHwpxRowHeight > 0
        ? Math.max(0, Math.min(280, Math.round(explicitHwpxRowHeight * TABLE_UNIT_SCALE)))
        : hwpUnitToPx(rowHeight, 24, 280, 12, 0))
      : Math.max(0, Math.min(320, Math.round((Number(rowHeight) || 0) * TABLE_UNIT_SCALE)));
    const cellHeightPx = isHwpxTable
      ? Math.max(0, Math.min(200, Math.round(maxCellHeight * TABLE_UNIT_SCALE)))
      : Math.max(0, Math.min(300, Math.round(maxCellHeight * TABLE_UNIT_SCALE)));
    const contentHeightPx = isHwpxTable
      ? Math.max(0, Math.min(200, Math.round(maxContentHeight * TABLE_UNIT_SCALE)))
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
      const isGroupedLabelCell = !explicitCellRole
        && !isStackedLabelCell
        && isGroupedRowLabelCell(cell, text, rawText);
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
      else if (isGroupedLabelCell) td.dataset.role = 'group-label';
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

      const cellVerticalAlign = resolveCellVerticalAlign(cell, {
        isStackedLabelCell,
        isGroupedLabelCell,
        rowLooksLikeCompactHeader,
        shouldMiddleCell,
      });
      td.style.verticalAlign = cellVerticalAlign;

      const [padL, padR, padT, padB] = cell.padding || [];
      const hasPaddingInfo = [padL, padR, padT, padB].some(v => Number(v) > 0);
      let topPx = 3;
      let rightPx = 4;
      let bottomPx = 3;
      let leftPx = 4;
      if (hasPaddingInfo) {
        topPx    = Math.max(0, Math.min(18, Math.round((Number(padT) || 0) * TABLE_UNIT_SCALE)));
        rightPx  = Math.max(0, Math.min(20, Math.round((Number(padR) || 0) * TABLE_UNIT_SCALE)));
        bottomPx = Math.max(0, Math.min(18, Math.round((Number(padB) || 0) * TABLE_UNIT_SCALE)));
        leftPx   = Math.max(0, Math.min(20, Math.round((Number(padL) || 0) * TABLE_UNIT_SCALE)));
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
      const shouldCenterContent = rowLooksLikeTitle || rowLooksLikeCompactHeader || isGroupedLabelCell;
      if (shouldCenterContent) {
        const innerHeight = Math.max(
          rowLooksLikeTitle ? TITLE_CELL_MIN_CONTENT_HEIGHT_PX : COMPACT_CELL_MIN_CONTENT_HEIGHT_PX,
          minRowHeight - topPx - bottomPx,
        );
        content.style.minHeight = `${innerHeight}px`;
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.justifyContent = 'center';
        if (isTitleLabelCell || isOptionCell || shouldCenterCell || rowLooksLikeCompactHeader || isGroupedLabelCell) {
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
            listStateRef,
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
          listStateRef,
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
