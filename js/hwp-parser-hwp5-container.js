/**
 * hwp-parser-hwp5-container.js — HWP5 OLE/CFB container and stream parser extension
 * hwp-parser.js core가 만든 전역 HwpParser에 기능을 덧붙이는 plain-script 확장 파일입니다.
 */

if (typeof HwpParser === 'undefined') {
  throw new Error('js/hwp-parser.js must be loaded before js/hwp-parser-hwp5-container.js');
}

Object.assign(HwpParser, {
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

  async _parseHwpBinaryMap(cfbOrBytes, allEntries, ss, fat, miniCutoff, miniStream, miniFat, docInfo = null) {
    const cfb = cfbOrBytes?.entries ? cfbOrBytes : null;
    const binEntries = cfb
      ? HwpParser._cfbEntriesUnder(cfb, 'BinData', /^(?:BIN|BinaryData)\d+/i).map(entry => [entry.name, entry])
      : Object.entries(allEntries || {}).filter(([name]) => /^(?:BIN|BinaryData)\d+/i.test(name));

    binEntries.sort((a, b) => {
        const ai = HwpParser._hwpBinaryStreamId(a[0]);
        const bi = HwpParser._hwpBinaryStreamId(b[0]);
        return ai - bi;
      });

    const images = {};
    const ordered = [];
    const byId = {};
    const allById = {};

    for (const [name, entry] of binEntries) {
      const numericId = HwpParser._hwpBinaryStreamId(name);
      const binMeta = HwpParser._hwpBinDataMetaForStream(docInfo, numericId);
      const baseEntry = {
        id: numericId,
        refId: binMeta?.refId || 0,
        binDataId: binMeta?.binDataId || numericId,
        name,
        path: entry?.path || name,
        size: Number(entry?.streamSz) || 0,
        extension: binMeta?.extension || String(name).split('.').pop().toLowerCase(),
        storageType: binMeta?.type || '',
        compression: binMeta?.compression || '',
        state: binMeta?.state || '',
      };
      if (numericId > 0) {
        allById[numericId] = baseEntry;
      }
      if (baseEntry.refId > 0) {
        allById[baseEntry.refId] = baseEntry;
      }

      if (!/\.(png|jpe?g|gif|bmp|webp)$/i.test(name) && !/^(png|jpe?g|gif|bmp|webp)$/i.test(baseEntry.extension)) continue;

      let bytes = cfb
        ? HwpParser._readCfbEntryStream(cfb, entry)
        : HwpParser._readEntryStream(cfbOrBytes, entry, ss, fat, miniCutoff, miniStream, miniFat);
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
      if (baseEntry.refId > 0) {
        byId[baseEntry.refId] = imageEntry;
        allById[baseEntry.refId] = imageEntry;
      }
    }

    return { images, ordered, byId, allById };
  },

  _hwpBinaryStreamId(name = '') {
    const match = String(name || '').match(/^(?:BIN|BinaryData)(\d+)/i);
    return Number(match?.[1] || 0);
  },

  _hwpBinDataMetaForStream(docInfo = null, streamId = 0) {
    if (!docInfo?.binDataRefs || !Number.isFinite(streamId) || streamId <= 0) return null;
    return Object.values(docInfo.binDataRefs).find(ref => (
      ref?.binDataId === streamId
    )) || docInfo.binDataRefs[streamId] || null;
  },


  _createCfbContext(b) {
    if (!HwpParser._isOleCompound(b)) return null;
    const ss = (() => {
      const e = HwpParser._u16(b, 0x1E);
      return (e >= 7 && e <= 14) ? (1 << e) : 512;
    })();
    const miniCutoff = HwpParser._u32(b, 0x38) || 4096;
    const dirStartSec = HwpParser._u32(b, 0x30);
    if (dirStartSec >= 0xFFFFFFFA) return null;

    const fat = HwpParser._readFat(b, ss);
    const miniFat = HwpParser._readMiniFat(b, ss, fat);
    const entries = HwpParser._readCfbDirectoryEntries(b, ss, fat, dirStartSec);
    if (!entries.length) return null;
    HwpParser._assignCfbPaths(entries);

    const rootEntry = entries[0];
    const miniStream = (rootEntry?.startSec < 0xFFFFFFFA && rootEntry?.streamSz > 0)
      ? HwpParser._readStreamByFat(b, rootEntry.startSec, rootEntry.streamSz, ss, fat)
      : null;

    const byPath = {};
    const byName = {};
    entries.forEach(entry => {
      if (!entry?.name) return;
      if (entry.path) byPath[entry.path.toLowerCase()] = entry;
      const key = entry.name.toLowerCase();
      if (!byName[key]) byName[key] = [];
      byName[key].push(entry);
    });

    return { b, ss, miniCutoff, fat, miniFat, miniStream, entries, byPath, byName, rootEntry };
  },

  _readCfbDirectoryEntries(b, ss, fat, dirStartSec) {
    const entries = [];
    let sec = dirStartSec;
    const visited = new Set();
    while (sec < 0xFFFFFFF8 && !visited.has(sec)) {
      visited.add(sec);
      const base = (sec + 1) * ss;
      if (base + ss > b.length) break;

      for (let pos = base; pos + 128 <= base + ss; pos += 128) {
        const nameBytes = Math.max(0, Math.min(64, HwpParser._u16(b, pos + 64) - 2));
        const name = nameBytes > 0
          ? new TextDecoder('utf-16le')
            .decode(b.slice(pos, pos + nameBytes))
            .replace(/\u0000/g, '')
          : '';
        const streamSzLow = HwpParser._u32(b, pos + 120);
        const streamSzHigh = HwpParser._u32(b, pos + 124);
        const streamSz = streamSzHigh > 0
          ? (streamSzHigh * 0x100000000) + streamSzLow
          : streamSzLow;
        entries.push({
          id: entries.length,
          name,
          type: b[pos + 66] || 0,
          leftId: HwpParser._u32(b, pos + 68),
          rightId: HwpParser._u32(b, pos + 72),
          childId: HwpParser._u32(b, pos + 76),
          startSec: HwpParser._u32(b, pos + 116),
          streamSz,
          path: '',
        });
      }

      sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
    }
    return entries;
  },

  _assignCfbPaths(entries) {
    const isValidId = id => Number.isInteger(id) && id >= 0 && id < entries.length && id < 0xFFFFFFFA;
    const visited = new Set();

    const visitTree = (entryId, parentPath = '', depth = 0) => {
      if (!isValidId(entryId) || depth > entries.length || visited.has(entryId)) return;
      visited.add(entryId);

      const entry = entries[entryId];
      visitTree(entry.leftId, parentPath, depth + 1);

      if (entry.name) {
        entry.path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        if ((entry.type === 1 || entry.type === 5) && isValidId(entry.childId)) {
          visitTree(entry.childId, entry.type === 5 ? '' : entry.path, depth + 1);
        }
      }

      visitTree(entry.rightId, parentPath, depth + 1);
    };

    const root = entries[0];
    if (root) {
      root.path = '';
      if (isValidId(root.childId)) visitTree(root.childId, '', 0);
    }

    entries.forEach(entry => {
      if (!entry.path && entry.name && entry.type !== 0) entry.path = entry.name;
    });
  },

  _cfbEntryByPath(cfb, path) {
    if (!cfb || !path) return null;
    const normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (cfb.byPath?.[normalized]) return cfb.byPath[normalized];
    const name = normalized.split('/').pop();
    return cfb.byName?.[name]?.[0] || null;
  },

  _cfbEntriesUnder(cfb, storageName, namePattern) {
    if (!cfb?.entries?.length) return [];
    const prefix = `${String(storageName || '').replace(/\\/g, '/').replace(/\/+$/, '')}/`.toLowerCase();
    return cfb.entries
      .filter(entry => (
        entry.type === 2
        && entry.path
        && entry.path.toLowerCase().startsWith(prefix)
        && (!namePattern || namePattern.test(entry.name || ''))
      ));
  },

  _readCfbEntryStream(cfb, entry) {
    if (!cfb || !entry) return null;
    const { startSec, streamSz } = entry;
    if (startSec >= 0xFFFFFFFA || streamSz === 0 || streamSz > Number.MAX_SAFE_INTEGER) return null;
    if (streamSz < cfb.miniCutoff && cfb.miniStream) {
      return HwpParser._readStreamByMiniFat(cfb.miniStream, startSec, streamSz, cfb.miniFat);
    }
    return HwpParser._readStreamByFat(cfb.b, startSec, streamSz, cfb.ss, cfb.fat);
  },

  _parseHwpFileHeader(data) {
    if (!data || data.length < 40) return null;
    const signature = new TextDecoder('ascii')
      .decode(data.slice(0, 32))
      .replace(/\u0000/g, '')
      .trim();
    const versionRaw = HwpParser._u32(data, 32);
    const properties = HwpParser._u32(data, 36);
    return {
      signature,
      versionRaw,
      version: [
        (versionRaw >>> 24) & 0xFF,
        (versionRaw >>> 16) & 0xFF,
        (versionRaw >>> 8) & 0xFF,
        versionRaw & 0xFF,
      ].join('.'),
      properties,
      flags: {
        compressed: Boolean(properties & (1 << 0)),
        passwordProtected: Boolean(properties & (1 << 1)),
        distributed: Boolean(properties & (1 << 2)),
        script: Boolean(properties & (1 << 3)),
        drm: Boolean(properties & (1 << 4)),
        xmlTemplate: Boolean(properties & (1 << 5)),
        history: Boolean(properties & (1 << 6)),
        certificateEncrypted: Boolean(properties & (1 << 8)),
      },
    };
  },

  _assertReadableHwpFlags(fileHeader) {
    const flags = fileHeader?.flags || {};
    if (flags.passwordProtected && !flags.distributed) {
      throw new Error('UnsupportedPasswordProtected: 암호가 설정된 HWP 문서는 아직 지원하지 않습니다.');
    }
    if (flags.drm) {
      throw new Error('UnsupportedDrmDocument: DRM 보안 HWP 문서는 지원하지 않습니다.');
    }
    if (flags.certificateEncrypted) {
      throw new Error('UnsupportedEncryptedDocument: 공인인증서 암호화 HWP 문서는 지원하지 않습니다.');
    }
  },

  _isUnsupportedHwpSecurityError(error) {
    return /^Unsupported(?:PasswordProtected|DrmDocument|EncryptedDocument|DistributableDocument)/.test(
      String(error?.message || error || ''),
    );
  },

  _parseHwpDocumentProperties(body) {
    if (!body || body.length < 26) return null;
    return {
      sectionCount: HwpParser._u16(body, 0),
      pageStart: HwpParser._u16(body, 2),
      footnoteStart: HwpParser._u16(body, 4),
      endnoteStart: HwpParser._u16(body, 6),
      figureStart: HwpParser._u16(body, 8),
      tableStart: HwpParser._u16(body, 10),
      equationStart: HwpParser._u16(body, 12),
      caretListId: HwpParser._u32(body, 14),
      caretParaId: HwpParser._u32(body, 18),
      caretCharPos: HwpParser._u32(body, 22),
    };
  },

  _parseHwpIdMappings(body) {
    const counts = [];
    if (!body) return { counts, extraCounts: [] };
    for (let offset = 0; offset + 4 <= body.length; offset += 4) {
      counts.push(HwpParser._u32(body, offset));
    }
    const names = [
      'binData',
      'hangulFonts',
      'latinFonts',
      'hanjaFonts',
      'japaneseFonts',
      'otherFonts',
      'symbolFonts',
      'userFonts',
      'borderFill',
      'charShape',
      'tabDef',
      'numbering',
      'bullet',
      'paraShape',
      'style',
      'memoShape',
      'trackChange',
      'trackChangeAuthor',
    ];
    const byName = {};
    names.forEach((name, index) => {
      byName[name] = counts[index] || 0;
    });
    return {
      counts,
      byName,
      extraCounts: counts.slice(names.length),
    };
  },

  _hwpBinDataTypeName(typeCode) {
    switch (Number(typeCode) & 0xF) {
      case 0: return 'LINK';
      case 1: return 'EMBEDDING';
      case 2: return 'STORAGE';
      default: return 'UNKNOWN';
    }
  },

  _hwpBinDataCompressionName(code) {
    switch (Number(code) & 0x3) {
      case 0: return 'DEFAULT';
      case 1: return 'COMPRESS';
      case 2: return 'NO_COMPRESS';
      default: return 'UNKNOWN';
    }
  },

  _hwpBinDataStateName(code) {
    switch (Number(code) & 0x3) {
      case 0: return 'NEVER_ACCESSED';
      case 1: return 'FOUND';
      case 2: return 'NOT_FOUND';
      case 3: return 'ACCESS_FAILED';
      default: return 'UNKNOWN';
    }
  },

  _readHwpLengthPrefixedString(body, offset) {
    if (!body || offset + 2 > body.length) return { text: '', nextOffset: offset };
    const length = HwpParser._u16(body, offset);
    const textOffset = offset + 2;
    const byteLength = Math.min(Math.max(0, body.length - textOffset), length * 2);
    const text = byteLength > 0
      ? new TextDecoder('utf-16le')
        .decode(body.slice(textOffset, textOffset + byteLength))
        .replace(/\u0000/g, '')
        .trim()
      : '';
    return { text, nextOffset: textOffset + byteLength };
  },

  _parseHwpBinData(body, refId = 0) {
    if (!body || body.length < 2) return null;
    const attr = HwpParser._u16(body, 0);
    const typeCode = attr & 0xF;
    const type = HwpParser._hwpBinDataTypeName(typeCode);
    const compression = HwpParser._hwpBinDataCompressionName((attr >> 4) & 0x3);
    const state = HwpParser._hwpBinDataStateName((attr >> 8) & 0x3);
    let offset = 2;

    const out = {
      refId,
      attr,
      typeCode,
      type,
      compression,
      state,
      absPath: '',
      relPath: '',
      binDataId: 0,
      extension: '',
      rawSize: body.length,
    };

    if (type === 'LINK') {
      const abs = HwpParser._readHwpLengthPrefixedString(body, offset);
      out.absPath = abs.text;
      offset = abs.nextOffset;
      const rel = HwpParser._readHwpLengthPrefixedString(body, offset);
      out.relPath = rel.text;
      return out;
    }

    if (offset + 2 <= body.length) {
      out.binDataId = HwpParser._u16(body, offset);
      offset += 2;
    }
    if (type === 'EMBEDDING' && offset + 2 <= body.length) {
      const ext = HwpParser._readHwpLengthPrefixedString(body, offset);
      out.extension = ext.text.toLowerCase();
    }

    return out;
  },

  _hwpSectionEntries(cfb, docInfo = null, distributed = false) {
    const candidates = distributed
      ? ['ViewText', 'BodyText']
      : ['BodyText', 'ViewText'];

    let sectionEntries = [];
    let sourceStorage = '';
    for (const storageName of candidates) {
      const entries = HwpParser._cfbEntriesUnder(cfb, storageName, /^Section\d+$/i)
        .map(entry => ({
          number: Number((entry.name.match(/Section(\d+)/i) || [])[1] || 0),
          entry,
          path: entry.path || entry.name,
        }))
        .sort((a, b) => a.number - b.number);
      if (entries.length) {
        sectionEntries = entries;
        sourceStorage = storageName;
        break;
      }
    }

    if (!sectionEntries.length) {
      sectionEntries = (cfb?.entries || [])
        .filter(entry => entry.type === 2 && /^Section\d+$/i.test(entry.name || ''))
        .map(entry => ({
          number: Number((entry.name.match(/Section(\d+)/i) || [])[1] || 0),
          entry,
          path: entry.path || entry.name,
        }))
        .sort((a, b) => a.number - b.number);
      sourceStorage = 'flat';
    }

    const expectedCount = Number(docInfo?.documentProperties?.sectionCount) || 0;
    if (expectedCount > 0 && sectionEntries.length !== expectedCount) {
      console.warn(
        '[HWP] DocInfo sectionCount=%d, OLE %s section streams=%d',
        expectedCount,
        sourceStorage || 'unknown',
        sectionEntries.length,
      );
    }

    return sectionEntries;
  },

  /* ── BodyText/Section 스트림 파싱 ── */
  async _parseBodyText(b) {
    const cfb = HwpParser._createCfbContext(b);
    if (!cfb) return null;

    let compressed = true;
    let distributed = false;
    let fileHeader = null;
    const fileHeaderEntry = HwpParser._cfbEntryByPath(cfb, 'FileHeader');
    if (fileHeaderEntry) {
      const fhData = HwpParser._readCfbEntryStream(cfb, fileHeaderEntry);
      fileHeader = HwpParser._parseHwpFileHeader(fhData);
      if (fileHeader) {
        if (!/^HWP Document File/i.test(fileHeader.signature)) {
          throw new Error('HWP FileHeader 시그니처 불일치');
        }
        HwpParser._assertReadableHwpFlags(fileHeader);
        compressed = fileHeader.flags.compressed;
        distributed = fileHeader.flags.distributed;
        console.log('[HWP] FileHeader: version=%s compressed=%s distributed=%s', fileHeader.version, compressed, distributed);
      }
    }

    const docInfoEntry = HwpParser._cfbEntryByPath(cfb, 'DocInfo');
    let docInfo = { borderFills: {}, borderFillCount: 0 };
    if (docInfoEntry) {
      const docInfoData = HwpParser._readCfbEntryStream(cfb, docInfoEntry);
      if (docInfoData?.length) {
        docInfo = await HwpParser._parseHwpDocInfoStream(docInfoData, {
          compressedHint: compressed,
          distributedHint: distributed,
        });
      }
    }
    docInfo.fileHeader = fileHeader;

    const hwpImages = await HwpParser._parseHwpBinaryMap(cfb, null, null, null, null, null, null, docInfo);
    docInfo.images = hwpImages.images;
    docInfo.binImages = hwpImages.ordered;
    docInfo.binImagesById = hwpImages.byId;
    docInfo.binEntriesById = hwpImages.allById;
    docInfo.binImageCursor = 0;

    const sectionEntries = HwpParser._hwpSectionEntries(cfb, docInfo, distributed);

    const allParas = [];
    const sections = [];
    let headerBlocks = [];
    let footerBlocks = [];
    let headerAreas = [];
    let footerAreas = [];
    let pageStyle = null;
    for (const { number: sn, entry, path } of sectionEntries) {
      const data = HwpParser._readCfbEntryStream(cfb, entry);
      if (!data || data.length === 0) continue;
      const parsed = await HwpParser._extractSectionParas(
        data,
        compressed,
        path || ('Section' + sn),
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
      if (!headerAreas.length && parsed?.headerAreas?.length) {
        headerAreas = parsed.headerAreas;
      }
      if (!footerAreas.length && parsed?.footerAreas?.length) {
        footerAreas = parsed.footerAreas;
      }
      if (!pageStyle && parsed?.sectionMeta) {
        pageStyle = parsed.sectionMeta;
      }
      if (parsed?.paras?.length) {
        sections.push({
          order: sn,
          paragraphs: parsed.paras,
          headerBlocks: parsed.headerBlocks || [],
          footerBlocks: parsed.footerBlocks || [],
          headerAreas: parsed.headerAreas || [],
          footerAreas: parsed.footerAreas || [],
          pageStyle: parsed.sectionMeta || null,
        });
      }
    }

    return allParas.length > 0 ? {
      paragraphs: allParas,
      headerBlocks,
      footerBlocks,
      headerAreas,
      footerAreas,
      pageStyle,
      sections,
      fileHeader,
      documentProperties: docInfo.documentProperties || null,
      resourceSummary: {
        imageCount: hwpImages.ordered.length,
        binaryEntryCount: Object.keys(hwpImages.allById || {}).length,
        binDataRefCount: docInfo.binDataRefCount || 0,
      },
    } : null;
  },

  _scanPrvText(b) {
    const cfb = HwpParser._createCfbContext(b);
    const entry = HwpParser._cfbEntryByPath(cfb, 'PrvText');
    if (!entry) {
      console.warn('[HWP] PrvText 엔트리를 찾지 못했습니다.');
      return null;
    }

    if (entry.streamSz > 8 * 1024 * 1024) return null;
    const raw = HwpParser._readCfbEntryStream(cfb, entry);
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


});
