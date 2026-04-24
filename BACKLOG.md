# Rendering Backlog

---

## 완료된 작업 이력 (Completed Work)

### 세션 1 (초기 구현)
- HWP CFB/OLE 스트림 파싱: FAT, MiniFAT, Section 디렉터리 엔트리 읽기
- `HWPTAG_PARA_TEXT(67)`, `HWPTAG_PARA_CHAR_SHAPE(68)`, `HWPTAG_PARA_LINE_SEG(69)` 기반 단락 복원
- `DocInfo` 스트림: `FaceName`, `CharShape`, `ParaShape`, `BorderFill`, `TabDef` 파싱
- HWP 표(`tbl ` ctrl) 파싱: 셀 구조, 병합, 열 너비, 행 높이
- HWPX ZIP 압축 해제 + `header.xml`/`section0.xml` 파싱
- HWPX `header.xml`: 문자 속성(`hh:charPr`), 단락 속성(`hh:paraPr`), 테두리(`hh:borderFill`) 로딩
- HWP `gso ` 도형 컨트롤: 텍스트박스/수식/이미지/OLE 분기
- 렌더러: `appendParagraphBlock()`, `appendTableBlock()`, `appendImageBlock()` 기본 구현
- Playwright 스모크 스크립트 + 샘플 검증 파이프라인 (`verify_samples.mjs`)
- Hancom oracle 페이지 기준선 (`docs/hancom-oracle-page-baseline.json`) 수립

### 세션 2 (레이아웃/페이지 정밀화)
- HWP 섹션별 페이지 스타일: `secd` ctrl → `HWPTAG_PAGE_DEF(73)` + `HWPTAG_PAGE_NUM_PARA(76)` 파싱
  - 용지 크기/여백/거터, 쪽번호 위치·형식 추출
- HWPX 섹션 메타 `_hwpxSectionMeta`: `hp:pagePr`(용지), `hp:visibility`(첫쪽 헤더 숨김) 파싱
- 헤더/푸터 (`head`/`foot` ctrl): `applyPageType` 기반 짝/홀/첫페이지 구분
- 페이지 예산 기반 자동 페이지 나눔 `_paginateSectionBlocks`:
  - 용지 높이/여백을 HWPUNIT → weight unit 환산, 표 행 분할 지원
- HWP 다중 섹션 조합: `sections[]` 배열 + `sectionOrder` 정렬
- HWPX 쪽번호 블록 생성 (`_hwpxCreatePageNumberBlock`)
- **검증 결과**: 전체 5개 샘플 모두 Hancom oracle 페이지 수 일치 달성
  - goyeopje.hwp: 2/2, goyeopje-full-2024.hwp: 11/11, gyeolseokgye.hwp: 1/1
  - attachment-sale-notice.hwp: 4/4, incheon-2a.hwpx: 18/18

### 세션 3 (HWPX 이미지/도형/스타일)
- HWPX `_hwpxPictureBlock`:
  - `curSz=0,0` 시 `orgSz` fallback → 장식 밴드·로고 이미지 복구
  - 한 dimension만 0이면 양쪽 모두 `orgSz` fallback (aspect ratio 일관성)
- HWPX `_hwpxParseObjectLayout`:
  - `hp:offset` 요소에서 `horzOffset`/`vertOffset` 읽기
  - `toSignedU32` 변환: 0xFFFF... overflow 값 → 올바른 음수 오프셋
- 렌더러 표 행 최소 높이:
  - `isThinSeparatorRow` 판별로 얇은 구분선 행(< 15px) 30px 강제 해제 → 4px 유지
- HWPX 블록 weight 정밀화:
  - `_blockText`에 shape/textbox sentinel 추가
  - `_estimateBlockWeight`: shape/textbox height 기반 weight 추가
  - 이미지 weight: `HWPX_IMAGE_WEIGHT_DIVISOR=529` (1/100mm → weight unit 정확한 제수)
