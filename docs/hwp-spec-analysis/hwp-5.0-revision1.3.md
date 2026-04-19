# HWP 5.0 Revision 1.3 구현 분석

- 원문 PDF: `/Users/shinehandmac/Downloads/한글문서파일형식_5.0_revision1.3.pdf`
- 개정: `revision 1.3:20181108`
- 최종 재검토: `2026-04-18`
- 범위: 원문 PDF 전체 재검토 기준. `개요`, `자료형`, `스토리지 구조`, `데이터 레코드`, `문서 이력 관리`, `변경 사항 이력`까지 모두 포함한다.

## 문서 개요

이 문서는 바이너리 HWP 5.0 형식을 구현 입력 수준으로 다시 정리한 것이다. 단순한 요약이 아니라 다음 판단을 바로 내릴 수 있게 하는 데 목적이 있다.

1. 어떤 스트림과 레코드를 우선 파싱해야 하는가
2. 어떤 필드가 실제 조판과 렌더링에 직접 영향을 주는가
3. 현재 구현하지 못하더라도 어떤 바이트를 손실 없이 보존해야 하는가
4. 스펙의 모호한 부분과 버전 게이트를 어디서 조심해야 하는가
5. 회귀 테스트에서 무엇을 눈으로, 무엇을 바이트로 검증해야 하는가

용어는 다음처럼 사용한다.

- `레이아웃 영향`
  - `직접`: 페이지/줄/개체 위치 계산에 바로 사용해야 한다.
  - `간접`: 즉시 조판에는 안 쓰더라도 렌더링 결과나 번호/참조/호환성에 영향을 준다.
  - `없음`: 레이아웃에는 직접 영향이 없다.
- `저장 보존`
  - `필수`: 해석하든 못 하든 반드시 재기록해야 한다.
  - `조건부`: 지원 기능일 때는 구조적으로 이해하고 갱신해야 한다.
  - `opaque`: 의미를 아직 몰라도 원문 바이트 그대로 round-trip 해야 한다.

## 원문 재검토 결과 요약

원문 PDF는 HWP 5.0 바이너리 형식의 골격과 주요 레코드 표는 충분히 제공하지만, 실제 구현 관점에서는 몇 가지 빈칸이 있다.

- `DocInfo` 요약표에만 등장하고 본문 필드 설명이 없는 레코드가 있다.
  - `HWPTAG_MEMO_SHAPE`
  - `HWPTAG_TRACKCHANGE`
  - `HWPTAG_TRACK_CHANGE`
  - `HWPTAG_TRACK_CHANGE_AUTHOR`
  - `HWPTAG_FORBIDDEN_CHAR`
- `BodyText`에서도 요약 또는 브리지 설명만 있고 내부 구조를 외부 문서에 위임하는 영역이 있다.
  - 차트: OLE 내부 `Contents` 또는 `OOXMLChartContents`로 저장되며 상세는 별도 차트 스펙 참조
  - 배포용 문서 데이터: 256 bytes만 정의하고 의미는 별도 배포용 문서 스펙 참조
  - 수식 스크립트: EQN 호환이라고만 하고 별도 수식 스펙으로 위임
- 일부 표는 길이/참조 번호가 어긋나거나 너무 축약되어 있다.
  - `HWPTAG_TAB_DEF`의 `count`는 `INT16`인데 길이 열이 `4`로 표시된다.
  - `HWPTAG_CTRL_HEADER`는 표 64만 보면 전체 길이 4로 오해하기 쉽지만, 실제로는 `CtrlID` 이후의 polymorphic payload를 각 절에서 따로 정의한다.
  - `HWPTAG_EQEDIT`는 스크립트 길이 `len`만 보이는데 수식 버전 문자열과 폰트 이름 문자열에도 같은 `len` 표기를 사용한다.
  - 그림 개체는 `개체 요소 공통 속성(표 80 참조)`라고 적혀 있으나 논리상 `표 83`을 가리키는 것으로 읽는 편이 자연스럽다.

따라서 구현 원칙은 다음이 안전하다.

1. 문서가 명시한 구조는 그대로 해석한다.
2. 명시가 없는 후행 필드, 미상 레코드, 버전별 꼬리 필드는 `opaque`로 보존한다.
3. 길이나 참조가 모호한 표는 실제 샘플과 함께 검증할 때까지 추정 파서를 두지 말고 보수적으로 읽는다.

## 형식 범위와 버전

### 버전 번호 해석

| 필드 | 의미 | 구현 판단 |
|---|---|---|
| `MM` | 구조가 완전히 바뀌는 큰 버전 | 다르면 비호환으로 보고 강한 게이트 필요 |
| `nn` | 큰 구조는 같지만 큰 변화 존재 | 다르면 비호환으로 보는 편이 안전 |
| `PP` | 구조는 같고 레코드 추가/비호환 정보 추가 | 하위 호환 가능, 미상 필드 보존 필요 |
| `rr` | 기존 레코드에 정보가 추가됨 | 후행 필드 보존 필수 |

### revision 1.3 변경 이력 반영점

원문 마지막 변경 이력에 따르면 revision 1.3은 다음을 추가하거나 수정했다.

| 항목 | 구현 영향 |
|---|---|
| 참고 문헌 | `Bibliography` storage 보존 필요 |
| 차트 개체 | 차트가 OLE 브리지라는 점과 외부 스펙 참조 경로 반영 |
| 동영상 개체 | `HWPTAG_VIDEO_DATA` 파서/보존 경로 추가 |
| 그림 추가 속성 | 그림 효과/추가 속성 후행 바이트 보존 필요 |
| 파일 인식 정보 추가 | `FileHeader` 플래그 비트 16, 17 등 최신 플래그 반영 |
| 수식 개체 속성 추가 | `HWPTAG_EQEDIT` 후행 문자열과 baseline 보존 |
| 글머리표 추가 | `HWPTAG_BULLET` 해석 및 저장 추가 |
| 필드 컨트롤 ID 추가 | 변경 추적/메모/개인정보/TOC 필드 ID 대응 |
| 개체 공통 속성 수정 | 앵커/감싸기/z-order 해석을 최신 비트 기준으로 맞춤 |
| 문단 번호 수정 | 레벨별 시작 번호, 확장 번호 형식 보존 강화 |

### 구현에 직접 걸리는 버전 게이트

| 버전 게이트 | 위치 | 영향 |
|---|---|---|
| `5.0.1.0 이상` | `HWPTAG_TABLE`의 `Valid Zone Info Size`와 영역 속성 | 표 영역별 border/fill 적용 |
| `5.0.1.5 이상` | `구역 정의`의 `대표Language` | 구역별 언어 fallback |
| `5.0.1.7 이상` | `ParaShape 속성 2`, `DocHistory`, 문서 이력 관리 | 저장 호환성과 이력 storage 처리 |
| `5.0.2.1 이상` | `CharShapeBorderFill ID`, `MemoShape` ID mapping index | 글자 배경/테두리 및 메모 모양 |
| `5.0.2.5 이상` | `Numbering` 수준별 시작 번호, `ParaShape 속성 3`, 새 줄간격 필드 | 번호/줄간격 충실도 |
| `5.0.3.0 이상` | `CharShape` 취소선 색 | 렌더 색상 충실도 |
| `5.0.3.2 이상` | `TrackChange`, `TrackChangeAuthor`, `ParaHeader 변경추적 병합 플래그` | 변경 추적 보존 |
| `5.1.0.0 이상` | `Numbering`의 확장 수준(8-10) 시작 번호 | forward compatibility. 이 문서 범위를 넘어도 후행 DWORD 보존 필요 |

### 이 PDF가 직접 풀어주지 않는 영역

- 배포용 문서 데이터 의미와 복호화 절차: 별도 배포용 문서 스펙
- 수식 스크립트 구문: 별도 수식 스펙
- 차트 `Contents` 내부 구조와 `OOXMLChartContents`: 별도 차트 스펙 또는 OOXML Chart
- HWPML/HWPX 계열 의미론: 별도 HWPML 문서
- 변경 추적/메모/금칙처리의 세부 필드 구조: 이 문서에는 요약명만 존재

## 자료형과 바이트 규칙

### 기본 규칙

- 모든 다중 바이트 정수는 little-endian이다.
- `WCHAR`는 한글 내부 코드 기반 2-byte 문자이며, 구현에서는 UTF-16LE 2-byte 단위로 다루는 편이 안전하다.
- `HWPUNIT`과 `SHWPUNIT`는 `1/7200 inch` 단위다.
- `COLORREF`는 `0x00bbggrr` 순서다.
- `BYTE stream`은 별도 구조를 가리키는 바이트 블록이라는 뜻이며, 표 안의 다른 구조 표를 참조해 다시 해석해야 한다.

### 구현에서 자주 쓰는 자료형

| 자료형 | 길이 | 의미 |
|---|---:|---|
| `BYTE` | 1 | 부호 없는 1 byte |
| `WORD` | 2 | 16-bit unsigned |
| `DWORD`, `UINT32`, `UINT` | 4 | 32-bit unsigned |
| `INT8`, `INT16`, `INT32` | 1, 2, 4 | signed 정수 |
| `WCHAR` | 2 | 문자 1개 |
| `HWPUNIT`, `SHWPUNIT` | 4 | 문서 내부 길이 단위 |
| `HWPUNIT16` | 2 | `INT16`과 같은 크기의 내부 길이 단위 |
| `COLORREF` | 4 | RGB 색상 |

## 컨테이너와 스트림 구조

### 최상위 OLE storage/stream

| 경로 | 압축 | 암호화 | 역할 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|---|
| `FileHeader` | 아니오 | 아니오 | 시그니처, 버전, 전체 기능 플래그 | 간접 | 필수 |
| `DocInfo` | 가능 | 가능 | 공통 테이블, 스타일, 번호, 호환성 | 직접 | 필수 |
| `BodyText/Section*` | 가능 | 가능 | 문단, 컨트롤, 개체, 구역 데이터 | 직접 | 필수 |
| `\005HwpSummaryInformation` | 아니오 | 아니오 | OLE Summary Info 메타데이터 | 없음 | 필수 |
| `BinData/BinaryData*` | 가능 | 아니오 | 그림/OLE/첨부 바이너리 | 간접 | 필수 |
| `PrvText` | 아니오 | 아니오 | 미리보기 텍스트 | 없음 | 조건부 |
| `PrvImage` | 아니오 | 아니오 | 미리보기 이미지(BMP/GIF) | 없음 | 조건부 |
| `DocOptions/*` | 가변 | 가변 | 링크 문서, DRM, 전자서명 관련 보조 정보 | 없음 | opaque |
| `Scripts/JScriptVersion` | 아니오 | 아니오 | 스크립트 버전 8 bytes | 없음 | 필수 |
| `Scripts/DefaultJScript` | 아니오 | 아니오 | header/source/pre/post source | 없음 | 필수 |
| `XMLTemplate/_SchemaName` | 아니오 | 아니오 | 스키마 이름 | 없음 | 필수 |
| `XMLTemplate/Schema` | 아니오 | 아니오 | XML schema 문자열 | 없음 | 필수 |
| `XMLTemplate/Instance` | 아니오 | 아니오 | XML instance 문자열 | 없음 | 필수 |
| `DocHistory/VersionLog*` | 가능 | 가능 | 문서 이력 아이템 스트림 | 없음 | 필수 |
| `DocHistory/HistoryLastDoc` | 가능 | 가능 | 최근 문서 스트림 | 없음 | opaque |
| `Bibliography` | 아니오 | 아니오 | 참고문헌 XML | 없음 | 필수 |

