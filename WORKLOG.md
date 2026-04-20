# Work Log

## 2026-04-20

### 문서 정확성 — 영향도 높은 항목 1차 구현

- 요청: 영향도 높은 항목부터 추가 개발 진행 후 md에 기록
- 수행 범위: `js/hwp-parser.js`, `js/parser.worker.js`, `js/hwp-renderer.js`

#### 1. 탭 정지 렌더링 (Tab Stop Rendering)

- 문제: HWP `TabDef` 레코드는 파싱되지만 렌더러에서 `tab-size: 4` (고정 4칸)로만 처리됨.
  양식 문서에서 탭으로 맞추는 레이블-값 정렬이 한컴 뷰어 대비 크게 어긋남.
- 수정 내용:
  - `_createHwpParagraphBlock` (hwp-parser.js) 및 `createHwpParagraphBlock` (parser.worker.js):
    `docInfo.tabDefs[tabDefId]`를 조회해 `tabStops: [{position, kind}]` 배열을 단락 블록에 임베드.
  - `appendParagraphBlock` (hwp-renderer.js):
    `tabStops` 중 첫 번째 `left` 정렬 탭 정지 위치(HWPUNIT → px)를 CSS `tab-size: Npx`로 적용.
    탭 정지가 없으면 기존 `tab-size: 4`로 폴백.
- 영향 범위: HWP 양식 문서 전체. 탭으로 정렬되는 레이블/값 쌍이 더 원본에 가까워짐.

#### 2. secd tag-76 (쪽 번호 위치) 파싱

- 문제: `secd` 컨트롤 서브레코드 스캔이 tag-73(PAGE_DEF)을 찾은 즉시 `break`해,
  tag-76(PAGE_NUM_PARA: 쪽 번호 자동 배치 위치·형식)를 전혀 읽지 못함.
- 수정 내용:
  - hwp-parser.js / parser.worker.js 양쪽의 secd 스캔 루프에서 `break` 제거.
  - tag-73과 tag-76을 모두 수집하도록 변경 (`while` 루프가 레벨 경계까지 전체 스캔).
  - `_parseHwpPageNumMeta` (hwp-parser.js) / `parseHwpPageNumMeta` (parser.worker.js) 추가:
    attr bits 0-3 위치 코드 → `BOTTOM_LEFT/BOTTOM_CENTER/...` 문자열 변환,
    bits 4-7 형식 코드 → `DIGIT/OTHER` 변환, sideChar 추출.
  - 파싱 결과를 `sectionMeta.pageNumber`에 저장.

#### 3. HWP 자동 쪽번호 블록 생성

- 문제: secd tag-76이 파싱되더라도 섹션 루프에서 쪽번호 블록을 생성하지 않아
  HWP 문서에 쪽번호가 표시되지 않음 (HWPX는 이미 지원).
- 수정 내용:
  - `_parseHwp5` 섹션 루프 (hwp-parser.js):
    섹션에 명시적 header/footer 블록이 없을 때만 `_hwpxCreatePageNumberBlock`을 호출해
    자동 쪽번호 블록을 footer 또는 header에 삽입 (중복 방지).
    위치(TOP_*/BOTTOM_*)에 따라 headerBlocks / footerBlocks에 분기.
  - 단일 섹션 경로(sections 배열 없는 경우)도 동일한 로직으로 적용.
- 영향 범위: secd에 tag-76이 정의된 HWP 문서. 명시적 `foot` 컨트롤 없이 자동 쪽번호만 사용하는 문서.

#### 검증

- `node --check js/hwp-parser.js` 통과
- `node --check js/parser.worker.js` 통과
- `node --check js/hwp-renderer.js` 통과

---


### 문서 정확성 — 영향도 높은 항목 3차 구현

- 수행 범위: `js/hwp-parser.js`, `js/parser.worker.js`, `js/hwp-renderer.js`

#### 7. HWP 표 기본 셀 내부 여백 파싱 (Table Default Cell Padding)

- 문제: HWP `HWPTAG_TABLE` (tag 80) 레코드의 offset 10-17 에는 표 전체 기본 셀 내부 여백
  (left/right/top/bottom inner margin, HWPUNIT)이 저장되어 있지만 파싱하지 않아
  개별 셀 여백이 0인 경우 3~4px 하드코딩 폴백으로 처리됨.
- 수정 내용:
  - `_parseTableInfo` (hwp-parser.js) / `parseTableInfo` (parser.worker.js):
    `defaultCellPadding: [L, R, T, B]` 배열 추가 파싱.
  - `_buildTableBlock` (hwp-parser.js): `defaultCellPadding`을 테이블 블록에 전달.
  - `appendTableBlock` (hwp-renderer.js):
    셀의 자체 padding이 모두 0일 때 `tableBlock.defaultCellPadding`을 우선 적용.
    기존 하드코딩 폴백(타이틀행/메타행 등)은 그 이후의 폴백으로 유지.
- 영향 범위: 개별 셀 여백을 지정하지 않고 표 수준 기본 여백을 사용하는 HWP 표 전체.

#### 검증

- `node --check js/hwp-parser.js` 통과
- `node --check js/parser.worker.js` 통과
- `node --check js/hwp-renderer.js` 통과

---


### 문서 정확성 — 영향도 높은 항목 2차 구현

- 수행 범위: `js/hwp-parser.js`, `js/parser.worker.js`, `js/hwp-renderer.js`

#### 4. CharShape 언어별 폰트 이름 분리 (Language-Specific Font)

- 문제: HWP CharShape는 언어별(한글/영어/한자/일어 등) 7개 폰트 face ID를 갖지만,
  기존 코드는 한글(faceId[0])만 읽어 모든 문자에 동일 폰트를 적용함.
  영문/수자 문자가 한글 폰트 폴백으로 렌더링 → 자폭 차이로 줄바꿈 위치가 어긋남.
- 수정 내용:
  - `_parseHwpCharShape` (hwp-parser.js) / `parseHwpCharShape` (parser.worker.js):
    `faceId[1]` (영어 face ID)도 읽어 `fontNameLatin`으로 저장.
    `fontNameLatin`이 `fontName`과 같으면 빈 문자열로 설정 (불필요한 중복 방지).
  - `appendTextRun` (hwp-renderer.js):
    `run.fontNameLatin`이 있으면 CSS `font-family` 스택 맨 앞에 추가.
    브라우저는 각 문자에 대해 스택 앞 폰트를 우선 시도하므로 라틴 문자는 라틴 폰트로 자동 렌더링됨.
- 영향 범위: 영문/라틴 혼합 HWP 문서. 공문서 내 영숫자 필드 정렬 정확도 개선.

#### 5. 표 테두리 최소 두께 정밀화 (Border Width)

- 문제: `hwpxBorderWidthToPx`에서 최소 0.8px로 클램프되어,
  HWP 0.1~0.2mm 최세선 표현이 한컴 뷰어보다 두꺼워 표 밀도 차이 발생.
- 수정 내용:
  - `hwpxBorderWidthToPx` (hwp-renderer.js): 최솟값 0.8px → 0.5px.
    0.1mm = 0.378px → 0.5px, 0.12mm = 0.454px → 0.5px, 0.15mm = 0.567px → 0.6px.
    얇은 선이 더 가늘게 렌더링되어 원본과의 밀도 차이 감소.
- 영향 범위: 표 테두리가 있는 모든 HWP/HWPX 문서.

#### 6. 셀 내부 여백 클램프 완화 (Cell Padding Clamp)

- 문제: 셀 padding 상한이 18~20px으로 너무 낮아 넓은 셀(1mm 이상 padding)에서
  여백이 찌그러져 보임.
- 수정 내용:
  - `appendTableBlock` (hwp-renderer.js): 상하 최대 18→30px, 좌우 최대 20→36px로 확대.
    1mm = 720 HWPUNIT ÷ 75 = 9.6px (상한 여유 충분), 2mm = 19.2px (기존 상한 초과).
- 영향 범위: 여백이 넓게 설정된 표 셀.

#### 검증

- `node --check js/hwp-parser.js` 통과
- `node --check js/parser.worker.js` 통과
- `node --check js/hwp-renderer.js` 통과

---


- 범위: `manifest.json`, `background.js`, `pages/viewer.html`, `js/app.js`, `popup.js`, `sidepanel.js`, `content_script.js`, 보조 모듈/스타일
- 수행:
  - 저장소 구조 및 변경 상태 확인
  - 주요 스크립트 정적 검토
  - `node --check`로 JS 구문 점검
- 확인한 핵심 이슈:
  - 뷰어에서 파일을 연 직후 내보내기 버튼을 누르면 빈 결과물이 생성될 수 있음
  - 편집 후 보기 모드로 돌아가면 수정 내용이 뷰어에 반영되지 않음
  - `default_popup`이 설정된 상태라 `chrome.action.onClicked`로 등록한 새 탭 열기 동작은 실행되지 않음
- 추가 대응:
  - HWP `BodyText` 파서의 제어문자 해석을 수정함
  - 잘못 2바이트 문자처럼 읽던 `0x0002`, `0x0006`, `0x0009` 계열 처리 보정
  - 수정 파일: `js/app.js`, `js/parser.worker.js`
  - 샘플 문서 `/Users/shinehandmac/Downloads/고엽제등록신청서.hwp` 로 재현 확인
  - 추가 원인 확인: CFB 헤더 오프셋을 잘못 읽어 `dirStartSec`를 `0x2C`에서 가져오고 있었음
  - 수정 후 샘플에서 `BodyText/Section0` 탐색 및 119개 문단 추출 확인
  - 추가 보정: 압축 섹션에서 `deflated` 결과가 있으면 `raw` 텍스트 스캔으로 되돌아가지 않도록 조정
  - 기대 효과: 5~30KB 문서에서 불필요한 섹션 재스캔 감소, 잡문자 후보 선택 방지
- 추가 보정: `DecompressionStream` 의존을 줄이고 `pako` 기반 raw deflate 해제로 전환
- 반영 파일: `lib/pako.min.js`, `pages/viewer.html`, `js/app.js`, `js/parser.worker.js`
- 추가 대응: HWP `tbl ` 제어 레코드를 파싱해 표/셀 구조를 블록 형태로 복원
- 반영 내용:
  - `js/app.js`, `js/parser.worker.js`에 표 메타/셀/문단 파서 추가
  - 뷰어 렌더러를 문단 전용에서 표 블록까지 처리하도록 확장
  - Quill 편집기 로딩 시 표를 탭 구분 텍스트로 펼쳐 편집 가능하게 보정
  - `css/viewer.css`에 신청서 양식용 표 스타일 추가
  - 큰 표를 행 단위로 분할하는 페이지네이션 로직 추가
- 검증:
  - Playwright로 `http://127.0.0.1:4173/pages/viewer.html` 직접 열어 샘플 문서 업로드
  - 샘플 `/Users/shinehandmac/Github/ChromeHWP/output/playwright/verify-hwp/test-input.hwp` 기준 표가 실제 칸 형태로 렌더링되는 것 확인
  - 페이지 수가 `3페이지`로 정리되고 첫 페이지에 머리 문단과 표가 함께 배치되는 것 확인
  - 검증 아티팩트: `.playwright-cli/page-2026-03-27T14-43-00-311Z.yml`, `.playwright-cli/page-2026-03-27T14-43-23-350Z.png`

## 2026-03-29

- 요청: 멀티 에이전트 방식으로 다음 고도화 방향을 잡고, 핵심 기능부터 개발 진행
- 역할 구성:
  - 기획 리더 1명 + 기획 연구원 3명으로 현재 상태/우선순위/리스크 조사
  - 개발 리더 1명 + 개발자 2명으로 핵심 기능과 추가 기능 분리 후 구현 착수
- 기획 결론:
  - `P0 핵심`: 보기·편집·내보내기 상태 통합
  - `P0 핵심`: 표/양식 충실도 유지 및 안정화
  - `P1 이후`: 서식 복원 확장, 파서 공용화, 비텍스트 요소, 회귀 체계