- HWPX 들여쓰기 요소명 수정: `hc:indent` → `hc:intent` (HWPML 스펙 준수)
- `parser.worker.js` 단순화: `hwp-parser.js`를 `importScripts`로 공유 → 로직 중복 해소

### 세션 4 (HWPX 텍스트/여백 세부 보정)
- HWPX `compose` 원문자 지원 (`_hwpxDecodeComposeChar`):
  - Hancom PUA 인코딩: `0xF02D7`(원 모양) + `0xF02DF+n` → `U+2460+(n-1)` (①..⑳)
  - `incheon-2a.hwpx` 기준 19개 원문자가 공백→올바른 문자로 복구
- HWPX 전각 공백 지원 (`_hwpxTElementText`):
  - `hp:t > hp:fwSpace` → `U+3000` (IDEOGRAPHIC SPACE)
  - `incheon-2a.hwpx` 기준 75개 전각 공백 복구
- `_hwpxParagraphHasText`에 `compose` 포함 (실제 디코딩 결과 검증)
- HWPX `cellMargin/inMargin` 0xFFFFFFFF 버그 수정 (`_hwpxCellMarginVal`):
  - 기존: `4294967295` → `TABLE_UNIT_SCALE` 곱 후 30px 클램핑 → 셀 안쪽 여백 과대
  - 수정: `0x80000000` 이상(signed int32 음수 범위) → 0 → 휴리스틱 여백 fallback

---

## 현재 상태 (Current Status)

### HWP 파서 (`js/hwp-parser.js`)
- CFB/OLE 완전 지원: FAT/MiniFAT, Section 스트림, 압축/배포 형식
- 단락: 텍스트 런, CharShape(폰트/크기/색상/볼드/이탤릭/밑줄), ParaShape(정렬/여백/줄간격/들여쓰기), LineSeg
- 표: `tbl ` ctrl 완전 지원 (셀 병합, 테두리, 여백, 열 너비, 행 높이)
- 도형/개체: `gso ` ctrl → 텍스트박스·이미지·수식·OLE·도형 플레이스홀더
- 헤더/푸터: `head`/`foot` ctrl, 짝/홀/첫페이지 구분
- 섹션: `secd` ctrl → 용지 크기·여백·쪽번호 위치, 다중 섹션 지원
- 이미지: BinData 스트림 → base64 data URI

### HWPX 파서 (`js/hwp-parser.js`)
- `header.xml`: CharPr(문자속성), ParaPr(단락속성), BorderFill(테두리), Numbering(번호 정의), TabItem
- `section0.xml`: 단락, 표, 이미지, 텍스트박스, 원문자(compose), 전각공백(fwSpace)
- 헤더/푸터, 쪽번호, 섹션 메타(용지/여백/가시성)
- 이미지: BinItem HWPX 내 base64 → data URI
- 셀 여백: `_hwpxCellMarginVal`로 0xFFFFFFFF 상속값 처리

### 렌더러 (`js/hwp-renderer.js`)
- 단락: 정렬, 좌우 여백, 들여쓰기, 줄간격, 자간, 상하 간격, 탭
- 표: 셀 병합, 테두리(두께/색상/스타일), 셀 여백, 행 높이, 얇은 구분선 보존
- 이미지: 절대 위치 배치(`registerPlacedBlock`), 크기, 오프셋
- 텍스트박스/도형: 절대 배치, 크기, fillColor
- 페이지: 용지 크기·여백 반영, 헤더/푸터 영역, 쪽번호

### 검증 기준선 (Hancom Oracle 기준)
| 문서 | 형식 | Hancom 페이지 | TotalDocs | 일치 |
|------|------|:---:|:---:|:---:|
| goyeopje.hwp | HWP | 2 | 2 | ✓ |
| goyeopje-full-2024.hwp | HWP | 11 | 11 | ✓ |
| gyeolseokgye.hwp | HWP | 1 | 1 | ✓ |
| attachment-sale-notice.hwp | HWP | 4 | 4 | ✓ |
| incheon-2a.hwpx | HWPX | 18 | 18 | ✓ |