### FileHeader

`FileHeader`는 고정 길이 256 bytes다.

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `signature` | `BYTE[32]` | `"HWP Document File"` | 없음 | 필수 |
| `version` | `DWORD` | `0xMMnnPPrr` | 간접 | 필수 |
| `flags` | `DWORD` | 압축, 암호, 배포용 문서, 스크립트, DRM, XMLTemplate, 문서 이력, 전자서명, 공인인증서, 모바일 최적화, 개인정보, 변경추적, KOGL, 비디오, TOC 필드 포함 여부 | 간접 | 필수 |
| `license flags` | `DWORD` | CCL/공공누리, 복제 제한, 동일조건 복제 허가 | 없음 | 필수 |
| `EncryptVersion` | `DWORD` | 암호화 버전 식별 | 없음 | 필수 |
| `KOGL country` | `BYTE` | `6=KOR`, `15=US` | 없음 | 필수 |
| `reserved` | `BYTE[207]` | 예약 | 없음 | opaque |

구현 메모:

- 플래그가 켜져 있다고 실제 storage가 반드시 온전하다고 가정하지 말고 OLE 존재 여부를 같이 검증한다.
- `reserved`를 0으로 재생성하지 말고 원문 그대로 유지한다.
- `flags.bit16`과 `bit17`은 revision 1.3 기준 최신 추가 플래그다.

### 보조 스트림

| 스트림 | 구조 | 구현 메모 |
|---|---|---|
| `\005HwpSummaryInformation` | OLE property set. `Title`, `Subject`, `Author`, `Keywords`, `Comments`, `LastSavedBy`, `RevisionNumber`, `LastPrinted`, `Create/Save time`, `PageCount`, `Date String`, `Para Count` 등이 저장됨 | 직접 편집하지 않더라도 손실 없이 보존. 저장기가 메타데이터를 재작성할 때만 필드별 갱신 |
| `PrvText` | 유니코드 문자열 | 검색용/미리보기용 보조 정보로 보고 본문 source of truth로 사용하지 않음 |
| `PrvImage` | BMP 또는 GIF | 렌더러 출력과 별개로 보존 |
| `Scripts/JScriptVersion` | `DWORD high`, `DWORD low` | 스크립트가 있으면 같이 저장 |
| `Scripts/DefaultJScript` | header, source, pre source, post source, end flag `-1` | 문자열 블록 순서 보존 |
| `XMLTemplate/*` | 길이 + 문자열 | 스키마/인스턴스를 모르면 opaque로 보존 |
| `Bibliography` | XML 파일 | 별도 해석하지 않아도 XML payload 유지 |

### 제어 문자와 포인터 모델

본문의 `PARA_TEXT`에는 일반 문자와 제어 문자가 함께 섞인다. 제어 문자를 무시하면 이후 레코드의 의미가 모두 어긋난다.

| 코드 | 의미 | 형식 | 구현 메모 |
|---:|---|---|---|
| `2` | 구역 정의/단 정의 | extended | 문단의 컨트롤 체인을 시작함 |
| `3` | 필드 시작 | extended | 필드 payload와 `CTRL_DATA` 연결 필요 |
| `4` | 필드 끝 | inline | 필드 범위 종료 |
| `8` | title mark | inline | range 처리와 연결될 수 있음 |
| `9` | 탭 | inline | `TabDef`와 함께 조판 |
| `10` | 한 줄 끝 | char | 강제 줄바꿈 |
| `11` | 그리기 개체/표 | extended | 개체 컨트롤 파싱 시작 |
| `13` | 문단 끝 | char | 문단 종료 식별 |
| `15` | 숨은 설명 | extended | 보안 레벨에 따라 무효화될 수 있음 |
| `16` | 머리말/꼬리말 | extended | 별도 문단 리스트를 가짐 |
| `17` | 각주/미주 | extended | 별도 문단 리스트를 가짐 |
| `18` | 자동 번호 | extended | 번호 범주/표현 유지 |
| `21` | 페이지 컨트롤 | extended | 감추기, 새 번호, 홀짝 조정 등 |
| `22` | 책갈피/찾아보기 표식 | extended | 일부 정보는 `CTRL_DATA`에 저장 |
| `23` | 덧말/글자 겹침 | extended | 인라인처럼 보이지만 별도 payload 필요 |
| `24` | 하이픈 | char | 문자 단위 렌더 영향 |
| `30` | 묶음 빈칸 | char | 폭 보존 필요 |
| `31` | 고정폭 빈칸 | char | 폭 보존 필요 |

문단 내부 extended control은 `8 WCHAR` 크기의 포인터 슬롯을 갖는다. `PARA_TEXT`에서 extended control을 만났을 때 뒤따르는 `HWPTAG_CTRL_HEADER` 체인과 1:1로 매칭해야 한다.

## 데이터 레코드 공통 규칙

### 레코드 헤더

| 비트 | 필드 | 의미 |
|---|---|---|
| 0-9 | `TagID` | 데이터 종류 |
| 10-19 | `Level` | 논리적 중첩 depth |
| 20-31 | `Size` | 데이터 길이 |

추가 규칙:

- `Size == 0xFFF`이면 바로 뒤에 `DWORD` 확장 길이가 한 번 더 온다.
- `TagID` 범위:
  - `0x000-0x00F`: 특수 용도
  - `0x010-0x1FF`: 한글 내부용 예약
  - `0x200-0x3FF`: 외부 애플리케이션 사용 가능

### 공통 파서 규칙

1. OLE stream을 읽기 전에 `FileHeader.flags`로 압축/암호 여부를 확인한다.
2. 레코드 헤더를 읽을 때 `TagID/Level/Size`를 먼저 분리한다.
3. `Level`은 중첩 레코드의 logical depth이므로 tree를 만들 때 사용한다.
4. 미상 `TagID`, 예약 태그, 확장 길이 레코드는 payload를 통째로 보관한다.
5. 기존 구현이 이해하지 못하는 후행 바이트는 버전 꼬리필드로 보고 버리지 않는다.

### 구현 함정

- `Level`을 XML식 parent/child와 동일시하면 안 된다. HWP는 논리 묶음과 직렬 레코드 순서를 같이 쓴다.
- `HWPTAG_CTRL_HEADER`는 사실상 polymorphic prefix다. `CtrlID`만 읽고 끝내면 바로 뒤 컨트롤 payload를 놓친다.
- `PARA_LINE_SEG`는 cache다. 렌더 fidelity 확인에는 중요하지만 편집 후 저장에서 source of truth로 삼으면 안 된다.
- `0x200-0x3FF` 외부 태그 영역은 향후 확장 가능성이 있으므로 무조건 opaque round-trip 한다.

## DocInfo 레코드 상세

### DocInfo 레코드 요약

| 레코드 | Tag Value | 길이 | 역할 | 레이아웃 영향 | 저장 보존 |
|---|---:|---|---|---|---|
| `HWPTAG_DOCUMENT_PROPERTIES` | `BEGIN+0` | 26 | 구역 수, 시작 번호, caret | 간접 | 필수 |
| `HWPTAG_ID_MAPPINGS` | `BEGIN+1` | 72+ | ID table 크기 | 간접 | 필수 |
| `HWPTAG_BIN_DATA` | `BEGIN+2` | 가변 | 바이너리 데이터 메타 | 간접 | 필수 |
| `HWPTAG_FACE_NAME` | `BEGIN+3` | 가변 | 글꼴 정의 | 직접 | 필수 |
| `HWPTAG_BORDER_FILL` | `BEGIN+4` | 가변 | 선/배경/채우기 | 직접 | 필수 |
| `HWPTAG_CHAR_SHAPE` | `BEGIN+5` | 72 | 글자 모양 | 직접 | 필수 |
| `HWPTAG_TAB_DEF` | `BEGIN+6` | 가변 | 탭 정지점 | 직접 | 필수 |
| `HWPTAG_NUMBERING` | `BEGIN+7` | 가변 | 번호 포맷 | 직접 | 필수 |
| `HWPTAG_BULLET` | `BEGIN+8` | 20 | 글머리표 | 직접 | 필수 |
| `HWPTAG_PARA_SHAPE` | `BEGIN+9` | 54 | 문단 모양 | 직접 | 필수 |
| `HWPTAG_STYLE` | `BEGIN+10` | 가변 | 스타일 연결 | 간접 | 필수 |
| `HWPTAG_DOC_DATA` | `BEGIN+11` | 가변 | 문서 임의 데이터 | 없음 | 필수 |
| `HWPTAG_DISTRIBUTE_DOC_DATA` | `BEGIN+12` | 256 | 배포용 문서 데이터 | 없음 | opaque |
| `HWPTAG_COMPATIBLE_DOCUMENT` | `BEGIN+14` | 4 | 대상 프로그램 | 간접 | 필수 |
| `HWPTAG_LAYOUT_COMPATIBILITY` | `BEGIN+15` | 20 | 호환성 스위치 | 직접 | 필수 |
| `HWPTAG_TRACKCHANGE` | `BEGIN+16` | 1032? | 변경 추적 정보 | 간접 | opaque |
| `HWPTAG_MEMO_SHAPE` | `BEGIN+76` | 22 | 메모 모양 | 간접 | opaque |
| `HWPTAG_FORBIDDEN_CHAR` | `BEGIN+78` | 가변 | 금칙 문자 | 직접 | opaque |
| `HWPTAG_TRACK_CHANGE` | `BEGIN+80` | 가변 | 변경 추적 내용/모양 | 간접 | opaque |
| `HWPTAG_TRACK_CHANGE_AUTHOR` | `BEGIN+81` | 가변 | 변경 추적 작성자 | 간접 | opaque |