- 이번 스프린트에서 반영한 내용:
  - `js/app.js`
    - 보기 모드에서도 현재 문서 기준 HTML/PDF/HWPX 내보내기 가능하도록 정리
    - 편집 후 보기 모드로 돌아가면 편집 결과를 `editedDoc/editedDelta` 기반으로 다시 렌더링
    - 파싱 실패/오류 문서는 편집/내보내기 버튼을 자동 비활성화
  - `background.js`, `popup.html`, `popup.js`
    - `default_popup` 중심 UX로 정리하고 `chrome.action.onClicked` 충돌 제거
    - 컨텍스트 메뉴 `targetUrlPatterns`를 루트/쿼리/해시 링크까지 확장
    - 원격 링크 열기 공통 함수 추가 및 최근 파일 메타데이터 `{name,url,source,ts}` 저장
    - 팝업에 최근 파일 목록 UI 및 원격 링크 `다시 열기` 동작 추가
  - 추가 보정:
    - `background.js`의 HWP 링크 정규식과 파일명 추출이 `#hash` 링크도 정상 처리하도록 수정
- 검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - `node --check background.js`
  - `node --check popup.js`
  - Playwright로 `http://127.0.0.1:4174/pages/viewer.html` 검증
    - 정상 샘플 업로드 시 `3페이지` 렌더링 유지
    - `getCurrentDocumentHtml().length = 27086`으로 보기 모드 즉시 내보내기 소스 비어 있지 않음 확인
    - 편집 모드에서 `테스트메모` 삽입 후 보기 모드 복귀 시 본문/내보내기 HTML에 반영되는 것 확인
    - 잘못된 샘플 `output/playwright/invalid.hwp` 업로드 시 편집/HTML 저장 버튼이 `disabled=true` 로 잠기고 오류 문구가 노출되는 것 확인
- 메모:
  - 편집 후 보기 반영은 현재 Quill delta를 문단 블록으로 재구성하는 방식이라, 편집 이후에는 원본 표/페이지 구조가 단순화될 수 있음
  - 다음 우선순위는 표의 border/fill/padding 충실도, 문자/문단 서식 복원, 파서 공용화 순서가 적절함
- 요청: 개발팀 4명 방식으로 원본 서식에 더 가깝게 첫 페이지 양식을 미세 조정
- 역할 분담:
  - 개발자 2명: 렌더링/CSS 미세 조정 방향 도출
  - 탐색 2명: 현재 스크린샷과 실제 신청서 양식 차이 분석
- 반영한 내용:
  - `js/app.js`
    - 첫 페이지 첫 표에 한해 신청서 전용 정규화 로직 추가
    - 제목/체크박스가 한 셀에 합쳐진 경우 `title-block` 전용 그리드로 재렌더링
    - `①~③`, `④~⑦`이 한 줄에 과도하게 합쳐진 행을 서식형 2줄 구조로 분리
    - `field-label`, `field-input`, `field-inline-note` 역할을 부여해 레이블 폭과 정렬을 안정화
    - 제목행 최소 높이 계산을 줄여 상단 공백을 축소
  - `css/viewer.css`
    - 신청서 전용 제목 그리드, 옵션 줄 간격, 필드 라벨 폰트 크기/행간 보정
    - `person-form`, `military-form` 계열 행의 상하 패딩과 세로 정렬을 원본 양식에 가깝게 조정
  - `HwpExporter._wrap()` 내보내기용 인라인 CSS도 동일한 스타일 규칙으로 동기화
  - 추가 미세 보정:
    - 제목행의 불필요한 빈 줄을 제거하고 `rowSpan`을 2행 기준으로 보정
    - 문서 내부 폰트 스택을 한글 문서용 serif 계열 우선으로 조정
    - `⑧질병명` 행을 `1/2/3` 구조로 재정렬하고 `4.` 칸을 제거
    - `⑬고엽제후유(의)증 환자 등과의 관계` 헤더 폭을 넓혀 2행 중심으로 정리
    - `90일`, `①성명`, `③주소`, `⑤계급`, `⑥군별`, `⑦군번`, `⑭성명`, `⑮주민등록번호` 표기를 정규화
- 검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - `node --check background.js`
  - `node --check popup.js`
  - Playwright로 `http://127.0.0.1:4174/pages/viewer.html` 에 샘플 업로드 재검증
    - 제목행이 `등록신청서 + 체크박스 3줄 + 처리기간` 구조로 분리되어 보이는 것 확인
    - `①성명/②주민등록번호` 와 `③주소`, `④입대일자/⑤계급`, `⑥군별/⑦군번`이 분리된 행으로 렌더링되는 것 확인
    - `⑧질병명` 행이 `1/2/3` 구조로 정리되고, 가족사항 헤더 폭이 완화된 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T02-48-17-102Z.png`

- 요청: HWP/HWPX 어떤 계열 파일도 더 안정적으로 열리도록 일반화하고, 실제 샘플 `.hwp` / `.hwpx` 파일로 다시 검증
  - 반영한 내용:
    - `js/app.js`
      - HWPX 셀 안의 중첩 표를 더 이상 평문으로 눌러버리지 않고 블록 구조로 유지
    - HWPX의 큰 레이아웃용 외곽 표를 문단 흐름 + 실제 표 블록으로 선형화하는 휴리스틱 추가
    - `Ⅰ / Ⅱ / Ⅲ ...` 같은 구획 제목 행은 단락형 헤더로 정리하고, 실제 다열 행은 작은 표 블록으로 유지
    - HWPX 표 행 높이를 원본 raw height 대신 내용 기반 weight로 다시 계산해 과도한 페이지 분리를 줄임
    - 셀 내부에 중첩 표가 남아 있을 때 렌더러가 재귀적으로 표를 그릴 수 있도록 확장
    - HWPX 표 렌더링 시 높이 스케일을 별도로 적용해 긴 본문이 한 행 때문에 비정상적으로 커지지 않도록 조정
  - `css/viewer.css`
    - 셀 내부 중첩 표 렌더링용 `.hwp-table-nested` 여백 규칙 추가
  - `HwpExporter._wrap()` 인라인 스타일도 동일한 중첩 표 규칙으로 동기화
  - 검증:
    - `node --check js/app.js`
    - Playwright로 `http://127.0.0.1:4174/pages/viewer.html` 실파일 업로드 검증

## 2026-04-14

- 요청: Planning Team member 3로서 공식 PDF 2종을 읽고, 수식/차트의 full-fidelity 요건과 즉시 구현 우선순위를 정리
- 분석 대상:
  - `/Users/shinehandmac/Downloads/한글문서파일형식_수식_revision1.3.pdf`
  - `/Users/shinehandmac/Downloads/한글문서파일형식_차트_revision1.2.pdf`
- 핵심 확인 사항:
  - 수식 문서는 `Equation Editor`의 명령어 집합, 글꼴 전환, 항 묶기, 줄바꿈, 빈칸 처리, 분수/제곱근/행렬/합·극한/조합 같은 템플릿 기반 조합식을 정의한다.
  - 수식 fidelity의 본질은 단순 텍스트 파싱이 아니라, 기호 위치와 크기, 상하 첨자, 분수선, 괄호 크기, 행렬 정렬, `scale`/`rm`/`bold`/`cases`/`pile`/`eqalign` 같은 명령의 레이아웃 해석이다.
  - 차트 문서는 `VtChart` 루트와 `ChartObj` 트리, `Axis`/`Legend`/`Plot`/`DataGrid`/`Title`/`Fill`/`Brush`/`View3D`/각종 `Constants`를 매우 세분화해서 정의한다.
  - 차트 fidelity의 본질은 표면적인 막대/선/파이 그림보다, 객체 트리, 속성 상속, 축 스케일, 범례, 라벨, 색/브러시/그라데이션, 2D/3D 분기, 그림자/패턴/각종 상수 매핑을 유지하는 데 있다.
- 즉시 권장 우선순위:
  - 수식은 `OVER`, `SQRT`, `MATRIX`, `SUM`, `BIGG`, `LEFT/RIGHT`, `lim`, `cases`, `pile`, `eqalign` 같은 핵심 템플릿을 실제 렌더링하는 쪽이 우선이다.
  - 차트는 먼저 `VtChart`-기반 트리와 주요 축/범례/데이터/텍스트 속성을 보존하고, 시각 출력은 단계적으로 고도화하는 편이 효율적이다.
  - 즉시 미루어도 되는 항목은 희귀한 상수 풀 커버리지, 특수 3D 장식, 상세 인쇄 옵션, 매우 드문 차트 변형과 부수 객체들이다.
- 결론:
  - 원본 그대로 보이게 하려면 수식은 “명령 해석 + 수학 레이아웃 엔진” 수준이 필요하고, 차트는 “객체 그래프 직렬화/역직렬화 + SVG/Canvas 렌더러”에 가까운 접근이 필요하다.
  - 초기 viewer fidelity 목표에서는 수식/차트의 구조와 대표 형태를 먼저 맞추고, 아주 세부적인 인쇄/장식 상수는 후순위로 둬야 한다.
    - `/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/goyeopje.hwp`
      - `3페이지` 유지
      - 첫 페이지 신청서 양식이 표/칸 구조로 유지되는 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T03-19-47-101Z.png`
    - `/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs/incheon-2a.hwpx`
      - 이전 `28페이지` 수준으로 과분할되던 상태에서 `5페이지`로 안정화
      - 첫 페이지에 제목과 공급위치/공급대상/안내 블록이 함께 배치되는 것 확인
      - 3페이지에서 `공급규모/공급대상` 구간의 실제 다열 표가 다시 표 형태로 렌더링되는 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T03-20-09-878Z.png`, `.playwright-cli/page-2026-03-29T03-20-34-461Z.png`
- 메모:
  - HWPX는 문서마다 레이아웃용 표 사용 방식이 달라서, 현재는 `본문 흐름용 큰 표`와 `실제 정보 표`를 분리하는 휴리스틱 기반 대응까지 반영된 상태
  - 남은 고도화 포인트는 `borderFill 실선/굵기/배경색 반영`, `문단 정렬/들여쓰기`, `도형/이미지 앵커 배치` 복원

- 추가 고도화:
  - `js/app.js`
    - HWPX `Contents/header.xml`을 읽어 `borderFill`, `paraPr`, `charPr`, 한글 폰트 정보를 파싱
    - HWPX 문단에 정렬/들여쓰기/문단 간격/줄간격을 반영하고, 글자 크기/굵기/색상/폰트를 run 스타일로 적용
    - HWPX 셀의 `borderFillIDRef`를 실제 CSS border/background로 매핑해 표 선 굵기와 색 차이를 반영
    - 새 파일 로드 시 뷰어 스크롤과 상태바 페이지 번호를 첫 페이지로 리셋해 이전 문서 위치가 남지 않도록 수정
- 재검증:
  - `node --check js/app.js`
  - Playwright 재검증
    - HWPX 첫 페이지 제목이 `HY헤드라인M` 계열 굵은 글꼴로 반영되고, 표 선이 문서 메타 기반 두께/색으로 적용되는 것 확인
    - HWPX 검증 아티팩트: `.playwright-cli/page-2026-03-29T04-52-44-807Z.png`
    - HWP 샘플 재업로드 시 상태바가 `1 / 3 페이지`로 초기화되는 것 확인
- 메모:
  - 현재 단계부터는 내용 파싱뿐 아니라 HWPX 헤더 스타일을 일부 반영하는 상태
  - 남은 우선순위는 `문단별 스타일 세분화(목차/표제/주석)`, `HWP 쪽 borderFill 정의 복원`, `도형/이미지 위치 복원`