---

## 다음 세션 시작 체크포인트

- `_hwpxParseObjectLayout`: `hp:pos`(tbl계열) / `hp:offset`(pic계열) 양쪽 처리 완료
- `compose` PUA base: `0xF02DF` (second char - base = n, 1≤n≤20 → ①..⑳)
- `cellMargin 0xFFFFFFFF` = hasOwnMargin=1이지만 실제 값 없음 → 0 후 heuristic
- `_hwpxCellMarginVal`: 0x80000000 이상은 signed int32 음수 범위 → 0 처리
- `isThinSeparatorRow` 임계값 15px = 약 1125 HWPUNIT (구분선 행 기준)
- `incheon-2a.hwpx`의 `hp:ctrl`: colPr×1, pageNum×1, footer×1, header×1, newNum×2, fieldBegin/End×18
- `hp:shp` 도형 요소는 incheon-2a.hwpx에 없음 → 다른 HWPX 문서에서 확인 필요
- `parser.worker.js`는 `hwp-parser.js`를 importScripts로 단순 위임 → 중복 해소 완료

---

## P0 (긴급 / 시각 품질 핵심)

### 1. HWPX `hp:shp` 도형 요소 지원
- **왜**: `hp:shp`는 일반 HWPX 문서에 광범위하게 사용됨. 현재는 무시되어 도형이 누락됨.
- **어디**: `js/hwp-parser.js` → `_hwpxParagraphBlocks` (run child 처리부), `_hwpxBlocksFromContainer`
- **무엇**:
  - `hp:shp` 요소에서 크기(`hp:sz`), 위치(`hp:pos`), 텍스트(`hp:subList`) 추출
  - shape 타입에 따라 textbox / image / shape placeholder 분기
  - 파서에 `_hwpxShapeBlock` 함수 추가
- **검증**: `hp:shp`가 있는 HWPX 샘플에서 도형이 렌더링되어야 함

### 2. HWP 이미지 앵커 정밀화
- **왜**: HWP 그림(`gso ` + tag-85) 앵커 위치·크기가 실제 문서 대비 어긋날 수 있음.
- **어디**: `js/hwp-parser.js` → `_parseHwpGsoBlock`, `_parseHwpObjectCommon`
- **무엇**:
  - `horzRelTo`/`vertRelTo` 기반 절대 배치 여부 판별 개선
  - HWP 이미지 오프셋 단위(HWPUNIT) → 렌더러 px 변환 정확도 확인
- **검증**: 이미지 포함 HWP 샘플에서 사라짐 없이 위치 근사

### 3. HWPX 셀 여백 실제값 반영 품질 검토
- **왜**: 현재 셀 여백은 heuristic fallback 비중이 높아, 문서마다 셀이 눌리거나 떠 보임.
- **어디**: `js/hwp-renderer.js` → 셀 padding 적용부 (line ~1657~1692)
- **무엇**:
  - `hasPaddingInfo = true`일 때 `TABLE_UNIT_SCALE(1/75)` 변환이 정확한지 재검토
  - 141 HWPUNIT(≈1.9px), 510 HWPUNIT(≈6.8px), 850 HWPUNIT(≈11.3px) 반영 품질 확인
  - 최소 padding 클램핑 값(현재 0~30/36) 타당성 검토
- **검증**: incheon-2a.hwpx 표 셀이 원본 대비 덜 눌려 보여야 함

---

## P1 (품질 개선)

### 4. HWPX 장식형 1셀 표 / 슬로건 밴드 위치 정밀화
- **왜**: 공고문 첫 페이지에서 핑크 타이틀 밴드, 슬로건이 원본 대비 위치 차이가 남.
- **어디**: `js/hwp-renderer.js` → `registerPlacedBlock`, `applyPlacedBlockAbsoluteStyles`, `applyDeferredObjectLayouts`
- **무엇**:
  - `vertRelTo='PARA'` flow 배치 vs `vertRelTo='PAGE'` 절대 배치 구분 재검토
  - 표 외부 여백(`outMargin`)이 렌더러에 반영되는지 확인