### 4.2.1 문서 속성

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `sectionCount` | `UINT16` | `BodyText/Section*` 개수 | 간접 | 필수 |
| `pageStart` | `UINT16` | 쪽 번호 시작값 | 간접 | 필수 |
| `footnoteStart` | `UINT16` | 각주 번호 시작값 | 간접 | 필수 |
| `endnoteStart` | `UINT16` | 미주 번호 시작값 | 간접 | 필수 |
| `figureStart` | `UINT16` | 그림 번호 시작값 | 간접 | 필수 |
| `tableStart` | `UINT16` | 표 번호 시작값 | 간접 | 필수 |
| `equationStart` | `UINT16` | 수식 번호 시작값 | 간접 | 필수 |
| `caretListId` | `UINT32` | 캐럿이 있던 리스트 ID | 없음 | 필수 |
| `caretParaId` | `UINT32` | 캐럿 문단 ID | 없음 | 필수 |
| `caretCharPos` | `UINT32` | 문단 내 문자 위치 | 없음 | 필수 |

구현 메모:

- `sectionCount`와 실제 `Section*` stream 수가 다르면 파일이 손상되었을 수 있다. 우선 OLE 실제 수를 신뢰하되 차이를 경고한다.
- 시작 번호는 `SectionDef`, `AutoNumber`, `NewNumber`와 함께 번호 연산의 base가 된다.

### 4.2.2 아이디 매핑 헤더

`INT32[18]` 배열로 각 indexed table의 개수를 보관한다.

| 인덱스 | 의미 | 비고 |
|---:|---|---|
| 0 | BinData | 그림/OLE/동영상 참조 |
| 1-7 | 한글/영어/한자/일어/기타/기호/사용자 글꼴 | `FaceName` 테이블 |
| 8 | BorderFill | 문단/표/글자 배경 |
| 9 | CharShape | 글자 모양 |
| 10 | TabDef | 탭 정의 |
| 11 | Numbering | 문단 번호 |
| 12 | Bullet | 글머리표 |
| 13 | ParaShape | 문단 모양 |
| 14 | Style | 스타일 |
| 15 | MemoShape | `5.0.2.1 이상` |
| 16 | TrackChange | `5.0.3.2 이상` |
| 17 | TrackChangeAuthor | `5.0.3.2 이상` |

구현 메모:

- 배열 길이는 원문상 18이지만 `doc version에 따라 가변적`이라고 적혀 있다. 길이가 더 길면 후행 count들도 raw 보존한다.
- ID table 개수와 실제 레코드 개수가 맞지 않는 샘플에 대비해, 파서는 `count`를 upper bound로만 사용하고 EOF까지 검증한다.

### 4.2.3 BinData

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr` | `UINT16` | type/compression/state bitfield | 간접 | 필수 |
| `absPathLen`, `absPath` | `WORD`, `WCHAR[]` | `LINK`일 때 절대 경로 | 없음 | 필수 |
| `relPathLen`, `relPath` | `WORD`, `WCHAR[]` | `LINK`일 때 상대 경로 | 없음 | 필수 |
| `binDataId` | `UINT16` | `EMBEDDING`/`STORAGE`일 때 `BinData/BinaryData*` ID | 간접 | 필수 |
| `extLen`, `extension` | `WORD`, `WCHAR[]` | `EMBEDDING`일 때 확장자(`jpg`, `bmp`, `gif`, `ole`) | 간접 | 필수 |

`attr` 비트:

| 비트 | 의미 |
|---|---|
| `0-3` | `LINK`, `EMBEDDING`, `STORAGE` |
| `4-5` | 기본 모드/강제 압축/강제 비압축 |
| `8-9` | 링크 access 상태 |

구현 메모:

- `LINK`라도 실제 렌더러는 저장된 상대 경로/절대 경로를 그대로 보존해야 한다.
- `STORAGE`는 OLE 개체를 가리키므로 `BinData` storage와 본문 OLE control을 같이 유지해야 한다.

### 4.2.4 FaceName

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr` | `BYTE` | 대체 글꼴/유형 정보/기본 글꼴 존재 플래그 | 직접 | 필수 |
| `fontName` | 길이 + `WCHAR[]` | 주 글꼴 이름 | 직접 | 필수 |
| `altFontType`, `altFontName` | 조건부 | 대체 글꼴 종류와 이름 | 직접 | 필수 |
| `fontTypeInfo[10]` | `BYTE[10]` | family, serif, weight, proportion 등 | 간접 | 필수 |
| `baseFontName` | 조건부 | 기본 글꼴 이름 | 직접 | 필수 |

구현 메모:

- `attr` 비트에 따라 필드 존재 여부가 갈리므로 고정 구조로 읽으면 안 된다.
- 레이아웃 엔진은 최소 `fontName`과 fallback chain을 유지해야 한다.
- 저장기는 `fontTypeInfo`를 무시하더라도 바이트를 잃으면 안 된다.

### 4.2.5 BorderFill

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr` | `UINT16` | 3D, shadow, slash/backslash 대각선, 회전, 중심선 | 직접 | 필수 |
| `lineType[4]` | `UINT8[4]` | 4방향 선 종류 | 직접 | 필수 |
| `lineWidth[4]` | `UINT8[4]` | 4방향 선 굵기 | 직접 | 필수 |
| `lineColor[4]` | `COLORREF[4]` | 4방향 선 색 | 직접 | 필수 |
| `diagType/Width/Color` | `UINT8`, `UINT8`, `COLORREF` | 대각선 정보 | 직접 | 필수 |
| `fillInfo` | 가변 | 단색/이미지/그라데이션 채우기 | 직접 | 필수 |

`fillInfo` 내부:

| 종류 | 핵심 필드 |
|---|---|
| 단색 | 배경색, 무늬색, 무늬 종류 |
| 이미지 | 이미지 채우기 유형, 밝기, 명암, 그림 효과, BinItem ID |
| 그라데이션 | 유형, 시작 각, 중심 X/Y, 번짐 정도, 색 수, 위치 배열, 색 배열, 추가 채우기 속성 |

구현 메모:

- `type`은 bitmask이므로 그라데이션 + 추가 채우기 속성이 함께 붙을 수 있다.
- 이미지 채우기는 `BinData` 참조와 함께 round-trip 해야 한다.

### 4.2.6 CharShape

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `faceId[7]` | `WORD[7]` | 언어별 글꼴 ID | 직접 | 필수 |
| `width[7]` | `UINT8[7]` | 언어별 장평 | 직접 | 필수 |
| `spacing[7]` | `INT8[7]` | 언어별 자간 | 직접 | 필수 |
| `relSize[7]` | `UINT8[7]` | 언어별 상대 크기 | 직접 | 필수 |
| `offset[7]` | `INT8[7]` | 언어별 글자 위치 | 직접 | 필수 |
| `baseSize` | `INT32` | 기준 크기 | 직접 | 필수 |
| `attr` | `UINT32` | 기울임, 진하게, 밑줄, 외곽선, 그림자, 위첨자/아래첨자, 취소선, 강조점, 빈칸, kerning | 직접 | 필수 |
| `shadowOffsetX/Y` | `INT8`, `INT8` | 그림자 간격 | 직접 | 필수 |
| `textColor`, `underlineColor`, `shadeColor`, `shadowColor` | `COLORREF` x4 | 글자 렌더 색상 | 직접 | 필수 |
| `charBorderFillId` | `UINT16` | 글자 테두리/배경 ID, `5.0.2.1 이상` | 직접 | 필수 |
| `strikeColor` | `COLORREF` | 취소선 색, `5.0.3.0 이상` | 직접 | 필수 |

우선순위가 높은 비트:

| 비트 | 의미 |
|---|---|
| `0` | 기울임 |
| `1` | 진하게 |
| `2-3` | 밑줄 위치 |
| `4-7` | 밑줄 모양 |
| `8-10` | 외곽선 |
| `11-12` | 그림자 종류 |
| `15`, `16` | 위첨자, 아래첨자 |
| `18-20` | 취소선 사용 |
| `21-24` | 강조점 종류 |
| `25` | 글꼴에 어울리는 빈칸 사용 |
| `26-29` | 취소선 모양 |
| `30` | kerning |

구현 메모:

- 언어별 7개 배열은 같은 인덱스 집합으로 묶여야 한다.
- `attr`만 보고 색상 필드를 생략하지 말고 항상 저장한다.

### 4.2.7 TabDef

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr` | `UINT32` | 문단 왼쪽 끝 자동 탭, 오른쪽 끝 자동 탭 | 직접 | 필수 |
| `count` | `INT16`로 표기, 길이는 `4`로 표기 | 탭 수 | 직접 | 필수 |
| `tabs[count]` | 8 bytes each | 위치, 종류(left/right/center/decimal), 채움, 예약 | 직접 | 필수 |

구현 메모:

- 길이 표기가 `INT16`와 `4 bytes`로 충돌한다. 실제 구현은 샘플 검증 전까지 보수적으로 읽고, 남는 2 bytes를 예약/패딩으로 취급하는 편이 안전하다.

### 4.2.8 Numbering

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `headInfo` | `BYTE stream 8` | 정렬, 번호 폭, 자동 내어쓰기, 거리 종류, 글자 모양 ID, 너비 보정값, 본문 거리 | 직접 | 필수 |
| `format[1..7]` | `len + WCHAR[]` x7 | 레벨별 번호 형식 | 직접 | 필수 |
| `startNumber` | `UINT16` | 기본 시작 번호 | 간접 | 필수 |
| `levelStart[1..7]` | `UINT32` x7 | 수준별 시작 번호, `5.0.2.5 이상` | 직접 | 필수 |
| `extFormat[8..10]` | `len + WCHAR[]` x3 | 확장 번호 형식 | 직접 | 필수 |
| `extLevelStart[8..10]` | `UINT32` x3 | `5.1.0.0 이상` | 직접 | 필수 |

구현 메모:

- 형식 문자열 안의 `^n`, `^N`은 문자 그대로 저장된 제어 코드다.
- 문서 버전이 낮으면 후행 레벨 시작 번호가 없어야 한다. 높으면 있더라도 현재 엔진이 해석하지 못할 수 있으므로 raw 보존한다.

### 4.2.9 Bullet

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `headInfo` | `BYTE stream 8` | 글머리 폭/거리/정렬/글자 모양 ID | 직접 | 필수 |
| `bulletChar` | `WCHAR` | 일반 글머리표 문자 | 직접 | 필수 |
| `imageBulletId` | `INT32` | 이미지 글머리표면 ID, 아니면 0 | 직접 | 필수 |
| `imageBulletInfo` | `BYTE stream 4` | 대비/밝기/효과/ID | 직접 | 필수 |
| `checkBulletChar` | `WCHAR` | 체크 글머리표 문자 | 직접 | 필수 |

