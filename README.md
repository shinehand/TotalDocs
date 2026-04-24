# TotalDocs

> **⚡ 설치 없이 브라우저에서 바로 사용하기**
>
> 👉 **[https://shinehand.github.io/TotalDocs/viewer.html](https://shinehand.github.io/TotalDocs/viewer.html)**
>
> 링크를 클릭하면 **아무것도 설치하지 않아도** HWP 뷰어가 바로 열립니다.
> `.hwp` / `.hwpx` / `.owpml` 파일을 화면에 끌어다 놓거나 "파일 선택" 버튼으로 올리면 즉시 렌더링됩니다.
> Chrome · Firefox · Safari · Edge 모두 지원합니다.

---

`HWP`, `HWPX`, `OWPML` 문서를 어떤 브라우저에서든 설치 없이 열고, 가능한 한 실제 한글 프로그램과 비슷한 화면과 동선으로 확인·편집·저장하려는 프로젝트이옵니다.

현재 프로젝트는 `웹 뷰어(GitHub Pages) + 크롬 확장 프로그램 셸 + TotalDocs 자체 JS 파서/DOM 렌더러 + 다운로드 원본 기준 QA` 구조로 움직이고 있사옵니다.

## 현재 상태

- `HWP` / `HWPX` 는 분리된 `HwpParser` 모듈과 `js/hwp-renderer.js` DOM 렌더러를 공식 경로로 사용하옵니다.
- 외부 WASM 엔진 실험 경로는 2026-04-22 기준으로 비활성화하고 번들에서 제거했사옵니다.
- 검색, 줌, 상태바, 썸네일 탐색이 TotalDocs 자체 렌더링 경로에 연결되어 있사옵니다.
- 사이드바에는 현재 쪽 집계와 집중 확인 쪽을 보여 주는 `레이아웃 감사 패널` 이 붙어 있사옵니다.
- QA는 저장소 fixture보다 `/Users/shinehandmac/Downloads` 의 실제 원본 `HWP/HWPX` 파일을 기준으로 돌고 있사옵니다.
- 검증 스크립트는 다운로드 폴더의 지원 문서를 자동 발견하므로, 새 파일이 들어와도 QA 범위에 바로 편입되옵니다.
- 구조 진단 데이터도 함께 수집하여 `표`, `수식`, `차트`, `개체`, `구역`, `페이지` 단위로 검증할 수 있사옵니다.
- HWPX 글자모양의 `shadow` 서식은 `type`, `color`, `offsetX`, `offsetY`까지 읽고, `DROP`과 `CONTINUOUS`를 구분하여 DOM 텍스트 그림자로 반영하옵니다.

아직 남은 큰 과제는 `페이지 내부 레이아웃 충실도`이옵니다.

최신 다운로드 샘플 검증 기준, 기준 문서 5개는 모두 한컴 Viewer 기준 페이지 수와 일치하옵니다.

- `goyeopje.hwp`: 한컴 `2쪽`, TotalDocs `2쪽`
- `goyeopje-full-2024.hwp`: 한컴 `11쪽`, TotalDocs `11쪽`
- `gyeolseokgye.hwp`: 한컴 `1쪽`, TotalDocs `1쪽`
- `attachment-sale-notice.hwp`: 한컴 `4쪽`, TotalDocs `4쪽`
- `incheon-2a.hwpx`: 한컴 `18쪽`, TotalDocs `18쪽`

최근 한컴 Viewer 화면 비교 기준 주요 수치입니다.

- `goyeopje.hwp`: visiblePageDiff `10.856`, titleDiff `10.350`
- `goyeopje-full-2024.hwp`: visiblePageDiff `18.053`, titleDiff `20.679`
- `gyeolseokgye.hwp`: visiblePageDiff `15.668`, titleDiff `12.574`
- `attachment-sale-notice.hwp`: visiblePageDiff `30.773`, titleDiff `32.788`
- `incheon-2a.hwpx`: visiblePageDiff `29.208`, titleDiff `26.707`
- 최신 비교 리포트: [hancom-page-compare-report.json](output/hancom-oracle/hancom-page-compare-report.json)

최근 반영했거나 검증 중인 충실도 항목은 아래와 같사옵니다.

- `HY헤드라인M` 계열은 한컴 Viewer 비교에서 가장 나은 결과를 보인 `dotum-Regular.ttf` 대체로 정식 매핑했사옵니다.
- HWPX 제목 글자 그림자는 `charPr/shadow` 의 `type`, `color`, `offsetX`, `offsetY`를 반영하고, `CONTINUOUS`는 원본과 오프셋 사이를 채운 연속 그림자로 렌더링하옵니다.
- 표 셀 안 비인라인 그림의 `horzRelTo="COLUMN"` 앵커는 셀 패딩이 아닌 셀 경계 기준으로 보정했사옵니다.
- `incheon-2a.hwpx` 제목 LH 로고는 `x=164.2px` 오배치에서 `x=114.2px`로 이동하여 한컴 Viewer 위치에 더 가까워졌사옵니다.
- HWPX 문단의 제어개체 오프셋은 스트림 순서대로 8 UTF-16 단위로 누적하여, 로고 뒤 제목처럼 `charPrIDRef` 경계가 한 글자 밀리는 문제를 바로잡았사옵니다.
- HWP DocInfo 참조를 0-base로 정리하여 `CHAR_SHAPE`, `PARA_SHAPE`, `TAB_DEF`, `NUMBERING`, `BULLET`, `STYLE` 참조가 한컴 구조와 맞도록 복구했사옵니다.
- HWP `BorderFill` 레코드의 6바이트 border 구조와 gradation fill 구조를 반영하여 표 테두리/배경 색상 오독을 바로잡았사옵니다.
- HWP 문단 안 `gso` 그림 컨트롤은 표 셀 안에서 흐름을 차지하지 않는 앵커 이미지로 렌더링하여 로고/제목 행이 과도하게 늘어나는 문제를 줄였사옵니다.
- HWP에서 `layoutHeightPx=0`인 제어 전용 빈 문단은 화면 흐름에서 제외하고, HWP 표 wrapper와 inline image margin을 원본 흐름에 가깝게 줄여 `attachment-sale-notice.hwp` 1쪽 헤더/제목 시작 위치를 한컴 Viewer 쪽에 더 가깝게 보정했사옵니다.
- TAC 표처럼 저장된 object 높이가 셀 내용보다 작을 때도 내용 우선 높이를 유지해야 한다는 검증 기준을 세웠사옵니다.
- `incheon-2a.hwpx` 2페이지 겹침은 HWPX page style 기반 페이지 예산과 대형 셀 continuation 보정 후 현재 재현되지 않사옵니다.
- 같은 행이 여러 페이지로 쪼개질 때는 `pageBreak`, 반복 머리행, raw row/cell height, 중첩 표 continuation을 TotalDocs 자체 레이아웃 규칙으로 계속 정밀화해야 하옵니다.
- 셀 안의 중첩 표 `Table.caption` 방향과 간격도 자체 렌더러에서 일반 규칙으로 다루어야 하옵니다.
- 최신 2페이지 TotalDocs 확인 캡처는 [incheon-2a-page2-after-budget.png](output/playwright/qa-snapshots/incheon-2a-page2-after-budget.png)에 남겨 두었고, 이전 한컴 비교 캡처는 [incheon-p2-side-by-side-vpos3.png](output/hancom-oracle/incheon-page-probe/incheon-p2-side-by-side-vpos3.png)에 보존했사옵니다.

즉, 지금 단계는 “열람 가능”과 “대표 샘플 쪽수 일치”를 넘었으나, “한컴 Viewer 화면과 매우 비슷한 표 높이·개체 위치·폰트 조판”을 향한 본수술이 계속 필요한 상태이옵니다.

## 프로젝트 원칙 및 개발 플랜

이 프로젝트의 목표는 특정 샘플 몇 개를 보기 좋게 맞추는 것이 아니옵니다.

- 어떤 `HWP`, `HWPX`, `OWPML` 문서라도 원본 형식 데이터에 따라 열리고, 한컴 Viewer와 같은 페이지 흐름과 레이아웃으로 보이게 한다.
- 문서명, 파일명, 페이지 번호, 테스트 샘플 전용 좌표, 특정 문구 감지 같은 하드코딩은 금지한다.
- 모든 보정은 문서 형식에서 읽은 값에 대한 일반 규칙이어야 한다.
- 예: `LineSeg.vertical_pos`, `line_height`, `line_spacing`, `Table.caption`, 셀 padding, 행 높이, 개체 anchor, `charPr/shadow`, border/fill, section/page definition.
- 다운로드 폴더의 실제 문서는 회귀검증 기준선이지만, 구현은 해당 문서에 종속되면 안 된다.
- 화면 정답은 한컴 Viewer이며, 최종 판단은 반드시 한컴 캡처와 TotalDocs 캡처의 페이지 단위 비교로 한다.

### 지금까지 완료한 일

1. 한 파일에 몰려 있던 JS 파서를 `hwp-parser.js`, `hwp-parser-hwp5-records.js`, `hwp-parser-hwpx.js`, `hwp-parser-hwp5-container.js`로 분리했다.
2. 실제 한글 프로그램과 유사한 메뉴/툴바/눈금자/페이지/상태바 레이아웃을 구성했다.
3. 다운로드 폴더 원본 문서 기준 QA 체계를 만들었다.
4. 한컴 Viewer 기준 전 페이지 감사 리포트를 만들었다.
5. HWPX 제목 그림자, 폰트 대체, 그림 앵커, TAC 표 높이, 대형 셀 continuation, 중첩 표 캡션 누락 문제를 자체 렌더러의 과제로 정리했다.
6. README와 렌더링 상태 문서에 하드코딩 금지 원칙을 명문화했다.
7. 외부 WASM 실험 경로가 TotalDocs의 기준 엔진이 되지 않도록 실행 경로와 문서에서 제거했다.

### 현재 진행 중인 일

1. 기준 5개 문서의 한컴 Viewer 페이지 수 일치 상태를 유지한다.
2. `attachment-sale-notice.hwp` 1쪽 공고 표 내부 행 높이와 공급내역 표 시작 위치를 한컴 화면에 더 가깝게 정밀화한다.
3. `goyeopje-full-2024.hwp`, `goyeopje.hwp`의 표 높이, 문단 줄간격, 글자 농도 오차를 줄인다.
4. 한컴 감사 crop 도구가 부분 페이지나 표 내부 흰 영역을 페이지로 오인하지 않도록 보강한다.
5. 수정할 때마다 `node --check`, `node scripts/verify_samples.mjs`, 전 페이지 한컴 감사를 반복하는 검증 루프를 유지한다.

### 남은 작업 목록

1. `attachment-sale-notice.hwp` 1쪽 공고 표 내부 행 높이, nested 일정 표 높이, 공급내역 표 시작 위치를 한컴 Viewer에 더 가깝게 정렬한다.
2. `goyeopje-full-2024.hwp`와 `goyeopje.hwp`의 표 높이, 문단 줄간격, 글자 농도, border 농도 차이를 줄인다.
3. 공통 폰트 계량과 줄바꿈 폭을 한컴 Viewer에 더 가깝게 보정한다.
4. 문단 line-height, line-spacing, cell padding, row height 계산을 HWP/HWPX 형식 문서 기준으로 계속 정밀화한다.
5. 반복 머리행, 셀/행 분할, 대형 표 continuation, nested table clipping을 문서 공통 규칙으로 안정화한다.
6. 그림, 도형, 수식, 차트, 배포용 문서를 같은 QA 기준으로 확대 검증한다.
7. 전 페이지 감사에서 `mismatch 0`, `review 최소화`, 최종적으로 육안상 한컴 Viewer와 동일한 수준을 목표로 반복 개선한다.

### 진행 방식

1. diff가 큰 페이지부터 보되, 수정은 항상 HWP/HWPX 형식의 일반 규칙으로 만든다.
2. 한 페이지를 맞추기 위해 다른 문서의 페이지 흐름이 깨지지 않도록 먼저 최소 원인 단위를 분리한다.
3. 원인 분류 순서는 `페이지 흐름`, `표/셀 분할`, `개체 anchor`, `문단 조판`, `폰트 계량`, `색/선/농도` 순서로 한다.
4. 수정 후에는 JS 문법 검사, 다운로드 샘플 검증, 한컴 전 페이지 감사를 순서대로 수행한다.
5. 검증 결과와 다음 우선순위는 README와 `docs/rendering-status.md`에 계속 갱신한다.

## 핵심 구조

### 1. 웹 뷰어 (GitHub Pages)

- **라이브 URL**: [https://shinehand.github.io/TotalDocs/viewer.html](https://shinehand.github.io/TotalDocs/viewer.html)
- 뷰어 (루트): [viewer.html](viewer.html)
- 뷰어 (크롬 확장용): [pages/viewer.html](pages/viewer.html)
- 스타일: [css/viewer.css](css/viewer.css)
- 앱 로직: [js/app.js](js/app.js)

현재 셸은 메뉴/툴바/눈금자/캔버스/상태바 구조를 갖추고 있으며, 상태바에는 페이지/구역/모드와 함께 구조 진단 요약도 표시하옵니다.
사이드바 하단의 `레이아웃 감사 패널` 은 현재 쪽의 `표/그림/수식/차트/텍스트` 집계와 hotspot 쪽 이동 버튼을 보여 주옵니다.

### 2. Parser / Renderer Core

- 파서 facade: [js/hwp-parser.js](js/hwp-parser.js)
- HWP5 레코드 파서: [js/hwp-parser-hwp5-records.js](js/hwp-parser-hwp5-records.js)
- HWPX 파서: [js/hwp-parser-hwpx.js](js/hwp-parser-hwpx.js)
- HWP5 컨테이너 파서: [js/hwp-parser-hwp5-container.js](js/hwp-parser-hwp5-container.js)
- DOM 렌더러: [js/hwp-renderer.js](js/hwp-renderer.js)
- Worker 진입점: [js/parser.worker.js](js/parser.worker.js)

이 경로가 TotalDocs의 공식 파서/레이아웃 구현체이옵니다. 외부 WASM 번들은 기준 엔진으로 삼지 않사옵니다.

### 3. QA / 회귀검증

- 검증 스크립트: [scripts/verify_samples.mjs](scripts/verify_samples.mjs)
- QA 스냅샷: [output/playwright/qa-snapshots](output/playwright/qa-snapshots)

검증기는 아래를 함께 확인하옵니다.

- 문서 로드 성공
- 페이지/구역 상태 표시
- 첫 페이지부터 마지막 페이지까지 순회
- 핵심 키워드 검색
- 구조 진단 합계 일치
- hotspot 쪽 우선순위 계산
- 전체 화면 PNG 스냅샷 저장

## QA 원칙

가장 중요한 규칙은 하나이옵니다.

- QA는 반드시 로컬 다운로드 폴더의 원본 `HWP/HWPX` 파일을 기준으로 한다.
- 화면 정답은 한컴 Viewer를 기준선으로 삼는다.
- 렌더러에는 문서명, 파일명, 페이지 번호, 특정 샘플 전용 수치를 하드코딩하지 않는다.
- 모든 보정은 HWP/HWPX 원본 레코드의 서식값, 위치값, 캡션 방향, 줄/행/셀 속성처럼 문서 형식에서 읽은 값에 대한 일반 규칙이어야 한다.

자동화는 브라우저 적재를 위해 `output/playwright/served-inputs/` 에 임시 복제본을 만들 수 있으나, 바이트 원천은 늘 다운로드 원본이어야 하옵니다.
또한 화면 충실도 판정은 한컴 Viewer 캡처와 TotalDocs 캡처를 짝지어 보며 내려야 하옵니다.

상세 기준은 아래 문서에 정리되어 있사옵니다.

- [Downloads QA Baseline](docs/downloads-qa-baseline-2026-04-18.md)
- [Rendering Status](docs/rendering-status.md)

## 실행 방법

### 🌐 웹 뷰어 (설치 불필요)

아래 링크를 클릭하면 바로 HWP 뷰어가 열립니다. 아무것도 설치할 필요가 없사옵니다.

**[https://shinehand.github.io/TotalDocs/viewer.html](https://shinehand.github.io/TotalDocs/viewer.html)**

- `.hwp` / `.hwpx` / `.owpml` 파일을 화면에 끌어다 놓거나 "파일 선택" 버튼으로 올리면 즉시 렌더링됩니다.
- Chrome · Firefox · Safari · Edge 모두 지원합니다.
- 홈 화면: [https://shinehand.github.io/TotalDocs/](https://shinehand.github.io/TotalDocs/)

### 로컬 정적 서버

```bash
cd /path/to/TotalDocs
python3 -m http.server 4173
# 브라우저에서 http://localhost:4173/viewer.html 접속
```

### 최소 회귀검증

```bash
cd /path/to/TotalDocs
node scripts/verify_samples.mjs
```

### 한컴 기준선 캡처

한컴 Viewer를 열 수 있는 macOS 환경이라면, 같은 문서를 한컴 Viewer와 TotalDocs 양쪽에서 캡처한 비교판을 생성할 수 있사옵니다.

```bash
node scripts/capture_hancom_oracle.mjs
```

### 전 페이지 한컴 감사

대표 화면 1장이 아니라 테스트 문서의 모든 페이지를 한컴 Viewer와 TotalDocs로 짝지어 확인하려면 아래를 실행하옵니다.

```bash
node scripts/capture_hancom_page_audit.mjs
python3 scripts/build_hancom_page_audit.py
```

현재 최신 다운로드 샘플 검증은 5개 문서를 모두 열며, TotalDocs 기준 46쪽을 렌더링하옵니다. 한컴 기준 총 36쪽과 아직 차이가 남아 있어 HWP 표/문단 조판 보정이 계속 필요하옵니다.

주요 잔여 대상: `attachment-sale-notice.hwp` 1~4쪽, `goyeopje-full-2024.hwp` 6·9쪽, `goyeopje.hwp` 2~3쪽 분할, 전반적인 글자 농도·줄 높이·상단 원점 미세 오차

## 핵심 문서

### 형식 분석

- [HWP 5.0 분석](docs/hwp-spec-analysis/hwp-5.0-revision1.3.md)
- [HWPML 3.0 분석](docs/hwp-spec-analysis/hwpml-3.0-revision1.2.md)
- [수식 분석](docs/hwp-spec-analysis/hwp-equation-revision1.3.md)
- [차트 분석](docs/hwp-spec-analysis/hwp-chart-revision1.2.md)
- [배포용 문서 분석](docs/hwp-spec-analysis/hwp-distributed-doc-revision1.2.md)
- [통합 구현 기준서](docs/hwp-spec-analysis/implementation-requirements.md)
- [형식 문서 교차표](docs/hwp-spec-analysis/spec-crosswalk.md)
- [Document Parser Research Report](docs/document-parser-research-report-2026-04-24.md)

### QA / 레이아웃

- [Downloads QA Baseline](docs/downloads-qa-baseline-2026-04-18.md)
- [Rendering Status](docs/rendering-status.md)
- [TotalDocs WASM Redesign Plan](docs/totaldocs-wasm-redesign-plan-2026-04-22.md)
- [Font Strategy](docs/font-strategy-2026-04-18.md)
- [Hancom Oracle Page Baseline](docs/hancom-oracle-page-baseline.json)

## 2026-04-22 방향 전환 메모

외부 WASM 실험 경로는 TotalDocs의 기준 엔진이 아니옵니다.

- TotalDocs의 공식 구현은 저장소 안의 JS 파서와 DOM 렌더러이옵니다.
- 외부 WASM 브리지와 번들은 실행 경로에서 제거했사옵니다.
- 과거 WASM 실험에서 얻은 관찰은 참고 기록일 뿐, 이후 구현은 HWP/HWPX 형식 문서와 TotalDocs 자체 코드 기준으로 진행하옵니다.
- HWPX 레이아웃 고도화는 `docs/hwp-spec/` 원문, `docs/hwp-spec-analysis/` 분석 문서, 한컴 Viewer 캡처 비교를 기준으로 삼사옵니다.

## 다음 우선순위

1. `attachment-sale-notice.hwp` 1~4쪽의 표/이미지/헤더 정렬 문제를 해결한다.
2. `goyeopje-full-2024.hwp` 6·9쪽의 표 높이와 문단 조판 잔여 오차를 줄인다.
3. `goyeopje.hwp` 2~3쪽 분할을 한컴 2쪽 기준으로 맞춘다.
4. `incheon-2a.hwpx` 16~18쪽의 대형 셀 continuation과 중첩 표 흐름은 18쪽 기준을 유지하면서 세부 시각 차이를 줄인다.
5. 공통 폰트 계량, 줄간격, border 농도, 배경색 농도, 상단 원점 오차를 줄인다.
6. 전 페이지 감사에서 `mismatch 0`을 만들고 `review`를 순차적으로 줄인다.
7. 이후 `수식`, `차트`, `배포용 문서`를 같은 기준으로 더 깊게 붙인다.

주군, 이 README는 현재 전황과 기준 문서를 빠르게 찾기 위한 입구이옵니다. 실제 구현 판단은 반드시 위 연결 문서들과 최신 QA 리포트를 함께 보고 내리는 것이 옳사옵니다.