- 추가 미세 보정:
  - `js/app.js`
    - HWPX 문단의 선행 공백을 정리하고, 큰 글자 + 굵은 제목 문단은 가운데 정렬/제로 들여쓰기로 자동 정리
    - 가운데/오른쪽 정렬 문단에는 좌측 패딩/들여쓰기를 강제로 넣지 않도록 렌더링 보정
- 재검증:
  - `node --check js/app.js`
  - Playwright로 `incheon-2a.hwpx` 재검증
    - 첫 페이지 제목 2줄의 `text-align`이 모두 `center` 로 반영되는 것 확인
    - 상태바가 `1 / 5 페이지`에서 시작하는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T06-35-49-639Z.png`

- 추가 확장:
  - `js/app.js`
    - HWPX `pic`를 실제 이미지 블록으로 파싱하고 `BinData/*` 자원을 data URL로 연결
    - HWPX 문단을 단일 문자열이 아니라 run 배열로 보존하도록 바꿔 혼합 글자 스타일 손실을 줄임
    - 이미지 블록을 보기/HTML 내보내기/표 셀 내부 렌더링 경로까지 연결
    - 로고처럼 작은 상단 이미지가 페이지를 과하게 밀지 않도록 이미지 weight 계산을 조정
- 재검증:
  - `node --check js/app.js`
  - Playwright로 `incheon-2a.hwpx` 재검증
    - 이미지 블록이 실제 DOM `img.hwp-image` 로 렌더링되는 것 확인
    - 첫 페이지가 다시 `로고 + 제목 + 공급위치/공급대상/안내 본문` 흐름으로 묶이고 전체가 `5페이지`로 유지되는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T06-47-21-182Z.png`

- 추가 고도화:
  - `js/app.js`
    - HWPX `secPr/visibility`, `header/footer applyPageType`, `pageNum`, `newNum(numType=PAGE)` 를 읽어 페이지별 헤더/푸터/쪽번호를 계산하도록 확장
    - 헤더/푸터를 단순 복제가 아니라 `BOTH/ODD/EVEN/FIRST` 규칙으로 페이지별로 선택하도록 정리
    - 쪽번호를 `- 1 -` 형태의 실제 footer 문단으로 생성해 DOM/HTML 내보내기에 같이 반영
    - 뷰어/HTML 내보내기 모두 `header/body/footer` 영역 래퍼를 두고 footer가 페이지 하단으로 정렬되도록 보정
    - 문단 렌더러가 `para.role` 을 직접 인식하도록 바꿔 synthetic page-number 스타일을 붙일 수 있게 수정
  - `css/viewer.css`
    - `.hwp-page-header`, `.hwp-page-body`, `.hwp-page-footer`, `.hwp-page-number` 규칙 추가
- 재검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - Playwright로 `http://127.0.0.1:4174/pages/viewer.html` 재검증
    - `incheon-2a.hwpx`
      - 첫 페이지에 헤더 슬로건 이미지 + 본문 로고/제목/공급안내가 함께 유지되는 것 확인
      - DOM snapshot에 footer 쪽번호 `- 1 -` 이 생성되는 것 확인
      - 전체 페이지 수가 계속 `5페이지` 인 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T07-00-59-430Z.png`, `.playwright-cli/page-2026-03-29T07-00-59-276Z.yml`
    - `goyeopje.hwp`
      - 첫 페이지 신청서 표 구조와 `3페이지` 상태가 유지되는 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T07-01-29-274Z.png`, `.playwright-cli/page-2026-03-29T07-01-29-215Z.yml`

- 추가 고도화:
  - `js/app.js`
    - HWPX에서 `border/fill/gradient` 가 있는 1셀 표를 더 이상 문단으로 평탄화하지 않도록 바꿔 제목 밴드/장식선 보존
    - `table/cell` 의 시각적 존재 여부를 텍스트뿐 아니라 border/fill 기준으로도 판단하도록 수정
    - `renderDocument()` 에도 HWPX 페이지 스타일 적용을 연결해 브라우저 렌더와 HTML 내보내기 동작을 일치시킴
    - `pageBorderFill` 참조를 실제 `borderFill` 정의와 연결해 페이지 메타를 더 정확히 유지
    - `ODD/EVEN/FIRST/BOTH` 페이지 장식 우선순위 계산을 보정
- 재검증:
  - `node --check js/app.js`
  - Playwright로 `incheon-2a.hwpx`, `goyeopje.hwp` 재검증
    - `incheon-2a.hwpx`
      - 첫 페이지 제목 영역이 다시 표/밴드 형태로 렌더링되고, 연분홍 장식선/배경이 살아난 것 확인
      - DOM snapshot 에 footer 쪽번호 `- 1 -` 이 계속 유지되는 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T07-05-46-407Z.png`, `.playwright-cli/page-2026-03-29T07-06-33-382Z.yml`
    - `goyeopje.hwp`
      - 3페이지 상태와 첫 페이지 신청서 표 구조가 그대로 유지되는 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T07-06-01-938Z.png`

- 추가 미세 조정:
  - `js/app.js`
    - HWPX `pic/pos` 의 `horzOffset`, `vertOffset` 을 inline/block 이미지 렌더 스타일에 반영
    - 큰 offset 을 가진 헤더 이미지가 완전히 사라지지 않도록 오른쪽 정렬 해석을 추가
- 재검증:
  - `node --check js/app.js`
  - Playwright로 `incheon-2a.hwpx` 재검증
    - 첫 페이지 상단 슬로건 이미지가 일부라도 실제 화면에 드러나고, 로고/제목/핑크 밴드 구조는 유지되는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T09-16-56-432Z.png`

- 추가 미세 조정:
  - `js/app.js`
    - 큰 `horzOffset` 을 가진 HWPX 헤더 이미지를 오른쪽 정렬 레이아웃으로 해석해 상단 슬로건이 완전히 잘리지 않도록 보정
- 재검증:
  - `node --check js/app.js`
  - Playwright로 `incheon-2a.hwpx` 재검증
    - 첫 페이지 상단 슬로건 이미지가 전체 문구로 노출되고, 핑크 타이틀 밴드/푸터 쪽번호가 계속 유지되는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T09-18-52-168Z.png`

- 추가 고도화:
  - `js/app.js`
    - HWP 바이너리 `DocInfo` 스트림에서 `HWPTAG_BORDER_FILL` 레코드를 읽어 표 셀의 `borderFillId` 와 연결
    - HWP `COLORREF`, 테두리선 종류, 굵기, 단색/그라데이션 채우기를 CSS 친화적인 `borderStyle` 형태로 정규화
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 `DocInfo borderFill` 파서를 추가해 메인/워커 결과 차이를 제거
    - `BodyText -> table cell` 파싱 시 `borderFillId` 를 실제 셀 테두리/배경 스타일로 반영
- 재검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - Playwright로 `goyeopje.hwp`, `incheon-2a.hwpx` 재검증
    - `goyeopje.hwp`
      - 신청서 첫 페이지가 `DocInfo` 기반 선 굵기/외곽선 강약을 가진 표 형태로 유지되는 것 확인
      - 전체 페이지 수가 계속 `3페이지` 인 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T09-28-47-405Z.png`, `.playwright-cli/page-2026-03-29T09-28-38-550Z.yml`
    - `incheon-2a.hwpx`
      - 상단 슬로건/핑크 타이틀 밴드/공급안내/푸터 쪽번호가 계속 유지되고, 전체가 `5페이지`로 안정적인 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T09-29-08-361Z.png`, `.playwright-cli/page-2026-03-29T09-28-59-474Z.yml`

- 추가 고도화:
  - `js/app.js`
    - HWP `DocInfo` 에서 `FACE_NAME`, `CHAR_SHAPE`, `PARA_SHAPE` 를 함께 읽어 폰트/글자크기/굵기/밑줄/문단 정렬/들여쓰기/문단 간격을 복원
    - 본문과 표 셀 모두 `HWPTAG_PARA_HEADER + HWPTAG_PARA_CHAR_SHAPE + HWPTAG_PARA_TEXT` 조합으로 문단 블록을 만들도록 변경
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 `FaceName/CharShape/ParaShape` 파서를 추가해 실제 확장 경로와 메인 경로의 렌더 차이를 줄임
    - 문단별 char-shape range를 run 단위로 나눠 HWP 일반 문서에서도 스타일 복원이 가능하도록 확장
- 재검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - Playwright로 `goyeopje.hwp`, `incheon-2a.hwpx` 재검증
    - `goyeopje.hwp`
      - 신청서 표 구조/외곽선 강약이 유지된 채 `3페이지`로 계속 열리는 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-21-10-489Z.png`, `.playwright-cli/page-2026-03-29T11-21-05-364Z.yml`
    - `incheon-2a.hwpx`
      - 상단 슬로건/핑크 타이틀 밴드/공급안내/푸터 쪽번호가 유지된 채 `5페이지` 상태가 계속 안정적인 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-21-30-602Z.png`, `.playwright-cli/page-2026-03-29T11-21-24-750Z.yml`

- 추가 고도화:
  - `js/app.js`
    - HWP `PARA_LINE_SEG` 를 읽어 문단의 실제 줄 높이/레이아웃 높이를 안전한 범위에서 복원
    - HWP 표 셀 `LIST_HEADER` 속성의 세로 정렬 비트를 읽어 `top/middle/bottom` 정렬로 반영
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 line-seg / cell vertical-align 파서를 추가해 렌더 일관성 유지
- 재검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - Playwright로 `goyeopje.hwp`, `incheon-2a.hwpx` 재검증
    - `goyeopje.hwp`
      - line-seg / cell 정렬 반영 후에도 신청서 표 구조와 `3페이지` 상태가 계속 안정적인 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-32-46-037Z.png`, `.playwright-cli/page-2026-03-29T11-32-38-500Z.yml`
    - `incheon-2a.hwpx`
      - HWP 개선 이후에도 상단 슬로건/핑크 타이틀 밴드/푸터 쪽번호가 유지된 채 `5페이지` 상태가 계속 안정적인 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-33-09-900Z.png`, `.playwright-cli/page-2026-03-29T11-33-01-348Z.yml`

- 기획/운영 정리:
  - `BACKLOG.md`
    - 현재 상태 점검과 함께 HWP/HWPX 품질, 공통 아키텍처, 검증/운영 관점의 우선순위 backlog 문서를 추가
  - Playwright 세션 정리:
    - 누적돼 있던 검증용 브라우저 세션을 모두 닫아 작업 환경을 초기화
    - 이후 검증은 고정 세션 재사용 또는 종료를 기본 원칙으로 진행
- 개발 적용:
  - `scripts/playwright_smoke.sh`
    - `chromehwp` 단일 세션으로 뷰어를 열고 HWP/HWPX 샘플을 순차 검증한 뒤 세션을 자동 종료하는 스모크 스크립트 추가
    - 검증 창이 누적되지 않도록 `close -> open -> verify -> close` 흐름으로 정리
- 재검증:
  - `bash scripts/playwright_smoke.sh`
    - `goyeopje.hwp` 업로드, 스크린샷 생성, `incheon-2a.hwpx` 업로드, 스크린샷 생성이 한 세션에서 순차 실행되는 것 확인
    - 실행 후 `playwright_cli.sh list` 기준 열린 브라우저가 남지 않는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-41-34-168Z.png`, `.playwright-cli/page-2026-03-29T11-41-37-373Z.png`, `.playwright-cli/page-2026-03-29T11-41-36-802Z.yml`
- 기획 문서 보강:
  - `BACKLOG.md`
    - HWPX 전용 품질 항목을 추가하고, 현재 렌더 품질과 구조 상태를 개발팀 전달용 관점으로 재정리
    - 우선순위를 `HWP 개체/도형 -> HWPX 앵커/장식 -> 공통 메트릭 -> 파서 구조 -> 검증/운영` 순으로 고정

- 기획/개발/운영 추가 정리:
  - `BACKLOG.md`
    - 기획팀 리서치 결과를 기준으로 현재 상태, 우선순위, 검증 기준을 다시 정리
    - 이번 패스의 핵심 축을 `HWPX 표 메트릭 정밀화 + Playwright 세션 단일화 + 탭 식별 개선`으로 확정
  - `docs/rendering-status.md`
    - 현재 지원 범위, 남은 공백, 샘플 회귀검증 규칙, Playwright 세션 운영 규칙을 문서화
  - `README.md`
    - 최소 smoke 검증 명령과 `verify-current` 세션 운영 규칙을 추가

- 추가 고도화:
  - `js/app.js`
    - HWPX `cellSz.height`, `subList.textHeight`, `subList.vertAlign` 를 실제 셀 메타에 반영
    - HWPX 표에 대해 행별 실제 높이(`hwpxRowHeights`)를 따로 계산하고, 렌더 시 추정 weight 대신 실측 높이를 우선 사용하도록 보정
    - HWPX 셀 margin 은 HWP와 분리된 스케일로 변환해 과도한 패딩을 줄이고 원본 칸 여백에 더 가깝게 조정
    - 문서 로드 후 브라우저 탭 제목을 `파일명 - ChromeHWP Viewer` 로 갱신해 탭 식별성을 높임
  - `pages/viewer.html`
    - favicon / apple-touch-icon 링크를 추가해 로컬 검증 시 `favicon.ico` 404 를 제거하고 탭 아이콘을 고정
  - `scripts/playwright_smoke.sh`
    - 기본 세션명을 `verify-current` 로 변경
    - 시작/종료 모두 `close-all` 을 사용해 검증 창이 누적되지 않도록 정리

- 재검증:
  - `node --check js/app.js`
  - `node --check scripts/verify_samples.mjs`
  - `node scripts/verify_samples.mjs`
    - HWP `3페이지`, HWPX `5페이지`, 핵심 키워드/파일 배지 기준 회귀검증 통과
  - `bash scripts/playwright_smoke.sh`
    - `goyeopje.hwp` 업로드 시 탭 제목이 `goyeopje.hwp - ChromeHWP Viewer` 로 바뀌고 스크린샷이 생성되는 것 확인
    - `incheon-2a.hwpx` 업로드 시 탭 제목이 `incheon-2a.hwpx - ChromeHWP Viewer` 로 바뀌고 스크린샷이 생성되는 것 확인
    - 콘솔 에러 카운트가 사라지고, 실행 후 `playwright_cli.sh list` 기준 열린 브라우저가 남지 않는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-48-50-301Z.png`, `.playwright-cli/page-2026-03-29T11-48-53-533Z.png`, `.playwright-cli/page-2026-03-29T11-48-49-705Z.yml`, `.playwright-cli/page-2026-03-29T11-48-52-988Z.yml`

- 추가 샘플 조사:
  - 신규 HWP 샘플 추가:
    - `/Users/shinehandmac/Downloads/(첨부)정정_공고문_신축다세대잔여세대선착순일반매각.hwp` 를 회귀 확인용으로 `output/playwright/inputs/attachment-sale-notice.hwp` 에 복사
  - Playwright 재확인:
    - `attachment-sale-notice.hwp` 를 현재 뷰어에서 열어 첫 페이지/썸네일 구조 확인
    - 현재 렌더는 본문 텍스트와 표 데이터는 읽지만, 공고문 첫 페이지 상단 레이아웃과 일정/안내 영역의 정밀 배치가 많이 무너지는 것 확인
    - 특히 제목 상단 여백/정렬, `알려드립니다` 헤더 스타일, `공고사전주택개방/동·호지정 및 계약체결` 일정행이 한 문단으로 뭉개지는 증상이 보여 HWP control object / tab stop / 정밀 레이아웃 해석 부족으로 판단
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-54-05-545Z.png`, `.playwright-cli/page-2026-03-29T11-53-56-135Z.yml`
  - WebHWP 참조 가능성 확인:
    - `https://webhwp.hancomdocs.com/webhwp/?mode=HWP_EDITOR&docId=nOnMzMd4EXx2h7x4fQE1yEB9B5nREZfQ&lang=ko_KR` 를 Playwright와 웹으로 확인
    - 에디터 셸 자체는 열리지만, 현재 제공된 `docId` 는 공개 접근이 되지 않아 `문서를 열 수 없습니다. 문서 주소가 올바르지 않습니다.` 상태로 실제 문서 비교 기준으로는 바로 사용 불가
    - 대신 한컴 공식 WebHWP 개발 가이드(`developer.hancom.com/en-us/webhwp/devguide`)와 HwpCtrl 문서를 기준 자료로 활용 가능하다는 점을 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T11-54-39-684Z.png`, `.playwright-cli/page-2026-03-29T11-54-39-194Z.yml`

- HWP 공고문 추가 보강:
  - 원인 확인:
    - `attachment-sale-notice.hwp` 의 일정 영역은 단순 문단이 아니라 HWP 셀 안에 다시 들어간 중첩 `tbl ` control 인 것을 raw record 수준에서 확인
    - 기존 구현은 셀 내부에서 nested control 을 재귀 파싱하지 못해, 중첩 표의 자식 문단이 바깥 셀 텍스트로 섞여 들어가고 있었음
  - `js/app.js`
    - HWP control subtree 스킵 헬퍼를 추가해 미지원 control 자식이 본문 흐름으로 새지 않게 보정
    - HWP 표 셀 내부에서 nested `tbl ` control 을 재귀 파싱해 nested table block 으로 보존
    - HWP 문단에서 연속 공백/개행/탭이 있는 경우 `pre-wrap` 으로 렌더해 의미 있는 공백이 유지되도록 보정
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 nested table 재귀 파싱 / control subtree 스킵 로직 반영
  - 재검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `node scripts/verify_samples.mjs` 통과로 기존 대표 HWP/HWPX 회귀 유지 확인
    - `attachment-sale-notice.hwp` 재확인 결과, 일정 구간이 더 이상 단순 문단이 아니라 실제 nested `table` 로 DOM snapshot 에 복원되는 것 확인
    - 검증 아티팩트: `.playwright-cli/page-2026-03-29T12-14-01-707Z.yml`, `.playwright-cli/page-2026-03-29T12-14-02-200Z.png`
  - 잔여 과제:
    - 첫 페이지 상단 로고/배너/정밀 위치 차이는 여전히 `gso` 개체(그림/도형) 파서 부재 영향이 커서 다음 패스에서 별도 대응 필요

- 한컴 WebHWP 가이드 기준 HWP 그림 처리 보강:
  - 기준 재점검:
    - 한컴 공식 WebHWP 개발 가이드(`developer.hancom.com/en-us/webhwp/devguide`)와 `HwpCtrl` 문서에서 개체/그림/헤더 컨트롤이 독립 기능 축이라는 점을 다시 확인
    - 다만 해당 문서는 HWP 바이너리 포맷 스펙이 아니라 기능 체크리스트 성격이라, 실제 구현은 샘플 HWP raw record 역분석으로 이어서 진행
  - 원인 확인:
    - 기존 HWP `gso` 그림 복원은 `BIN0001 -> BIN0002 -> ...` 순차 소비 휴리스틱이라, 문서마다 그림 순서가 달라지면 잘못된 이미지가 매칭될 여지가 있었음
    - `attachment-sale-notice.hwp` 의 `HWPTAG_SHAPE_COMPONENT_PICTURE(85)` 바디를 raw dump 로 확인한 결과, 그림 body 후반부에 `1`, `2`, `3` 형태의 실제 BinData 참조값이 들어있는 것을 확인
  - `js/app.js`
    - HWP BinData 로드 결과에 `id -> image` 맵을 추가해 `BIN0001.png` 같은 스트림을 숫자 참조로 바로 찾을 수 있게 정리
    - HWP picture body 에서 BinData 참조값을 읽는 헬퍼를 추가하고, `gso` 그림 렌더가 순차 소비보다 참조 기반 매핑을 우선 사용하도록 변경
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 BinData id 매핑 / picture body 참조 파싱 로직을 반영해 메인/워커 결과 차이가 생기지 않도록 정리
  - 회귀검증 강화:
    - `scripts/verify_samples.mjs`
      - `attachment-sale-notice.hwp` 를 기본 회귀 샘플에 추가
      - 상단 배너 이미지(`img "BIN0001.png"`), `알려드립니다`, `동·호지정 및 계약체결` 존재 여부를 함께 검사하도록 확장
    - `scripts/playwright_smoke.sh`
      - 세 번째 샘플 인자로 `attachment-sale-notice.hwp` 까지 업로드하도록 확장
  - 재검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `node scripts/verify_samples.mjs`
    - `bash scripts/playwright_smoke.sh`
    - `attachment-sale-notice.hwp` 는 현재 snapshot 기준으로 상단 타이틀/배너 구간에서 `BIN0002.png` 가 렌더되고, 일정 표의 `동·호지정 및 계약체결` 컬럼과 하단 `BIN0003.jpg` 도 함께 확인
    - 최신 검증 아티팩트: `.playwright-cli/page-2026-03-29T12-40-29-857Z.yml`, `.playwright-cli/page-2026-03-29T12-43-13-245Z.png`, `.playwright-cli/page-2026-03-29T12-43-12-791Z.yml`

- HWP GSO 표시 크기 보정:
  - 원인 확인:
    - `attachment-sale-notice.hwp` 첫 페이지에서 LH 로고가 페이지 대부분을 덮는 문제는 picture body 의 원본/확장 크기 후보를 그대로 최대값으로 선택하고 있었기 때문
    - 같은 샘플의 raw record 를 보면 `ctrlBody` 쪽 표시 크기와 `pictureBody` 쪽 원본 크기 후보가 함께 들어 있어, 최대값 기준은 과대 렌더를 유발
  - `js/app.js`
    - HWP `gso` 그림의 width/height 계산을 최대값이 아니라 “실제 표시 크기에 가까운 최소 양수 후보”를 고르는 방식으로 변경
    - `ctrlBody(16/20, 24/28)` 와 `pictureBody(52/56, 20/28, 32/40)` 후보를 함께 비교해 소형 로고/배너가 과대 표시되지 않도록 보정
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 표시 크기 선택 규칙을 반영
  - 재검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - Playwright로 `attachment-sale-notice.hwp` 재업로드 후 첫 페이지 확인
      - 기존의 과대 로고가 제목 아래 소형 로고 크기로 정상화된 것 확인
      - 검증 아티팩트: `.playwright-cli/page-2026-03-29T13-29-10-444Z.png`, `.playwright-cli/page-2026-03-29T13-29-09-939Z.yml`
    - `node scripts/verify_samples.mjs`
      - 기존 대표 HWP/HWPX + 추가 HWP 공고문 회귀검증 통과

- HWP 헤더/알 수 없는 control subtree 일반화:
  - 한컴 WebHWP 개발 가이드에서 `HeadCtrl`, `LastCtrl`, `ParentCtrl` 처럼 control 기반 문서 구조를 다시 확인했고, 실제 바이너리 해석은 샘플 역분석으로 이어서 진행
  - 원인 확인:
    - `attachment-sale-notice.hwp` 의 상단 슬로건 `BIN0001.png` 는 `head` control subtree 아래에 있었고, 기존 파서는 `head/foot` 외의 미지원 control subtree 를 통째로 건너뛰고 있었음
    - 이 구조면 문서마다 다른 wrapper control 아래 숨어 있는 표/그림/문단이 계속 누락될 수 있어 범용 HWP 대응에 취약
  - `js/app.js`
    - `head/foot` subtree 는 별도 `headerBlocks/footerBlocks` 로 수집하는 기존 흐름을 유지
    - 그 외 미지원 control 도 subtree 를 재귀적으로 훑어, 내부에 복원 가능한 표/그림/문단이 있으면 본문 블록으로 살려내도록 일반화
  - `js/parser.worker.js`
    - Worker 경로에도 동일한 subtree salvage 로직을 반영해 메인/워커 결과 차이를 방지
  - 재검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `bash scripts/playwright_smoke.sh`
    - `node scripts/verify_samples.mjs`
    - 대표 샘플 3종(`goyeopje.hwp`, `incheon-2a.hwpx`, `attachment-sale-notice.hwp`) 회귀검증 통과
    - 최신 검증 아티팩트: `.playwright-cli/page-2026-03-29T14-10-26-234Z.png`, `.playwright-cli/page-2026-03-29T14-10-25-778Z.yml`

- 저장 UX 재구성:
  - 요구사항:
    - 상단에 흩어져 있던 `HTML/PDF/HWPX 저장` 3버튼 대신, `편집 후에만 활성화되는 저장`과 `포맷을 고르는 다른 이름으로 저장` 흐름으로 정리
    - 현재 문서가 `HWPX` 인 경우에는 가능한 한 같은 파일을 덮어쓸 수 있게 하고, 원본이 `.hwp` 인 경우에는 안전하지 않은 바이너리 재저장을 막기
  - `pages/viewer.html`
    - 헤더 액션을 `💾 저장` + `형식 선택` + `🗂️ 다른 이름으로 저장` 구조로 교체
    - 편집 모드 안내 문구도 저장 흐름에 맞게 조정
  - `css/viewer.css`
    - 저장 형식 `select` UI 스타일 추가
  - `js/app.js`
    - 편집 중 delta baseline 과 비교해 `hasUnsavedChanges` 를 실시간 추적하고, 실제 수정이 생긴 경우에만 `저장` 버튼이 활성화되도록 연결
    - `HWPX` 파일은 `저장` 시 현재 파일명 기준으로 저장되며, 파일 시스템 핸들이 있으면 덮어쓰기 / 없으면 한 번 저장 위치를 받아 이후 기준 파일처럼 동작하도록 정리
    - `다른 이름으로 저장` 은 `HWPX`, `HTML`, `PDF` 를 지원하고, `HWP` 바이너리 저장은 아직 안전하게 생성할 수 없어 버튼 비활성/안내 문구로 막음
    - 기존 Playwright 업로드 흐름과 충돌하지 않도록 파일 열기 버튼은 hidden input 기반 업로드를 유지
    - `Ctrl+S` 는 저장 가능 상태일 때 현재 문서 저장에 연결
  - 재검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `bash scripts/playwright_smoke.sh`
    - Playwright 수동 검증:
      - `incheon-2a.hwpx` 로드 직후 `💾 저장` 비활성 확인: `.playwright-cli/page-2026-03-29T14-21-04-634Z.yml`
      - 편집 모드 진입 직후 `💾 저장` 비활성 유지 확인: `.playwright-cli/page-2026-03-29T14-21-15-176Z.yml`
      - 에디터 입력 후 `💾 저장` 활성화 확인: `.playwright-cli/page-2026-03-29T14-21-30-107Z.yml`
      - 저장 형식을 `HWP` 로 바꾸면 `🗂️ 다른 이름으로 저장` 비활성화 확인: `.playwright-cli/page-2026-03-29T14-21-55-571Z.yml`

- 저장소 정리/커밋 준비:
  - 목표:
    - 실제 코드/문서/검증 스크립트/샘플만 커밋 대상으로 남기고, 로컬 Playwright 산출물은 저장소에서 제외
  - `.gitignore`
    - `.playwright-cli/`
    - `output/playwright/*.png`
    - `output/playwright/verify-hwp/`
    - `output/playwright/invalid.hwp`
    - `.DS_Store`
  - 결과:
    - 회귀검증에 필요한 `output/playwright/inputs/*` 샘플은 유지
    - 반복 생성되는 스냅샷/스크린샷/로그 폴더는 커밋 범위에서 제외

## 2026-04-05

- 요청: 현재 프로젝트 상태 확인 및 Claude에서 이어서 작업하던 내용 추적
- 범위:
  - 저장소 상태
  - 작업 기록 문서
  - 최근 커밋 히스토리
  - 뷰어 진입점/최신 기능 반영 여부
- 확인:
  - `git status --short --branch` 기준 워크트리는 깨끗하고 현재 브랜치는 `main`
  - 작업 기록 문서는 `WORKLOG.md`, `BACKLOG.md`, `docs/rendering-status.md` 중심으로 유지되고 있음
  - 별도 `.claude*` 파일이나 Claude 전용 세션 로그 파일은 저장소 내에서 확인되지 않음
  - 최근 자동 에이전트 커밋은 Claude가 아니라 GitHub Copilot 세션 기준으로 남아 있음
    - `e2d7767`: 뷰어에 `🖨️ 인쇄` 버튼과 `Ctrl+P` 추가
    - `1c95264`: 인쇄 액션 명명과 상태 헬퍼 정리
    - `07c928c`: 위 작업이 `main`에 머지된 상태
  - 따라서 문서 로그상 마지막 큰 작업 묶음은 `2026-03-29` 렌더링/저장 UX 개선이고, 그 이후 실제 코드 변경은 인쇄 기능 추가로 이어진 상태로 해석하는 것이 타당함
- 현재 프로젝트 요약:
  - Chrome Extension Manifest V3 기반 `HWP Web Viewer & Editor`
  - 핵심 런타임은 `background.js`, `popup.js`, `pages/viewer.html`, `js/app.js`, `js/parser.worker.js`
  - 현재 뷰어 액션은 파일 열기, 편집 모드, 현재 저장, 다른 이름으로 저장, 인쇄까지 포함
- 다음 이어보기 후보:
  - `BACKLOG.md` 기준 최우선은 `HWP 개체/도형 앵커 복원`, `HWPX 도형/이미지 앵커 정밀화`, `공통 레이아웃 메트릭 보정`
  - 구조적으로는 `js/app.js` 와 `js/parser.worker.js` 중복 해소가 중기 핵심 과제로 남아 있음

- 요청: 공식 HWP 형식 PDF를 근거로 HWP 처리 정확도 보강
- 참고 문서:
  - `/Users/shinehandmac/Downloads/한글문서파일형식_5.0_revision1.3.pdf`
  - `/Users/shinehandmac/Downloads/한글문서파일형식_수식_revision1.3.pdf`
  - `/Users/shinehandmac/Downloads/한글문서파일형식_차트_revision1.2.pdf`
  - `/Users/shinehandmac/Downloads/한글문서파일형식_배포용문서_revision1.2.pdf`
  - `/Users/shinehandmac/Downloads/한글문서파일형식3.0_HWPML_revision1.2.pdf`
- 문서에서 실제 반영 대상으로 잡은 항목:
  - `표 68/69`: 개체 공통 속성의 `offset`, `width/height`, `inline`, 설명문
  - `표 105`: `HWPTAG_EQEDIT` 수식 스크립트/글자 크기/색상
  - `표 117~119`: `HWPTAG_SHAPE_COMPONENT_OLE` 기본 속성 및 BinData ID
  - 차트 문서 연계: `HWPTAG_CHART_DATA` 동반 여부로 차트 placeholder 식별
- 반영 내용:
  - `js/app.js`
    - HWP `BinData` 인덱스를 이미지 전용에서 전체 `BINxxxx.*` 메타까지 확장
    - 개체 공통 속성 파서를 추가해 HWP 이미지의 `inline`, `offsetX/Y`, 설명문(`alt`)을 실제 레코드 값으로 반영
    - `gso` subtree 에서 `HWPTAG_EQEDIT`, `HWPTAG_SHAPE_COMPONENT_OLE`, `HWPTAG_CHART_DATA`, `HWPTAG_VIDEO_DATA`를 함께 스캔하도록 확장
    - 수식은 스크립트를 보존한 `equation` 블록으로, OLE/차트/동영상은 식별 가능한 placeholder 블록으로 복원
    - 렌더러에 `equation`/`ole` 블록 스타일과 표 셀 내부 중첩 렌더 경로 추가
  - `js/parser.worker.js`
    - 메인 스레드와 동일한 HWP 개체 공통 속성 / 수식 / OLE 파싱 로직 반영
    - Worker 쪽 block text/weight 계산도 새 블록 타입을 이해하도록 보정
  - `css/viewer.css`
    - 수식/OLE placeholder 렌더 스타일 추가
- 검증:
  - `node --check js/app.js`
  - `node --check js/parser.worker.js`
  - Worker VM으로 대표 HWP 샘플 2종(`goyeopje.hwp`, `attachment-sale-notice.hwp`) 재파싱
    - 기존 샘플 구조 유지 확인
    - `attachment-sale-notice.hwp` 이미지 블록이 공식 개체 공통 속성 기준 `inline=true`로 해석되는 것 확인
  - synthetic byte로 `EQEDIT` / `OLE` helper 파서 동작 점검
  - `node scripts/verify_samples.mjs` 는 Playwright 세션 `verify-current` 연결 실패(`connect ENOENT verify-current`)로 완료하지 못함

- 추가 반영: 배포용 문서 복호화 기반 정리
  - 참고 문서:
    - `한글문서파일형식_배포용문서_revision1.2.pdf`
    - `한글문서파일형식_5.0_revision1.3.pdf` 의 `HWPTAG_DISTRIBUTE_DOC_DATA`
  - 반영 내용:
    - `js/app.js`, `js/parser.worker.js`
      - `HWPTAG_DISTRIBUTE_DOC_DATA`(256바이트) 해석 helper 추가
      - 문서에 적힌 MS Visual C `srand()/rand()` 규칙으로 256바이트 난수 패턴 재생성
      - XOR 후 해시 데이터에서 AES-128 키(앞 16바이트)와 옵션 플래그 추출
      - AES-128 ECB 복호화 루틴을 내장해 배포용 스트림 payload 를 해제할 수 있는 경로 추가
      - `DocInfo`/`Section` 파싱 전에 `raw`, `deflated`, `distributed`, `distributed+deflated`, `deflated+distributed` 시도를 순차적으로 평가하도록 확장
      - 일반 암호화 문서는 계속 차단하되, 배포용 문서는 별도 복호화 시도로 진행하도록 FileHeader 분기 수정
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - Node `crypto`로 만든 synthetic AES-128 ECB ciphertext 를 worker helper 로 복호화해 원문 일치 확인
    - 대표 일반 HWP 3종(`goyeopje.hwp`, `attachment-sale-notice.hwp`, `231229 ... 등록신청서 ... .hwp`) 재파싱 유지 확인
  - 메모:
    - 현재 보유 샘플에서는 실제 `배포용` 플래그가 선명한 문서를 아직 확보하지 못해, 실문서 end-to-end 검증은 synthetic/helper 단계까지 수행

- 추가 반영: `결석계.hwp` 테이블 헤더 렌더 보정
  - 배경:
    - `/Users/shinehandmac/Downloads/결석계.hwp` 검증 중 첫 행의 `결석계` 제목과 우측 결재란이 세로로 쌓여 보여 상단 비율이 크게 어긋남
    - 원인은 첫 표라는 이유만으로 `first-page-primary` 보정을 적용하던 렌더러와, `제목 + 결재란 중첩 표` 조합을 일반 셀 흐름으로 직렬 렌더하던 처리
  - 반영 내용:
    - `js/app.js`
      - `shouldUsePrimaryFormLayout()`을 추가해 `등록신청서` 계열 첫 표에만 첫 페이지 전용 휴리스틱을 적용하도록 제한
      - `getCompositeHeaderCellModel()` / `renderCompositeHeaderCell()`을 추가해 `제목 + 결재란` 헤더 셀을 중앙 제목 + 우측 결재란 레이아웃으로 별도 렌더
    - `css/viewer.css`
      - `.hwp-form-header-*` 스타일을 추가해 헤더 셀을 3열 그리드로 배치하고 결재란을 우측에 고정
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - Playwright headed 검증으로 `결석계.hwp` 재오픈
      - 첫 표의 `data-layout`가 `null`로 바뀌어 등록신청서 전용 보정이 빠진 것 확인
      - 첫 셀 `data-role`이 `form-header`로 렌더되고, 실제 화면에서 `결석계` 제목과 결재란이 상단 좌우로 분리 배치되는 것 확인

- 추가 반영: OWPML 확장자 수용 경로 정리
  - 참고 자료:
    - e-나라표준인증 `KS X 6101 개방형 워드프로세서 마크업 언어(OWPML) 문서 구조`
      - 최종개정확인일 `2024-10-30`
      - 적용범위에 `바이너리 HWP 문서 포맷을 100% 호환할 수 있는 문서 규격`, `문서의 호환성 평가 기준`, `메타데이터 추가 등 확장성` 명시
    - 한컴 다운로드센터 `HWP/OWPML 형식`
      - `OWPML은 HWP 2018부터 .owpml`, `하위 버전은 HWP 2010부터 .hwpx` 라고 안내
    - 한컴 WebHwpCtrl `지원되는 파일 형식`
      - `한글 표준 문서 .hwpx`, `개방형 표준 문서 .owpml` 표기 확인
  - 판단:
    - 현재 저장소의 `HWPX` 파서는 ZIP + `Contents/section*.xml` 기반 OWPML 패키지를 읽고 있으므로 `.owpml`은 신규 포맷 구현보다 확장자 alias 지원이 우선
  - 반영 내용:
    - `js/app.js`, `js/parser.worker.js`, `js/hwp-parser.js`
      - `.owpml`을 `HWPX/OWPML` 패키지 파서로 연결
    - `pages/viewer.html`, `popup.html`, `popup.js`, `js/viewer.js`
      - 파일 선택/드롭/오류 문구/저장 형식 목록에 `.owpml` 추가
    - `background.js`, `content_script.js`
      - 웹 링크 수집 및 컨텍스트 메뉴 패턴에 `.owpml` 추가
    - `js/app.js`, `js/exporter.js`
      - OWPML 저장을 HWPX 패키지 생성 경로와 공용화하고, 원본이 `.owpml`이면 덮어쓰기/다른 이름으로 저장 시 `.owpml` 확장자를 유지하도록 보정
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `node --check js/hwp-parser.js`
    - `node --check js/viewer.js`
    - `node --check js/exporter.js`
    - `node --check popup.js`
    - `node --check background.js`
    - `node --check content_script.js`
    - Playwright로 `output/playwright/inputs/incheon-2a.hwpx`를 `incheon-2a.owpml`로 복제해 업로드
      - 탭 제목이 `incheon-2a.owpml - ChromeHWP Viewer`로 표시되는 것 확인
      - 기존과 동일하게 `10페이지` 문서가 렌더되는 것 확인

- 추가 반영: HWP 문단/표 단위 변환 재보정
  - 참고 자료:
    - `한글문서파일형식_5.0_revision1.3.pdf`
      - `HWPUNIT = 1/7200 inch`
      - 문단 모양의 `왼쪽 여백`, `들여쓰기`, `문단 간격 위/아래`가 HWPUNIT 계열 값으로 정의됨
    - `한글문서파일형식3.0_HWPML_revision1.2.pdf`
      - `LineSpacing`, 여백, 들여쓰기 값이 `hwpunit` 또는 글자수로 정의됨
  - 배경:
    - 렌더러가 HWP 문단 여백/들여쓰기와 셀 padding에 임의 배율(`/60`, `/22`)을 써서 실제보다 크게 벌어지는 문제가 있었음
    - `결석계.hwp`와 일반 공고문 샘플 모두 표 내부 여백과 문단 들여쓰기가 과장되어 보였음
  - 반영 내용:
    - `js/app.js`
      - `hwpSignedPageUnitToPx()` 추가
      - 문단 `marginLeft`, `textIndent`, `spacingBefore`, `spacingAfter`를 `HWPUNIT -> px` 기준(`1/106`)으로 재변환
      - HWP/HWPX 표 셀 높이와 내용 높이 계산을 `hwpPageUnitToPx()` 기반으로 보정
      - 표 셀 padding을 HWPUNIT 기준으로 줄이고, padding 정보가 없을 때 기본값도 `6/8px`에서 `3/4px`로 축소
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - Playwright로 `결석계.hwp` 재오픈
      - 상단 표와 `결석 종류` 중첩 표가 이전보다 덜 부풀고 셀 내부 여백이 줄어든 것 확인
    - Playwright로 `incheon-2a.hwpx` 재오픈
      - 대표 문단의 들여쓰기/패딩 계산값이 이전보다 축소된 것 확인

- 추가 반영: 줄 간격 종류 해석 및 OWPML 메인 파서 경로 정리
  - 참고 자료:
    - `한글문서파일형식_5.0_revision1.3.pdf`
      - 문단 모양 `속성 1` 하위 `bit 0~1`이 구버전 줄 간격 종류
      - `속성 2` 하위 `bit 0~4`에 줄 간격 종류가 정의되며 값 `0=글자에 따라(%)`, `1=고정 값`, `2=여백만 지정`, `3=최소`
    - `한글문서파일형식3.0_HWPML_revision1.2.pdf`
      - `LineSpacingType`, `LineSpacing`이 독립 속성으로 정의되고 값은 `hwpunit` 또는 글자수 기반
  - 반영 내용:
    - `js/app.js`
      - `HwpParser._normalizeLineSpacingType()`, `HwpParser._hwpLineSpacingTypeFromCode()` 추가
      - HWP 문단 모양 파서가 `lineSpacingType`을 함께 복원하도록 수정
      - HWPX/OWPML `header.xml`의 `lineSpacing type="..."` 값을 `paraProps`에 보존
      - `resolveParagraphLineHeight()`를 추가해 `percent/fixed/space-only/minimum`별로 CSS `line-height`를 다르게 계산
      - `parseWithWorker()`에서 `.owpml`도 `.hwpx`와 동일하게 메인 파서 경로를 사용하도록 수정
    - `js/parser.worker.js`
      - HWP 문단 모양 파서와 문단 블록 모델에 `lineSpacingType` 반영
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - Worker VM으로 `/Users/shinehandmac/Downloads/결석계.hwp` 파싱
      - 문단 `lineSpacingType`가 `percent`로 복원되는 것 확인
    - Playwright로 `incheon-2a.owpml` 재오픈
      - `.owpml`이 메인 파서 경로로 열리고 `10페이지` 문서가 유지되는 것 확인

- 추가 반영: 글자 모양 `장평/자간/상대크기/글자위치` 및 표 `cellSpacing` 반영
  - 참고 자료:
    - `한글문서파일형식_5.0_revision1.3.pdf`
      - 글자 모양 레코드에서 언어별 `장평`, `자간`, `상대 크기`, `글자 위치`가 각각 `UINT8/INT8` 배열로 저장됨
    - `한글문서파일형식3.0_HWPML_revision1.2.pdf`
      - `RATIO`, `CHARSPACING`, `RELSIZE`, `CHAROFFSET` 엘리먼트 정의
      - `CellSpacing`이 HTML `cellspacing`과 같은 의미로 정의됨
  - 반영 내용:
    - `js/app.js`
      - HWPX `charPr`에서 `ratio`, `spacing`, `relSz`, `offset`를 읽어 런 스타일로 보존
      - HWP 글자 모양 레코드에서 언어별 `장평`, `자간`, `상대 크기`, `글자 위치`를 복원
      - 런 병합 비교(`_hwpxSameRunStyle`)에 새 스타일 필드를 포함
      - 렌더러가 `letter-spacing`, 상대 글자 크기, 기준선 오프셋, 제한적 `scaleX/fontStretch`를 적용
      - 표 `cellSpacing`이 있을 때 `border-collapse: separate`와 `border-spacing`으로 반영
    - `js/parser.worker.js`
      - HWP 글자 모양 레코드에 `scaleX`, `letterSpacing`, `relSize`, `offsetY` 추가
    - `js/hwp-parser.js`, `js/viewer.js`
      - 모듈형 뷰어 경로도 동일한 글자 모양 필드를 읽고 렌더하도록 동기화
    - 회귀 샘플:
      - `/Users/shinehandmac/Downloads/결석계.hwp`를 `output/playwright/inputs/gyeolseokgye.hwp`로 복사해 저장소 내 검증 샘플로 추가
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `node --check js/hwp-parser.js`
    - `node --check js/viewer.js`
    - Worker VM으로 `/Users/shinehandmac/Downloads/결석계.hwp` 파싱
      - 표 내부 문단에서 자간 `-19~-3`, 일부 문장 `장평 97` 값이 실제로 복원되는 것 확인
    - Playwright로 `http://127.0.0.1:4174/pages/viewer.html`에서 `output/playwright/inputs/gyeolseokgye.hwp` 업로드
      - 제목이 `gyeolseokgye.hwp - ChromeHWP Viewer`로 표시되는 것 확인
      - `.hwp-page` 1장 렌더와 스타일 적용 span 23개 확인
      - 검증 스크린샷: `.playwright-cli/page-2026-04-05T14-12-12-640Z.png`

- 추가 반영: 개체 앵커 배치, `textFlow`, 상대 크기 기반 렌더 보강
  - 참고 자료:
    - `한글문서파일형식_5.0_revision1.3.pdf`
      - `표 69 개체 공통 속성`: `VertRelTo`, `HorzRelTo`, `FlowWithText`, `AllowOverlap`, `TextWrap`, `TextFlow`, `width/height` 기준 비트 정의
      - `표 68 개체 공통 속성`: `vertOffset`, `horzOffset`, `width`, `height`, 바깥 여백이 개체 공통 속성에 포함됨
    - `한글문서파일형식3.0_HWPML_revision1.2.pdf`
      - `표 104 SIZE`: `WidthRelTo/HeightRelTo`가 `Paper/Page/Column/Para/Absolute` 기준을 가짐
      - `표 105 POSITION`: `TreatAsChar=false`일 때 `VertRelTo/HorzRelTo`, 오프셋, `FlowWithText`, `AllowOverlap`이 적용됨
  - 배경:
    - 기존 렌더러는 HWP/HWPX 개체 메타데이터를 파싱해도 실제 화면에서는 대부분 문단 안 흐름으로만 배치했고, `page/paper` 기준 개체나 `behind/in-front`, `textFlow`를 실사용하지 않았음
    - HWPX 비인라인 그림/표가 작은 경우 문단 내 인라인처럼 섞이거나, 표 오프셋이 과소 반영되는 문제가 있었음
  - 반영 내용:
    - `js/app.js`
      - HWPX `pic/tbl`와 HWP 개체 공통 속성에서 읽은 `vertRelTo`, `horzRelTo`, `textWrap`, `textFlow`, `widthRelTo`, `heightRelTo`, `allowOverlap`, `flowWithText`를 공통 블록 메타로 유지
      - 비인라인 HWPX 그림을 더 이상 크기 휴리스틱만으로 인라인 처리하지 않도록 수정
      - 개체 배치 전용 helper를 추가해:
        - HWP/HWPX별 오프셋/바깥 여백 단위를 따로 변환
        - `textFlow=left-only/right-only`에 따라 float 방향을 보정
        - `widthRelTo/heightRelTo`가 `absolute`가 아닐 때 페이지/본문/문단 폭 기준 상대 크기를 계산
        - `page/paper` 기준 절대배치 개체는 실제 `.hwp-page` 앵커로 옮긴 뒤 좌표를 계산
      - 표 셀 내부 절대배치를 위해 `.hwp-table-cell-content`를 기준 컨테이너로 사용
    - `css/viewer.css`
      - `.hwp-table-cell-content { position: relative; }` 추가
    - HTML 내보내기용 인라인 스타일에도 동일한 셀 기준 컨테이너 규칙 반영
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - `node --check js/hwp-parser.js`
    - `node --check js/viewer.js`
    - Playwright로 `incheon-2a.hwpx` 재오픈
      - 비인라인 LH 로고가 다시 본문 제목과 겹치지 않는 위치로 렌더되는 것 확인
      - 첫 이미지 배치 transform이 `translate(50px, 0px)` 수준으로 적용되고, 표 오프셋도 `392 -> 5px`, `952/2033 -> 13px/27px` 등으로 복원되는 것 확인
      - 검증 스크린샷: `.playwright-cli/page-2026-04-05T14-47-37-877Z.png`
    - Playwright로 `attachment-sale-notice.hwp` 재오픈
      - `15페이지`, 이미지 3개, 상단 배너/본문 텍스트 유지 확인
      - 검증 스크린샷: `.playwright-cli/page-2026-04-05T14-48-31-916Z.png`
    - Playwright DOM 주입 테스트
      - `horzRelTo=page`, `vertRelTo=page`, `textWrap=behind-text` 가상 블록이 `position:absolute`로 계산되고 부모가 `.hwp-page`로 옮겨지는 것 확인
    - 참고:
      - `node scripts/verify_samples.mjs`는 Playwright CLI의 `verify-current` 세션 연결 오류(`connect ENOENT verify-current`)로 이번에도 자동 회귀를 끝까지 수행하지 못함

- 추가 반영: HWP 양식표 열폭 계산과 세로 라벨 렌더 보정
  - 배경:
    - `결석계.hwp`에서 첫 표가 여전히 어긋나 보였고, 원인을 확인해 보니 `colSpan` 셀 폭을 균등 분배하는 기존 열폭 계산이 실제 열 비율을 오염시키고 있었음
    - 특히 첫 줄/중간 줄의 병합 셀이 1열 폭을 과도하게 키우거나 줄이는 바람에 `인 적 사 항`, `결 석 일 수`, `결 석 종 류` 라벨이 한 글자씩 떨어지거나 지나치게 벌어지는 문제가 있었음
  - 반영 내용:
    - `js/app.js`, `js/parser.worker.js`
      - 테이블 열폭 계산을 `단일 칸(colSpan=1)` 우선 방식으로 바꾸고, 병합 셀은 비어 있는 열을 채우거나 부족분만 보정하도록 수정
      - `결 석 종 류`처럼 단일 음절이 공백으로 나열된 라벨 셀은 2글자씩 줄바꿈(`결 석\n종 류`)으로 렌더하도록 보정
    - `js/app.js`
      - `stacked-label` 역할을 추가하고 해당 셀은 `vertical-align: middle`, `line-height: 1.06`, `white-space: pre-line`로 렌더
  - 검증:
    - `node --check js/app.js`
    - `node --check js/parser.worker.js`
    - Playwright로 `gyeolseokgye.hwp`를 cache-busting URL에서 재오픈
      - 첫 표 열폭이 `[73, 67, 270, 66, 222]`로 재계산되는 것 확인
      - 첫 열 라벨 셀이 `stacked-label` 역할로 렌더되고 행 높이가 `243px -> 142px` 수준으로 줄어든 것 확인
      - 검증 스크린샷: `.playwright-cli/page-2026-04-05T15-00-32-735Z.png`

- 상태 정리:
  - 현재까지 누적 반영 사항과 남은 큰 작업을 빠르게 볼 수 있도록 `STATUS.md`를 추가
  - 커밋 전에 최근 핵심 로직(개체 배치, 표 열폭 계산, 세로 라벨 보정)에 한글 주석 보강
  - 공식 형식 PDF 5종을 `docs/hwp-spec/`로 복사하고, 테스트 샘플 목록을 `docs/hwp-assets.md`에 정리
  - 추가 검증용 양식 샘플 `output/playwright/inputs/goyeopje-full-2024.hwp` 추가

## 2026-04-14

- 공식 PDF 구조 검토
  - 대상:
    - `/Users/shinehandmac/Downloads/한글문서파일형식3.0_HWPML_revision1.2.pdf`
    - `/Users/shinehandmac/Downloads/한글문서파일형식_배포용문서_revision1.2.pdf`
  - 핵심 확인 사항:
    - HWPML 루트는 `Version`, `SubVersion`, `Style2` 속성을 가지며 `HEAD`, `BODY`, `TAIL` 순서의 전체 구조를 따른다.
    - `HEAD/MAPPINGTABLE` 아래의 참조 테이블은 렌더 fidelity의 핵심이며 `BINDATALIST`, `FACENAMELIST`, `BORDERFILLLIST`, `CHARSHAPELIST`, `TABDEFLIST`, `NUMBERINGLIST`, `BULLETLIST`, `PARASHAPELIST`, `STYLELIST`, `MEMOSHAPELIST`를 반드시 보존해야 한다.
    - `BINITEM`은 `Type="Link"`일 때 `APath`, `RPath`가 필수이고, `Type="Embedding"`일 때 `BinData`, `Format`이 필수이며, `Storage`는 OLE 저장 경로다.
    - `CHARSHAPE`, `PARASHAPE`, `STYLE`는 모두 `Id` 참조 기반이라서 숫자 인덱스 재매핑이나 누락이 곧바로 스타일 붕괴로 이어진다.
    - `TAIL/XMLTEMPLATE`는 `SCHEMA`와 `INSTANCE` 문자열을 담으므로, XML 연계/재내보내기에서 버리면 round-trip 정보가 깨진다.
    - 배포용 문서는 `ViewText/Section*`, `Scripts/*`, `DocHistory/*` 스트림을 암호화하고, `HWPTAG_DISTRIBUTE_DOC_DATA` 256바이트 레코드로 seed, SHA1 기반 해시, 옵션 플래그를 유도한다.
  - 코드베이스 영향:
    - 현재 파서/렌더러는 스타일 목록과 바이너리 참조를 유지하는 쪽은 맞지만, `XMLTEMPLATE`와 배포용 문서 복호화 경로는 별도 보강 여지가 크다.
    - 다음 구현 우선순위는 `MAPPINGTABLE` 참조 보존, `BINITEM` 조건부 필수 속성 처리, 배포용 문서 스트림 복호화 지원 여부 판단이다.

- 프로젝트 구조 파악
  - 목적:
    - 크롬 확장에서 `.hwp`, `.hwpx`, `.owpml` 문서를 열람하고, 제한적인 편집과 저장/내보내기를 제공하는 구조임
  - 현재 실제 런타임 경로:
    - 확장 진입: `manifest.json`
    - 백그라운드/브리지: `background.js`
    - 업로드 팝업: `popup.html`, `popup.js`
    - 링크 수집: `content_script.js`
    - 메인 뷰어: `pages/viewer.html`
    - 핵심 로직: `js/hwp-parser.js`, `js/hwp-renderer.js`, `js/app.js`
    - HWP worker 파싱: `js/parser.worker.js`
  - 실제 동작 흐름:
    - 팝업 업로드 또는 웹 링크/컨텍스트 메뉴 진입
    - `background.js`가 세션 저장소/최근 파일 목록을 관리하고 `viewer.html`을 열어 줌
    - `js/app.js`의 `processBuffer()`가 문서를 읽고 `parseWithWorker()`로 파싱 시작
    - `.hwp`는 기본적으로 `js/parser.worker.js`에서 파싱하고, `.hwpx`/`.owpml`은 메인 스레드 `HwpParser` 경로를 사용
    - 파싱 결과는 `js/hwp-renderer.js`를 통해 DOM 페이지로 렌더됨
  - 편집/저장 모델:
    - 편집기는 Quill 기반이며 `js/app.js` 내부 `HwpEditor` 래퍼를 사용
    - 현재 덮어쓰기는 `hwpx`/`owpml`만 지원하고, `.hwp` 바이너리 저장은 미지원 상태
    - HTML/PDF/HWPX/OWPML 내보내기 로직도 `js/app.js` 내부 `HwpExporter`에 포함되어 있음
  - 보조 경로:
    - `sidepanel.html`, `sidepanel.js`는 최근 파일/현재 페이지 HWP 링크 목록 확인용 보조 UI
    - `js/editor.js`, `js/exporter.js`, `js/viewer.js`는 module 스타일 분리본이지만 현재 `pages/viewer.html`에서 로드되지 않음
    - 현재 기준으로는 미사용 또는 이전 구조 잔재일 가능성이 높음
  - 문서/검증 자산:
    - 현재 상태 요약: `STATUS.md`
    - 남은 작업 목록: `BACKLOG.md`
    - 렌더링 지원 범위: `docs/rendering-status.md`
    - 최소 스모크 검증: `scripts/verify_samples.mjs`
    - 형식 레퍼런스: `docs/hwp-spec/`
  - 구조 메모:
    - 저장소에 `package.json`이 없어서 빌드 단계 없는 plain JS 크롬 확장 프로젝트로 보임
    - HWP 파서 로직은 `js/hwp-parser.js`와 `js/parser.worker.js` 양쪽에 상당 부분 동기화돼 있어 drift 위험이 남아 있음
- 확인:
  - `git status --short`
    - 작업 시작 시 기준으로 워킹트리는 비어 있었음
  - 문법 확인:
    - `node --check background.js`
    - `node --check popup.js`
    - `node --check content_script.js`
    - `node --check js/app.js`
    - `node --check js/hwp-parser.js`
    - `node --check js/hwp-renderer.js`
    - `node --check js/parser.worker.js`
    - 모두 통과
  - 미실행:
    - `node scripts/verify_samples.mjs`는 이번 세션에서 실행하지 않았음
    - 뷰어 서버(`http://127.0.0.1:4174`)와 Playwright 세션 준비가 필요한 스모크 검증이라, 구조 파악 범위에서는 코드/문서 확인까지만 진행

- 추가 반영: 공식 형식 문서 기반 fidelity 1차 정리 및 구현 시작
  - 사전 회의:
    - 다운로드 폴더의 공식 PDF 5종과 샘플 문서를 기준으로 역할별 분석을 진행했고, 회의 결과를 `docs/fidelity-meeting-2026-04-14.md`에 정리
    - 공통 결론:
      - `구역/페이지`, `문단/글자 모양`, `표`, `그림·OLE·배치 개체`가 원본 fidelity의 핵심
      - 현재 코드는 일부 구간에서 readability 중심 휴리스틱을 사용하고 있어 원본 구조 보존과 충돌
      - Playwright 회귀 스크립트는 `verify-current` 세션 여는 방식이 잘못되어 자동 검증이 불안정
  - 반영 내용:
    - `js/hwp-parser.js`
      - HWPX `charPr`에서 `shadeColor`, `underlineColor`, `underlineShape`, `strikeout`, `shadow`, `outline` 정보를 보존하도록 확장
      - HWP `charShape`에서 `strike`, `superscript`, `subscript` 비트를 보존하도록 확장
      - HWPX 표를 문단 흐름으로 바꾸던 `_hwpxShouldFlattenTable`, `_hwpxShouldLinearizeTable` 적용을 제거해 원본 표 구조를 기본적으로 유지하도록 변경
      - `_run()` 기본값에 새 텍스트 시각 속성 필드를 추가
    - `js/parser.worker.js`
      - HWP worker 경로도 `strike`, `superscript`, `subscript`와 새 런 기본 필드를 동일하게 반영
    - `js/hwp-renderer.js`
      - `underline + strike-through` 동시 표현, decoration color/style, `shadeColor`, superscript/subscript, shadow 렌더를 추가
    - `scripts/verify_samples.mjs`
      - Playwright를 `PLAYWRIGHT_CLI_SESSION` 환경변수 대신 `-s=verify-current`로 호출하도록 수정
      - 최신 CLI의 인라인 YAML snapshot 출력도 읽을 수 있도록 보강
    - `scripts/playwright_smoke.sh`
      - 동일하게 `-s=verify-current` 직접 전달 방식으로 수정
  - 검증:
    - 문법:
      - `node --check js/hwp-parser.js`
      - `node --check js/hwp-renderer.js`
      - `node --check js/parser.worker.js`
      - `node --check scripts/verify_samples.mjs`
      - `bash -n scripts/playwright_smoke.sh`
    - 자동 회귀:
      - `node scripts/verify_samples.mjs` 통과
      - `bash scripts/playwright_smoke.sh` 통과
    - 추가 확인:
      - 다운로드 샘플과 저장소 `output/playwright/inputs/` 샘플이 SHA-256 기준 동일 파일임을 확인

## 2026-04-14

- 요청: 공식 PDF `한글문서파일형식_5.0_revision1.3.pdf` 기준으로 HWP 원본 충실도에 중요한 섹션을 분석하고, 현재 프로젝트의 누락/위험 항목을 기획 관점에서 정리
- 분석 범위:
  - `4.2.6 글자 모양`
  - `4.2.10 문단 모양`
  - `4.3.9.1 표 개체`
  - `4.3.9.2 그리기 개체/개체 요소`
  - `4.3.9.4 그림 개체`
  - `4.3.9.5 OLE 개체`
  - `4.3.10.1 구역 정의 / 용지 설정`
  - `4.3.10.2 단 정의`
- 핵심 결론:
  - 현재 프로젝트는 `page width/height/margins`, `align`, `charShape`, `paraShape`, `table basic geometry`, `object wrap/position`의 일부만 반영하고 있음
  - 원문 fidelity에 특히 위험한 항목은 `page border/background`, `multi-column section`, `paragraph border inset`, `char shape shadow/strike/border fill`, `picture crop/effects`, `OLE type/extent`, `table valid-zone/title-repeat`, `object rotation/group/rendering matrix`
  - 따라서 첫 우선순위는 “페이지/구역 정의를 실제 레이아웃 엔진에 연결”하고, 그 다음 “표/그림/OLE의 보이는 속성”을 보완하는 것이 적절함
- 메모:
  - 이 결과는 planning team member 1의 1차 정리이며, 이후 팀 회의용 의제 초안으로 사용 가능

- 추가 반영: HWP 섹션별 페이지 생성 1차 적용
  - 배경:
    - 이전 턴에서 fidelity 우선순위를 `구역/페이지 -> 표/개체 -> 수식/차트`로 정리했고, 이번 턴은 그 중 `HWP 섹션(page/section) 경계 보존`을 먼저 진행
    - 중간에 `pageStyle.height/margins`를 pagination budget에 직접 연결하는 실험도 했지만, 다운로드 샘플에서 과분할(예: HWPX 5페이지 -> 9페이지)이 즉시 발생해 이번 반영에서는 제외
  - 반영 내용:
    - `js/hwp-parser.js`
      - HWP `BodyText` 파싱 결과에 `sections` 배열을 추가해 섹션별 `paragraphs/headerBlocks/footerBlocks/pageStyle`를 유지
      - `_parseHwp5()`에서 전체 문서를 한 번에 paginate하지 않고, 섹션 단위로 페이지를 생성한 뒤 각 페이지에 해당 섹션의 `pageStyle`과 `sectionIndex/sectionPageIndex`를 부여
      - 공통 빈 단락 정리 로직을 `_cleanBlocksForPagination()` / `_paginateSectionBlocks()`로 정리
    - `js/parser.worker.js`
      - worker 경로도 동일하게 `sections`를 유지하고, 섹션별 페이지 생성으로 동기화
      - worker 결과 페이지에도 `pageStyle`, `sectionIndex`, `sectionPageIndex`를 부여
    - `scripts/verify_samples.mjs`
      - 인라인 YAML snapshot 외에 bare YAML 형태도 읽도록 보강
      - snapshot 경로를 찾지 못할 때 CLI 출력 일부를 같이 노출하도록 변경해 진단성을 높임
  - 검증 메모:
    - `node --check js/hwp-parser.js`
    - `node --check js/parser.worker.js`
    - `node --check scripts/verify_samples.mjs`
    - `node scripts/verify_samples.mjs` 통과
    - `bash scripts/playwright_smoke.sh` 통과
    - 주의:
      - `verify_samples.mjs`와 `playwright_smoke.sh`는 기본적으로 같은 Playwright 세션명(`verify-current`)을 사용하므로 병렬 실행하면 충돌함
      - 실제 검증은 순차 실행 기준으로 확인
  - 다음 시작 지점:
    - HWP `header/footer first/odd/even` 규칙
    - HWP `쪽번호 시작 번호/숨김` 규칙
    - `pageStyle.height/margins` 기반 pagination은 과분할 문제를 재검증한 뒤 재도입 여부 판단
    - 구체 우선순위는 `BACKLOG.md`의 `Next Session Start` 섹션 참조

---

### 문서 정확성 — 영향도 높은 항목 4차 구현

- 수행 범위: `js/hwp-parser.js`, `js/parser.worker.js`, `js/hwp-renderer.js`, `css/viewer.css`

#### 8. HWP GSO 텍스트박스 파싱

- 문제: GSO 컨트롤이 그림/수식/OLE 서브레코드를 갖지 않는 경우(텍스트박스, 벡터 도형 등) 블록이 `null`로 반환돼 해당 개체가 완전히 사라짐.
- 수정 내용:
  - `_parseGsoControl` (hwp-parser.js) / `parseGsoControl` (parser.worker.js):
    - 스캔 루프에서 `LIST_HEADER` (tag 72) 를 감지하면 `hasListHeader = true` 로 전환.
    - 이후 `PARA_HEADER`(66) / `PARA_TEXT`(67) / `PARA_CHAR_SHAPE`(68) / `PARA_LINE_SEG`(69) 레코드를 수집해 `textBoxParas` 배열에 단락 블록으로 조립.
    - `equationBody / pictureBody / oleBody`가 없고 `hasListHeader && textBoxParas.length`이면 `_parseHwpTextBoxBlock` 호출.
  - `_parseHwpTextBoxBlock` (hwp-parser.js) / `parseHwpTextBoxBlock` (parser.worker.js) 신규 추가:
    - `type: 'textbox'`를 갖는 블록 생성, `paragraphs` 배열과 `width/height` 포함.
    - `_withObjectLayout` / `withObjectLayout`으로 앵커 정보 적용.
  - `appendTextBoxBlock` (hwp-renderer.js) 신규 추가:
    - 래퍼 `div.hwp-textbox-block` + 내부 `div.hwp-textbox-content` 생성.
    - 폭·높이 적용 후 `paragraphs` 각각을 `appendBlockByType`으로 렌더링.
    - `registerPlacedBlock`으로 float/절대 배치 사후 처리에 참여.
  - `appendBlockByType` (hwp-renderer.js): `type === 'textbox'` 분기 추가.

#### 9. HWP GSO 벡터 도형 플레이스홀더

- 문제: 텍스트박스도 아니고 그림/수식/OLE도 없는 GSO (선·사각형·타원 등 순수 벡터 도형)도 `null`로 드롭됨.
- 수정 내용:
  - `_parseGsoControl` / `parseGsoControl`: 위의 모든 경우가 해당 없고 `objectInfo.width > 0`이면 `_parseHwpShapePlaceholder` 호출.
  - `_parseHwpShapePlaceholder` (hwp-parser.js) / `parseHwpShapePlaceholder` (parser.worker.js) 신규 추가:
    - `type: 'shape'`를 갖는 최소 블록 생성, 크기 정보 유지.
  - `appendShapePlaceholder` (hwp-renderer.js) 신규 추가:
    - `div.hwp-shape-block` + `div.hwp-shape` 생성, 폭·높이 적용.
    - `registerPlacedBlock`으로 앵커 배치 사후 처리에 참여.
  - `appendBlockByType`: `type === 'shape'` 분기 추가.
  - `css/viewer.css`: `.hwp-textbox-block`, `.hwp-textbox-content`, `.hwp-shape-block`, `.hwp-shape` CSS 추가.
  - 표 셀 내부 인라인 렌더 경로에도 `textbox`/`shape` 분기 추가.

#### 10. HWP secd PAGE_DEF flags — hideFirstHeader/Footer 파싱

- 문제: `_parseHwpSecDef` (tag 73 PAGE_DEF 레코드)가 offset 36의 flags 필드를 읽지 않아 "첫 페이지에서 헤더/푸터 숨김" 설정이 무시됨.
- 수정 내용:
  - `_parseHwpSecDef` (hwp-parser.js) / `parseHwpSecDef` (parser.worker.js):
    - `body.length >= 40`이면 `flags = u32(body, 36)` 추출.
    - bit 8 → `hideFirstHeader`, bit 9 → `hideFirstFooter`, bit 10 → `hideFirstPageNum`.
    - 결과를 `visibility: { hideFirstHeader, hideFirstFooter, hideFirstPageNum }` 으로 `sectionMeta` 에 포함.
  - `_resolveHwpHeaderFooterBlocks` (hwp-parser.js): `hideFirst = false` 파라미터 추가. `hideFirst && pageIndex === 0`이면 빈 배열 반환.
  - `_parseHwp5` 섹션 루프 및 단일 섹션 경로:
    - `section.pageStyle?.visibility` / `parsedBody.pageStyle?.visibility`에서 hideFirstHeader/Footer/PageNum을 꺼내 `_resolveHwpHeaderFooterBlocks`와 자동 쪽번호 블록 생성에 전달.

- 검증:
  - `node --check js/hwp-parser.js` 통과
  - `node --check js/parser.worker.js` 통과
  - `node --check js/hwp-renderer.js` 통과

---

### 문서 정확성 — 영향도 높은 항목 5차 구현

- 수행 범위: `js/hwp-parser.js`, `js/parser.worker.js`, `index.html`, `favicon.ico`

#### 11. HWPX 테이블 셀 `inMargin` fallback

- 문제: HWPX 표에서 셀의 `hasMargin="0"` 속성이 설정된 경우 셀 고유 `cellMargin`이 없고 테이블 레벨 `<hp:inMargin>`을 사용해야 하는데, 기존 코드는 항상 `cellMargin`만 읽어 zero padding이 됨.
- 수정: `_hwpxTableBlocks`에서 `tblInMarginEl = _hwpxFirstChild(tblEl, 'inMargin')` 추출 후, `hasOwnMargin = tcEl.getAttribute('hasMargin') === '1'`이 false이면 `tblInMarginEl`을 fallback으로 사용.

#### 12. HWP `PAGE_NUM_PARA` (tag-76) `startPageNum` 추출

- 문제: HWP secd sub-record tag-76 (PAGE_NUM_PARA)이 4+2바이트만 읽고, 일부 HWP 버전에서 offset 6에 존재하는 WORD startPageNum을 읽지 않았음.
- 수정:
  - `_parseHwpPageNumMeta` (hwp-parser.js) / `parseHwpPageNumMeta` (parser.worker.js): body.length >= 8이면 offset 6의 u16을 `startPageNum`으로 읽음. 0이면 1로 기본값.
  - secd scan 결과 병합 시 `pageNumMeta.startPageNum > 1`이면 `secDef.startPageNum`으로 전달.
  - HWP 다중 섹션 루프: `section.pageStyle.startPageNum`이 양수이면 `pageNumber = sectionBasePageNum + sectionPageIndex`, 없으면 기존 누적 방식 유지.
  - HWP 단일 섹션 경로: `parsedBody.pageStyle.startPageNum`으로 동일 처리.

#### 13. 파비콘 `favicon.ico` / `index.html` 아이콘 링크 추가

- 문제: `http://127.0.0.1:4174/favicon.ico` 요청 시 404가 반복되어 개발·검증 콘솔이 오염됨. `index.html`에 favicon link tag가 없었음.
- 수정:
  - `favicon.ico` 파일을 루트에 추가 (icon32.png 복사본).
  - `index.html`에 `<link rel="icon">`, `<link rel="apple-touch-icon">`, `<link rel="shortcut icon">` 추가.

- 검증:
  - `node --check js/hwp-parser.js` 통과
  - `node --check js/parser.worker.js` 통과
  - `node --check js/hwp-renderer.js` 통과