### 4.2.10 ParaShape

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr1` | `UINT32` | 정렬, 줄 나눔, 격자, 최소 공백, 외톨이줄 보호, keep-with-next, 문단 보호, 앞쪽 나눔, 세로정렬, 문단 머리 종류/수준, 테두리 연결, 여백 무시, 꼬리 모양 | 직접 | 필수 |
| `marginLeft/Right` | `INT32` | 좌우 여백 | 직접 | 필수 |
| `indent` | `INT32` | 들여쓰기/내어쓰기 | 직접 | 필수 |
| `spacingTop/Bottom` | `INT32` | 문단 위/아래 간격 | 직접 | 필수 |
| `lineSpacingLegacy` | `INT32` | `5.0.2.5 미만` 줄 간격 | 직접 | 필수 |
| `tabDefId` | `UINT16` | 탭 정의 참조 | 직접 | 필수 |
| `numberingOrBulletId` | `UINT16` | 번호 또는 글머리표 참조 | 직접 | 필수 |
| `borderFillId` | `UINT16` | 문단 테두리/배경 참조 | 직접 | 필수 |
| `borderPadding[4]` | `INT16[4]` | 문단 테두리 안쪽 간격 | 직접 | 필수 |
| `attr2` | `UINT32` | 한 줄 입력, 한글-영어/숫자 간격 자동 조절, `5.0.1.7 이상` | 직접 | 필수 |
| `attr3` | `UINT32` | 새 줄 간격 종류, `5.0.2.5 이상` | 직접 | 필수 |
| `lineSpacingNew` | `UINT32` | 새 줄 간격 값, `5.0.2.5 이상` | 직접 | 필수 |

핵심 비트:

| 필드 | 비트 | 의미 |
|---|---|---|
| `attr1` | `2-4` | 정렬 방식 |
| `attr1` | `5-7` | 줄 나눔 기준(영어/한글) |
| `attr1` | `16` | 외톨이줄 보호 |
| `attr1` | `17` | 다음 문단과 함께 |
| `attr1` | `19` | 문단 앞에서 항상 쪽 나눔 |
| `attr1` | `20-21` | 세로 정렬 |
| `attr1` | `23-24` | 문단 머리 종류(개요/번호/글머리표) |
| `attr1` | `25-27` | 문단 수준 |
| `attr2` | `4`, `5` | 한글-영어/숫자 자동 간격 |
| `attr3` | `0-4` | 줄 간격 종류(글자에 따라/고정/여백만/최소) |

### 4.2.11 Style

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `localName`, `enName` | 길이 + `WCHAR[]` | 스타일 이름 | 간접 | 필수 |
| `attr` | `BYTE` | 스타일 종류(문단/글자) | 간접 | 필수 |
| `nextStyleId` | `BYTE` | 다음 스타일 참조 | 간접 | 필수 |
| `langId` | `INT16` | 언어 ID | 간접 | 필수 |
| `paraShapeId` | `UINT16` | 문단 스타일일 때 필수 | 간접 | 필수 |
| `charShapeId` | `UINT16` | 글자 스타일일 때 필수 | 간접 | 필수 |

구현 메모:

- 스타일 종류가 문단이면 `paraShapeId`, 글자면 `charShapeId`를 반드시 유지해야 한다.

### 4.2.12 DocData

`DocData`는 label 문서 여부, 인쇄 대화상자 정보 등을 담는 Parameter Set의 집합이다.

| 필드 | 의미 |
|---|---|
| `ParameterSet.id` | 파라미터 셋 ID |
| `ParameterSet.itemCount` | 아이템 개수 |
| `ParameterItem.id` | 아이템 ID |
| `ParameterItem.type` | `PIT_NULL`, `PIT_BSTR`, `PIT_I1`, `PIT_I2`, `PIT_I4`, `PIT_I`, `PIT_UI1`, `PIT_UI2`, `PIT_UI4`, `PIT_UI`, `PIT_SET`, `PIT_ARRAY`, `PIT_BINDATA` |
| `ParameterItem.data` | 타입별 payload |

구현 메모:

- 의미를 모르는 파라미터 셋이라도 ID와 타입, 바이트 순서를 그대로 유지해야 한다.

### 4.2.13 배포용 문서 데이터

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `raw` | `BYTE[256]` | 배포용 문서 데이터 | 없음 | opaque |

구현 메모:

- 의미 해석은 별도 문서에 위임되어 있으므로 이 문서만으로는 raw bytes 그대로 보존하는 것이 맞다.

### 4.2.14 호환 문서 / 4.2.15 레이아웃 호환성

| 레코드 | 필드 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `CompatibleDocument` | `targetProgram` | `0=current`, `1=HWP2007`, `2=MS Word` | 간접 | 필수 |
| `LayoutCompatibility` | `char/para/section/object/field` 각 `UINT32` | 분야별 호환성 스위치 | 직접 | 필수 |

구현 메모:

- `LayoutCompatibility`의 비트 의미는 이 PDF에 나오지 않으므로 값 자체를 opaque compatibility token처럼 유지해야 한다.

### 본문이 없는 DocInfo 레코드

| 레코드 | 현재 알 수 있는 사실 | 구현 방침 |
|---|---|---|
| `HWPTAG_MEMO_SHAPE` | 길이 22, ID mapping index 15와 연결 | raw bytes 보존 |
| `HWPTAG_TRACKCHANGE` | 요약표상 존재, 길이 1032로 읽힘 | raw bytes 보존 |
| `HWPTAG_TRACK_CHANGE` | 변경 추적 내용 및 모양 | raw bytes 보존 |
| `HWPTAG_TRACK_CHANGE_AUTHOR` | 변경 추적 작성자 | raw bytes 보존 |
| `HWPTAG_FORBIDDEN_CHAR` | 금칙처리 문자 | raw bytes 보존, 조판기에서는 별도 실험 후 적용 |

## BodyText/Section 레코드 상세

### Section stream 기본 규칙

- `BodyText`는 구역별로 `Section%d` stream으로 나뉜다.
- 각 구역의 첫 문단에는 구역 정의 레코드가 저장된다.
- 각 단 설정의 첫 문단에는 단 정의 레코드가 저장된다.
- 각 구역 끝에는 확장 바탕쪽 관련 정보가 저장될 수 있다.
- 마지막 구역 끝에는 메모 관련 정보가 저장될 수 있다.

### 본문 레코드 요약

| 레코드 | Tag Value | 길이 | 역할 |
|---|---:|---|---|
| `HWPTAG_PARA_HEADER` | `BEGIN+50` | 24 | 문단 메타 |
| `HWPTAG_PARA_TEXT` | `BEGIN+51` | 가변 | 문단 텍스트와 제어 문자 |
| `HWPTAG_PARA_CHAR_SHAPE` | `BEGIN+52` | 가변 | 글자 모양 run |
| `HWPTAG_PARA_LINE_SEG` | `BEGIN+53` | 가변 | 줄 cache |
| `HWPTAG_PARA_RANGE_TAG` | `BEGIN+54` | 가변 | 겹칠 수 있는 영역 태그 |
| `HWPTAG_CTRL_HEADER` | `BEGIN+55` | prefix 4 + polymorphic payload | 컨트롤 식별 |
| `HWPTAG_LIST_HEADER` | `BEGIN+56` | 6 | 문단 리스트 헤더 |
| `HWPTAG_PAGE_DEF` | `BEGIN+57` | 40 | 용지 설정 |
| `HWPTAG_FOOTNOTE_SHAPE` | `BEGIN+58` | 26 | 각주/미주 모양 |
| `HWPTAG_PAGE_BORDER_FILL` | `BEGIN+59` | 12 | 쪽 테두리/배경 |
| `HWPTAG_SHAPE_COMPONENT` | `BEGIN+60` | 가변 | 개체 요소 공통 속성 |
| `HWPTAG_TABLE` | `BEGIN+61` | 가변 | 표 개체 |
| `HWPTAG_SHAPE_COMPONENT_LINE` | `BEGIN+62` | 18 | 선 |
| `HWPTAG_SHAPE_COMPONENT_RECTANGLE` | `BEGIN+63` | 33 | 사각형 |
| `HWPTAG_SHAPE_COMPONENT_ELLIPSE` | `BEGIN+64` | 60 | 타원 |
| `HWPTAG_SHAPE_COMPONENT_ARC` | `BEGIN+65` | 28 | 호 |
| `HWPTAG_SHAPE_COMPONENT_POLYGON` | `BEGIN+66` | 가변 | 다각형 |
| `HWPTAG_SHAPE_COMPONENT_CURVE` | `BEGIN+67` | 가변 | 곡선 |
| `HWPTAG_SHAPE_COMPONENT_OLE` | `BEGIN+68` | 24 | OLE 개체 |
| `HWPTAG_SHAPE_COMPONENT_PICTURE` | `BEGIN+69` | 가변 | 그림 개체 |
| `HWPTAG_SHAPE_COMPONENT_CONTAINER` | `BEGIN+70` | 가변 | 묶음 개체 |
| `HWPTAG_CTRL_DATA` | `BEGIN+71` | 가변 | 필드 이름, 하이퍼링크, 책갈피 이름 등 |
| `HWPTAG_EQEDIT` | `BEGIN+72` | 가변 | 수식 개체 |
| `HWPTAG_SHAPE_COMPONENT_TEXTART` | `BEGIN+74` | 가변 | 글맵시 |
| `HWPTAG_FORM_OBJECT` | `BEGIN+75` | 가변 | 양식 개체 |
| `HWPTAG_MEMO_SHAPE` | `BEGIN+76` | 22 | 메모 모양 |
| `HWPTAG_MEMO_LIST` | `BEGIN+77` | 4 | 메모 리스트 헤더 |
| `HWPTAG_CHART_DATA` | `BEGIN+79` | 2 | 차트 데이터 브리지 |
| `HWPTAG_VIDEO_DATA` | `BEGIN+82` | 가변 | 비디오 데이터 |
| `HWPTAG_SHAPE_COMPONENT_UNKNOWN` | `BEGIN+99` | 36 | 미상 개체 |

### 문단 클러스터

문단은 대체로 다음 묶음으로 저장된다.

`PARA_HEADER -> PARA_TEXT -> PARA_CHAR_SHAPE -> PARA_LINE_SEG -> PARA_RANGE_TAG -> CTRL_HEADER/CTRL_DATA/...`

#### `HWPTAG_PARA_HEADER`

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `nchars` | `UINT32` | 문자 수. 최상위 비트가 켜져 있으면 먼저 제거 | 직접 | 필수 |
| `controlMask` | `UINT32` | `(1 << ctrlch)` bitset | 직접 | 필수 |
| `paraShapeId` | `UINT16` | 문단 모양 참조 | 직접 | 필수 |
| `paraStyleId` | `UINT8` | 문단 스타일 참조 | 간접 | 필수 |
| `breakType` | `UINT8` | 구역/다단/쪽/단 나눔 | 직접 | 필수 |
| `charShapeCount` | `UINT16` | `PARA_CHAR_SHAPE` run 수 | 간접 | 필수 |
| `rangeTagCount` | `UINT16` | `PARA_RANGE_TAG` 수 | 간접 | 필수 |
| `lineSegCount` | `UINT16` | `PARA_LINE_SEG` 수 | 간접 | 필수 |
| `instanceId` | `UINT32` | 문단 unique ID | 없음 | 필수 |
| `trackMerge` | `UINT16` | 변경추적 병합 문단 여부, `5.0.3.2 이상` | 간접 | 필수 |

`breakType` 비트:

| 값 | 의미 |
|---|---|
| `0x01` | 구역 나누기 |
| `0x02` | 다단 나누기 |
| `0x04` | 쪽 나누기 |
| `0x08` | 단 나누기 |

#### `HWPTAG_PARA_TEXT`

| 필드 | 의미 |
|---|---|
| `WCHAR[nchars]` | 일반 문자 + 제어 문자 포함 텍스트 |

구현 메모:

- `nchars < 1`이면 `PARA_BREAK`만 있는 빈 문단으로 취급한다.
- extended control은 텍스트 안에서 8 WCHAR를 차지하므로 글자수 계산과 커서 위치 계산에서 일반 문자와 다르게 취급해야 한다.

#### `HWPTAG_PARA_CHAR_SHAPE`

| 필드 | 타입 | 의미 |
|---|---|---|
| `pos` | `UINT32` | 글자 모양이 바뀌는 시작 위치 |
| `charShapeId` | `UINT32` | 적용할 `CharShape` ID |

구현 메모:

- 최소 1개 run이 있어야 하고 첫 `pos`는 반드시 `0`이어야 한다.
- run 수는 `ParaHeader.charShapeCount`와 일치해야 한다.

#### `HWPTAG_PARA_LINE_SEG`

`PARA_LINE_SEG`는 각 줄 cache다.

| 필드 | 의미 |
|---|---|
| `textStartPos` | 줄 시작 텍스트 위치 |
| `lineVerticalPos` | 줄 세로 위치 |
| `lineHeight` | 줄 높이 |
| `textPartHeight` | 텍스트 영역 높이 |
| `baselineDistance` | 줄 위치에서 baseline까지 거리 |
| `lineSpacing` | 줄 간격 |
| `columnStartPos` | 컬럼 내 시작 위치 |
| `segmentWidth` | 세그먼트 폭 |
| `tag` | 첫 줄/컬럼 첫 줄/빈 세그먼트/줄 첫 세그먼트/줄 마지막 세그먼트/auto-hyphenation/indentation/문단머리 적용 등 |

구현 메모:

- 재조판 엔진은 이 값을 그대로 재사용하지 말고 검증용 cache로만 사용한다.

#### `HWPTAG_PARA_RANGE_TAG`

| 필드 | 타입 | 의미 |
|---|---|---|
| `start` | `UINT32` | 영역 시작 |
| `end` | `UINT32` | 영역 끝 |
| `tag` | `UINT32` | 상위 8 bits = 종류, 하위 24 bits = 종류별 데이터 |

구현 메모:

- range tag는 서로 겹칠 수 있으므로 일반 스타일 run처럼 병합하면 안 된다.

### `CTRL_HEADER`, `LIST_HEADER`, `CTRL_DATA`

#### `HWPTAG_CTRL_HEADER`

| 필드 | 타입/길이 | 의미 |
|---|---|---|
| `ctrlId` | `UINT32` | 컨트롤 종류 식별자 |

중요:

- 표 64는 4-byte prefix만 보여준다.
- 실제 구현에서는 `ctrlId` 다음 payload를 각 절의 컨트롤 구조 표로 해석해야 한다.
- 즉, `CTRL_HEADER`는 "길이 4의 완결 레코드"가 아니라 "컨트롤 타입을 여는 prefix"로 읽는 편이 안전하다.

#### `HWPTAG_LIST_HEADER`

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 |
|---|---|---|---|
| `paraCount` | `INT16` | 포함 문단 수 | 간접 |
| `attr` | `UINT32` | 텍스트 방향, 줄바꿈 방식, 세로 정렬 | 직접 |

이 구조는 표/머리말/각주/글상자/캡션 등 내부 문단 리스트를 가진 컨트롤에 반복해서 등장한다.

#### `HWPTAG_CTRL_DATA`

| 필드 | 의미 |
|---|---|
| `Parameter Set` | 필드 이름, 하이퍼링크 정보, 책갈피 이름 등 컨트롤 부가 데이터 |

구현 메모:

- `FIELD_*`, 책갈피, 하이퍼링크는 표시와 별도로 command/name이 `CTRL_DATA`에 숨어 있으므로 잃어버리면 round-trip이 깨진다.

## 개체 컨트롤

### 개체 공통 속성

개체 컨트롤 분류:

| CtrlID | 의미 | 공통 속성 | 개체 요소 속성 |
|---|---|---|---|
| `tbl ` | 표 | 예 | 아니오 |
| `$lin/$rec/$ell/$arc/$pol/$cur` | 그리기 개체 | 예 | 예 |
| `eqed` | 한글 수식 | 예 | 아니오 |
| `$pic` | 그림 | 예 | 예 |
| `$ole` | OLE | 예 | 예 |
| `$con` | 묶음 개체 | 예 | 예 |

#### 표 69 개체 공통 속성

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `ctrlId` | `UINT32` | 개체 컨트롤 ID | 간접 | 필수 |
| `attr` | `UINT32` | 앵커/기준/감싸기/측면/번호 범주 | 직접 | 필수 |
| `vertOffset`, `horzOffset` | `HWPUNIT` | 기준점으로부터 오프셋 | 직접 | 필수 |
| `width`, `height` | `HWPUNIT` | 개체 크기 | 직접 | 필수 |
| `zOrder` | `INT32` | z-order | 직접 | 필수 |
| `outerMargin[4]` | `HWPUNIT16[4]` | 외부 4방향 여백 | 직접 | 필수 |
| `instanceId` | `UINT32` | 개체 unique ID | 간접 | 필수 |
| `preventPageBreak` | `INT32` | 쪽 나눔 방지 | 직접 | 필수 |
| `descLen`, `description` | `WORD`, `WCHAR[]` | 개체 설명문 | 없음 | 필수 |

우선순위가 높은 `attr` 비트:

| 비트 | 의미 |
|---|---|
| `0` | 글자처럼 취급 |
| `2` | 줄 간격에 영향 |
| `3-4` | `VertRelTo` (`paper`, `page`, `para`) |
| `5-7` | 세로 상대 배치 (`top/center/bottom/inside/outside` 계열) |
| `8-9` | `HorzRelTo` (`page`, `page`, `column`, `para`) |
| `10-12` | 가로 상대 배치 |
| `13` | 본문 영역으로 세로 위치 제한 |
| `14` | 다른 개체와 겹침 허용 |
| `15-17` | 폭 기준 (`paper/page/column/para/absolute`) |
| `18-19` | 높이 기준 (`paper/page/absolute`) |
| `20` | para 기준일 때 크기 보호 |
| `21-23` | 텍스트 감싸기 (`Square`, `Tight`, `Through`, `TopAndBottom`, `BehindText`, `InFrontOfText`) |
| `24-25` | 좌/우 배치 (`BothSides`, `LeftOnly`, `RightOnly`, `LargestOnly`) |
| `26-28` | 번호 범주 (`none`, `figure`, `table`, `equation`) |

#### 캡션

| 필드 | 의미 |
|---|---|
| `captionList` | 내부 문단 리스트 |
| `captionAttr` | 방향(left/right/top/bottom), 가로 캡션에서 margin 포함 여부 |
| `captionWidth` | 세로 방향일 때만 사용 |
| `captionGap` | 개체와 캡션 간격 |
| `textMaxWidth` | 텍스트 최대 길이. 대체로 개체 폭 |

구현 메모:

- 캡션은 개체 바깥에 별도 문단 리스트를 갖는다.
- 캡션 유무만 저장하고 내용을 잃어버리면 번호 캡션/설명문이 모두 깨진다.

### 표 개체 `HWPTAG_TABLE`

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr` | `UINT32` | 쪽 경계 분할, 제목 줄 자동 반복 | 직접 | 필수 |
| `rowCount`, `colCount` | `UINT16`, `UINT16` | 행/열 수 | 직접 | 필수 |
| `cellSpacing` | `HWPUNIT16` | 셀 사이 간격 | 직접 | 필수 |
| `innerMargin` | 8 bytes | 안쪽 여백 | 직접 | 필수 |
| `rowSize[rowCount]` | `BYTE stream 2*rowCount` | 행 높이 배열 | 직접 | 필수 |
| `borderFillId` | `UINT16` | 표 border/fill | 직접 | 필수 |
| `validZoneInfoSize` | `UINT16`, `5.0.1.0 이상` | 영역 속성 크기 | 직접 | 필수 |
| `zones` | 10 bytes each | 시작/끝 행열 + border fill ID | 직접 | 필수 |
| `cells` | 가변 | 각 셀의 문단 리스트 + 속성 | 직접 | 필수 |

