# HWP 구현 요구사항 통합 기준서

Date: 2026-04-18
Sources:
- `hwp-5.0-revision1.3.md`
- `hwpml-3.0-revision1.2.md`
- `hwp-equation-revision1.3.md`
- `hwp-chart-revision1.2.md`
- `hwp-distributed-doc-revision1.2.md`

## 목적

- 다섯 형식 문서에서 뽑아낸 요구사항을 실제 구현 순서 기준으로 다시 묶는다.
- `파서`, `조판`, `렌더링`, `편집`, `저장`, `회귀검증`에 필요한 데이터를 한 장에서 찾을 수 있게 한다.
- 현재 프로젝트의 ChromeHWP 자체 파서/조판/렌더러에서 무엇을 먼저 고쳐야 하는지 명확히 고정한다.

## 최종 심화 검토 상태

| 문서 | 범위 | 이번 최종 검토에서 보강한 축 |
|---|---|---|
| `hwp-5.0` | PDF 71쪽 전장 | 레코드/필드 표, 버전 게이트, 구현 함정, 회귀 포인트 |
| `hwpml-3.0` | PDF 122쪽 전장 | XML element/attribute 매핑, 내부 모델 연결, 위험 필드 |
| `equation` | PDF 19쪽 전장 | 토큰/명령/기호 표, baseline 규칙, 정규화 금지 목록 |
| `chart` | PDF 47쪽 전장 | 객체 트리, 필드 분류, 자동/수동 플래그, enum 원값 보존 |
| `distributed-doc` | PDF 11쪽 전장 | seed/XOR/AES 절차, 옵션 플래그, 저장 정책 분기 |

이 기준서는 위 재검토 결과를 다시 묶은 최종 통합본이다.

## 1. 파서가 반드시 확보해야 할 데이터

| 영역 | 반드시 확보할 데이터 | 주 근거 문서 |
|---|---|---|
| 바이너리 HWP 헤더 | `FileHeader` 시그니처, 버전, 압축/암호화/배포 플래그, 예약 비트 | `hwp-5.0` |
| 공통 레코드 | `TagID`, `Level`, `Size`, 확장 size, 알 수 없는 레코드 원문 바이트 | `hwp-5.0` |
| 문서 정보 | `Document Properties`, `ID Mappings`, `BinData`, `FaceName`, `BorderFill`, `CharShape`, `TabDef`, `Numbering`, `Bullet`, `ParaShape`, `Style`, `DocData`, `CompatibleDocument`, `LayoutCompatibility` | `hwp-5.0`, `hwpml-3.0` |
| 본문 문단 | 문단 헤더, 텍스트 run, 글자 모양 run, 줄 정보, range tag, control char, paragraph list header | `hwp-5.0`, `hwpml-3.0` |
| 구역/쪽 | `SectionDef`, `PageDef`, `PageBorderFill`, `ColumnsDef`, header/footer, footnote/endnote, page number control | `hwp-5.0`, `hwpml-3.0` |
| 표/개체 | 표 셀 구조, span, row sizing, caption, `ShapeObject`, `ShapeComponent`, `Picture`, `OLE`, `Equation`, `TextArt`, `Position`, `Size`, `RenderingInfo` | `hwp-5.0`, `hwpml-3.0` |
| HWPML 루트 | `HWPML -> HEAD -> BODY -> TAIL`, 참조 테이블, `BINDATASTORAGE`, 부가 script/XML 자산 | `hwpml-3.0` |
| 수식 | `HWPTAG_EQEDIT` 저장 구조, script string, `len`, `size`, `color`, `baseline`, `version`, `font name`, 문서 수준 `수식 시작 번호` | `equation`, `hwp-5.0` |
| 차트 | `ChartObj` 순서, `StoredtypeID`, `StoredName`, `StoredVersion`, `ChartObjData`, `VtChart` 루트, `Axis`, `Series`, `DataPoint`, `Legend`, `Plot`, `PrintInformation` | `chart` |
| 배포용 문서 | `HWPTAG_DISTRIBUTE_DOC_DATA` 원본 256 bytes, seed, offset, hashcode 80 bytes, AES key 16 bytes, option flags, 암호화 대상 스트림 목록 | `distributed-doc` |

## 2. 레이아웃 충실도에 직접 연결되는 데이터

### 2.1 최우선 조판 축

1. 문단 들여쓰기, 정렬, 줄간격, 탭, 번호/글머리표
2. 구역 정의, 용지 설정, 페이지 여백, 머리말/꼬리말, 쪽 번호
3. 표 셀 크기, 병합, row height, row split, repeat header row, border/fill/padding
4. 그림/도형/차트/OLE의 앵커, 본문 감싸기, z-order, 회전, 바깥 여백
5. 수식 템플릿 조판
6. 차트 축/범례/제목/시리즈 배치

