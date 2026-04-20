# ChromeHWP

> **⚡ 설치 없이 브라우저에서 바로 사용하기**
>
> 👉 **[https://shinehand.github.io/ChromeHWP/viewer.html](https://shinehand.github.io/ChromeHWP/viewer.html)**
>
> 링크를 클릭하면 **아무것도 설치하지 않아도** HWP 뷰어가 바로 열립니다.
> `.hwp` / `.hwpx` / `.owpml` 파일을 화면에 끌어다 놓거나 "파일 선택" 버튼으로 올리면 즉시 렌더링됩니다.
> Chrome · Firefox · Safari · Edge 모두 지원합니다.

---

`HWP`, `HWPX`, `OWPML` 문서를 어떤 브라우저에서든 설치 없이 열고, 가능한 한 실제 한글 프로그램과 비슷한 화면과 동선으로 확인·편집·저장하려는 프로젝트이옵니다.

현재 프로젝트는 `웹 뷰어(GitHub Pages) + 크롬 확장 프로그램 셸 + HWP 엔진 기반 Canvas 렌더링 + 직접 편집 경로 + 다운로드 원본 기준 QA` 구조로 움직이고 있사옵니다.

## 현재 상태

- `HWP` / `HWPX` 는 `js/hwp-wasm-renderer.js` 를 통해 HWP 엔진 기반 Canvas 렌더링을 우선 사용하옵니다.
- 문서 위 직접 편집, 현재 파일 저장, 검색, 줌, 상태바, 썸네일 탐색이 연결되어 있사옵니다.
- 사이드바에는 현재 쪽 집계와 집중 확인 쪽을 보여 주는 `레이아웃 감사 패널` 이 붙어 있사옵니다.
- QA는 저장소 fixture보다 `/Users/shinehandmac/Downloads` 의 실제 원본 `HWP/HWPX` 파일을 기준으로 돌고 있사옵니다.
- 검증 스크립트는 다운로드 폴더의 지원 문서를 자동 발견하므로, 새 파일이 들어와도 QA 범위에 바로 편입되옵니다.
- 구조 진단 데이터도 함께 수집하여 `표`, `수식`, `차트`, `개체`, `구역`, `페이지` 단위로 검증할 수 있사옵니다.
- HWPX 글자모양의 `shadow` 서식은 `type`, `color`, `offsetX`, `offsetY`까지 읽고, `DROP`과 `CONTINUOUS`를 구분하여 Canvas/SVG 텍스트 그림자로 반영하옵니다.

아직 남은 큰 과제는 `페이지 내부 레이아웃 충실도`이옵니다.

- 한컴 Viewer 기준 페이지 수는 현재 다운로드 대표 5종 모두 일치하옵니다.
- `goyeopje.hwp`: 한컴 `2쪽`, ChromeHWP `2쪽`
- `goyeopje-full-2024.hwp`: 한컴 `11쪽`, ChromeHWP `11쪽`
- `gyeolseokgye.hwp`: 한컴 `1쪽`, ChromeHWP `1쪽`
- `attachment-sale-notice.hwp`: 한컴 `4쪽`, ChromeHWP `4쪽`
- `incheon-2a.hwpx`: 한컴 `18쪽`, ChromeHWP `18쪽`

최근 한컴 Viewer 화면 비교 기준 주요 수치입니다.

- `goyeopje.hwp`: visiblePageDiff `10.856`, titleDiff `10.350`
- `goyeopje-full-2024.hwp`: visiblePageDiff `18.053`, titleDiff `20.679`
- `gyeolseokgye.hwp`: visiblePageDiff `15.668`, titleDiff `12.574`
- `attachment-sale-notice.hwp`: visiblePageDiff `30.773`, titleDiff `32.788`
- `incheon-2a.hwpx`: visiblePageDiff `29.208`, titleDiff `26.707`
- 최신 비교 리포트: [hancom-page-compare-report.json](/Users/shinehandmac/Github/ChromeHWP/output/hancom-oracle/hancom-page-compare-report.json:1)

최근 반영된 충실도 개선은 아래와 같사옵니다.

- `HY헤드라인M` 계열은 한컴 Viewer 비교에서 가장 나은 결과를 보인 `dotum-Regular.ttf` 대체로 정식 매핑했사옵니다.
- HWPX 제목 글자 그림자는 `charPr/shadow` 의 `type`, `color`, `offsetX`, `offsetY`를 반영하고, `CONTINUOUS`는 원본과 오프셋 사이를 채운 연속 그림자로 렌더링하옵니다.
- 표 셀 안 비인라인 그림의 `horzRelTo="COLUMN"` 앵커는 셀 패딩이 아닌 셀 경계 기준으로 보정했사옵니다.
- `incheon-2a.hwpx` 제목 LH 로고는 `x=164.2px` 오배치에서 `x=114.2px`로 이동하여 한컴 Viewer 위치에 더 가까워졌사옵니다.
- HWPX 문단의 제어개체 오프셋은 스트림 순서대로 8 UTF-16 단위로 누적하여, 로고 뒤 제목처럼 `charPrIDRef` 경계가 한 글자 밀리는 문제를 바로잡았사옵니다.
- TAC 표는 저장된 object 높이가 셀 내용보다 작을 때 행 높이를 강제 축소하지 않도록 배치기와 페이지 측정기 양쪽에서 보호하여, 한컴 Viewer처럼 내용 우선 높이를 유지하게 했사옵니다.
- `incheon-2a.hwpx` 2페이지는 큰 표 셀 안에서 `LineSeg.vertical_pos`가 되감기는 continuation window를 감지하여, 한컴 Viewer처럼 `[무주택세대구성원]` 박스부터 이어지도록 보정했사옵니다.
- 같은 행이 여러 페이지로 쪼개질 때 `split_end`를 `split_start + visible_length` 기준으로 해석하도록 방어하여, 중첩 표가 이전/다음 continuation 구간에서 되살아나는 위험을 줄였사옵니다.
- 셀 안의 중첩 표도 `Table.caption` 방향과 간격을 그대로 적용하도록 일반화하여, `Top` 캡션이 표 머리행과 겹치거나 누락되는 문제를 바로잡았사옵니다.
- 최신 2페이지 직접 비교 캡처는 [incheon-p2-side-by-side-vpos3.png](/Users/shinehandmac/Github/ChromeHWP/output/hancom-oracle/incheon-page-probe/incheon-p2-side-by-side-vpos3.png)에 남겨 두었사옵니다.

즉, 지금 단계는 “열람 가능”과 “대표 샘플 쪽수 일치”를 넘었으나, “한컴 Viewer 화면과 매우 비슷한 표 높이·개체 위치·폰트 조판”을 향한 본수술이 계속 필요한 상태이옵니다.

## 프로젝트 원칙 및 개발 플랜

이 프로젝트의 목표는 특정 샘플 몇 개를 보기 좋게 맞추는 것이 아니옵니다.

- 어떤 `HWP`, `HWPX`, `OWPML` 문서라도 원본 형식 데이터에 따라 열리고, 한컴 Viewer와 같은 페이지 흐름과 레이아웃으로 보이게 한다.
- 문서명, 파일명, 페이지 번호, 테스트 샘플 전용 좌표, 특정 문구 감지 같은 하드코딩은 금지한다.
- 모든 보정은 문서 형식에서 읽은 값에 대한 일반 규칙이어야 한다.
- 예: `LineSeg.vertical_pos`, `line_height`, `line_spacing`, `Table.caption`, 셀 padding, 행 높이, 개체 anchor, `charPr/shadow`, border/fill, section/page definition.
- 다운로드 폴더의 실제 문서는 회귀검증 기준선이지만, 구현은 해당 문서에 종속되면 안 된다.
- 화면 정답은 한컴 Viewer이며, 최종 판단은 반드시 한컴 캡처와 ChromeHWP 캡처의 페이지 단위 비교로 한다.

### 지금까지 완료한 일

1. `HWP/HWPX` 렌더링 경로를 WASM 기반 `hwp` 엔진으로 통합했다.
2. 외부 표기는 `rhwp`가 아니라 `hwp`로 통일했다.
3. 실제 한글 프로그램과 유사한 메뉴/툴바/눈금자/페이지/상태바 레이아웃을 구성했다.
4. 다운로드 폴더 원본 문서 기준 QA 체계를 만들었다.
5. 대표 5개 문서의 한컴 Viewer 페이지 수와 ChromeHWP 페이지 수를 일치시켰다.
6. 한컴 Viewer 기준 전 페이지 감사 리포트를 만들었다.
7. HWPX 제목 그림자, 폰트 대체, 그림 앵커, TAC 표 높이, 대형 셀 continuation, 중첩 표 캡션 누락 문제를 일반 규칙으로 수정했다.
8. README와 렌더링 상태 문서에 하드코딩 금지 원칙을 명문화했다.

### 현재 진행 중인 일

1. `incheon-2a.hwpx` 15쪽 mismatch 원인 분석.
2. 대형 셀 안의 `LineSeg.vertical_pos` 리셋 구간과 페이지 continuation 분할 매핑 검증.
3. 한컴 감사 crop 도구가 부분 페이지나 표 내부 흰 영역을 페이지로 오인하지 않도록 보강.
4. 수정할 때마다 `cargo test --lib --quiet`, `node scripts/verify_samples.mjs`, 전 페이지 한컴 감사를 반복하는 검증 루프 유지.

### 남은 작업 목록

1. `incheon-2a.hwpx` 15쪽 mismatch 해결.
2. `incheon-2a.hwpx` 12~16쪽 후반 대형 셀 continuation 흐름 재검증.
3. `attachment-sale-notice.hwp` 1~4쪽 표, 이미지, 헤더, 셀 여백, 선 두께 정렬 개선.
4. `goyeopje-full-2024.hwp` 6쪽과 9쪽의 표 높이, 문단 줄간격, 글자 농도, border 농도 개선.
5. 공통 폰트 계량과 줄바꿈 폭을 한컴 Viewer에 더 가깝게 보정.
6. 문단 line-height, line-spacing, cell padding, row height 계산을 HWP/HWPX 형식 문서 기준으로 계속 정밀화.
7. 반복 머리행, 셀/행 분할, 대형 표 continuation, nested table clipping을 문서 공통 규칙으로 안정화.
8. 그림, 도형, 수식, 차트, 배포용 문서를 같은 QA 기준으로 확대 검증.
9. 전 페이지 감사에서 `mismatch 0`, `review 최소화`, 최종적으로 육안상 한컴 Viewer와 동일한 수준을 목표로 반복 개선.

### 진행 방식

1. diff가 큰 페이지부터 보되, 수정은 항상 HWP/HWPX 형식의 일반 규칙으로 만든다.
2. 한 페이지를 맞추기 위해 다른 문서의 페이지 흐름이 깨지지 않도록 먼저 최소 원인 단위를 분리한다.
3. 원인 분류 순서는 `페이지 흐름`, `표/셀 분할`, `개체 anchor`, `문단 조판`, `폰트 계량`, `색/선/농도` 순서로 한다.
4. 수정 후에는 Rust 단위 테스트, WASM 재빌드, 다운로드 샘플 검증, 한컴 전 페이지 감사를 순서대로 수행한다.
5. 검증 결과와 다음 우선순위는 README와 `docs/rendering-status.md`에 계속 갱신한다.

## 핵심 구조

### 1. 웹 뷰어 (GitHub Pages)

- **라이브 URL**: [https://shinehand.github.io/ChromeHWP/viewer.html](https://shinehand.github.io/ChromeHWP/viewer.html)
- 뷰어 (루트): [viewer.html](viewer.html)
- 뷰어 (크롬 확장용): [pages/viewer.html](pages/viewer.html)
- 스타일: [css/viewer.css](css/viewer.css)
- 앱 로직: [js/app.js](js/app.js)

현재 셸은 메뉴/툴바/눈금자/캔버스/상태바 구조를 갖추고 있으며, 상태바에는 페이지/구역/모드와 함께 구조 진단 요약도 표시하옵니다.
사이드바 하단의 `레이아웃 감사 패널` 은 현재 쪽의 `표/그림/수식/차트/텍스트` 집계와 hotspot 쪽 이동 버튼을 보여 주옵니다.

### 2. HWP 엔진 브리지

- 브리지: [js/hwp-wasm-renderer.js](js/hwp-wasm-renderer.js)
- 엔진 번들: [lib/hwp.js](lib/hwp.js), `lib/hwp_bg.wasm`

브리지는 아래 역할을 맡고 있사옵니다.

- 문서 렌더링
- 검색
- hit test / 커서 rect
- 직접 편집용 삽입/삭제/문단 분할
- 페이지 정보 / 컨트롤 레이아웃 / 구역 정의 / 표/그림/수식/양식 진단
- `collectDocumentDiagnostics()` 를 통한 문서 구조 집계

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
또한 화면 충실도 판정은 한컴 Viewer 캡처와 ChromeHWP 캡처를 짝지어 보며 내려야 하옵니다.

상세 기준은 아래 문서에 정리되어 있사옵니다.

- [Downloads QA Baseline](docs/downloads-qa-baseline-2026-04-18.md)
- [Rendering Status](docs/rendering-status.md)

## 실행 방법

### 🌐 웹 뷰어 (설치 불필요)

아래 링크를 클릭하면 바로 HWP 뷰어가 열립니다. 아무것도 설치할 필요가 없사옵니다.

**[https://shinehand.github.io/ChromeHWP/viewer.html](https://shinehand.github.io/ChromeHWP/viewer.html)**

- `.hwp` / `.hwpx` / `.owpml` 파일을 화면에 끌어다 놓거나 "파일 선택" 버튼으로 올리면 즉시 렌더링됩니다.
- Chrome · Firefox · Safari · Edge 모두 지원합니다.
- 홈 화면: [https://shinehand.github.io/ChromeHWP/](https://shinehand.github.io/ChromeHWP/)

### 로컬 정적 서버

```bash
cd /path/to/ChromeHWP
python3 -m http.server 4173
# 브라우저에서 http://localhost:4173/viewer.html 접속
```

### 최소 회귀검증

```bash
cd /path/to/ChromeHWP
node scripts/verify_samples.mjs
```

### 한컴 기준선 캡처

한컴 Viewer를 열 수 있는 macOS 환경이라면, 같은 문서를 한컴 Viewer와 ChromeHWP 양쪽에서 캡처한 비교판을 생성할 수 있사옵니다.

```bash
node scripts/capture_hancom_oracle.mjs
```

### 전 페이지 한컴 감사

대표 화면 1장이 아니라 테스트 문서의 모든 페이지를 한컴 Viewer와 ChromeHWP로 짝지어 확인하려면 아래를 실행하옵니다.

```bash
node scripts/capture_hancom_page_audit.mjs
python3 scripts/build_hancom_page_audit.py
```

현재 최신 전 페이지 감사는 다운로드 기준 5개 문서 36쪽을 모두 캡처했으며, 아직 모든 페이지가 원본과 동일한 수준은 아니옵니다.

주요 잔여 대상: `incheon-2a.hwpx` 15쪽, `attachment-sale-notice.hwp` 1쪽, `goyeopje-full-2024.hwp` 6·9쪽, 전반적인 글자 농도·줄 높이·상단 원점 미세 오차

## 핵심 문서

### 형식 분석

- [HWP 5.0 분석](docs/hwp-spec-analysis/hwp-5.0-revision1.3.md)
- [HWPML 3.0 분석](docs/hwp-spec-analysis/hwpml-3.0-revision1.2.md)
- [수식 분석](docs/hwp-spec-analysis/hwp-equation-revision1.3.md)
- [차트 분석](docs/hwp-spec-analysis/hwp-chart-revision1.2.md)
- [배포용 문서 분석](docs/hwp-spec-analysis/hwp-distributed-doc-revision1.2.md)
- [통합 구현 기준서](docs/hwp-spec-analysis/implementation-requirements.md)
- [형식 문서 교차표](docs/hwp-spec-analysis/spec-crosswalk.md)

### QA / 레이아웃

- [Downloads QA Baseline](docs/downloads-qa-baseline-2026-04-18.md)
- [Rendering Status](docs/rendering-status.md)
- [Font Strategy](docs/font-strategy-2026-04-18.md)
- [Hancom Oracle Page Baseline](docs/hancom-oracle-page-baseline.json)

## 2026-04-19 종료 메모

오늘 종료 시점의 핵심 전황이옵니다.

- `rhwp-reference`의 HWPX 대형 셀 continuation 처리를 보강하고, 최신 엔진을 `lib/hwp.js`, `lib/hwp_bg.wasm`, `lib/hwp.d.ts`로 다시 반영했사옵니다.
- `LineSeg.vertical_pos`가 큰 셀 안에서 여러 번 되감기는 구간을 continuation window로 분리하고, 분할 렌더링 시 문단 y를 저장된 vpos 기준으로 앵커링하는 규칙을 추가했사옵니다.
- 중첩 표가 split window 안에서 렌더링될 때 `split_start`와 `split_end`를 절대 좌표처럼 오해하지 않도록 보정했사옵니다.
- `incheon-2a.hwpx`는 한컴 기준 `18쪽`과 ChromeHWP `18쪽`이 계속 일치하오나, 15~16쪽의 내부 시각 흐름은 아직 원본과 완전히 같지 않사옵니다.
- 남은 핵심 원인은 큰 셀 안의 page-like vpos window와 중첩 표 분할이 결합될 때 일부 페이지가 한컴보다 늦게 흘러가거나 겹쳐 보이는 문제이옵니다.
- 이 문제는 문서명/페이지번호 하드코딩 없이 `LineSeg.vertical_pos`, 중첩 표 실제 높이, 셀 continuation window, partial table clipping 규칙으로 계속 해결해야 하옵니다.

오늘 확인한 테스트이옵니다.

- `cargo test --lib split_line_ranges_can_span_multiple_vpos_windows --quiet`: 통과, `1 passed`, `811 filtered out`.
- `RUSTC=/Users/shinehandmac/.cargo/bin/rustc /Users/shinehandmac/.cargo/bin/cargo build --release --target wasm32-unknown-unknown --lib`: 통과.
- `/Users/shinehandmac/.cargo/bin/wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/rhwp.wasm`: 통과.
- `node scripts/verify_samples.mjs`: 대표 5개 문서 통과.
- 페이지 수 재확인: `goyeopje.hwp 2/2`, `goyeopje-full-2024.hwp 11/11`, `gyeolseokgye.hwp 1/1`, `attachment-sale-notice.hwp 4/4`, `incheon-2a.hwpx 18/18`.

로컬 빌드 주의사항이옵니다.

- 현재 셸의 기본 `cargo/rustc`가 Homebrew x86_64 경로(`/usr/local/bin`)를 먼저 잡으면 WASM 타깃을 못 찾아 실패할 수 있사옵니다.
- WASM 빌드 시에는 `RUSTC=/Users/shinehandmac/.cargo/bin/rustc /Users/shinehandmac/.cargo/bin/cargo build --release --target wasm32-unknown-unknown --lib`처럼 rustup 경로를 명시하는 편이 안전하옵니다.

## 다음 우선순위

1. `incheon-2a.hwpx` 15쪽 mismatch를 먼저 해결한다.
2. 같은 대형 셀 흐름을 쓰는 `incheon-2a.hwpx` 12~16쪽을 연쇄 검증한다.
3. `attachment-sale-notice.hwp` 1~4쪽의 표/이미지/헤더 정렬 문제를 해결한다.
4. `goyeopje-full-2024.hwp` 6·9쪽의 표 높이와 문단 조판 잔여 오차를 줄인다.
5. 공통 폰트 계량, 줄간격, border 농도, 배경색 농도, 상단 원점 오차를 줄인다.
6. 전 페이지 감사에서 `mismatch 0`을 유지하고 `review`를 순차적으로 줄인다.
7. 이후 `수식`, `차트`, `배포용 문서`를 같은 기준으로 더 깊게 붙인다.

주군, 이 README는 현재 전황과 기준 문서를 빠르게 찾기 위한 입구이옵니다. 실제 구현 판단은 반드시 위 연결 문서들과 최신 QA 리포트를 함께 보고 내리는 것이 옳사옵니다.