`attr` 비트:

| 비트 | 의미 |
|---|---|
| `0-1` | 쪽 경계에서 나눔 방식 |
| `2` | 제목 줄 자동 반복 |

셀 속성:

| 필드 | 의미 |
|---|---|
| `col`, `row` | 셀 주소 |
| `colSpan`, `rowSpan` | 병합 개수 |
| `width`, `height` | 셀 크기 |
| `margin[4]` | 셀 4방향 여백 |
| `borderFillId` | 셀 border/fill |

구현 메모:

- `rowSize`와 `rowCount`가 맞지 않으면 손상 가능성이 높다.
- `validZoneInfoSize / 10`으로 영역 개수를 얻되, 나머지 바이트가 있으면 opaque로 붙잡아 둔다.
- `heading row repeat`를 렌더에 아직 안 쓰더라도 저장에서는 유지한다.

### 그리기 개체 공통 `HWPTAG_SHAPE_COMPONENT`

#### 개체 요소 공통 속성

| 필드 | 의미 |
|---|---|
| 그룹 내 `x/y offset` | 그룹 좌표계 위치 |
| `groupDepth` | 몇 번 그룹되었는지 |
| `localFileVersion` | 개체 요소의 로컬 버전 |
| `initialWidth/Height` | 최초 생성 크기 |
| `currentWidth/Height` | 현재 크기 |
| `flags` | horz flip, vert flip |
| `rotation` | 회전각 |
| `rotationCenter` | 회전 중심 |
| `renderingInfo` | translation + scale/rotation matrix sequence |

