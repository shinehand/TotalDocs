/**
 * editor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Quill.js WYSIWYG 에디터를 초기화하고,
 * 파서가 생성한 HwpDocument를 Quill Delta 형식으로 변환해 로드합니다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class HwpEditor {
  constructor() {
    /** @type {Quill|null} */
    this.quill = null;
    this._initialized = false;
  }

  /**
   * Quill 인스턴스를 초기화합니다.
   * viewer.html의 #quillEditor 요소에 마운트됩니다.
   */
  init() {
    if (this._initialized) return;

    // 한국어 폰트를 Quill 폰트 화이트리스트에 등록
    const Font = Quill.import('formats/font');
    Font.whitelist = ['malgun', 'nanum', 'haansoft', 'gothic', 'serif'];
    Quill.register(Font, true);

    this.quill = new Quill('#quillEditor', {
      theme: 'snow',
      placeholder: '문서 내용을 편집하세요...',
      modules: {
        toolbar: [
          [{ font: Font.whitelist }],
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ color: [] }, { background: [] }],
          [{ align: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          [{ indent: '-1' }, { indent: '+1' }],
          ['blockquote', 'code-block'],
          ['clean'],
        ],
      },
    });

    this._initialized = true;
  }

  /**
   * HwpDocument → Quill Delta 변환 후 에디터에 로드
   * @param {object} hwpDoc  hwp-parser.js가 반환한 HwpDocument
   */
  loadDocument(hwpDoc) {
    if (!this._initialized) this.init();

    const delta = this._documentToDelta(hwpDoc);
    this.quill.setContents(delta, 'silent');
    this.quill.setSelection(0, 0);
  }

  /**
   * HwpDocument → Quill Delta
   * @param {object} hwpDoc
   * @returns {object} Quill Delta
   */
  _documentToDelta(hwpDoc) {
    const ops = [];

    hwpDoc.pages.forEach((page, pageIdx) => {
      // 페이지 구분자
      if (pageIdx > 0) {
        ops.push({ insert: '\n', attributes: { 'code-block': true } });
        ops.push({ insert: `── 페이지 ${pageIdx + 1} ──\n`, attributes: { 'code-block': true } });
      }

      page.paragraphs.forEach(para => {
        if (para.texts.length === 0) {
          ops.push({ insert: '\n' });
          return;
        }

        para.texts.forEach(run => {
          const attrs = {};
          if (run.bold)      attrs.bold      = true;
          if (run.italic)    attrs.italic    = true;
          if (run.underline) attrs.underline = true;
          if (run.color && run.color !== '#000000') attrs.color = run.color;
          if (run.fontSize)  attrs.size      = `${run.fontSize}pt`;

          ops.push(Object.keys(attrs).length
            ? { insert: run.text || '', attributes: attrs }
            : { insert: run.text || '' });
        });

        // 단락 끝 줄바꿈 (정렬 속성 포함)
        const paraAttrs = {};
        if (para.align && para.align !== 'left') paraAttrs.align = para.align;
        ops.push(Object.keys(paraAttrs).length
          ? { insert: '\n', attributes: paraAttrs }
          : { insert: '\n' });
      });
    });

    return { ops };
  }

  /**
   * 현재 Quill 에디터의 HTML 콘텐츠를 반환
   * @returns {string} innerHTML
   */
  getHtml() {
    if (!this.quill) return '';
    return this.quill.root.innerHTML;
  }

  /**
   * 현재 Quill 에디터의 Delta를 반환
   * @returns {object}
   */
  getDelta() {
    if (!this.quill) return { ops: [] };
    return this.quill.getContents();
  }

  /**
   * 편집기 내용이 비어 있는지 확인
   */
  isEmpty() {
    if (!this.quill) return true;
    return this.quill.getLength() <= 1;
  }

  /**
   * 에디터 포커스
   */
  focus() {
    this.quill?.focus();
  }
}
