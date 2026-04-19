# HWP Spec Crosswalk

Date: 2026-04-18
Scope: `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec/*.pdf`

## 목적

- 형식 문서 5종이 서로 어떤 구현 영역을 책임지는지 한 장으로 정리한다.
- 파서, 조판 엔진, 렌더러, 편집기, 저장기에서 무엇을 먼저 붙여야 하는지 우선순위를 준다.
- 개별 분석 Markdown을 읽기 전에 전체 관계를 빠르게 파악할 수 있게 한다.

## 문서별 책임 영역

| 문서 | 페이지 수 | 핵심 영역 | 바로 연결되는 구현 모듈 |
|---|---:|---|---|
| `hwp-5.0-revision1.3.pdf` | 71 | 바이너리 HWP 전체 구조, 레코드, 문단/표/개체/구역 | OLE/CFB 파서, DocInfo 파서, BodyText 파서, 조판 엔진, 저장기 |
| `hwpml-3.0-revision1.2.pdf` | 122 | XML 기반 HWPML/HWPX 계열 구조, 요소/속성, 추가 정보 블록 | XML 파서, style mapping, HWPX import/export, 필드/개체 복원 |
| `hwp-equation-revision1.3.pdf` | 19 | 수식 명령어, 토큰, 조합 규칙, 예제 | 수식 파서, 토큰화, 레이아웃 엔진, 수식 저장기 |
| `hwp-chart-revision1.2.pdf` | 47 | 차트 객체 트리, 축/범례/시리즈/스타일/3D | 차트 파서, object tree, chart renderer, chart serializer |
| `hwp-distributed-doc-revision1.2.pdf` | 11 | 배포용 문서 데이터, 복호화/해제 절차 | 배포용 문서 해제, AES 처리, 편집 가능 변환, 저장 호환 |

## 구현 관점 핵심 매핑

## 1. 파서

- `hwp-5.0`:
  - CFB/OLE 스토리지 구조
  - `FileHeader`, `DocInfo`, `BodyText/Section*`, `BinData`, `PrvText`, `PrvImage`
  - `HWPTAG_*` 레코드 해석
- `hwpml-3.0`:
  - XML element/attribute 파싱
  - 문단/글자/표/개체/필드 구조 복원
  - 추가 정보 블록과 미리보기/이미지/누름틀 메타 연결
- `equation`:
  - 수식 문자열을 토큰/트리로 바꾸는 규칙
- `chart`:
  - ChartObj 하위 객체 트리 파싱
- `distributed-doc`:
  - 배포용 문서 데이터와 복호화 메타 파싱

## 2. 조판 엔진

- `hwp-5.0`:
  - 문단 레이아웃
  - 줄 분할
  - 구역 정의
  - 쪽 번호/머리말/꼬리말
  - 표 배치/행 분할/반복 머리행
  - 그림/도형/OLE/차트 앵커
- `hwpml-3.0`:
  - XML 계열 스타일을 조판용 내부 모델로 정규화
- `equation`:
  - 분수, 루트, 행렬, 합계, 극한, 괄호 크기, 정렬
- `chart`:
  - 차트 박스, 축, 범례, series layout

## 3. 렌더러

- `hwp-5.0`:
  - 글자 모양, 문단 모양, 탭, 번호, 글머리표
  - 표 border/fill/padding
  - 그림/도형/차트 배치
- `hwpml-3.0`:
  - XML 속성을 CSS/Canvas/SVG 렌더 속성으로 투영
- `equation`:
  - 기호 위치, 스크립트 배치, 템플릿 렌더
- `chart`:
  - 축/series/legend/title/gridline/3D 시각화

## 4. 편집 및 저장

- `hwp-5.0`:
  - 편집 후 레코드/ID 매핑 유지
  - 문단/글자/표/구역/개체 round-trip
- `hwpml-3.0`:
  - element/attribute 보존과 재생성
- `equation`:
  - 수식 명령 문자열과 시각 레이아웃 간 역변환
- `chart`:
  - 차트 객체 트리 손실 없는 저장
- `distributed-doc`:
  - 배포용 해제 후 일반 저장 또는 재배포 정책 분리

## 레이아웃 충실도에 가장 영향이 큰 문서

1. `hwp-5.0-revision1.3.pdf`
2. `hwpml-3.0-revision1.2.pdf`
3. `hwp-equation-revision1.3.pdf`
4. `hwp-chart-revision1.2.pdf`
5. `hwp-distributed-doc-revision1.2.pdf`

## 즉시 우선순위

1. `hwp-5.0` 와 `hwpml-3.0`에서 공통적으로 등장하는 문단/글자/표/구역/개체 필드를 내부 모델 기준으로 통일한다.
2. `표 위치`, `행 분할`, `반복 머리행`, `문단 들여쓰기`, `줄간격`, `쪽 정의`, `머리말/꼬리말`을 최우선 조판 축으로 잡는다.
3. `equation`은 토큰화보다 템플릿 조판부터 먼저 붙인다.
4. `chart`는 렌더 완성보다 객체 트리와 속성 보존을 먼저 완성한다.
5. `distributed-doc`는 읽기/해제 경로와 저장 정책을 분리하여 안정화한다.

## 문서별 최고 위험 지점

| 문서 | 가장 위험한 함정 | 구현 대응 |
|---|---|---|
| `hwp-5.0` | `CTRL_HEADER` polymorphic 해석, `TabDef` 길이 모호점, unknown tag 유실 | raw-preserving 레코드 모델과 타입별 payload 해석을 분리한다. |
| `hwpml-3.0` | 속성 단위/기준 불일치, `폼/필드/XMLTemplate/스크립트` 누락 | element/attribute 원형 보존과 내부 모델 정규화를 분리한다. |
| `equation` | alias 충돌, roman 예외, baseline 처리, 입력 문자열 정규화 | raw script 보존을 우선하고 렌더링 AST는 파생 구조로 둔다. |
| `chart` | `VariableData` 생략 규칙, 자동/수동 플래그 덮어쓰기, enum 원값 손실 | raw field + normalized field 이중 모델을 유지한다. |
| `distributed-doc` | MSVC `rand()` 불일치, 80-byte hash 해석 착오, 저장 정책 혼선 | 알고리즘 고정 테스트와 읽기/일반 저장/배포용 저장 경로 분리를 먼저 한다. |

## 개별 분석 문서

- [README](/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/README.md)
- [implementation-requirements.md](/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/implementation-requirements.md)
- `hwp-5.0-revision1.3.md`
- `hwpml-3.0-revision1.2.md`
- `hwp-equation-revision1.3.md`
- `hwp-chart-revision1.2.md`
- `hwp-distributed-doc-revision1.2.md`