### 2.2 레이아웃 계산에 반드시 쓰여야 할 필드

| 영역 | 필드 |
|---|---|
| 문단 | `ParaShape`, `CharShape`, tab, line seg, range tag, numbering/bullet, justification |
| 페이지 | `SectionDef`, `PageDef`, `PageMargin`, `ColumnsDef`, `PageBorderFill`, header/footer |
| 표 | zone info, cell span, row sizing, caption, inside/outside margin |
| 개체 | `Position`, `Size`, `TextWrap`, `TextFlow`, `ZOrder`, render matrix, group nesting |
| 수식 | `OVER`, `SQRT`, `SUP/SUB`, `MATRIX`, `CASES`, `LONGDIV`, roman-font exceptions |
| 차트 | `ChartType`, `SeriesType`, `ScaleType`, `AxisGrid`, `TextLayout`, `Location`, `View3D` |

### 2.3 현재 프로젝트에서 먼저 확인할 오차 지점

1. `표 위치`, `행 분할`, `반복 머리행`
2. `문단 들여쓰기`, `줄간격`, `탭 정렬`
3. `쪽 정의`, `머리말/꼬리말`, `쪽 번호`
4. `그림/도형` 감싸기와 anchor offset
5. `수식 baseline`과 script 배치
6. `차트 범례/축 제목` 위치와 인쇄용 텍스트 길이 처리

## 2.4 문서별 최고 위험 지점

| 문서 | 위험 지점 | 반드시 취할 대응 |
|---|---|---|
| `hwp-5.0` | `CTRL_HEADER` polymorphic payload, `TabDef` 길이 모호점, version-gated trailing field | tag별 raw body 보존과 typed decode를 동시에 유지한다. |
| `hwpml-3.0` | 단위/기준이 섞인 속성값, `FIELD/FORM/XMLTEMPLATE/SCRIPT` 누락 | raw attribute map과 normalized layout model을 분리한다. |
| `equation` | alias 충돌, roman 예외, baseline과 math axis 혼동, raw script 정규화 | 입력 문자열을 원문 그대로 보존하고 layout tree는 별도 파생 구조로 둔다. |
| `chart` | `VariableData` 생략 규칙, auto/manual side effect, enum value 소실 | raw field cache를 유지하고 렌더러용 정규화 결과는 덮어쓰지 않는다. |
| `distributed-doc` | MSVC `rand()` 불일치, 80-byte hash 오해, read/save 정책 혼선 | 알고리즘 고정 테스트와 읽기/일반 저장/배포용 저장 분기를 분리한다. |

## 3. 편집과 저장에서 절대 잃으면 안 되는 데이터

| 범주 | 보존 대상 |
|---|---|
| 원문 구조 | 알 수 없는 레코드/노드/속성 원문, record order, XML element order, 객체 중첩 순서 |
| 참조 무결성 | 모든 `Id`, `InstId`, `Style` 연결, `BinData` 참조, `Name` 계열 식별자 |
| 호환성 | `CompatibleDocument`, `LayoutCompatibility`, version-gated trailing fields, enum 원값 |
| 본문 개체 | 표 span/row size, object matrices, z-order, caption, field command strings, bookmark names |
| 부가 자산 | script storage, XML template storage, history streams, distributed-doc bytes |
| 수식 | 원문 토큰 문자열, `len`, 색상, baseline, font name, version, script range |
| 차트 | `StoredtypeID`, `ChartObjData`, 데이터 바인딩, 자동/수동 플래그, 인쇄 관련 값 |
| 배포용 문서 | 256-byte distribute-doc 레코드, hashcode, option flags, encrypted stream 구조 |

## 4. 구현 우선순위

### P0

1. `FileHeader + DocInfo + BodyText`의 lossless 파서 고정
2. `HWPML -> HEAD -> BODY -> TAIL` 왕복 보존 경로 완성
3. 문단/구역/쪽/표/개체의 내부 공통 모델 통일
4. 수식 `HWPTAG_EQEDIT` 저장/복원 + 토큰화 기본기 구현
5. 차트 `VtChart` 트리 복원과 `ChartObj` 재귀 파서 구현
6. 배포용 문서 seed/XOR/AES 복호화 경로 구현

### P1

1. 문단/페이지/표 조판 정확도 개선
2. 그림/도형/차트/OLE 배치와 감싸기 정교화
3. header/footer/field/bookmark/autonum round-trip 완성
4. 수식 템플릿 렌더링과 baseline 정렬 보정
5. 차트 축/범례/시리즈/제목 렌더링 구현

