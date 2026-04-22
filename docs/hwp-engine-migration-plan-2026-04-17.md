# HWP Engine Integration Plan

기준일: 2026-04-17

## 결론

`TotalDocs`는 확장 셸은 유지하고, 문서 엔진과 편집 본체는 외부 `HWP 엔진` 중심으로 재편한다.

- 유지:
  - Chrome 확장 MV3 셸
  - 팝업 업로드/최근 파일/링크 감지/배지/컨텍스트 메뉴
  - 샘플 문서와 Playwright 회귀 자산
- 교체:
  - 레거시 JS 파서/렌더러 (`js/hwp-parser.js`, `js/hwp-renderer.js`, `js/parser.worker.js`)
  - Quill 기반 편집 경로
- 최종 목표:
  - 한글형 편집기 UI 계열
  - WASM 기반 HWP 렌더/편집/저장
  - 실제 한글 프로그램에 가까운 레이아웃과 상호작용

## 왜 이 방향인가

- 참조한 외부 HWP 엔진은 이미 Rust/WASM 코어, Canvas/SVG/HTML 출력, HWP 저장, 필드 API, hwpctl 호환층을 보유한다.
- 참조한 웹 편집기 본체는 메뉴바, 아이콘 툴바, 서식바, 눈금자, 중앙 페이지 캔버스, 상태바, 각종 대화상자까지 갖춘 완성형 웹 편집기다.
- 참조한 Chrome 확장판은 그 편집기 본체를 확장으로 패키징하는 선례를 제공한다.
- 현 `TotalDocs`는 외부 HWP 엔진을 일부만 가져와 보기/편집/저장 경로가 이중화되어 있어 구조적으로 불안정하다.

## 목표 아키텍처

### 1. 확장 셸

- `manifest.json`
- `background.js`
- `popup.html`, `popup.js`
- `content_script.js`
- `sidepanel.js`
- `sw/thumbnail-extractor.js`

역할:
- 파일 진입
- 최근 파일/최근 링크
- 컨텍스트 메뉴
- HWP 링크 배지/호버
- 탭 라우팅

### 2. 문서 엔진

- HWP WASM 단일 엔진 사용
- `HwpDocument` API를 표준 문서 인터페이스로 삼음
- 우선 활용 API:
  - `renderPageToCanvas`
  - `renderPageSvg`
  - `renderPageHtml`
  - `searchText`
  - `hitTest`
  - `getFieldList`
  - `setFieldValueByName`
  - `saveSnapshot` / `restoreSnapshot`
  - `exportHwp`

### 3. UI 본체

- 최종적으로 한글형 편집기 UI 계열로 수렴
- 단기에는 현재 뷰어 셸 위에 HWP 엔진 기능을 먼저 넓힘
- 중기에는 `viewer.html`을 한글형 3단 상단 크롬 + 눈금자 + 중앙 캔버스로 재구성

## 단계별 실행

## Phase 0

목표:
- 현재 코드베이스에서 HWP 엔진 실익을 바로 확보

작업:
- 로컬 폰트 자산 복구
- WASM 기반 `.hwp` 저장 열기
- WASM 문서에 대한 HTML/PDF 저장 경로 유지
- 기존 회귀 검증이 WASM 경로에 맞게 실패 원인을 드러내도록 정리

완료 기준:
- `viewer.html` 폰트 404 제거
- WASM 경로로 연 문서를 `.hwp`로 저장 가능

## Phase 1

목표:
- 레거시 JS 파서 의존도 축소

작업:
- `js/hwp-wasm-renderer.js`를 문서 브리지로 승격
- 필드 API, SVG/HTML 출력, snapshot API 노출
- eager page rendering 대신 virtual scroll 또는 lazy page rendering 도입
- `saveAs`/`print`/`search`를 HWP 엔진 기준으로 정렬

완료 기준:
- `.hwp`, `.hwpx` 주 경로가 모두 HWP 엔진
- `js/hwp-parser.js` fallback 의존도 최소화

## Phase 2

목표:
- UI를 한글 프로그램형 편집기로 전환

작업:
- 메뉴바/아이콘 툴바/서식바/상태바 재구성
- 눈금자와 중앙 페이지 캔버스 레이아웃 도입
- 찾기/표 만들기/도형/머리말·꼬리말 편집 상호작용 이식
- 현재 좌측 썸네일 패널은 유지하되 새 편집기 본체와 결합

완료 기준:
- 현재 Quill 편집기 제거
- 한글 프로그램과 유사한 화면 구조 확보

## Phase 3

목표:
- 새 편집기 본체 계열 완전 수렴

작업:
- 외부 편집기 소스 통합 또는 셀프 호스팅 빌드 체계 구축
- 외부 Chrome 확장판의 빌드 방식과 자산 배치 참조
- 저장/인쇄/필드 자동화/hwpctl 흐름 정리
- `HWPX` / `OWPML` 처리 정책 최종 결정

완료 기준:
- 단일 엔진, 단일 UI, 단일 저장 전략

## 버릴 것

- Quill round-trip 편집을 정식 경로로 유지하지 않는다.
- 레거시 JS 파서를 장기 핵심 엔진으로 유지하지 않는다.
- `viewer.js`, `editor.js`, `exporter.js` 같은 미사용 분리본은 최종 정리 대상이다.

## 남겨둘 것

- 확장 프로그램 진입 경험
- 팝업과 최근 파일 UX
- 링크 감지와 배지
- 썸네일 추출기
- 샘플 문서/회귀 자산

## 주요 리스크

- 폰트 라이선스와 배포 정책
- 외부 편집기 쪽 CDN 폰트 의존 제거
- 대용량 문서에서의 성능
- `HWPX` / `OWPML` 저장 정책
- `hwpctl` 미구현 액션에 대한 기대 관리

## 다음 우선순위

1. HWP 엔진 기반 저장/검색/필드 API를 현재 앱에서 직접 노출
2. Playwright 회귀 검증을 WASM 중심 기준으로 재작성
3. `viewer.html`을 한글형 편집기 레이아웃으로 1차 리스킨
4. 외부 편집기 소스 통합 또는 셀프 호스팅 빌드 체계 도입
