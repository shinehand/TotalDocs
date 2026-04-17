// HWP 파일에서 PrvImage 썸네일을 경량 추출 (WASM 불필요)
//
// CFB(OLE2 Compound File) 컨테이너에서 /PrvImage 스트림만 추출한다.
// 전체 HWP 파싱 없이 썸네일만 빠르게 얻을 수 있다.
//
// MIT License: Based on rhwp-chrome/sw/thumbnail-extractor.js
// by Edward Kim (https://github.com/edwardkim/rhwp)

const THUMBNAIL_CACHE = new Map();
const CACHE_MAX_SIZE = 100;

/**
 * URL에서 HWP 파일을 fetch하여 PrvImage 썸네일을 추출한다.
 * @param {string} url - HWP 파일 URL
 * @returns {Promise<{dataUri: string, width: number, height: number} | null>}
 */
export async function extractThumbnailFromUrl(url) {
  if (THUMBNAIL_CACHE.has(url)) {
    return THUMBNAIL_CACHE.get(url);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);

    const isZip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B;
    const result = isZip
      ? await extractPrvImageFromZipAsync(data)
      : extractPrvImage(data);
    if (result) {
      if (THUMBNAIL_CACHE.size >= CACHE_MAX_SIZE) {
        const firstKey = THUMBNAIL_CACHE.keys().next().value;
        THUMBNAIL_CACHE.delete(firstKey);
      }
      THUMBNAIL_CACHE.set(url, result);
    }
    return result;
  } catch {
    return null;
  }
}

function extractPrvImage(data) {
  if (data.length < 512) return null;
  if (data[0] !== 0xD0 || data[1] !== 0xCF || data[2] !== 0x11 || data[3] !== 0xE0) return null;

  const sectorSizePow = data[30] | (data[31] << 8);
  const sectorSize = 1 << sectorSizePow;

  const miniSectorSizePow = data[32] | (data[33] << 8);
  const miniSectorSize = 1 << miniSectorSizePow;

  const miniStreamCutoff = readU32LE(data, 56);
  const miniFatStart     = readU32LE(data, 60);

  const fatEntries = buildFatTable(data, sectorSize);

  const dirStartSector = readU32LE(data, 48);
  const rootOffset = (dirStartSector + 1) * sectorSize;
  const miniStreamStart = readU32LE(data, rootOffset + 116);
  const miniStreamSize  = readU32LE(data, rootOffset + 120);

  const miniFatEntries = buildMiniFatTable(data, sectorSize, miniFatStart, fatEntries);
  const miniStreamData = readStreamFromFAT(data, miniStreamStart, miniStreamSize, sectorSize, fatEntries);

  const entriesPerSector = sectorSize / 128;
  let dirSector = dirStartSector;

  while (dirSector < 0xFFFFFFFE) {
    const dirOffset = (dirSector + 1) * sectorSize;

    for (let i = 0; i < entriesPerSector; i++) {
      const entryOffset = dirOffset + i * 128;
      if (entryOffset + 128 > data.length) break;

      const nameLen = readU16LE(data, entryOffset + 64);
      if (nameLen === 0 || nameLen > 64) continue;

      const name = readUTF16LE(data, entryOffset, nameLen);
      if (name !== 'PrvImage') continue;

      const startSector = readU32LE(data, entryOffset + 116);
      const streamSize  = readU32LE(data, entryOffset + 120);

      if (streamSize === 0 || streamSize > 10 * 1024 * 1024) continue;

      let streamData;
      if (streamSize < miniStreamCutoff && miniStreamData) {
        streamData = readStreamFromMini(miniStreamData, startSector, streamSize, miniSectorSize, miniFatEntries);
      } else {
        streamData = readStreamFromFAT(data, startSector, streamSize, sectorSize, fatEntries);
      }
      if (!streamData) continue;

      return parseImageData(streamData);
    }

    dirSector = dirSector < fatEntries.length ? fatEntries[dirSector] : 0xFFFFFFFE;
  }

  return null;
}

function buildMiniFatTable(data, sectorSize, miniFatStart, fatEntries) {
  const miniFatEntries = [];
  let sector = miniFatStart;
  for (let safety = 0; safety < 10000; safety++) {
    if (sector >= 0xFFFFFFFE) break;
    const offset = (sector + 1) * sectorSize;
    const entriesPerSector = sectorSize / 4;
    for (let j = 0; j < entriesPerSector; j++) {
      const off = offset + j * 4;
      if (off + 4 > data.length) break;
      miniFatEntries.push(readU32LE(data, off));
    }
    sector = sector < fatEntries.length ? fatEntries[sector] : 0xFFFFFFFE;
  }
  return miniFatEntries;
}

function readStreamFromMini(miniStream, startSector, streamSize, miniSectorSize, miniFatEntries) {
  const result = new Uint8Array(streamSize);
  let sector = startSector;
  let bytesRead = 0;

  for (let safety = 0; safety < 10000 && bytesRead < streamSize; safety++) {
    if (sector >= 0xFFFFFFFE) break;
    const offset = sector * miniSectorSize;
    const copyLen = Math.min(miniSectorSize, streamSize - bytesRead);
    if (offset + copyLen > miniStream.length) break;
    result.set(miniStream.subarray(offset, offset + copyLen), bytesRead);
    bytesRead += copyLen;
    sector = sector < miniFatEntries.length ? miniFatEntries[sector] : 0xFFFFFFFE;
  }

  return bytesRead >= streamSize ? result : null;
}

