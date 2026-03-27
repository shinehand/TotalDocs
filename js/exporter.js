/**
 * exporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 수정된 문서를 다양한 포맷으로 내보내는 유틸리티.
 *
 * 지원 포맷:
 *  1. HTML   — Quill innerHTML + 스타일 래퍼
 *  2. PDF    — window.print() 기반 (CSS @print 미디어 쿼리 활용)
 *  3. HWPX   — 최소 HWPX XML 구조 생성 후 ZIP 패키징 (JSZip 사용)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class HwpExporter {
  /**
   * @param {HwpEditor} editor  editor.js의 HwpEditor 인스턴스
   * @param {string}    filename 원본 파일명 (확장자 제외에 사용)
   */
  constructor(editor, filename = 'document') {
    this.editor   = editor;
    this.basename = filename.replace(/\.[^.]+$/, '');
  }

  /* ──────────────────────────────────────────────
     HTML 내보내기
  ────────────────────────────────────────────── */
  exportHtml() {
    const body    = this.editor.getHtml();
    const html    = this._wrapHtml(body);
    const blob    = new Blob([html], { type: 'text/html;charset=utf-8' });
    this._download(blob, `${this.basename}.html`);
  }

  _wrapHtml(body) {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${this.basename}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR&display=swap');
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: 'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif;
      font-size: 14px; line-height: 1.75;
      max-width: 860px; margin: 0 auto;
      padding: 72px 80px; color: #1e293b;
    }
    p { margin: 0 0 4px; }
    h1,h2,h3 { margin: 12px 0 6px; }
    @media print {
      body { padding: 20mm 25mm; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
  }

  /* ──────────────────────────────────────────────
     PDF 내보내기 (브라우저 인쇄 → PDF 저장)
  ────────────────────────────────────────────── */
  exportPdf() {
    const body    = this.editor.getHtml();
    const html    = this._wrapHtml(body);

    // 새 창에서 인쇄 대화상자를 띄웁니다.
    // 사용자가 "PDF로 저장"을 선택하면 PDF 파일이 생성됩니다.
    const printWin = window.open('', '_blank', 'width=900,height=700');
    if (!printWin) {
      alert('팝업이 차단되었습니다. 브라우저 팝업 차단을 해제해 주세요.');
      return;
    }
    printWin.document.write(html);
    printWin.document.close();

    // 렌더링 완료 후 인쇄
    printWin.onload = () => {
      printWin.focus();
      printWin.print();
      // 인쇄 대화상자 닫힌 후 창 닫기
      printWin.onafterprint = () => printWin.close();
    };
  }

  /* ──────────────────────────────────────────────
     HWPX 내보내기 (최소 XML 구조 + JSZip)
  ────────────────────────────────────────────── */
  async exportHwpx() {
    if (typeof JSZip === 'undefined') {
      alert('JSZip 라이브러리가 로드되지 않았습니다.');
      return;
    }

    const delta = this.editor.getDelta();
    const sectionXml = this._deltaToHwpxSection(delta);

    const zip = new JSZip();

    // mimetype (압축 없이 저장 — HWPX 명세)
    zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });

    // Contents/
    zip.folder('Contents').file('section0.xml', sectionXml);
    zip.folder('Contents').file('header.xml', this._headerXml());

    // META-INF/
    zip.folder('META-INF').file('container.xml', this._containerXml());
    zip.folder('META-INF').file('manifest.xml', this._manifestXml());

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/hwp+zip' });
    this._download(blob, `${this.basename}.hwpx`);
  }

  /**
   * Quill Delta → HWPX section XML
   */
  _deltaToHwpxSection(delta) {
    const ns = 'xmlns:hp="urn:schemas-microsoft-com:hwp" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    let paras = '';
    let currentPara = '';
    let paraAttrs   = '';

    const flushPara = () => {
      if (currentPara !== null) {
        paras += `    <hp:p${paraAttrs}>\n${currentPara}    </hp:p>\n`;
      }
      currentPara = '';
      paraAttrs   = '';
    };

    delta.ops.forEach(op => {
      if (typeof op.insert !== 'string') return;

      const lines = op.insert.split('\n');
      lines.forEach((line, idx) => {
        if (line !== '') {
          const attrs = op.attributes || {};
          let charPr  = '';
          if (attrs.bold)      charPr += ' bold="1"';
          if (attrs.italic)    charPr += ' italic="1"';
          if (attrs.underline) charPr += ' underline="1"';
          if (attrs.color)     charPr += ` color="${attrs.color}"`;

          const escaped = line
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

          currentPara += `      <hp:run>\n`;
          if (charPr) currentPara += `        <hp:charPr${charPr}/>\n`;
          currentPara += `        <hp:t>${escaped}</hp:t>\n`;
          currentPara += `      </hp:run>\n`;
        }

        // 줄바꿈 = 단락 끝
        if (idx < lines.length - 1) {
          const align = op.attributes?.align || 'left';
          if (align !== 'left') paraAttrs = ` align="${align}"`;
          flushPara();
        }
      });
    });

    flushPara();

    return `<?xml version="1.0" encoding="UTF-8"?>
<hp:sec ${ns}>
${paras}</hp:sec>`;
  }

  _headerXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<hp:head xmlns:hp="urn:schemas-microsoft-com:hwp">
  <hp:docInfo>
    <hp:editingInfo createdDate="${new Date().toISOString()}" lastModifiedDate="${new Date().toISOString()}"/>
  </hp:docInfo>
</hp:head>`;
  }

  _containerXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="Contents/header.xml" media-type="application/hwp+zip"/>
  </rootfiles>
</container>`;
  }

  _manifestXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest>
  <item id="header"   href="Contents/header.xml"   media-type="application/xml"/>
  <item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
</manifest>`;
  }

  /* ── 파일 다운로드 헬퍼 ────────────────────── */
  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