#### 렌더링 정보

| 필드 | 의미 |
|---|---|
| `translationMatrix` | 3x2 matrix |
| `scale/rotationMatrixPairs` | 그룹화될 때마다 증가 |

구현 메모:

- 그룹 개체를 정확히 round-trip하려면 matrix 시퀀스를 원문 순서대로 유지해야 한다.
- 현재 렌더러가 transform을 모두 적용하지 못하더라도 matrix를 잃지 않는 것이 우선이다.

#### 테두리 선 정보

| 필드 | 의미 |
|---|---|
| `lineColor` | 선 색상 |
| `lineWidth` | 선 굵기 |
| `attr` | 선 종류, 끝 모양, 화살표 시작/끝 모양과 크기, 채움 |
| `outlineStyle` | `normal`, `outer`, `inner` |

### 개별 그리기 개체

| 레코드 | 핵심 필드 | 구현 포인트 |
|---|---|---|
| 선 | 시작/끝 좌표, 방향 보정 플래그 | 수직/수평 최초 생성 방향 보정 보존 |
| 사각형 | 모서리 곡률, 좌표 4쌍 | 둥근 모서리 비율 유지 |
| 타원 | 중심, 제1축/제2축 좌표, start/end pos, interval | 호 전환 여부와 arc 종류 보존 |
| 다각형 | `count`, `x[]`, `y[]` | 꼭짓점 순서 보존 |
| 호 | 타원 중심과 축 좌표 | arc 유형 보존 |
| 곡선 | `count`, `x[]`, `y[]`, `segmentType[]` | 선/곡선 segment 구분 유지 |

### 수식 개체 `HWPTAG_EQEDIT`

| 필드 | 타입/길이 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|---|
| `attr` | `UINT32` | 스크립트 범위. 첫 비트 on이면 줄 단위, off면 글자 단위 | 직접 | 필수 |
| `len` | `WORD` | 스크립트 길이 | 직접 | 필수 |
| `script` | `WCHAR[len]` | 한글 수식 스크립트(EQN 호환) | 직접 | 필수 |
| `fontSize` | `HWPUNIT` | 수식 글자 크기 | 직접 | 필수 |
| `textColor` | `COLORREF` | 글자 색상 | 직접 | 필수 |
| `baseline` | `INT16` | baseline | 직접 | 필수 |
| `versionInfo` | `WCHAR[len]` 표기 | 수식 버전 정보 | 간접 | 필수 |
| `fontName` | `WCHAR[len]` 표기 | 수식 폰트 이름 | 직접 | 필수 |

구현 메모:

- 원문 표는 `versionInfo`와 `fontName`에도 별도 길이 필드를 주지 않고 같은 `len`을 재사용한다. 이 부분은 스펙 모호점으로 분리해 관리해야 한다.
- 수식 스크립트의 실제 의미 해석은 별도 수식 스펙으로 위임하고, 이 문서 기준으로는 문자열과 baseline, 폰트 정보를 잃지 않는 것이 우선이다.

### 그림 개체 `HWPTAG_SHAPE_COMPONENT_PICTURE`

| 필드 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|
| 테두리 색/두께/속성 | 그림 외곽선 | 직접 | 필수 |
| 최초 삽입 시 테두리 사각형 좌표 `x[4], y[4]` | 초기 frame | 직접 | 필수 |
| crop `left/top/right/bottom` | 자르기 영역 | 직접 | 필수 |
| 안쪽 여백 | 그림/표 여백 | 직접 | 필수 |
| 그림 정보 | 밝기, 명암, 효과, BinItem ID | 직접 | 필수 |
| `borderTransparency` | 테두리 투명도 | 직접 | 필수 |
| `instanceId` | 개체 고유 ID | 간접 | 필수 |
| 그림 효과 정보 | 그림자, 네온, 부드러운 가장자리, 반사 | 직접 | 필수 |
| 그림 추가 속성 | 최초 생성 시 기준 이미지 크기 2개 + 이미지 투명도 | 직접 | 필수 |

구현 메모:

- 그림 효과는 effect 종류별 하위 payload가 가변이다. 효과를 이해하지 못해도 블록 단위로 보존해야 한다.
- revision 1.3에서 그림 추가 속성이 들어왔으므로, 이전 파서가 78 bytes까지만 읽도록 고정돼 있으면 반드시 깨진다.

### OLE 개체 `HWPTAG_SHAPE_COMPONENT_OLE`

| 필드 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|
| `attr` | draw aspect, moniker, baseline, object type | 직접 | 필수 |
| `extentX`, `extentY` | 자체 크기 | 직접 | 필수 |
| `binDataId` | OLE storage가 있는 `BinData` ID | 간접 | 필수 |
| 테두리 색/두께/속성 | 외곽선 | 직접 | 필수 |

`attr` 해석:

| 비트 | 의미 |
|---|---|
| `0-7` | `DVASPECT_*` |
| `8` | moniker 할당 여부 |
| `9-15` | baseline. `0`은 기본 85%, `1-101`은 0-100% |
| `16-21` | object type (`Unknown`, `Embedded`, `Link`, `Static`, `Equation`) |

### 차트 개체

차트는 본문에서 독립 레코드 트리로 풀어지지 않고 OLE 개체로 저장된다.

| 저장 위치 | 의미 | 구현 방침 |
|---|---|---|
| OLE 최상위 `Contents` | 구 한글 차트 데이터 | 별도 차트 스펙 참조, opaque 보존 가능 |
| OLE 최상위 `OOXMLChartContents` | OOXML `chartSpace` 기반 차트 | 별도 OOXML Chart 해석 또는 opaque 보존 |

구현 메모:

- 한글 2018에서는 `OOXMLChartContents`와 `Contents`가 함께 있을 수 있다.
- `Contents`는 구버전 호환용 예비 데이터일 수 있으므로 둘 다 보존한다.

### 묶음 개체 `HWPTAG_SHAPE_COMPONENT_CONTAINER`

| 필드 | 의미 |
|---|---|
| `count` | 내부 개체 수 |
| `ctrlIdArray[count]` | 포함된 개체 컨트롤 ID |
| `childObjectPayloads` | 그리기/OLE/그림/묶음 개체 payload 반복 |

구현 메모:

- 그룹 내부 개체 순서와 matrix 시퀀스를 같이 보존해야 ungroup/regroup 시 위치가 안 틀어진다.

### 동영상 개체 `HWPTAG_VIDEO_DATA`

| 타입 | 필드 | 구현 메모 |
|---|---|---|
| 로컬 동영상 | 비디오 BinData ID, 썸네일 BinData ID | `BinData`와 연동 |
| 웹 동영상 | 웹 태그 문자열, 썸네일 BinData ID | 태그 문자열 보존 |

## 개체 이외의 컨트롤

### 컨트롤 ID 요약

| CtrlID | 의미 | 문단 리스트 |
|---|---|---|
| `secd` | 구역 정의 | 예 |
| `cold` | 단 정의 | 아니오 |
| `head`, `foot` | 머리말, 꼬리말 | 예 |
| `fn  `, `en  ` | 각주, 미주 | 예 |
| `atno` | 자동 번호 | 아니오 |
| `nwno` | 새 번호 지정 | 아니오 |
| `pghd` | 감추기 | 아니오 |
| `pgct` | 홀/짝수 조정 | 아니오 |
| `pgnp` | 쪽 번호 위치 | 아니오 |
| `idxm` | 찾아보기 표식 | 아니오 |
| `bokm` | 책갈피 | 아니오. 이름은 `CTRL_DATA` |
| `tcps` | 글자 겹침 | 아니오 |
| `tdut` | 덧말 | 아니오 |
| `tcmt` | 숨은 설명 | 예 |
| `FIELD_*` | 필드 시작 | 종류별로 다름 |

### 4.3.10.1 구역 정의 `secd`

| 필드 | 의미 | 레이아웃 영향 | 저장 보존 |
|---|---|---|---|
| `attr` | 머리말/꼬리말/바탕쪽/테두리/배경/쪽 번호 숨김, 첫 쪽만 테두리/배경, 텍스트 방향, 빈 쪽 감춤, 구역 나눔 시 페이지 번호 적용, 원고지 정서법 | 직접 | 필수 |
| `columnGap` | 같은 페이지의 단 간격 | 직접 | 필수 |
| `vertGrid`, `horzGrid` | 줄맞춤 간격 또는 off | 직접 | 필수 |
| `defaultTabStop` | 기본 탭 간격 | 직접 | 필수 |
| `numberingShapeId` | 번호 문단 모양 ID | 간접 | 필수 |
| `pageNumberStart` | 0=이어받기, n=새 번호 | 간접 | 필수 |
| `figure/table/equationStart[3]` | 번호 시작 | 간접 | 필수 |
| `representativeLanguage` | `5.0.1.5 이상` | 간접 | 필수 |
| 하위 레코드 `PAGE_DEF` | 용지 설정 | 직접 | 필수 |
| 하위 레코드 `FOOTNOTE_SHAPE` x2 | 각주/미주 모양 | 직접 | 필수 |
| 하위 레코드 `PAGE_BORDER_FILL` | 쪽 테두리/배경 | 직접 | 필수 |
| 바탕쪽 정보 | 양쪽/홀수/짝수 바탕쪽 문단 리스트 참조 | 직접 | 필수 |

### 4.3.10.1.1 용지 설정 `HWPTAG_PAGE_DEF`

| 필드 | 의미 |
|---|---|
| 용지 가로/세로 크기 | page size |
| 왼/오/위/아래 여백 | body margin |
| 머리말/꼬리말 여백 | header/footer frame |
| 제본 여백 | binding margin |
| 속성 bit 0 | 방향: 좁게/넓게 |
| 속성 bit 1-2 | 제책 방법: 한쪽 편집/맞쪽 편집/위로 넘기기 |

### 4.3.10.1.2 각주/미주 모양 `HWPTAG_FOOTNOTE_SHAPE`

핵심 필드:

- 번호 모양
- 사용자 기호, 앞 장식, 뒤 장식
- 시작 번호
- 구분선 길이/위 여백/아래 여백/주석 사이 여백
- 구분선 종류/굵기/색상
- 다단 배열 방식
- numbering 정책(이어쓰기/구역별/쪽별)
- 번호 superscript 여부
- 텍스트에 이어 바로 출력할지 여부

### 4.3.10.1.3 쪽 테두리/배경 `HWPTAG_PAGE_BORDER_FILL`

| 필드 | 의미 |
|---|---|
| `attr` | 본문 기준/종이 기준, 머리말 포함, 꼬리말 포함, 채울 영역(종이/쪽/테두리) |
| `margin[4]` | 테두리/배경 위치 간격 |
| `borderFillId` | 참조 ID |