function buildFatTable(data, sectorSize) {
  const fatEntries = [];
  for (let i = 0; i < 109; i++) {
    const fatSect = readU32LE(data, 76 + i * 4);
    if (fatSect === 0xFFFFFFFE || fatSect === 0xFFFFFFFF) break;
    const fatOffset = (fatSect + 1) * sectorSize;
    const entriesPerSector = sectorSize / 4;
    for (let j = 0; j < entriesPerSector; j++) {
      const off = fatOffset + j * 4;
      if (off + 4 > data.length) break;
      fatEntries.push(readU32LE(data, off));
    }
  }
  return fatEntries;
}

function readStreamFromFAT(data, startSector, streamSize, sectorSize, fatEntries) {
  if (!fatEntries) fatEntries = buildFatTable(data, sectorSize);

  const result = new Uint8Array(streamSize);
  let sector = startSector;
  let bytesRead = 0;

  for (let safety = 0; safety < 10000 && bytesRead < streamSize; safety++) {
    if (sector >= 0xFFFFFFFE) break;
    const offset = (sector + 1) * sectorSize;
    const copyLen = Math.min(sectorSize, streamSize - bytesRead);
    if (offset + copyLen > data.length) break;
    result.set(data.subarray(offset, offset + copyLen), bytesRead);
    bytesRead += copyLen;
    sector = sector < fatEntries.length ? fatEntries[sector] : 0xFFFFFFFE;
  }

  return bytesRead >= streamSize ? result : null;
}

function parseImageData(data) {
  let mime, width = 0, height = 0;

  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    mime = 'image/png';
    if (data.length >= 24) {
      width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
      height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    }
  } else if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4D) {
    mime = 'image/bmp';
    if (data.length >= 26) {
      width = readU32LE(data, 18);
      height = Math.abs(readI32LE(data, 22));
    }
  } else if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    mime = 'image/gif';
    if (data.length >= 10) {
      width = readU16LE(data, 6);
      height = readU16LE(data, 8);
    }
  } else {
    return null;
  }

  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = btoa(binary);
  const dataUri = `data:${mime};base64,${base64}`;

  return { dataUri, width, height, mime };
}

async function extractPrvImageFromZipAsync(data) {
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= 0 && i >= data.length - 65558; i--) {
    if (data[i] === 0x50 && data[i+1] === 0x4B && data[i+2] === 0x05 && data[i+3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const cdOffset = readU32LE(data, eocdOffset + 16);
  const cdEntries = readU16LE(data, eocdOffset + 10);

  let offset = cdOffset;
  for (let i = 0; i < cdEntries && offset + 46 < data.length; i++) {
    if (data[offset] !== 0x50 || data[offset+1] !== 0x4B || data[offset+2] !== 0x01 || data[offset+3] !== 0x02) break;

    const compMethod = readU16LE(data, offset + 10);
    const compSize = readU32LE(data, offset + 20);
    const uncompSize = readU32LE(data, offset + 24);
    const nameLen = readU16LE(data, offset + 28);
    const extraLen = readU16LE(data, offset + 30);
    const commentLen = readU16LE(data, offset + 32);
    const localHeaderOffset = readU32LE(data, offset + 42);

    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);

    if (name.startsWith('Preview/PrvImage')) {
      if (localHeaderOffset + 30 >= data.length) break;
      const localNameLen = readU16LE(data, localHeaderOffset + 26);
      const localExtraLen = readU16LE(data, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;

      if (compMethod === 0) {
        const imageData = data.subarray(dataStart, dataStart + uncompSize);
        return parseImageData(imageData);
      } else if (compMethod === 8) {
        try {
          const compressed = data.slice(dataStart, dataStart + compSize);
          const ds = new DecompressionStream('raw');
          const writer = ds.writable.getWriter();
          writer.write(compressed);
          writer.close();
          const reader = ds.readable.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const decompressed = new Uint8Array(totalLen);
          let pos = 0;
          for (const chunk of chunks) { decompressed.set(chunk, pos); pos += chunk.length; }
          return parseImageData(decompressed);
        } catch {
          return null;
        }
      }
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

function readU16LE(data, offset) { return data[offset] | (data[offset + 1] << 8); }
function readU32LE(data, offset) { return (data[offset] | (data[offset+1] << 8) | (data[offset+2] << 16) | (data[offset+3] << 24)) >>> 0; }
function readI32LE(data, offset) { return data[offset] | (data[offset+1] << 8) | (data[offset+2] << 16) | (data[offset+3] << 24); }
function readUTF16LE(data, offset, byteLen) {
  let str = '';
  for (let i = 0; i < byteLen - 2; i += 2) {
    const code = data[offset + i] | (data[offset + i + 1] << 8);
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str;
}
