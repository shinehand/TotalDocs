/**
 * hwp-parser-hwp5-records.js — HWP5 record/body parser extension
 * hwp-parser.js core가 만든 전역 HwpParser에 HWP5 레코드, DocInfo, 문단/표/개체 해석 기능을 덧붙입니다.
 */

if (typeof HwpParser === 'undefined') {
  throw new Error('js/hwp-parser.js must be loaded before js/hwp-parser-hwp5-records.js');
}

Object.assign(HwpParser, {
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

  _hwpHex(value, width = 4) {
    return `0x${(Number(value) >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
  },

  _bytesToHex(data, start = 0, end = data?.length || 0) {
    if (!data?.length) return '';
    const safeStart = Math.max(0, Math.min(data.length, Number(start) || 0));
    const safeEnd = Math.max(safeStart, Math.min(data.length, Number(end) || 0));
    const out = [];
    for (let i = safeStart; i < safeEnd; i += 1) {
      out.push((data[i] || 0).toString(16).toUpperCase().padStart(2, '0'));
    }
    return out.join('');
  },

  _recordParaTextControl(options, control) {
    if (!Array.isArray(options?.controls)) return;
    const offset = Math.max(0, (Number(options.baseOffset) || 0) + (Number(control.offset) || 0));
    options.controls.push({
      ...control,
      offset,
      charCodeHex: HwpParser._hwpHex(control.charCode || 0, 4),
    });
  },

  _hwpControlKind(controlId = '') {
    switch (controlId) {
      case 'tbl ': return 'table';
      case 'gso ': return 'drawing';
      case 'eqed': return 'equation';
      case 'head': return 'header';
      case 'foot': return 'footer';
      case 'secd': return 'sectionDefinition';
      case 'fn  ': return 'footnote';
      case 'en  ': return 'endnote';
      default: return controlId ? 'control' : '';
    }
  },

  _attachHwpControlHeader(paraState, controlId, record) {
    if (!Array.isArray(paraState?.controls) || !controlId) return;
    const controls = paraState.controls;
    const target = [...controls].reverse().find(control => (
      control.kind === 'extendedControl' && !control.controlId
    )) || [...controls].reverse().find(control => !control.controlId);
    if (!target) return;
    target.controlId = controlId;
    target.controlKind = HwpParser._hwpControlKind(controlId);
    target.recordTagId = record?.tagId ?? 71;
    target.recordLevel = record?.level ?? 0;
    target.recordSize = record?.size ?? 0;
    target.ctrlHeaderRawHex = HwpParser._bytesToHex(record?.body || [], 0, Math.min(record?.body?.length || 0, 64));
  },

  _decodeParaText(data, start, end, options = {}) {
    const chars = [];
    let i = start;

    while (i + 2 <= end) {
      const ch = data[i] | (data[i + 1] << 8);
      const recordControl = (kind, spanBytes, replacement = '') => {
        const safeSpan = Math.max(0, Math.min(spanBytes, end - i));
        HwpParser._recordParaTextControl(options, {
          kind,
          offset: chars.length,
          sourceOffset: i,
          spanBytes: safeSpan,
          charCode: ch,
          replacement,
          rawHex: HwpParser._bytesToHex(data, i, i + safeSpan),
        });
      };

      if (ch === 0x000D) {
        recordControl('paragraphBreak', 2, '');
        i += 2;
        break;
      }

      if (ch === 0x0009) {
        recordControl('tab', 16, '\t');
        chars.push('\t');
        i += 16;
        continue;
      }

      if (ch === 0x000A) {
        recordControl('lineBreak', 2, '\n');
        chars.push('\n');
        i += 2;
        continue;
      }

      if (ch === 0x0018) {
        recordControl('fixedWidthHyphen', 2, '-');
        chars.push('-');
        i += 2;
        continue;
      }

      if (ch === 0x001E || ch === 0x001F) {
        recordControl(ch === 0x001E ? 'nonBreakingHyphen' : 'nonBreakingSpace', 2, ' ');
        chars.push(' ');
        i += 2;
        continue;
      }

      if (HwpParser._isInlineOrExtendedControl(ch)) {
        recordControl('extendedControl', 16, '');
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
    // face IDs: 한글(0), 영어(2), 한자(4), 일어(6), 기타(8), 심벌(10), 사용자(12)
    const faceId      = HwpParser._u16(body, 0);
    const faceIdLatin = HwpParser._u16(body, 2);
    const fontName      = faceNames[faceId]      || '';
    const fontNameLatin = faceNames[faceIdLatin]  || '';
    const scaleX = body[14] ?? 100;
    const letterSpacing = (body[21] ?? 0) << 24 >> 24;
    const relSize = body[28] ?? 100;
    const offsetY = (body[35] ?? 0) << 24 >> 24;
    const fontSizeRaw = HwpParser._u32(body, 42);
    return {
      fontName,
      fontNameLatin: fontNameLatin !== fontName ? fontNameLatin : '',
      fontSize: fontSizeRaw > 0 ? Math.round((fontSizeRaw / 100) * 10) / 10 : 0,
      color: HwpParser._hwpColorRefToCss(HwpParser._u32(body, 52)),
      bold: Boolean(attr & (1 << 1)),
      italic: Boolean(attr & 1),
      underline: ((attr >> 2) & 0x3) !== 0,
      strike: Boolean((attr >> 18) & 0x7),
      superscript: Boolean(attr & (1 << 15)),
      subscript: Boolean(attr & (1 << 16)),
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
    // attr2 is at offset 42 (한 줄 입력 / 자동 간격 flags — not line spacing type).
    // attr3 at offset 46 holds the new line-spacing kind (bits 0-4).
    // lineSpacingNew at offset 50 holds the new line-spacing value.
    const attr3 = body.length >= 50 ? HwpParser._u32(body, 46) : 0;
    const modernLineSpacing = body.length >= 54 ? HwpParser._u32(body, 50) : 0;
    const legacyLineSpacing = body.length >= 28 ? HwpParser._u32(body, 24) : 0;
    const modernLineSpacingType = modernLineSpacing
      ? HwpParser._hwpLineSpacingTypeFromCode(attr3 & 0x1F)
      : null;
    // Modern percent format stores value×100 (16000=160%); normalize to legacy scale (160=160%)
    // so that resolveParagraphLineHeight can use a consistent divisor of 100.
    const lineSpacing = modernLineSpacing
      ? (modernLineSpacingType === 'percent'
        ? Math.round(modernLineSpacing / 100)
        : modernLineSpacing)
      : (legacyLineSpacing || 0);
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
      lineSpacingType: modernLineSpacingType || HwpParser._hwpLineSpacingTypeFromCode(attr & 0x3),
      lineSpacing,
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
      return { paraShapeId: 0, charShapes: [], controls: [] };
    }
    const rawCharCount = HwpParser._u32(body, 0);
    return {
      rawCharCount,
      charCount: rawCharCount & 0x7FFFFFFF,
      hasExtendedCharCount: Boolean(rawCharCount & 0x80000000),
      controlMask: HwpParser._u32(body, 4),
      paraShapeId: HwpParser._u16(body, 8),
      styleId: body[10] ?? 0,
      splitFlags: body[11] ?? 0,
      charShapeCount: HwpParser._u16(body, 12),
      rangeTagCount: body.length >= 16 ? HwpParser._u16(body, 14) : 0,
      lineAlignCount: body.length >= 18 ? HwpParser._u16(body, 16) : 0,
      instanceId: body.length >= 22 ? HwpParser._u32(body, 18) : 0,
      charShapes: [],
      controls: [],
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
      // Accept lines from tiny text (200 = ~2.7px) up to large headings (14400 = ~192px)
      return height >= 200 && height <= 14400;
    });
    if (!saneSegs.length) {
      return { lineHeightPx: 0, layoutHeightPx: 0 };
    }

    const heights = saneSegs.map(seg => Math.max(Number(seg.height) || 0, Number(seg.textHeight) || 0));
    const totalHeight = heights.reduce((sum, value) => sum + value, 0);
    const avgHeight = totalHeight / heights.length;
    // HWPUNIT (1/7200 inch) → px at 96 DPI: 1/75 scale.
    // Allow up to 96px per line so large heading fonts are not clamped.
    return {
      lineHeightPx: Math.max(11, Math.min(96, Math.round(avgHeight / 75))),
      layoutHeightPx: Math.max(12, Math.min(480, Math.round(totalHeight / 75))),
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
    const tabDef = docInfo?.tabDefs?.[paraStyle?.tabDefId];
    const tabStops = (tabDef?.tabs || []).map(t => ({ position: t.position, kind: t.kind }));
    const controls = Array.isArray(paraState?.controls)
      ? paraState.controls.map(control => ({ ...control }))
      : [];
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
      tabStops,
      listInfo: HwpParser._resolveHwpParagraphListInfo(paraStyle, docInfo),
      lineHeightPx: lineMetrics.lineHeightPx,
      layoutHeightPx: lineMetrics.layoutHeightPx,
      controls,
      hwp: {
        charCount: paraState?.charCount ?? 0,
        rawCharCount: paraState?.rawCharCount ?? 0,
        controlMask: paraState?.controlMask ?? 0,
        controlMaskHex: HwpParser._hwpHex(paraState?.controlMask || 0, 8),
        paraShapeId: paraState?.paraShapeId ?? 0,
        styleId: paraState?.styleId ?? 0,
        charShapeCount: paraState?.charShapeCount ?? 0,
        rangeTagCount: paraState?.rangeTagCount ?? 0,
        lineAlignCount: paraState?.lineAlignCount ?? 0,
        instanceId: paraState?.instanceId ?? 0,
      },
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
    let documentProperties = null;
    let idMappings = null;
    const binDataRefs = {};
    let faceNameId = 1;
    let binDataRefId = 1;
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
      if (rec.tagId === 16) {
        documentProperties = HwpParser._parseHwpDocumentProperties(rec.body);
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 17) {
        idMappings = HwpParser._parseHwpIdMappings(rec.body);
        pos = rec.nextPos;
        continue;
      }
      if (rec.tagId === 18) {
        const binData = HwpParser._parseHwpBinData(rec.body, binDataRefId);
        if (binData) {
          binDataRefs[binDataRefId] = binData;
        }
        binDataRefId += 1;
        pos = rec.nextPos;
        continue;
      }
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
      documentProperties,
      idMappings,
      binDataRefs,
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
      binDataRefCount: binDataRefId - 1,
    };
  },

  async _parseHwpDocInfoStream(data, streamOptions = {}) {
    const normalizedOptions = typeof streamOptions === 'object'
      ? streamOptions
      : { compressedHint: Boolean(streamOptions) };
    const { compressedHint = false, distributedHint = false } = normalizedOptions;
    const attempts = await HwpParser._buildHwpRecordAttempts(data, { compressedHint, distributedHint });

    let best = {
      documentProperties: null,
      idMappings: null,
      binDataRefs: {},
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
      binDataRefCount: 0,
    };
    let bestMode = 'raw';
    for (const attempt of attempts) {
      if (!attempt.bytes?.length) continue;
      const parsed = HwpParser._parseHwpDocInfoRecords(attempt.bytes);
      const score = (parsed.faceNameCount || 0)
        + (parsed.binDataRefCount || 0)
        + (parsed.borderFillCount || 0)
        + (parsed.charShapeCount || 0)
        + (parsed.tabDefCount || 0)
        + (parsed.numberingCount || 0)
        + (parsed.bulletCount || 0)
        + (parsed.paraShapeCount || 0)
        + (parsed.styleCount || 0);
      const bestScore = (best.faceNameCount || 0)
        + (best.binDataRefCount || 0)
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
        '[HWP] DocInfo: binData=%d borderFill=%d charShape=%d tabDef=%d numbering=%d bullet=%d paraShape=%d style=%d (%s)',
        best.binDataRefCount || 0,
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
    // HWP 5 CTRL_HEADER bits 21-23 (obTextWrapStyle):
    // 0: 자리차지 (top-and-bottom), 1: 정사각형 (square), 2: 빡빡하게 (tight),
    // 3: 투명하게 (through), 4: 글 뒤에 (behind-text), 5: 글 앞에 (in-front-of-text)
    return ['top-and-bottom', 'square', 'tight', 'through', 'behind-text', 'in-front-of-text'][Number(code) || 0]
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
    // HWPTAG_PAGE_DEF (tag 73): secd 컨트롤 내부의 페이지 정의 레코드 — 40바이트
    // offset  0: paperWidth (HWPUNIT), 4: paperHeight (HWPUNIT)
    // offset  8: marginLeft, 12: marginRight, 16: marginTop, 20: marginBottom
    // offset 24: marginHeader, 28: marginFooter, 32: gutter, 36: flags
    // flags bit 8: hide header on first page, bit 9: hide footer on first page
    if (!body || body.length < 32) return null;
    const paperWidth  = HwpParser._i32(body, 0);
    const paperHeight = HwpParser._i32(body, 4);
    if (paperWidth <= 0 || paperHeight <= 0) return null;
    const flags = body.length >= 40 ? HwpParser._u32(body, 36) : 0;
    const hideFirstHeader = Boolean(flags & (1 << 8));
    const hideFirstFooter = Boolean(flags & (1 << 9));
    const hideFirstPageNum = Boolean(flags & (1 << 10));
    return {
      sourceFormat: 'hwp',
      width:  paperWidth,
      height: paperHeight,
      margins: {
        left:   HwpParser._i32(body, 8),
        right:  HwpParser._i32(body, 12),
        top:    HwpParser._i32(body, 16),
        bottom: HwpParser._i32(body, 20),
        header: HwpParser._i32(body, 24),
        footer: HwpParser._i32(body, 28),
      },
      visibility: {
        hideFirstHeader: hideFirstHeader ? '1' : '0',
        hideFirstFooter: hideFirstFooter ? '1' : '0',
        hideFirstPageNum: hideFirstPageNum ? '1' : '0',
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
    let shapeComponentBody = null;
    let hasChartData = false;
    let hasVideoData = false;

    // Text box support: track LIST_HEADER (tag 72) and collect paragraph records
    let hasListHeader = false;
    const textBoxParas = [];
    let textBoxCurrentText = null;
    let textBoxParaState = { paraShapeId: 0, charShapes: [], lineSegs: [], controls: [] };
    const pushTextBoxPara = () => {
      if (textBoxCurrentText === null) return;
      textBoxParas.push(HwpParser._createHwpParagraphBlock(textBoxCurrentText, textBoxParaState, docInfo));
      textBoxCurrentText = null;
      textBoxParaState = { paraShapeId: 0, charShapes: [], lineSegs: [], controls: [] };
    };

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
      } else if (rec.tagId === 86 && !shapeComponentBody) {
        shapeComponentBody = rec.body;
      } else if (rec.tagId === 95) {
        hasChartData = true;
      } else if (rec.tagId === 98) {
        hasVideoData = true;
      } else if (rec.tagId === 72 && !hasListHeader) {
        hasListHeader = true;
        textBoxCurrentText = '';
      } else if (hasListHeader && !pictureBody && !oleBody && !equationBody) {
        if (rec.tagId === 66) {
          pushTextBoxPara();
          textBoxCurrentText = '';
          textBoxParaState = HwpParser._parseHwpParaHeader(rec.body);
          textBoxParaState.lineSegs = [];
          textBoxParaState.controls = [];
        } else if (rec.tagId === 67) {
          if (textBoxCurrentText === null) textBoxCurrentText = '';
          textBoxCurrentText += HwpParser._decodeParaText(rec.body, 0, rec.body.length, {
            controls: textBoxParaState.controls,
            baseOffset: textBoxCurrentText.length,
          });
        } else if (rec.tagId === 68) {
          textBoxParaState.charShapes = HwpParser._parseHwpParaCharShape(rec.body);
        } else if (rec.tagId === 69) {
          textBoxParaState.lineSegs = HwpParser._parseHwpParaLineSeg(rec.body);
        }
      }
      pos = rec.nextPos;
    }
    pushTextBoxPara();

    let block = null;
    if (equationBody) {
      block = HwpParser._parseHwpEquationBlock(objectInfo, equationBody);
    } else if (pictureBody) {
      block = HwpParser._parseHwpGsoBlock(objectInfo, pictureBody, docInfo);
    } else if (oleBody) {
      block = HwpParser._parseHwpOleBlock(objectInfo, oleBody, docInfo, { hasChartData, hasVideoData });
    } else if (hasListHeader && textBoxParas.length) {
      block = HwpParser._parseHwpTextBoxBlock(objectInfo, textBoxParas);
    } else if (objectInfo?.width > 0 && objectInfo?.height > 0) {
      const shapeInfo = shapeComponentBody
        ? HwpParser._parseHwpShapeComponent(shapeComponentBody)
        : null;
      block = HwpParser._parseHwpShapePlaceholder(objectInfo, shapeInfo);
    }

    return {
      block,
      nextPos: pos,
    };
  },

  _parseHwpTextBoxBlock(objectInfo, paragraphs) {
    if (!objectInfo) return null;
    return HwpParser._withObjectLayout({
      type: 'textbox',
      paragraphs: paragraphs || [],
      width: objectInfo.width || 0,
      height: objectInfo.height || 0,
      sourceFormat: 'hwp',
      texts: (paragraphs || []).flatMap(p => p.texts || []),
    }, objectInfo);
  },

  // HWPTAG_SHAPE_COMPONENT (tag 86) 바디에서 선 색상·채움 색상을 추출한다.
  // 구조: [localFileVersion:4][xOffset:4][yOffset:4][initW:4][initH:4][curW:4][curH:4]
  //        [flags:4][rotation:4][rotCenterX:4][rotCenterY:4][renderCount:2]
  //        renderCount*24 bytes of matrix data
  //        [lineColor:4][lineWidth:4][lineAttr:4][outlineStyle:1]
  //        [fillType:4][fillColor:4] ...
  _parseHwpShapeComponent(body) {
    if (!body || body.length < 46) return null;
    // Skip fixed header: 11 DWORDs (44 bytes) + WORD renderCount (2 bytes) = 46 bytes
    const renderCount = HwpParser._u16(body, 44);
    const lineOffset = 46 + renderCount * 24;
    if (lineOffset + 4 > body.length) return null;

    const lineColor = HwpParser._hwpColorRefToCss(HwpParser._u32(body, lineOffset));
    const lineWidthRaw = lineOffset + 4 < body.length ? HwpParser._u32(body, lineOffset + 4) : 0;
    const lineWidthMm = lineWidthRaw > 0 ? lineWidthRaw / 100 : 0;
    // fill info follows after lineColor(4) + lineWidth(4) + lineAttr(4) + outlineStyle(1) = 13
    const fillOffset = lineOffset + 13;
    const { fillColor, fillGradient } = fillOffset + 4 < body.length
      ? HwpParser._parseHwpFillInfo(body, fillOffset)
      : { fillColor: '', fillGradient: null };

    return { fillColor, fillGradient, lineColor, lineWidthMm };
  },

  _parseHwpShapePlaceholder(objectInfo, shapeInfo = null) {
    if (!objectInfo || !(objectInfo.width > 0)) return null;
    return HwpParser._withObjectLayout({
      type: 'shape',
      width: objectInfo.width || 0,
      height: objectInfo.height || 0,
      sourceFormat: 'hwp',
      fillColor: shapeInfo?.fillColor || '',
      fillGradient: shapeInfo?.fillGradient || null,
      lineColor: shapeInfo?.lineColor || '',
      lineWidthMm: shapeInfo?.lineWidthMm || 0,
      texts: [HwpParser._run('')],
    }, objectInfo);
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

    // DWORD at offset 0: attribute flags
    //   bits 0-4: numHeaderRow (0-31) — 머리 행 수 (반복 출력 행 수)
    const attrDword = HwpParser._u32(body, 0);
    const numHeaderRows = attrDword & 0x1F; // bits 0-4

    const rowCount = HwpParser._u16(body, 4);
    const colCount = HwpParser._u16(body, 6);
    const cellSpacing = HwpParser._u16(body, 8);
    // offsets 10-17: 표 전체 기본 셀 내부 여백 (HWPUNIT) — 셀이 자체 여백을 지정하지 않을 때 기준값
    const defaultCellPadding = [
      HwpParser._u16(body, 10), // left
      HwpParser._u16(body, 12), // right
      HwpParser._u16(body, 14), // top
      HwpParser._u16(body, 16), // bottom
    ];
    const rowHeights = [];

    let off = 18;
    for (let i = 0; i < rowCount && off + 2 <= body.length; i++, off += 2) {
      rowHeights.push(HwpParser._u16(body, off));
    }

    return {
      numHeaderRows,
      rowCount,
      colCount,
      cellSpacing,
      defaultCellPadding,
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

    if (block.type === 'shape') {
      return '[도형]';
    }

    if (block.type === 'textbox') {
      const inner = (block.paragraphs || [])
        .map(para => HwpParser._blockText(para))
        .join('\n')
        .trim();
      return inner || '[텍스트박스]';
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
      const h = Number(block.height) || 0;
      // HWPX 이미지: height는 1/100mm 단위 (orgSz/curSz 기준)
      // 1/100mm × (96px/inch ÷ 25.4mm/inch) ÷ (20px/weight)
      //   = 96 / (25.4 × 100 × 20) = 96 / 50800 ≈ 1/529
      // 즉, height(1/100mm) / 529 ≈ weight unit 수
      const HWPX_IMAGE_WEIGHT_DIVISOR = 529; // 1/100mm → weight unit (96DPI, 20px/weight)
      const HWPX_IMAGE_WEIGHT_MAX = 10;
      if (block.sourceFormat === 'hwpx') {
        return Math.max(1, Math.min(HWPX_IMAGE_WEIGHT_MAX, Math.round(h / HWPX_IMAGE_WEIGHT_DIVISOR)));
      }
      return Math.max(1, Math.min(6, Math.round((h || 1200) / 1000)));
    }
    if (block.type === 'shape' || block.type === 'textbox') {
      if (block.inline) return 1;
      // shape/textbox height는 HWP HWPUNIT 기준
      return Math.max(1, Math.min(8, Math.round((Number(block.height) || 1200) / 1000)));
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
      // startRowOffset lets the renderer know which rows in the original table these rows correspond to
      // (used to determine if header rows should be rendered as <thead>)
      startRowOffset: startRow,
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
      defaultCellPadding: tableInfo?.defaultCellPadding || null,
      rowHeights: tableInfo?.rowHeights || [],
      numHeaderRows: Math.max(0, Number(tableInfo?.numHeaderRows) || 0),
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
        let currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [], controls: [] };
        const pushParagraph = () => {
          if (currentText === null) return;
          paragraphs.push(HwpParser._createHwpParagraphBlock(currentText, currentParaState, docInfo));
          currentText = null;
          currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [], controls: [] };
        };

      while (pos < data.length) {
        const next = HwpParser._readRecord(data, pos);
        if (!next) break;
        if (next.level <= ctrlLevel) break;
        if (next.level === ctrlLevel + 1 && next.tagId === 72) break;

        if (next.tagId === 71) {
          const nestedCtrlId = HwpParser._ctrlId(next.body);
          HwpParser._attachHwpControlHeader(currentParaState, nestedCtrlId, next);
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
            currentParaState.controls = [];
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
            currentText += HwpParser._decodeParaText(next.body, 0, next.body.length, {
              controls: currentParaState.controls,
              baseOffset: currentText.length,
            });
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
    let currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [], controls: [] };
    const pushParagraph = () => {
      if (currentText === null) return;
      paras.push(HwpParser._createHwpParagraphBlock(currentText, currentParaState, docInfo));
      currentText = null;
      currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [], controls: [] };
    };

    while (pos < data.length) {
      const rec = HwpParser._readRecord(data, pos);
      if (!rec) break;
      if (stopLevel !== null && rec.level <= stopLevel) break;

      if (rec.tagId === 71) {
        const controlId = HwpParser._ctrlId(rec.body);
        HwpParser._attachHwpControlHeader(currentParaState, controlId, rec);
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
          const applyPageType = HwpParser._parseHwpHeaderFooterApplyPageType(rec.body);
          const target = controlId === 'head' ? extras?.headerBlocks : extras?.footerBlocks;
          const targetAreas = controlId === 'head' ? extras?.headerAreas : extras?.footerAreas;
          if (target && subtree.blocks.length) {
            target.push(...subtree.blocks);
          }
          if (targetAreas && subtree.blocks.length) {
            targetAreas.push({
              applyPageType,
              blocks: subtree.blocks,
            });
          }
          pos = subtree.nextPos;
          continue;
        }

        if (controlId === 'secd') {
          pushParagraph();
          if (extras && !extras.sectionMeta) {
            // tag-73: PAGE_DEF (용지/여백), tag-76: PAGE_NUM_PARA (쪽번호 위치/형식)
            // break 없이 전체 서브레코드를 스캔해 두 레코드를 모두 수집한다.
            let scanPos = rec.nextPos;
            let secDef = null;
            let pageNumMeta = null;
            while (scanPos < data.length) {
              const sub = HwpParser._readRecord(data, scanPos);
              if (!sub) break;
              if (sub.level <= rec.level) break;
              if (sub.tagId === 73 && !secDef) {
                secDef = HwpParser._parseHwpSecDef(sub.body);
              } else if (sub.tagId === 76 && !pageNumMeta) {
                pageNumMeta = HwpParser._parseHwpPageNumMeta(sub.body);
              }
              scanPos = sub.nextPos;
            }
            if (secDef) {
              if (pageNumMeta) {
                secDef.pageNumber = pageNumMeta;
                // startPageNum: tag-76 PAGE_NUM_PARA에서 읽은 시작 쪽번호 (기본 1)
                if (pageNumMeta.startPageNum > 1) {
                  secDef.startPageNum = pageNumMeta.startPageNum;
                }
              }
              extras.sectionMeta = secDef;
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
        currentParaState.controls = [];
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
        currentText += HwpParser._decodeParaText(rec.body, 0, rec.body.length, {
          controls: currentParaState.controls,
          baseOffset: currentText.length,
        });
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
    let bestHeaderAreas = [];
    let bestFooterAreas = [];
    let bestSectionMeta = null;
    let bestScore = 0;

    for (const { mode, bytes } of attempts) {
      const extras = {
        headerBlocks: [],
        footerBlocks: [],
        headerAreas: [],
        footerAreas: [],
        sectionMeta: null,
      };
      const paras = HwpParser._parseHwpRecords(bytes, docInfo, extras);
      const score = HwpParser._scoreParas(paras);
      if (score > bestScore) {
        bestScore = score;
        bestParas = paras;
        bestHeaderBlocks = extras.headerBlocks;
        bestFooterBlocks = extras.footerBlocks;
        bestHeaderAreas = extras.headerAreas || [];
        bestFooterAreas = extras.footerAreas || [];
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
        headerAreas: bestHeaderAreas,
        footerAreas: bestFooterAreas,
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
        return {
          paras,
          headerBlocks: [],
          footerBlocks: [],
          headerAreas: [],
          footerAreas: [],
          sectionMeta: null,
        };
      }
    }

    return {
      paras: [],
      headerBlocks: [],
      footerBlocks: [],
      headerAreas: [],
      footerAreas: [],
      sectionMeta: null,
    };
  },


});