### 4.3.10.2 단 정의 `cold`

| 필드 | 의미 | 레이아웃 영향 |
|---|---|---|
| 단 종류 | 일반/배분/평행 다단 | 직접 |
| 단 개수 | `1-255` | 직접 |
| 단 방향 | 왼쪽부터/오른쪽부터/맞쪽 | 직접 |
| 동일 너비 여부 | 가변 폭 여부 | 직접 |
| 단 사이 간격 | gap | 직접 |
| 단 폭 배열 | 동일 너비가 아닐 때만 사용 | 직접 |
| 단 구분선 종류/굵기/색 | separator line | 직접 |

### 4.3.10.3 머리말/꼬리말 `head` / `foot`

| 필드 | 의미 |
|---|---|
| `attr` | 적용 범위(양쪽/짝수/홀수) |
| `textAreaWidth/Height` | 텍스트 영역 크기 |
| 텍스트/번호 참조 비트 | 각 레벨 참조 여부 |
| 내부 문단 리스트 | 실제 머리말/꼬리말 내용 |

### 4.3.10.4 각주/미주 컨트롤

- 별도 속성은 없지만 쓰레기 값/불필요 업데이트를 줄이기 위해 8 bytes를 serialize 한다.
- 본문은 문단 리스트에 들어 있으므로 문단 리스트 보존이 핵심이다.

### 4.3.10.5 자동 번호 / 4.3.10.6 새 번호 지정

| 컨트롤 | 핵심 필드 |
|---|---|
| 자동 번호 | 번호 종류(쪽/각주/미주/그림/표/수식), 번호 모양, superscript, 번호 값, 사용자/앞/뒤 장식 |
| 새 번호 지정 | 번호 종류 + 새 시작 번호 |

### 4.3.10.7 감추기 / 4.3.10.8 홀짝 조정 / 4.3.10.9 쪽 번호 위치

| 컨트롤 | 핵심 필드 |
|---|---|
| 감추기 | 머리말, 꼬리말, 바탕쪽, 테두리, 배경, 쪽 번호 위치 숨김 bitset |
| 홀짝 조정 | 양쪽/짝수/홀수 |
| 쪽 번호 위치 | 번호 모양, 표시 위치(왼위/가운데위/.../안쪽아래), 사용자/앞/뒤 장식 |

### 4.3.10.10 찾아보기 표식 / 4.3.10.11 책갈피

| 컨트롤 | 핵심 필드 |
|---|---|
| 찾아보기 표식 | 키워드 1, 키워드 2, dummy |
| 책갈피 | 이름은 `HWPTAG_CTRL_DATA`에 저장 |

### 4.3.10.12 글자 겹침 / 4.3.10.13 덧말 / 4.3.10.14 숨은 설명

| 컨트롤 | 핵심 필드 |
|---|---|
| 글자 겹침 | 겹칠 문자열, 테두리 타입, 내부 글자 크기/펼침, 내부 charshape ID 배열 |
| 덧말 | main/sub text, 위치(위/아래/가운데), size ratio, 정렬 기준 |
| 숨은 설명 | 문단 리스트만 포함. 보안 레벨에 따라 무효화 가능 |

### 4.3.10.15 필드 시작

| 필드 | 의미 |
|---|---|
| `ctrlId` | 필드 종류 |
| `attr` | 읽기 전용 수정 가능 여부, 하이퍼링크 글자 속성 업데이트 종류, 필드 내용 수정 여부 |
| `miscAttr` | 기타 속성 |
| `commandLen`, `command` | 필드별 고유 command 문자열 |
| `id` | 문서 내 고유 ID |

필드 `CtrlID` 예:

- 날짜/문서 날짜/파일 경로
- 책갈피/상호참조/메일머지
- 수식/요약/사용자 정보/하이퍼링크
- 변경 추적 계열 필드
- 메모
- 개인정보 보안
- 차례(TOC)

구현 메모:

- 필드는 표시 문자열과 command 문자열을 분리해 보존해야 한다.
- TOC나 하이퍼링크는 `command` 손실 시 재생성이 거의 불가능하다.

## 문서 이력 관리 `DocHistory`

### 저장 구조

- `DocHistory` storage 아래에 `VersionLog%d` stream이 들어간다.
- 각 아이템은 압축되고 암호화되어 저장될 수 있다.
- `HistoryLastDoc` 스트림이 따로 존재할 수 있다.

### 레코드 구조

| 레코드 | Tag | payload |
|---|---:|---|
| 시작 | `0x10` | `flag: WORD`, `option: UINT` |
| 끝 | `0x11` | 없음 |
| 버전 | `0x20` | `DWORD` |
| 날짜 | `0x21` | `SYSTEMDATE` |
| 작성자 | `0x22` | `WCHAR` |
| 설명 | `0x23` | `WCHAR` |
| 비교 정보 | `0x30` | DiffML `WCHAR` |
| 최근 문서 | `0x31` | HWPML `WCHAR` |

`flag` 비트:

| 비트 | 의미 |
|---|---|
| `0x01` | version 존재 |
| `0x02` | date 존재 |
| `0x04` | writer 존재 |
| `0x08` | description 존재 |
| `0x10` | diff data 존재 |
| `LASTDOCDATA` | 최근 문서 존재. 기록하지 않음, 필수라고 명시 |
| `0x40` | lock 상태 |

구현 메모:

- 문서 이력은 현재 렌더와 무관하더라도 별도 storage로 취급해 lossless round-trip 해야 한다.
- `VersionLog*` 내부의 미상 record type도 그대로 보존한다.

## 레이아웃에 직접 영향을 주는 필드

### 우선순위 높은 레이아웃 축

| 축 | 핵심 필드 |
|---|---|
| 문단 조판 | `ParaShape`, `CharShape`, `TabDef`, `Numbering`, `Bullet`, `PARA_LINE_SEG` 검증용 cache |
| 페이지/구역 | `SectionDef`, `PageDef`, `PageBorderFill`, `ColumnsDef`, 머리말/꼬리말 범위 |
| 표 | `rowSize`, `cellSpacing`, `cell span`, `borderFillId`, `zone info`, `heading row repeat` |
| 개체 배치 | `ObjectCommon.attr`, offsets, width/height, z-order, outer margin, caption |
| 그림/도형 | transform matrix, crop, effect chain, line info, fill info |
| 수식 | script, font size, baseline, font name |
| 각주/미주 | numbering mode, separator line, spacing, start number |
| 필드/번호 | field command, page number position, auto number / new number |

### 렌더러가 반드시 소비해야 하는 필드

| 영역 | 필드 |
|---|---|
| 텍스트 | `faceId`, `baseSize`, `spacing`, `relSize`, `offset`, `underline/strike/emphasis`, colors |
| 문단 | 여백, 들여쓰기, 줄간격, 정렬, keep-with-next, page break before, vertical align |
| 탭/번호 | 탭 위치와 종류, 번호 format string, bullet char/image, distance/width adjust |
| 페이지 | 용지 크기, 여백, 머리말/꼬리말 여백, binding, orientation |
| 다단 | column count, width, gap, direction, separator line |
| 표 | row/col count, row size, cell span, cell margin, border/fill, split policy |
| 떠있는 개체 | anchor 기준, 상대 위치, wrap mode, side option, width/height basis, overlap |
| 그림 | crop, transparency, effect chain, initial frame |
| 각주/미주 | separator length/style/color, start number, numbering mode, superscript |
| 쪽 번호 | 위치, 번호 모양, 장식 문자 |

## 편집/저장에서 반드시 보존할 필드

| 범주 | 보존 대상 |
|---|---|
| 헤더/호환성 | `FileHeader` 전체 256 bytes, `CompatibleDocument`, `LayoutCompatibility`, 예약 영역 |
| 레코드 구조 | 모든 `TagID/Level/Size`, 확장 길이, 미상 태그, 외부 태그(`0x200-0x3FF`) |
| DocInfo 참조 | ID mapping count, 미상 후행 count, `Style`, `BinData`, `MemoShape`, 변경 추적 레코드 |
| 문단 구조 | control mask, instance ID, track-merge, `CTRL_DATA`의 parameter set |
| 표 | row size 배열, zone info, cell span, cell border fill, heading row repeat |
| 개체 | instance ID, z-order, matrix, desc text, caption list, wrap/side/basis bits |
| 그림/OLE | crop, effect chain, transparency, baseline, BinData ID |
| 수식 | script, baseline, version info, font name |
| 필드 | command 문자열, 고유 ID, 필드 종류 |
| 부가 storage | Scripts, XMLTemplate, Bibliography, SummaryInformation, PrvText, PrvImage |
| 이력 | `DocHistory/VersionLog*`, `HistoryLastDoc` |
| 배포용 문서 | `HWPTAG_DISTRIBUTE_DOC_DATA` 256 bytes와 관련 storage |

## 구현 함정, 모호점, 버전 게이트, opaque round-trip 지점

### 구현 함정

| 구분 | 내용 |
|---|---|
| 문단 문자 수 | `nchars` 최상위 비트를 먼저 제거해야 한다. |
| 빈 문단 | `nchars < 1`이면 `PARA_BREAK`만 가진 문단으로 생성해야 한다. |
| 컨트롤 | `PARA_TEXT`의 extended control과 `CTRL_HEADER` 레코드 체인을 함께 해석해야 한다. |
| line segment | `PARA_LINE_SEG`는 cache이지 저장용 진실이 아니다. |
| range tag | 서로 겹칠 수 있으므로 스타일 run처럼 병합 불가 |
| 그룹 개체 | matrix 시퀀스와 group depth를 잃으면 위치가 무너진다. |
| 표 분할 | split policy와 heading row repeat는 렌더 미구현이어도 저장에서 반드시 유지해야 한다. |

### 스펙 모호점

| 위치 | 모호점 | 권장 대응 |
|---|---|---|
| `TabDef` | `count`가 `INT16`인데 길이 열은 `4` | 샘플로 검증 전까지 2-byte count + 2-byte 패딩 가정, 남는 바이트 opaque |
| `CTRL_HEADER` | 표 64는 길이 4로 보이나 후속 절들은 CtrlID별 payload를 별도로 정의 | `ctrlId prefix + ctrl-specific payload`로 구현 |
| `EQEDIT` | 스크립트 길이 `len`이 버전 정보/폰트 이름에도 재사용되는 표기 | 문자열 구획이 명확하지 않으면 전체 후행 문자열 블록 raw 보존 |
| 그림 개체 참조표 | `개체 요소 공통 속성(표 80 참조)` 표기 | 논리상 표 83로 읽고 구현, 원문 cross-reference 오기 가능성 문서화 |
| `LayoutCompatibility` | 5개의 `UINT32` 의미 미기재 | 값 자체를 opaque compatibility switch로 보존 |