- **검증**: incheon-2a.hwpx 1페이지에서 슬로건·밴드 상대 위치가 개선되어야 함

### 5. HWPX 번호 매기기 자동화 (`hh:numbering` + `paraHead`)
- **왜**: `hh:paraHead`(번호 형식), 자동 들여쓰기, `newNum` ctrl이 현재 무시됨.
- **어디**: `js/hwp-parser.js` → `_hwpxParseHeader`, `_hwpxParagraphBlocks`
- **무엇**:
  - `hh:numbering / hh:paraHead`에서 번호 형식(DIGIT/HANGUL/ALPHA)과 레벨별 텍스트 추출
  - 단락의 `listInfo` → 자동 번호 접두어 텍스트 삽입
- **검증**: incheon-2a.hwpx에서 "1.", "가." 등 자동 번호가 표시되어야 함

### 6. HWP 세부 선 굵기 / 테두리 정밀화
- **왜**: HWP `BorderFill`에서 선 굵기(THICK, 0.4mm 등)가 렌더러에서 하나로 뭉쳐짐.
- **어디**: `js/hwp-renderer.js` → `resolveBorderStyle`
- **무엇**:
  - `lineWidthMm` → CSS `border-width` 매핑 테이블 추가 (0.1mm=1px, 0.4mm=2px, 1.0mm=3px 등)
  - 이중 선(`DOUBLE`) / 점선(`DOTTED`) 스타일 CSS 구현
- **검증**: attachment-sale-notice.hwp, goyeopje.hwp 표 테두리가 원본 굵기에 근사

### 7. HWPX `fieldBegin`-`fieldEnd` 필드 값 렌더링
- **왜**: `FORMULA`, `HYPERLINK` 필드의 결과값(`LastResult`)이 fieldBegin 파라미터 없이 표시됨.
- **어디**: `js/hwp-parser.js` → `_hwpxParagraphBlocks` (ctrl child 처리부)
- **무엇**:
  - `fieldBegin`의 `LastResult` stringParam → 표시 텍스트로 사용
  - `HYPERLINK` 필드 → `<a>` 태그 생성 (뷰어 UX)
- **검증**: 필드가 있는 HWPX에서 수식 결과값이 올바르게 표시

---

## P2 (인프라 / 운영)

### 8. Playwright 회귀 검증 자동화
- **왜**: 현재 검증은 수동 실행 필요. CI 없이 회귀 감지 불가.
- **어디**: `scripts/verify_samples.mjs`, `.github/workflows/`
- **무엇**: GitHub Actions 워크플로 추가 → PR마다 5개 샘플 페이지 수 자동 검증
- **검증**: PR에서 페이지 수 불일치 시 빌드 실패 표시

### 9. 샘플 기반 회귀셋 확장
- **왜**: 현재는 신청서 계열 HWP·공고문 계열 HWPX에 치우쳐 있음.
- **어디**: `output/playwright/inputs`
- **무엇**: 표 중심 HWP, 이미지 포함 HWP, 본문형 HWPX, `hp:shp` 포함 HWPX 각 1종 추가
- **검증**: 추가된 샘플의 페이지 수를 oracle에 등록하고 검증 통과

### 10. 파비콘 / 뷰어 탭 식별성
- **왜**: 로컬 검증 시 `favicon.ico` 404가 반복됨. 탭이 많아지면 구분이 어려움.
- **어디**: `pages/viewer.html`, `icons/`
- **무엇**: `favicon.ico` 추가 또는 `<link rel="icon">` SVG inline, 타이틀 동적 업데이트
- **검증**: 콘솔 404 없음, 파일 로드 후 탭 타이틀에 파일명 표시