### P2

1. 3D 차트, 통계선, 등고선
2. 배포용 문서 재배포 저장 정책
3. 스크립트/XMLTemplate/문서 이력 전체 보존 UI
4. 의미를 모르는 개체에 대한 opaque edit-safe 저장

## 5. 회귀검증 기준

### 5.1 파서 회귀

- 샘플 HWP/HWPX/HWPML 파일을 열고 다시 저장한 뒤 구조 diff가 최소인지 확인한다.
- 알 수 없는 레코드와 속성이 유실되지 않는지 확인한다.
- `BinData`, `InstId`, `Style` 참조가 깨지지 않는지 확인한다.

### 5.2 레이아웃 회귀

- 페이지 수
- 페이지별 텍스트 블록 수
- 표 행/열 수와 셀 병합 상태
- 머리말/꼬리말 존재 여부
- 개체 anchor 좌표와 z-order
- 수식 baseline과 분수/루트 템플릿 배치
- 차트 축/범례/제목/데이터 시리즈의 bounding box

### 5.3 저장 회귀

- 원본 재열기 시 오류가 없는지 확인한다.
- 배포용 문서는 제한 플래그와 암호화 구조가 유지되는지 확인한다.
- 수식/차트는 입력 문자열과 구조가 보존되는지 확인한다.

### 5.4 문서별 최소 회귀 세트

| 문서 | 최소 회귀 항목 |
|---|---|
| `hwp-5.0` | `DocInfo` index table, 문단 cluster, `CTRL_HEADER`, 표, 개체, section/page control, unknown tag round-trip |
| `hwpml-3.0` | `HEAD/BODY/TAIL` 왕복, `PARASHAPE/CHARSHAPE/PAGEDEF/TABLE/SHAPEOBJECT`, field/form/script/XML 자산 보존 |
| `equation` | 예제 2.1~2.5 파싱/렌더/저장, alias 충돌, roman 예외, baseline snapshot |
| `chart` | bar/line/pie/donut/3D bar 회귀, `Axis/Series/Legend/PrintInformation`, auto/manual flag 보존, enum 원값 보존 |
| `distributed-doc` | seed/XOR/AES 알고리즘, 옵션 플래그, 암호화 스트림 전 범위, 읽기/일반 저장/배포용 저장 정책 분기 |

## 6. 현재 코드베이스에 바로 연결할 작업

1. `js/hwp-parser*.js`
   - 레이아웃 감사용 원문 필드 노출 범위를 넓힌다.
   - 표/개체/수식/차트의 구조 정보를 내부 문서 모델에 보존한다.
2. `js/app.js`
   - 페이지별 레이아웃 diff 표시와 상태바 진단 정보를 넣는다.
   - 저장 시 opaque 보존 대상이 빠지지 않도록 경고 경로를 만든다.
3. `scripts/verify_samples.mjs`
   - 페이지 수 외에 표/개체/수식/차트 검증 항목을 추가한다.
4. 샘플 문서 세트
   - `고엽제`, `incheon`, `attachment-sale-notice` 외에 수식/차트/배포용 샘플을 확보한다.

## 6.1 코드베이스 반영 순서

1. `js/hwp-parser*.js` / `js/hwp-renderer.js`
   - `section/page/table/object/equation/chart` 구조 필드를 진단용으로 노출한다.
   - raw-preserving 저장 경로가 가능한지 ChromeHWP 내부 모델 한계를 먼저 확인한다.
2. `js/app.js`
   - 레이아웃 감사 UI를 `페이지 수` 중심에서 `표/개체/수식/차트` 진단 중심으로 확장한다.
   - 제한 플래그가 있는 배포용 문서는 UI에서 저장/인쇄/복사 정책을 분리 표기한다.
3. `scripts/verify_samples.mjs`
   - 문서별 최소 회귀 세트를 구현 가능한 자동 검증으로 쪼갠다.
   - 수식/차트/배포용 샘플은 별도 fixture군으로 분리한다.
4. fixture 체계
   - 일반 HWP, HWPML/HWPX, 수식 포함 문서, 차트 포함 문서, 배포용 문서를 분리 수집한다.
   - 원본/재저장본/렌더 snapshot 세 벌을 함께 보관한다.

## 7. 결론

- 레이아웃 정확도를 올리려면 `문단/페이지/표/개체`가 먼저이고, 그 다음이 `수식/차트`이옵니다.
- 저장 호환성을 지키려면 `lossless round-trip`을 기본 원칙으로 잡아야 하옵니다.
- 배포용 문서, 수식, 차트는 "보여 주는 것"보다 "원문 구조를 안 잃는 것"을 먼저 끝내야 하옵니다.