### 버전 게이트

| 위치 | 게이트 | 대응 |
|---|---|---|
| `Table.validZoneInfo` | `5.0.1.0 이상` | table payload 길이 계산 시 조건부 |
| `SectionDef.representativeLanguage` | `5.0.1.5 이상` | 없으면 application language fallback |
| `ParaShape.attr2` | `5.0.1.7 이상` | 후행 4 bytes 조건부 |
| `DocHistory` | `Doc 5.0.1.7 이상` | storage가 있으면 개별 stream 압축/암호 고려 |
| `CharShape.borderFillId` | `5.0.2.1 이상` | 텍스트 배경 충실도 |
| `Numbering.levelStart` | `5.0.2.5 이상` | 7개 `UINT32` 후행 |
| `ParaShape.attr3 + lineSpacingNew` | `5.0.2.5 이상` | 줄간격 계산 분기 |
| `CharShape.strikeColor` | `5.0.3.0 이상` | 후행 `COLORREF` |
| `ParaHeader.trackMerge` | `5.0.3.2 이상` | 후행 `UINT16` |
| `Numbering.extLevelStart` | `5.1.0.0 이상` | forward tail opaque 보존 |

### opaque round-trip 우선 지점

| 영역 | 이유 |
|---|---|
| `HWPTAG_MEMO_SHAPE`, `TRACKCHANGE*`, `FORBIDDEN_CHAR` | 본문 필드 구조가 없음 |
| `DocOptions/*` | DRM/서명/인증서 구조 미상 |
| `LayoutCompatibility` | 값 의미가 미상 |
| `DocData` 미상 parameter set | 제품별 UI 상태일 수 있음 |
| 차트 OLE 내부 `Contents`, `OOXMLChartContents` | 외부 스펙 의존 |
| `DocHistory` 미상 record type | 향후 확장 가능성 높음 |
| 외부 태그 영역 `0x200-0x3FF` | 애플리케이션 확장 가능 |

## 회귀 테스트로 바로 쓸 수 있는 검증 포인트

### 바이트 구조 회귀

| 케이스 | 검증 포인트 |
|---|---|
| `FileHeader` | 256 bytes 유지, signature/flags/version/reserved byte exact match |
| record header | `Size == 0xFFF`인 레코드에서 확장 길이 처리 확인 |
| DocInfo | ID mapping count와 실제 레코드 수/인덱스 연결 검증 |
| ParaHeader | `nchars` high bit 제거, `nchars==0` 빈 문단 처리 |
| ParaCharShape | 첫 run의 `pos==0`, run 수 일치 |
| ParaRangeTag | 겹치는 영역 태그 2개 이상이 손실 없이 저장되는지 |
| Table | `rowSize.length == rowCount`, zone info count 계산, cell span 유지 |
| Object | `instanceId`, `zOrder`, `width/height`, matrix payload 동일성 |
| Picture | crop와 effect chain 바이트 동일성 |
| OLE | `binDataId`, baseline, object type 비트 유지 |
| Field | `command` 문자열과 `id` 유지 |
| DocHistory | `VersionLog*` stream 존재와 record order 유지 |

### 레이아웃 회귀

| 케이스 | 검증 포인트 |
|---|---|
| 문단 정렬 | 좌/우/가운데/배분/나눔 정렬이 페이지 스냅샷에서 일치 |
| 들여쓰기 | 내어쓰기, 자동 내어쓰기, 번호 거리 계산 일치 |
| 탭 | left/right/center/decimal 탭 위치가 텍스트와 함께 일치 |
| 줄간격 | legacy/new line spacing 모두 샘플에서 비교 |
| 구역 전환 | 구역 나누기와 새 페이지 번호 정책 확인 |
| 다단 | 단 수, 방향, 단 폭, 구분선 렌더 일치 |
| 표 | row split, heading row repeat, cell span, zone border/fill 일치 |
| 떠있는 개체 | wrap mode, both/left/right side, behind/in front of text 일치 |
| 그림 | crop, transparency, effect on/off에 따른 bounding box 변화 |
| 수식 | baseline과 줄 단위/글자 단위 배치 차이 확인 |
| 각주/미주 | 구분선, numbering mode, superscript 번호 확인 |
| 쪽 번호 | 위치/모양/장식 문자 렌더 일치 |

### 저장 round-trip 회귀

| 케이스 | 검증 포인트 |
|---|---|
| 미상 레코드 포함 문서 | 원본 대비 미상 레코드 payload byte-for-byte 동일 |
| 차트 포함 문서 | `Contents`와 `OOXMLChartContents` 둘 다 손실 없음 |
| 수식 포함 문서 | script/version/font name/baseline 유지 |
| 배포용 문서 | 256-byte distribute-doc 데이터와 관련 storage 유지 |
| 변경 추적 문서 | `FileHeader` bit14, 관련 DocInfo record, ParaHeader trailing flag 유지 |
| Scripts/XMLTemplate 문서 | storage가 온전히 남아 있는지 |

## 장/절별 재참조 목록

| 원문 절 | 다시 봐야 하는 이유 | 연결 구현 |
|---|---|---|
| `2. 자료형 설명` | `HWPUNIT`, `COLORREF`, little-endian 규칙 확인 | binary reader |
| `3.1` | 전체 storage 배치와 압축/암호 범위 확인 | OLE/CFB layer |
| `3.2.1` | `FileHeader` 전체 256 bytes와 최신 플래그 | header parser, saver |
| `3.2.2` | `DocInfo` 전체 레코드 목록과 길이 | docinfo parser |
| `3.2.3` | `Section*`의 첫 문단/끝 문단 special placement | body parser |
| `3.2.4` | SummaryInformation property set | metadata saver |
| `3.2.5` | `BinData` storage와 본문 참조 연결 | asset loader |
| `3.2.6` | preview text 저장 형식 | preview exporter |
| `3.2.7` | preview image 저장 형식 | preview exporter |
| `3.2.8` | DRM/서명 관련 opaque storage | opaque round-trip |
| `3.2.9` | script version/source 구조 | script preservation |
| `3.2.10` | XML template 문자열 storage | template preservation |
| `3.2.11` | `DocHistory` storage 배치 | history parser |
| `3.2.12` | `Bibliography` XML storage | storage preservation |
| `4.1` | 레코드 헤더/확장 길이 규칙 | common record reader |
| `4.2.1` | section count와 시작 번호 | numbering bootstrap |
| `4.2.2` | ID mapping index 의미 | shared table loader |
| `4.2.3` | `LINK/EMBEDDING/STORAGE` 분기 | BinData resolver |
| `4.2.4` | font fallback chain | font mapper |
| `4.2.5` | border/fill과 diagonal/gradient | renderer |
| `4.2.6` | char shape 7-language arrays와 colors | text renderer |
| `4.2.7` | 탭 구조와 count 모호점 | tab parser |
| `4.2.8` | numbering format string과 version tail | numbering engine |
| `4.2.9` | bullet/image bullet | bullet renderer |
| `4.2.10` | paragraph layout core | layout engine |
| `4.2.11` | style linking | style resolver |
| `4.2.12` | parameter set typed item | opaque doc settings |
| `4.2.13` | distribute-doc raw 256 bytes | distributed-doc bridge |
| `4.2.14` | target program value | compatibility mode |
| `4.2.15` | layout compatibility tokens | compatibility mode |
| `4.3.1` | paragraph header counts, break bits | paragraph parser |
| `4.3.2` | text/control char interleave | text parser |
| `4.3.3` | char shape run rules | run builder |
| `4.3.4` | line segment cache semantics | verifier |
| `4.3.5` | overlapping range tags | annotation layer |
| `4.3.6` | polymorphic `CTRL_HEADER` 시작점 | control dispatcher |
| `4.3.7` | nested paragraph list header | table/header/footer/textbox |
| `4.3.8` | `CTRL_DATA` parameter sets | field/bookmark/hyperlink |
| `4.3.9` | object control 분기와 CtrlID map | object dispatcher |
| `4.3.9.1` | table row/cell/zone/heading row | table layout |
| `4.3.9.2.1` | object element attrs + matrix | drawing transform |
| `4.3.9.2.2-2.7` | 각 shape geometry | drawing renderer |
| `4.3.9.3` | equation baseline과 문자열 | equation bridge |
| `4.3.9.4` | picture crop/effect chain | image renderer |
| `4.3.9.5` | OLE baseline/object type | OLE bridge |
| `4.3.9.6` | chart가 OLE 내부 bridge라는 점 | chart loader |
| `4.3.9.7` | grouped object payload order | group transform |
| `4.3.9.8` | local/web video payload | video bridge |
| `4.3.10.1` | section payload + child records | section/page model |
| `4.3.10.1.1` | page size/orientation/binding | page model |
| `4.3.10.1.2` | footnote/endnote numbering and separator | footnote layout |
| `4.3.10.1.3` | page border/background anchor | page painter |
| `4.3.10.2` | multi-column layout | column layout |
| `4.3.10.3` | header/footer scope | page master |
| `4.3.10.4` | footnote/endnote paragraph list | note layout |
| `4.3.10.5-10` | page controls, auto number, index mark | field/number subsystem |
| `4.3.10.11-15` | bookmark/overlap/dutmal/hidden comment/field | annotations + fields |
| `4.4.1-4.4.2` | history record set | history preservation |

## 즉시 구현 우선순위

1. `FileHeader`, `DocInfo`, `BodyText` 공통 record reader를 lossless로 고정한다.
2. `ParaShape`, `CharShape`, `TabDef`, `Numbering`, `Bullet`를 내부 layout model에 바로 매핑한다.
3. `SectionDef`, `PageDef`, `ColumnsDef`, `Header/Footer`, `FootnoteShape`를 page model로 끌어올린다.
4. `Table`, `ObjectCommon`, `Picture`, `OLE`, `Equation`의 저장 보존 경로를 완성한다.
5. `LayoutCompatibility`, `DocHistory`, `DocOptions`, 미상 DocInfo record는 opaque round-trip 계층으로 분리한다.

## 구현 메모

- 이 PDF 하나만으로도 파서 골격과 조판 핵심 축은 세울 수 있지만, 차트/수식/배포용 문서는 별도 문서를 함께 봐야 완성된다.
- 그 전까지의 안전한 전략은 `알 수 있는 필드는 구조화`, `모르는 필드는 그대로 보존`이다.
- 현재 코드베이스 기준 최우선 fidelity 축은 `문단`, `페이지`, `표`, `떠있는 개체`, `수식 baseline`, `필드 command`다.
