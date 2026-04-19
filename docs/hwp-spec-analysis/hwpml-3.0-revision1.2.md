# HWPML 3.0 revision 1.2 구현 분석

- 원문: `/Users/shinehandmac/Downloads/한글문서파일형식3.0_HWPML_revision1.2.pdf`
- 재검토 범위: PDF 122쪽 전체
- 개정: `revision 1.2:20141105`
- 구현 초점: `lossless import/export`, `HWP/HWPX 공통 내부 모델 정규화`, `layout fidelity`, `round-trip 보존`

## 1. 문서 개요

이 문서는 `Hwp Document File Formats 3.0 / HWPML` revision 1.2를 구현 관점에서 다시 정리한 분석서다. 이번 재정리는 PDF를 처음부터 끝까지 다시 읽고, 곧바로 파서/렌더러/저장기 입력으로 쓸 수 있도록 세부 요소와 보존 정책을 보강한 결과물이다.

이 PDF는 구현상 두 덩어리로 봐야 한다.

- Part I: 옛 `HWP 3.x` 저장 구조, 추가 정보 블록, 특수 문자, 그리기/OLE 구조
- Part II: 실제 `HWPML` XML element/attribute 정의

Part II만 읽으면 XML 문법은 알 수 있지만, 다음 항목은 Part I을 같이 봐야 구현이 완성된다.

- 필드/책갈피/상호참조/하이퍼링크의 레거시 의미
- 추가 정보 블록에 들어가는 그림/OLE/배경/셀 필드 이름/누름틀 필드 이름
- 그리기 개체 공통 헤더, 회전/그라데이션/비트맵 패턴 구조
- OLE 스토리지와 차트/OLE 부가 데이터

즉, HWPML 구현은 단순 XML DOM 처리 문제가 아니라 다음 4개 층을 함께 다뤄야 한다.

1. XML 트리와 속성 해석
2. `Id`, `InstId`, `BinItem`, `Style` 계열 참조 그래프
3. HWP/HWPX 공통 내부 모델로의 정규화
4. 렌더링에 직접 안 보여도 저장 시 반드시 살려야 하는 부가 자산 보존

## 2. 형식 범위와 버전

### 2.1 기본 버전 정보

- 루트 엘리먼트는 `HWPML`
- `HWPML/@Version = 2.8`
- `HWPML/@SubVersion = 8.0.0.0`
- `HWPML/@Style2 = embed | export`, 기본값은 `embed`
- PDF 개정 이력상 `revision 1.2`에서는 "구 5.0 내용 삭제"가 반영되었다.

### 2.2 단위와 기본 값 집합

Part II의 `hwpunit`은 `10 pt = 1000 hwpunit`으로 정의된다. 즉 HWP 5.x/HWPX 계열과 같은 `1/7200 inch` 축으로 해석해야 한다. Part I의 HWP 3.x `hunit(1/1800 inch)`과 혼동하면 안 된다.

구현체는 다음 문자열 집합을 별도 enum 테이블로 가져가는 편이 안전하다.

| 값 집합 | 대표 사용처 | 구현 메모 |
|---|---|---|
| `LineType1`, `LineType2`, `LineType3` | 테두리, 밑줄, 외곽선, 선 객체 | 문자열 토큰과 렌더용 선 스타일을 분리 |
| `LineWidth` | 테두리, 구분선, 주석선 | mm 값과 내부 width code를 같이 보관 |
| `NumberType1`, `NumberType2` | 번호 문단, 각주/미주, 쪽번호, 자동번호 | 표시 문자열과 번호 로직을 분리 |
| `AlignmentType1`, `AlignmentType2` | 문단 정렬, 개체 내부 정렬 | `Distribute`, `DistributeSpace`는 일반 정렬과 구분 |
| `TextWrapType`, `LineWrapType` | 떠있는 개체, 문단 한줄입력 | 배치 엔진 옵션과 1:1 대응 |
| `FieldType` | `FIELDBEGIN`, `FIELDEND` | 렌더보다 저장/자동화 기능에서 중요 |
| `ArrowType`, `ArrowSize` | `LINESHAPE` | 선 끝 모양 렌더링에 필요 |
| `LangType` | `FONTFACE`, `FONTID` | 언어별 글꼴 슬롯 유지 |
| `HatchStyle`, `InfillMode` | `WINDOWBRUSH`, `IMAGEBRUSH` | 채우기와 타일 배치 정책 보존 |

보존 전략은 `정규화된 enum 값`과 `원문 문자열 토큰`을 함께 들고 가는 방식이 가장 안전하다.

### 2.3 구현 시 꼭 기억할 형식 제약

- `BINDATALIST/BINITEM`
  - `Type="Link"`면 `APath`, `RPath`가 실질 필수
  - `Type="Embedding"`이면 `BinData`, `Format`이 실질 필수
  - `Type="Storage"`는 OLE 전용
- `SIZE`
  - `Width`, `Height`는 숫자만 보면 안 되고 `WidthRelTo`, `HeightRelTo`와 함께 해석해야 한다.
  - `Absolute`가 아니면 사실상 `% 값`이다.
- `PARAMARGIN`, `SECDEF/@TabStop`
  - `hwpunit`뿐 아니라 `nch` 꼴의 글자수 표현이 가능하다.
  - 숫자로만 변환하면 round-trip이 깨진다.
- `POSITION`
  - `TreatAsChar="false"`일 때만 대부분의 떠있는 개체 배치 속성이 의미를 가진다.
  - `FlowWithText="true"`면 `AllowOverlap`은 사실상 `false`로 취급된다.
- `COMPATIBLEDOCUMENT`, `LAYOUTCOMPATIBILITY`
  - 문서 뒤쪽에 추가된 late-bound 호환성 노드다.
  - 현재 렌더러가 전부 쓰지 않더라도 반드시 파싱/보존해야 한다.

## 3. 핵심 데이터 구조

### 3.1 HWPML 트리

```text
HWPML
├─ HEAD
│  ├─ DOCSUMMARY
│  ├─ DOCSETTING
│  ├─ MAPPINGTABLE
│  └─ COMPATIBLEDOCUMENT
├─ BODY
│  └─ SECTION*
│     └─ P*
│        └─ TEXT
│           ├─ CHAR
│           ├─ SECDEF / COLDEF
│           ├─ TABLE / PICTURE / drawing / CONTAINER
│           ├─ FORM controls / OLE / EQUATION / TEXTART
│           └─ field / note / page / hidden / comment controls
└─ TAIL
   ├─ BINDATASTORAGE
   ├─ SCRIPTCODE*
   └─ XMLTEMPLATE
```

### 3.2 처리 순서

1. 루트와 `HEAD`를 먼저 읽어 참조 테이블을 만든다.
2. `BODY`는 `SECTION -> P -> TEXT` 순으로 스트림화한다.
3. `TEXT` 안의 문자, 제어부호, 개체는 순서를 그대로 보존한다.
4. `TAIL`의 바이너리, 스크립트, XML 템플릿을 문서 자산 그래프로 묶는다.
5. 저장 시에는 element 순서, attribute 값, 참조 ID, 미해석 노드를 최대한 원형 유지한다.

### 3.3 HWP/HWPX 공통 내부 모델 축

아래 표의 `현재 코드베이스 내부 모델`은 `/Users/shinehandmac/Github/ChromeHWP/js/hwp-parser.js` 기준 구현 대응을 정리한 것이다. 즉, `HWP 5.0 대응`은 원문 스펙 기반이고 `HWPX/현재 코드베이스 대응`은 현 코드 구조에서 추론한 구현 연결이다.

| 내부 버킷 | HWPML 소스 | HWP 5.0 대응 | HWPX/현재 코드베이스 대응 |
|---|---|---|---|
| 문서 메타 | `DOCSUMMARY`, `DOCSETTING` | `Document Properties`, `Summary Info` | 메타데이터, 시작번호, 캐럿 위치 |
| 공통 테이블 | `MAPPINGTABLE` 하위 리스트 전부 | `DocInfo` 레코드 묶음 | `header.borderFills`, `header.paraProps`, `header.charProps`, `header.hangulFonts`와 동급의 `docInfo.*` 맵 |
| 페이지/구역 | `SECDEF`, `PAGEDEF`, `PAGEMARGIN`, `PAGEBORDERFILL`, `STARTNUMBER`, `HIDE`, `MASTERPAGE` | `SectionDef`, `PageDef`, `PageBorderFill`, header/footer/note controls | `sectionMeta.pageStyle`, `pageStyle.margins`, `pageStyle.pageBorderFills`, `pageNumber`, `startPageNum` |
| 문단 | `P`, `TEXT`, `CHAR`, `PARASHAPE`, `CHARSHAPE`, `STYLE` | `PARA_HEADER`, `PARA_TEXT`, `PARA_CHAR_SHAPE`, `PARA_LINE_SEG`, `PARA_SHAPE`, `STYLE` | `{ type: 'paragraph', align, marginLeft, marginRight, textIndent, spacingBefore, spacingAfter, lineSpacingType, lineSpacing, styleId, styleName, tabDefId, texts[] }` |
| 글자 run | `TEXT/@CharShape`, `CHAR/@Style`, `CHAR` 하위 텍스트/제어부호 | 글자 모양 run + control char | `texts[]` 안의 run 객체 (`fontName`, `fontSize`, `color`, `underline`, `strike`, `shadow*`, `outlineType`, `scaleX`, `letterSpacing`, `relSize`, `offsetY`) |
| 목록/번호 | `NUMBERING`, `BULLET`, `PARAHEAD`, `PARASHAPE/@Heading*` | `NUMBERING`, `BULLET`, 문단 머리 | `listInfo = { kind, level, listId, marker/format/start }` |
| 표 | `TABLE`, `ROW`, `CELL`, `CELLMARGIN`, `CELLZONELIST` | 표 control + cell/list header | `{ type: 'table', rowCount, colCount, cellSpacing, rows[].cells[] }` |
| 떠있는 개체 공통 | `SHAPEOBJECT`, `SIZE`, `POSITION`, `OUTSIDEMARGIN`, `CAPTION` | GSO 공통 헤더 | `_withObjectLayout()`가 붙이는 `inline`, `vertRelTo`, `vertAlign`, `horzRelTo`, `horzAlign`, `offsetX`, `offsetY`, `flowWithText`, `allowOverlap`, `holdAnchorAndSO`, `widthRelTo`, `heightRelTo`, `sizeProtected`, `textWrap`, `textFlow`, `zOrder`, `outMargin` |
| 그림/도형 | `PICTURE`, `SHAPECOMPONENT`, `LINESHAPE`, `EFFECTS`, drawing elements | 그림/도형 record + shape component | 이미지 블록, 도형 블록, `description`, 선/채우기, 회전/행렬 |
| OLE/수식/글맵시 | `OLE`, `EQUATION`, `TEXTART` | OLE control, `EQEDIT`, text art | OLE placeholder, equation block, textart outline/shape |
| 부가 자산 | `BINITEM`, `BINDATA`, `SCRIPTCODE`, `XMLTEMPLATE` | `BinData`, `Scripts`, `XMLTemplate` streams | binary asset map + future script/template graph |

## 4. XML element/attribute 매핑과 내부 모델 연결

### 4.1 루트와 헤더

| HWPML 요소 | 핵심 속성/자식 | 내부 모델 및 HWP/HWPX 대응 | 구현 메모 |
|---|---|---|---|
| `HWPML` | `Version`, `SubVersion`, `Style2`, `HEAD`, `BODY`, `TAIL` | 문서 루트, 패키지 버전 식별 | 버전 문자열 자체를 저장해야 serializer가 안전하다. |
| `HEAD` | `SecCnt`, `DOCSUMMARY`, `DOCSETTING`, `MAPPINGTABLE` | HWP `Document Properties` + `DocInfo`, HWPX header 영역 | `SecCnt`와 실제 `SECTION` 수는 검증하되 원문값 우선 보존 |
| `DOCSUMMARY` | `TITLE`, `SUBJECT`, `AUTHOR`, `DATE`, `KEYWORDS`, `COMMENTS`, `FORBIDDENSTRING` | HWP SummaryInfo, HWPX metadata | 표시에는 약하지만 round-trip 메타데이터로 중요 |
| `FORBIDDENSTRING/FORBIDDEN` | `FORBIDDEN/@id`, 문자열 값 | HWP `FORBIDDEN_CHAR` 계열 | 금칙 처리용이라 렌더만 보는 구현이 놓치기 쉽다. |
| `DOCSETTING/BEGINNUMBER` | `Page`, `Footnote`, `Endnote`, `Picture`, `Table`, `Equation`, `TotalPage` | HWP `Document Properties`, HWPX `beginNum` 계열과 동급 | 문서 전역 시작번호와 구역별 `STARTNUMBER`를 분리 저장 |
| `DOCSETTING/CARETPOS` | `List`, `Para`, `Pos` | 편집 상태 복원 | 렌더엔 직접 안 쓰여도 저장 시 유지 |
| `MAPPINGTABLE` | 각종 `*LIST` | HWP `DocInfo` indexed tables, HWPX `header.xml` refs | import 시 `Id` 기반 dict를 먼저 구성 |
| `BINDATALIST/BINITEM` | `Type`, `APath`, `RPath`, `BinData`, `Format` | HWP `HWPTAG_BIN_DATA`, HWPX `BinData` 파일과 `binaryItemIDRef` | `Link`, `Embedding`, `Storage`를 자산 타입으로 구분 |
| `FACENAMELIST/FONTFACE/FONT` | `FONTFACE/@Lang`, `FONT/@Id,@Type,@Name`, `SUBSTFONT`, `TYPEINFO` | HWP `FACE_NAME`, HWPX `fontface/font` | 언어별 슬롯 7개를 유지해야 `FONTID`와 맞물린다. |
| `BORDERFILLLIST/BORDERFILL` | `Id`, `ThreeD`, `Shadow`, `Slash`, `BackSlash`, `CrookedSlash`, `CounterSlash`, `CounterBackSlash`, `BreakCellSeparateLine` | HWP `BORDER_FILL`, HWPX `borderFill` | 대각선/꺾인 대각선 플래그는 표/문단 테두리 재현에 직접 영향 |
| `LEFTBORDER` 등 5개 | `Type`, `Width`, `Color` | border side style | 시각 검토상 기본값은 `Solid`, `0.12mm`, `0` |
| `FILLBRUSH/WINDOWBRUSH/GRADATION/IMAGEBRUSH/IMAGE` | `FaceColor`, `HatchColor`, `HatchStyle`, `Type`, `Angle`, `CenterX/Y`, `Step`, `ColorNum`, `StepCenter`, `Mode`, `Bright`, `Contrast`, `Effect`, `BinItem`, `Alpha` | 채우기/이미지 fill, HWP fill info, HWPX `winBrush/gradation/imgBrush` | gradient/image fill은 렌더뿐 아니라 저장 시 파라미터 전체 보존이 중요 |
| `CHARSHAPELIST/CHARSHAPE` | `Id`, `Height`, `TextColor`, `ShadeColor`, `UseFontSpace`, `UseKerning`, `SymMark`, `BorderFillId` + `FONTID/RATIO/CHARSPACING/RELSIZE/CHAROFFSET` + 장식 요소 | HWP `CHAR_SHAPE`, HWPX `charPr` | 7개 언어 슬롯과 장평/자간/상대크기/오프셋을 한 세트로 묶어야 한다. |
| `UNDERLINE/STRIKEOUT/OUTLINE/SHADOW` | 위치/형태/색/오프셋 | char decoration | `strike`와 `underline`은 on/off만이 아니라 shape/color가 중요 |
| `TABDEFLIST/TABDEF/TABITEM` | `Id`, `AutoTabLeft`, `AutoTabRight`, `Pos`, `Type`, `Leader` | HWP `TAB_DEF`, HWPX `tabPr` 동급 | `TABITEM/Pos`는 정수값만 저장하지 말고 정렬/leader와 같이 저장 |
| `NUMBERINGLIST/NUMBERING/PARAHEAD` | `Id`, `Start`, `Level`, `Alignment`, `UseInstWidth`, `AutoIndent`, `WidthAdjust`, `TextOffsetType`, `TextOffset`, `NumFormat`, `CharShape` | HWP `NUMBERING`, HWPX list header 동급 | 머리 문자열 포맷의 `^n`, `^N`, `^1..^7` 규칙을 같이 유지해야 한다. |
| `BULLETLIST/BULLET` | `Id`, `Char`, `Image`, `PARAHEAD` | HWP `BULLET` | 이미지 불릿 가능 여부를 따로 보존 |
| `PARASHAPELIST/PARASHAPE` | `Id`, `Align`, `VerAlign`, `HeadingType`, `Heading`, `Level`, `TabDef`, `BreakLatinWord`, `BreakNonLatinWord`, `Condense`, `WidowOrphan`, `KeepWithNext`, `KeepLines`, `PageBreakBefore`, `FontLineHeight`, `SnapToGrid`, `LineWrap`, `AutoSpaceEAsianEng`, `AutoSpaceEAsianNum` | HWP `PARA_SHAPE`, HWPX `paraPr` | 문단 조판 중심축이다. `HeadingType+Heading+Level`은 목록 모델로 정규화 필요 |
| `PARAMARGIN` | `Indent`, `Left`, `Right`, `Prev`, `Next`, `LineSpacingType`, `LineSpacing` | paragraph block margins | `Indent`와 여백은 `hwpunit` 또는 `nch`일 수 있어 `value+unit` 구조로 보관 |
| `PARABORDER` | `BorderFill`, `OffsetLeft/Right/Top/Bottom`, `Connect`, `IgnoreMargin` | paragraph border box | `Connect`와 `IgnoreMargin`은 인접 문단 연결에 중요 |
| `STYLELIST/STYLE` | `Id`, `Type`, `Name`, `EngName`, `ParaShape`, `CharShape`, `NextStyle`, `LangId`, `LockForm` | HWP `STYLE`, HWPX style refs | paragraph style과 character style을 분리해서 저장 |
| `MEMOSHAPELIST/MEMO` | `Id`, `Width`, `LineType`, `LineColor`, `FillColor`, `ActiveColor`, `MemoType` | HWP `MEMO_SHAPE` | 메모는 편집 기능 쪽에서 빠지기 쉽지만 보존 필요 |

### 4.2 본문 기본 흐름과 제어부호

| HWPML 요소 | 핵심 속성/자식 | 내부 모델 및 HWP/HWPX 대응 | 구현 메모 |
|---|---|---|---|
| `BODY/SECTION` | `SECTION/@Id`, `P*` | HWP `BodyText/Section*`, HWPX `section.xml` | `SECTION/@Id`는 저장 시 유지 |
| `P` | `ParaShape`, `Style`, `InstId`, `PageBreak`, `ColumnBreak` | HWP paragraph header, HWPX `p/@paraPrIDRef` | `InstId`는 개요 문단 식별자로 중요 |
| `TEXT` | `CharShape`, 다수의 문자/컨트롤 자식 | HWP `PARA_TEXT` + control sequence, HWPX `run/t` | 문단 안의 순서 보존이 핵심 |
| `CHAR` | 문자열, `TAB`, `LINEBREAK`, `HYPEN`, `NBSPACE`, `FWSPACE`, `TITLEMARK`, `MARKPENBEGIN`, `MARKPENEND`, `Style` | 텍스트 run + inline control char | HWPX로 옮기면 대체로 `run/t`, `lineBreak`, `tab`로 펴지지만 원문 control 정보도 따로 유지해야 안전 |
| `MARKPENBEGIN/END` | `Color` | 형광펜 범위 | 시작/끝쌍이 깨지면 마크업이 망가진다. |
| `TITLEMARK` | `Ignore` | 제목차례 표시 | TOC 생성과 저장 무결성에 영향 |
| `FIELDBEGIN/FIELDEND` | `Type`, `Name`, `InstId`, `Editable`, `Dirty`, `Property`, `Command` | HWP field control, HWPX field/run 계열 | `Command`는 필드별 고유 로직이므로 절대 의미 손실 없이 보존 |
| `BOOKMARK` | `Name` | HWP bookmark control, HWPX bookmark | 이름 충돌/중복 검증 필요 |
| `HEADER/FOOTER` | `ApplyPageType`, `SeriesNum`, `PARALIST` | HWP header/footer control, HWPX `header/footer` area | 페이지 유형 필터와 구역내 일련번호를 함께 저장 |
| `FOOTNOTE/ENDNOTE` | `PARALIST` | HWP foot/endnote control, HWPX note area | 주석 본문은 독립 문단 리스트로 처리 |
| `AUTONUM/NEWNUM` | `Number`, `NumberType`, `AUTONUMFORMAT` | HWP number code/new number control | 문서 전역 시작번호와 구역 시작번호와 충돌하지 않게 모델링 |
| `PAGENUMCTRL` | `PageStartsOn` | 홀/짝수 시작 조정 | 구역 분리와 함께 계산해야 함 |
| `PAGEHIDING` | `HideHeader`, `HideFooter`, `HideMasterPage`, `HideBorder`, `HideFill`, `HidePageNum` | 숨김 control | section-level `HIDE`와 inline `PAGEHIDING`를 구분 |
| `PAGENUM` | `Pos`, `FormatType`, `SideChar` | 쪽번호 위치 control | 현재 렌더러는 `Digit`만 쉽게 처리하지만 원문 값은 모두 보존 |
| `INDEXMARK/KEYFIRST/KEYSECOND` | 키워드 문자열 | 색인 표식 | index generator 입력 |
| `COMPOSE/COMPCHARSHAPE` | `CircleType`, `CharSize`, `ComposeType`, `CharShapeSize`, `ShapeID` | 글자 겹침 | 확장 문자 조합과 호환 플래그에 영향 |
| `DUTMAL/MAINTEXT/SUBTEXT` | `PosType`, `SizeRatio`, `Option`, `StyleNo`, `Align` | 덧말 | 렌더는 어려워도 저장 보존은 필수 |
| `HIDDENCOMMENT` | `PARALIST` | 숨은 설명 | 표시와 저장을 분리 처리 |

### 4.3 구역, 페이지, 단

| HWPML 요소 | 핵심 속성/자식 | 내부 모델 및 HWP/HWPX 대응 | 구현 메모 |
|---|---|---|---|
| `SECDEF` | `TextDirection`, `SpaceColumns`, `TabStop`, `OutlineShape`, `LineGrid`, `CharGrid`, `FirstBorder`, `FirstFill`, `ExtMasterpageCount`, `MemoShapeId`, `TextVerticalWidthHead` | HWP `SectionDef`, HWPX `secPr` | `LineGrid`, `CharGrid`는 `0=off, 1..n=간격`이다. |
| `PARAMETERSET/PARAMETERARRAY/ITEM` | `SetId`, `Count`, `ItemId`, `Type` | HWP `DocData`/parameter set, HWPX parameter nodes | 드물지만 lossless tree로 반드시 보관 |
| `STARTNUMBER` | `PageStartsOn`, `Page`, `Figure`, `Table`, `Equation` | section start numbering | 구역 분리 시 번호 재시작 정책 |
| `HIDE` | `Header`, `Footer`, `MasterPage`, `Border`, `Fill`, `PageNumPos`, `EmptyLine` | first-page hide flags | `SECDEF` 자식 `HIDE`와 `TEXT` 자식 `PAGEHIDING`는 의미층이 다름 |
| `PAGEDEF/PAGEMARGIN` | `Landscape`, `Width`, `Height`, `GutterType`, `Left`, `Right`, `Top`, `Bottom`, `Header`, `Footer`, `Gutter` | HWP `PageDef`, HWPX `pagePr/margin` | A4 기본값과 제본 방식을 분리 저장 |
| `FOOTNOTESHAPE/ENDNOTESHAPE` | `AUTONUMFORMAT`, `NOTELINE`, `NOTESPACING`, `NOTENUMBERING`, `NOTEPLACEMENT` | HWP note shape, HWPX note settings | 각주/미주 배치 규칙과 번호 매기기 정책을 함께 보존 |
| `PAGEBORDERFILL/PAGEOFFSET` | `Type`, `BorderFill`, `TextBorder`, `HeaderInside`, `FooterInside`, `FillArea`, `Left`, `Right`, `Top`, `Bottom` | HWP page border/fill, HWPX `pageBorderFill/offset` | 본문 기준/종이 기준과 채울 영역은 레이아웃 차이를 크게 만든다. |
| `MASTERPAGE/PARALIST` | `Type`, `TextWidth`, `TextHeight`, `HasTextRef`, `HasNumRef` | HWP master page, HWPX header/footer/master area | 실제 텍스트 참조/번호 참조 여부도 같이 유지 |
| `EXT_MASTERPAGE` | `Type`, `PageNumber`, `PageDuplicate`, `PageFront` | 확장 바탕쪽 | `OptionalPage`와 기존 바탕쪽 겹침 정책 보존 |
| `COLDEF/COLUMNLINE/COLUMNTABLE/COLUMN` | `Type`, `Count`, `Layout`, `SameSize`, `SameGap`, 구분선, 각 단 폭/간격 | HWP column definition, HWPX column settings | `BalancedNewspaper`, `Parallel`, `Mirror` 차이를 구분 |

### 4.4 표와 떠있는 개체

| HWPML 요소 | 핵심 속성/자식 | 내부 모델 및 HWP/HWPX 대응 | 구현 메모 |
|---|---|---|---|
| `TABLE` | `PageBreak`, `RepeatHeader`, `RowCount`, `ColCount`, `CellSpacing`, `BorderFill`, `SHAPEOBJECT`, `INSIDEMARGIN`, `CELLZONELIST`, `ROW` | HWP `tbl` control, HWPX `tbl` | 시각 검토상 기본값은 `PageBreak=Cell`, `RepeatHeader=true`, `CellSpacing=0` |
| `SHAPEOBJECT` | `InstId`, `ZOrder`, `NumberingType`, `TextWrap`, `TextFlow`, `Lock` + `SIZE`, `POSITION`, `OUTSIDEMARGIN`, `CAPTION`, `SHAPECOMMENT` | HWP GSO 공통 헤더, HWPX object layout | 표, 그림, 선, 도형, OLE, 수식 모두 공유하는 축 |
| `SIZE` | `Width`, `Height`, `WidthRelTo`, `HeightRelTo`, `Protect` | object size policy | `Absolute`가 아니면 `%` 값이므로 값과 기준을 같이 저장 |
| `POSITION` | `TreatAsChar`, `AffectLSpacing`, `VertRelTo`, `VertAlign`, `HorzRelTo`, `HorzAlign`, `VertOffset`, `HorzOffset`, `FlowWithText`, `AllowOverlap`, `HoldAnchorAndSO` | object anchor policy | `HoldAnchorAndSO`는 표 자식 개체에서 특히 중요 |
| `OUTSIDEMARGIN` | `Left`, `Right`, `Top`, `Bottom` | object outer margin | 기본값이 개체 타입별로 다르므로 타입까지 함께 보존 |
| `CAPTION` | `Side`, `FullSize`, `Width`, `Gap`, `LastWidth`, `PARALIST` | caption block | 캡션 방향과 폭 계산 규칙을 따로 저장 |
| `CELLZONELIST/CELLZONE` | row/col 범위 + `BorderFill` | cell zone styling | 셀 개별 border와 zone border를 함께 처리 |
| `ROW/CELL/CELLMARGIN` | `Name`, `ColAddr`, `RowAddr`, `ColSpan`, `RowSpan`, `Width`, `Height`, `Header`, `HasMargin`, `Protect`, `Editable`, `Dirty`, `BorderFill`, margin 4변 | HWP cell list header, HWPX `tr/tc` | `CELL/@Name`은 필드 맵핑과 연결될 수 있다. |

### 4.5 그림, 도형, 양식, OLE, 수식, 글맵시, 꼬리 자산

| HWPML 요소 | 핵심 속성/자식 | 내부 모델 및 HWP/HWPX 대응 | 구현 메모 |
|---|---|---|---|
| `PICTURE` | `Reverse`, `SHAPEOBJECT`, `SHAPECOMPONENT`, `LINESHAPE`, `IMAGERECT`, `IMAGECLIP`, `EFFECTS`, `INSIDEMARGIN`, `IMAGE` | HWP picture + shape component, HWPX `pic/img` | `Reverse`, clip, effect, fill, image ref를 함께 저장 |
| `SHAPECOMPONENT` | `HRef`, `XPos`, `YPos`, `GroupLevel`, `OriWidth`, `OriHeight`, `CurWidth`, `CurHeight`, `HorzFlip`, `VertFlip`, `InstID` | HWP shape component, HWPX component layout | 그룹 개체와 회전 행렬 계산의 기본축 |
| `ROTATIONINFO/RENDERINGINFO/*MATRIX` | 회전각, 중심, 변환행렬 요소 | transform matrix | 회전과 스케일을 재직렬화하려면 raw matrix까지 보존 |
| `LINESHAPE` | `Color`, `Width`, `Style`, `EndCap`, `HeadStyle`, `TailStyle`, `HeadSize`, `TailSize`, `OutlineStyle`, `Alpha` | line pen style | 선종류와 화살표 크기까지 보존 |
| `IMAGERECT/IMAGECLIP` | 좌표 4점, 잘라내기 사각형 | picture crop model | 원본 좌표와 clip 좌표를 분리 |
| `EFFECTS` 하위 | `SHADOWEFFECT`, `GLOW`, `SOFTEDGE`, `REFLECTION`, `EFFECTSCOLOR`, `COLOREFFECT` | modern image effect model | 현재 렌더 미지원이어도 저장 시 절대 버리면 안 된다. |
| `DRAWINGOBJECT/DRAWTEXT/TEXTMARGIN` | 도형 공통 속성, 도형 글상자, 텍스트 여백 | HWP drawing object common header | `SHADOW`는 `CHARSHAPE`, `DRAWINGOBJECT`, `TEXTARTSHAPE`에서 공통 재사용 |
| `LINE/RECTANGLE/ELLIPSE/ARC/POLYGON/POINT/CURVE/SEGMENT/CONNECTLINE/UNKNOWNOBJECT` | 각 개체별 기하 속성 | HWP drawing object detail blocks | `UNKNOWNOBJECT`는 opaque object로 그대로 보존 |
| `FORMOBJECT/FORMCHARSHAPE/BUTTONSET` | `Name`, `ForeColor`, `BackColor`, `GroupName`, `TabStop`, `TapOrder`, `Enabled`, `BorderType`, `DrawFrame`, `Printable`, 글자속성, 버튼 공통값 | HWP form object, HWPX form control | 폼 계열은 실제 편집/출력 동작에 영향 |
| `BUTTON/RADIOBUTTON/CHECKBUTTON/COMBOBOX/EDIT/EDITTEXT/LISTBOX/SCROLLBAR` | 개별 subtype 속성 | form control subtype | 표에 기본값이 비어 있는 속성이 많으므로 "미상"으로 날리면 안 된다. |
| `CONTAINER` | `SHAPEOBJECT`, `SHAPECOMPONENT`, 하위 개체들 | group object | 그룹 내부 상대 좌표와 바깥 anchor를 같이 관리 |
| `OLE` | `ObjetType`, `ExtentX`, `ExtentY`, `BinItem`, `DrawAspect`, `HasMoniker`, `EqBaseLine` | HWP OLE control, legacy OLE storage, HWPX OLE equivalent | `DrawAspect`, `HasMoniker`, `EqBaseLine`은 복원 시 중요 |
| `EQUATION/SCRIPT` | `LineMode`, `BaseUnit`, `TextColor`, `BaseLine`, `Version`, 수식 문자열 | HWP `EQEDIT`, HWPX equation | 수식은 표시보다 스크립트 문자열 보존이 우선 |
| `TEXTART/TEXTARTSHAPE/OUTLINEDATA` | `Text`, `X0..Y3`, `FontName`, `FontStyle`, `FontType`, `TextShape`, `LineSpacing`, `CharSpacing`, `Align`, 외곽선 포인트 | HWP text art, HWPX textart | 좌표 4점과 외곽선 point 배열 모두 필요 |
| `TAIL/BINDATASTORAGE/BINDATA` | `Id`, `Size`, `Encoding=Base64`, `Compress` | HWP `BinData` streams | `BINITEM/@BinData`와 일치하는 자산 저장소 |
| `SCRIPTCODE` | `Type=JScript`, `Version`, `SCRIPTHEADER`, `SCRIPTSOURCE`, `PRESCRIPT`, `POSTSCRIPT` | HWP `Scripts` stream | 기능 자산이므로 주석으로 취급하면 안 된다. |
| `PRESCRIPT/POSTSCRIPT/SCRIPTFUNCTION` | `Count`, 함수 문자열 | pre/post event hooks | 호출 순서와 함수 목록 유지 |
| `XMLTEMPLATE/SCHEMA/INSTANCE` | XML 스키마와 인스턴스 문자열 | HWP `XMLTemplate` | 외부 업무 XML과 연결될 수 있다. |
| `COMPATIBLEDOCUMENT/LAYOUTCOMPATIBILITY` | `TargetProgram`, 36개 불리언 플래그 | HWP `COMPATIBLE_DOCUMENT`, `LAYOUT_COMPATIBILITY` | 현재 엔진이 일부 무시하더라도 전체 보존 필요 |

## 5. 레이아웃/저장에 치명적인 속성과 round-trip 보존 항목

### 5.1 레이아웃에 바로 영향을 주는 축

| 영역 | 치명 필드 | 놓쳤을 때 증상 | 보존/모델링 원칙 |
|---|---|---|---|
| 문단 | `PARASHAPE`, `PARAMARGIN`, `PARABORDER`, `TABDEF`, `NUMBERING/BULLET`, `TEXT/@CharShape` | 들여쓰기, 줄간격, 정렬, 목록 머리, 탭 위치 붕괴 | 문단 스타일, 직접 문단 속성, char run을 분리 저장 |
| 글자 | `CHARSHAPE`, `FONTID`, `RATIO`, `CHARSPACING`, `RELSIZE`, `CHAROFFSET`, `UNDERLINE`, `STRIKEOUT`, `SHADOW`, `OUTLINE` | 글자폭, 기준선, 강조선, 그림자, 언어별 폰트 fallback 오차 | 7개 언어 슬롯을 한 세트로 유지 |
| 페이지/구역 | `SECDEF`, `STARTNUMBER`, `HIDE`, `PAGEDEF`, `PAGEMARGIN`, `PAGEBORDERFILL`, `MASTERPAGE`, `EXT_MASTERPAGE`, `COLDEF` | 페이지 수, 여백, 홀짝 적용, 첫쪽 감춤, 바탕쪽, 단 나눔 차이 | `sectionMeta`와 `pageStyle`을 별도 구조로 관리 |
| 표 | `TABLE/@PageBreak,@RepeatHeader,@CellSpacing`, `CELL/@ColSpan,@RowSpan,@Width,@Height,@Header,@BorderFill`, `CELLMARGIN`, `CELLZONE` | 행 높이 틀어짐, 반복 머리행 유실, 병합 깨짐, 셀 배경 누락 | 셀 주소/병합/실측폭/콘텐츠 높이를 같이 저장 |
| 떠있는 개체 | `SHAPEOBJECT`, `SIZE`, `POSITION`, `OUTSIDEMARGIN`, `CAPTION` | 개체가 인라인화되거나 위치가 밀림, 겹침 규칙 붕괴 | anchor 기준, 상대 단위, 오프셋, wrap 옵션을 함께 저장 |
| 그림/도형 | `SHAPECOMPONENT`, `ROTATIONINFO`, `RENDERINGINFO`, `LINESHAPE`, `IMAGERECT`, `IMAGECLIP`, `EFFECTS` | 회전/반전/크롭/그림자/반사 오차 | 원 좌표와 변환행렬을 보존 |
| 주석/쪽번호 | `FOOTNOTESHAPE`, `ENDNOTESHAPE`, `HEADER`, `FOOTER`, `AUTONUM`, `NEWNUM`, `PAGENUMCTRL`, `PAGEHIDING`, `PAGENUM` | 쪽번호 시작, 각주 배열, 머리말 적용 면이 틀어짐 | section-level과 inline-level control을 구분 |
| 호환성 | `COMPATIBLEDOCUMENT`, `LAYOUTCOMPATIBILITY/*` | 같은 문서인데 줄바꿈/테두리/여백/anchor 결과가 달라짐 | 현재 미사용이어도 전량 보존 |

### 5.2 round-trip에서 절대 잃으면 안 되는 항목

| 범주 | 보존 항목 | 이유 |
|---|---|---|
| 식별자 | 모든 `Id`, `InstId`, `Style`, `BinItem`, `BorderFill`, `ShapeID`, `SeriesNum`, `Name` | 참조 무결성의 중심 |
| 자산 포인터 | `BINITEM`의 `Type/APath/RPath/BinData/Format`, `BINDATA/@Id,@Size,@Encoding,@Compress` | 외부 링크/포함 자산/OLE 저장소 복원 |
| 문서 상태 | `CARETPOS`, `BEGINNUMBER`, `TotalPage`, `DOCSUMMARY`, `FORBIDDENSTRING` | 편집기 상태와 메타 정보 유지 |
| 필드/표식 | `FIELDBEGIN/END`, `BOOKMARK`, `INDEXMARK`, `TITLEMARK`, `MARKPENBEGIN/END` | 자동화, 색인, TOC, 강조 범위 |
| 숨김/주석 | `MEMO`, `SHAPECOMMENT`, `HIDDENCOMMENT`, `COMMENTS` | 눈에 덜 보여도 정보 손실이 큼 |
| 개체 부가값 | `Lock`, `NumberingType`, `TextWrap`, `TextFlow`, `HoldAnchorAndSO`, `Protect`, `Editable`, `Dirty` | 편집 행동과 배치 정책 |
| 수식/OLE/텍스트아트 | `EQUATION/SCRIPT`, `OLE/@DrawAspect,@HasMoniker,@EqBaseLine`, `TEXTART/@X0..Y3` | 재편집 가능성 유지 |
| 스크립트/XML | `SCRIPTCODE`, `PRESCRIPT`, `POSTSCRIPT`, `SCRIPTFUNCTION`, `XMLTEMPLATE/SCHEMA/INSTANCE` | 업무 로직/외부 XML 연계 |
| 미해석 노드 | `UNKNOWNOBJECT`, `PARAMETERSET`, 알 수 없는 attribute/child | 미래 호환성과 안전한 재저장 |

### 5.3 구현상 특별 취급이 필요한 값 형식

- `PARAMARGIN/@Indent,@Left,@Right,@Prev,@Next`
  - 숫자만이 아니라 `2ch` 같은 글자수 표현 가능
- `SECDEF/@TabStop`
  - `hwpunit` 또는 글자수
- `SIZE/@Width,@Height`
  - `Absolute`가 아니면 기준 대상 대비 비율
- `POSITION`
  - `TreatAsChar=false`일 때만 대부분의 anchor 속성이 의미
- `PARAHEAD`
  - `NumFormat` 외에 엘리먼트 값 자체가 번호 문자열 포맷
- `FONTID`
  - 언어별 `FONTFACE Lang=...` 하위 `FONT/@Id`를 참조하는 7-slot 구조

## 6. 누락되기 쉬운 필드/폼/스크립트/XML 자산 경고

- `PARAMETERSET`, `PARAMETERARRAY`, `ITEM`
  - 명세가 "극히 드물게 사용"된다고 했지만 `SECDEF`, `COLDEF`, `SHAPECOMPONENT`, `FORMOBJECT` 아래에 나온다. 구조를 해석하지 못해도 트리째 보존해야 한다.
- `CELL/@Name`만 저장하면 불충분하다.
  - Part I `8.7`에는 테이블 셀 필드 이름 추가 정보 블록이 따로 있다. HWP/HWPML/HWPX 변환 경로에서는 셀 이름과 외부 필드 목록을 같이 관리해야 한다.
- `FIELDBEGIN Type="Clickhere"`는 특히 위험하다.
  - Part I `10.1.5`의 32바이트 누름틀 바이너리 데이터와 Part I `8.8`의 누름틀 필드 이름 리스트가 함께 있어야 필드명 맵핑이 맞는다.
- 하이퍼링크는 `FIELDBEGIN Type="Hyperlink"`만으로 끝나지 않을 수 있다.
  - Part I `8.3`의 하이퍼텍스트 추가 정보 블록은 텍스트박스 순서와 연결되므로, `Command` 문자열만 살리고 부가 블록을 버리면 링크가 틀어진다.
- 폼 개체는 공통 속성보다 subtype 필드가 더 자주 빠진다.
  - `COMBOBOX/ListBoxRows,ListBoxWidth,Text,EditEnable`
  - `EDIT/MultiLine,PasswordChar,MaxLength,ScrollBars,TabKeyBehavior,Number,ReadOnly,AlignText`
  - `LISTBOX/Text,ItemHeight,TopIndex`
  - `SCROLLBAR/Delay,LargeChange,SmallChange,Min,Max,Page,Value,Type`
- `UNKNOWNOBJECT`는 "모르는 개체"가 아니라 "파서가 아직 지원하지 않는 개체"다.
  - `Ctrlid`, 좌표 4점, `SHAPEOBJECT`, `DRAWINGOBJECT`를 모두 opaque로 보존해야 한다.
- `SHAPECOMMENT`, `MEMO`, `FORBIDDENSTRING`, `CARETPOS`, `MARKPEN*`, `TITLEMARK`, `COMPOSE`, `DUTMAL`, `HIDDENCOMMENT`는 렌더 우선 구현에서 자주 빠진다.
- `SCRIPTCODE`, `PRESCRIPT`, `POSTSCRIPT`, `SCRIPTFUNCTION`은 문서 로직 자산이다.
  - 특히 `Type=JScript`와 함수 목록 순서를 그대로 유지해야 한다.
- `XMLTEMPLATE/SCHEMA/INSTANCE`는 단순 첨부 문자열이 아니다.
  - 외부 업무 XML과의 binding 지점일 수 있으므로 schema와 instance를 같이 보존해야 한다.
- `COMPATIBLEDOCUMENT`와 `LAYOUTCOMPATIBILITY`는 문서 말미에 붙어 있어 누락되기 쉽다.
  - 실제 레이아웃 차이를 만드는 플래그 묶음이므로 별도 섹션으로 파싱하라.

## 7. 구현 체크리스트

1. `HWPML -> HEAD -> BODY -> TAIL` 전체 트리를 lossless DOM으로 읽고 다시 쓸 수 있게 만든다.
2. `HEAD`의 모든 참조 테이블을 `Id` 기반 dict로 먼저 만든 뒤 `BODY`를 읽는다.
3. `PARAMARGIN`, `TabStop`, `SIZE`처럼 `값 + 단위/기준`이 결합된 필드를 구조체로 보관한다.
4. `P -> TEXT` 내부를 문자 run, inline control, object control의 순서 있는 시퀀스로 유지한다.
5. `SHAPEOBJECT` 공통 축을 표/그림/도형/OLE/수식/글맵시에 모두 재사용한다.
6. `BINITEM -> BINDATA`와 외부 링크 자산을 하나의 asset graph로 묶되, 링크/포함/OLE 저장소 타입은 분리 보관한다.
7. `SCRIPTCODE`, `XMLTEMPLATE`, `COMPATIBLEDOCUMENT`, `LAYOUTCOMPATIBILITY`를 별도 부가 자산/호환성 영역으로 취급한다.
8. 해석하지 못한 요소/속성/텍스트는 raw XML fragment 또는 AST sidecar로 유지한다.
9. serializer는 원문 element 순서, attribute 조합, ID 값, 기본값 생략 여부를 가능하면 원문에 가깝게 복원한다.
10. 변환 경로가 HWP/HWPX를 포함한다면 Part I의 추가 정보 블록과 control payload도 같이 관리한다.

## 8. 회귀 테스트 포인트

| 영역 | 테스트 시나리오 | 반드시 확인할 것 |
|---|---|---|
| 루트/헤더/꼬리 | 샘플 문서를 읽고 즉시 재저장 | `Version/SubVersion/Style2`, `SecCnt`, `TAIL` 자산 누락 여부 |
| BinData | `Link`, `Embedding`, `Storage` 각각 1개 이상 포함 | 경로, `BinData` id, 포맷, base64/압축 플래그 유지 |
| 글꼴 | 7개 언어 슬롯이 모두 다른 `FONTID` 케이스 | 언어별 폰트 ref, `SUBSTFONT`, `TYPEINFO` 보존 |
| BorderFill | 대각선, 꺾인 대각선, gradation, image fill 포함 표/문단 | 각 side border와 fill 파라미터, diagonal flags |
| CharShape | 밑줄, 취소선, 그림자, 외곽선, 장평/자간/상대크기/오프셋 사용 | run style diff가 최소인지 |
| ParaShape | `Indent="2ch"` 같은 글자수 단위, `LineSpacingType` 4종, 자동간격 on/off | 단위 보존, 들여쓰기/줄간격 렌더 차이 |
| 목록 | `NUMBERING`, `BULLET`, `PARAHEAD` 1~7단계 | `^n/^N/^레벨번호` 포맷과 시작번호 |
| 구역/페이지 | 홀짝 바탕쪽, 첫쪽 감춤, 구역별 페이지 재시작, page border fill | 페이지 수, 머리말/꼬리말, 쪽번호 위치, border/fill |
| 표 | 병합 셀, 반복 머리행, `PageBreak=Cell/Table/None`, `CELL/@Name` | 병합, 행 높이, 제목행 반복, 필드명 유지 |
| 떠있는 개체 | `TreatAsChar=false`, `WidthRelTo=Page/Column/Para`, `FlowWithText`, `AllowOverlap` | anchor 위치, wrap, z-order, margin |
| 그림 효과 | crop, reverse, shadow/glow/reflection, image fill | 크롭 박스와 effect parameter 보존 |
| 폼/필드 | `Clickhere`, hyperlink, combo/edit/listbox/scrollbar | `Command`, form subtype 속성, 누름틀 이름 매핑 |
| 주석/표식 | `BOOKMARK`, `INDEXMARK`, `COMPOSE`, `DUTMAL`, `HIDDENCOMMENT` | 표식 이름/키워드/텍스트 유지 |
| OLE/수식/글맵시 | `OLE/@DrawAspect`, `EQUATION/SCRIPT`, `TEXTART/OUTLINEDATA` | 스크립트 문자열, baseline, textart 좌표/outline |
| 스크립트/XML | `SCRIPTCODE`, `PRESCRIPT`, `POSTSCRIPT`, `XMLTEMPLATE` 포함 문서 | 함수 수, 문자열 내용, schema/instance 유지 |
| 호환성 | `COMPATIBLEDOCUMENT`, `LAYOUTCOMPATIBILITY` 플래그가 있는 문서 | 플래그 전량 보존, 저장 후 값 변형 없음 |
| 미해석 요소 | `UNKNOWNOBJECT`, vendor extension attribute 추가 | 재저장 후 raw fragment 보존 |

회귀 검증은 최소 두 층으로 나누는 편이 좋다.

- 구조 회귀: XML diff, ID/ref diff, asset diff
- 시각 회귀: 페이지 수, 표 행/열/병합, 떠있는 개체 위치, 머리말/꼬리말, 쪽번호, 수식 baseline

## 9. 장/절별 재참조 목록

### 9.1 Part I. HWP 3.x 쪽에서 다시 볼 곳

| 원문 장/절 | 다시 봐야 하는 이유 | HWPML과 연결되는 구현 지점 |
|---|---|---|
| `I.2 자료형 설명` | endian, 레거시 단위, 배열 표현 | HWP 3.x 추가 블록 import/export |
| `I.7.1 책갈피`, `I.7.2 상호참조` | 이름/종류/참조 대상의 레거시 저장법 | `BOOKMARK`, `FIELDBEGIN Type=Crossref` |
| `I.8.1 파일에 포함된 그림 정보` | embedded image 저장 위치 | `BINITEM`, `BINDATASTORAGE`, `PICTURE` |
| `I.8.2 OLE 정보` | OLE 추가 정보 블록 | `OLE`, `BINITEM Type=Storage` |
| `I.8.3 하이퍼텍스트 정보` | textbox/button 기반 hyperlink 부가 정보 | `FIELDBEGIN Type=Hyperlink`, 텍스트박스 링크 |
| `I.8.4 프리젠테이션 설정 정보` | drawing 속성과 겹치는 레거시 구조 | 도형/프레젠테이션 변환 |
| `I.8.6 배경이미지 정보` | 배경 이미지, 밝기/명암/effect/page option | `PAGEBORDERFILL`, image asset import |
| `I.8.7 테이블 확장(셀 필드 이름)` | 셀 이름 목록의 별도 저장소 | `CELL/@Name` round-trip |
| `I.8.8 누름틀 필드 이름 정보` | clickhere field 번호와 이름 맵핑 | `FIELDBEGIN Type=Clickhere`, form objects |
| `I.9.1 미리보기 이미지`, `I.9.2 미리보기 텍스트` | 패키지 미리보기 자산 | HWP/HWPX 변환 시 preview 정책 |
| `I.10.1 필드 코드`, `I.10.1.5 누름틀` | 필드 종류, clickhere 32-byte payload | `FIELDBEGIN/FIELDEND`, clickhere |
| `I.10.2 책갈피`, `I.10.20 찾아보기`, `I.10.22 상호참조` | inline special char 구조 | `BOOKMARK`, `INDEXMARK`, crossref |
| `I.10.6 표/텍스트박스/수식/버튼/하이퍼텍스트` | 레거시 공통 객체 박스 구조 | `TABLE`, `EQUATION`, `BUTTON`, hyperlink textbox |
| `I.10.7 그림`, `I.10.8 선` | 그림/선 레거시 payload | `PICTURE`, `LINE` 변환 |
| `I.10.10 머리말/꼬리말`, `I.10.11 각주/미주`, `I.10.12-10.15 번호/쪽번호/감추기` | inline control의 원 의미 | `HEADER`, `FOOTER`, `FOOTNOTE`, `AUTONUM`, `PAGENUM`, `PAGEHIDING` |
| `I.11.3.1-11.3.10 그리기 개체 상세` | 공통 헤더, 회전, gradient, bitmap pattern, 각 shape detail | `DRAWINGOBJECT`, `SHAPECOMPONENT`, `RENDERINGINFO` |
| `I.12.1-12.2 OLE 개체 자료 구조` | OLE storage, `.inf`, aspect 정보 | `OLE/@DrawAspect,@HasMoniker,@ExtentX,@ExtentY` |

### 9.2 Part II. HWPML 쪽에서 다시 볼 곳

| 원문 장/절 | 핵심 포인트 | 직접 연결되는 모델 |
|---|---|---|
| `II.2.1-2.2` | enum/value set 전체 | enum table, serializer token |
| `II.3` | 루트와 버전 속성 | document root metadata |
| `II.4.1` | 문서 요약, 금칙 문자열 | doc summary/meta |
| `II.4.2` | 문서 시작번호, 캐럿 위치 | doc setting/editor state |
| `II.4.3.1` | `BINITEM` 강제 속성 조합 | asset graph |
| `II.4.3.2` | `FONTFACE`, `FONT`, `SUBSTFONT`, `TYPEINFO` | font table |
| `II.4.3.3` | `BORDERFILL`, diagonal, fill brush | border/fill renderer + serializer |
| `II.4.3.4` | `CHARSHAPE` 전체 슬롯과 장식 | text run model |
| `II.4.3.5` | `TABDEF`, `TABITEM` | tab stops |
| `II.4.3.6` | `NUMBERING`, `BULLET`, `PARAHEAD` | list model |
| `II.4.3.7` | `PARASHAPE`, `PARAMARGIN`, `PARABORDER` | paragraph layout |
| `II.4.3.8` | `STYLE` | style resolution |
| `II.4.3.9` | `MEMO` | annotation/comment state |
| `II.5.1` | `CHAR`, whitespace controls, mark pen | text stream |
| `II.5.2.1-5.2.7` | section/page/note/masterpage controls | `sectionMeta`, `pageStyle` |
| `II.5.3` | `COLDEF` | columns |
| `II.5.4` | 표와 셀 구조 | table model |
| `II.5.5` | 그림, shape component, image effect | image/object model |
| `II.5.6` | 도형 공통 속성과 geometry | drawing model |
| `II.5.7` | unknown object | opaque preservation |
| `II.5.8` | form controls | form model |
| `II.5.9` | `CONTAINER` | group object |
| `II.5.10` | `OLE` | OLE placeholder/storage |
| `II.5.11` | `EQUATION`, `SCRIPT` | equation model |
| `II.5.12` | `TEXTART`, `OUTLINEDATA` | text art model |
| `II.5.13-5.25` | field/page/note/index/dutmal/comment controls | inline control model |
| `II.6` | `TAIL`, script, XML template, compatibility | asset graph + compat flags |

## 10. 구현 메모

- 이 명세는 `렌더링에 필요한 필드`와 `저장 무결성에 필요한 필드`가 자주 다르다. 두 층을 분리해서 설계해야 한다.
- `TABLE`, `PICTURE`, drawing objects, `OLE`, `EQUATION`, `TEXTART`는 모두 `SHAPEOBJECT` 공통 축으로 묶는 편이 가장 안정적이다.
- `MAPPINGTABLE`과 `TAIL`은 서로 떨어져 있지만 구현체 안에서는 하나의 `문서 자산 그래프`로 묶여야 한다.
- HWP/HWPX와 공통 엔진을 쓰려면 다음 축으로 정규화하면 좋다.
  - `docInfo.tables`
  - `pageStyle/sectionMeta`
  - `paragraph blocks + text runs`
  - `table blocks`
  - `object layout`
  - `asset graph`
  - `compatibility flags`
- 의미를 모르는 요소라도 `opaque round-trip`이 가능해야 한다. HWPML은 사람이 읽기 쉬운 XML이지만, 구현 난점은 오히려 "읽기 쉬워 보여서 임의 축약하기 쉽다"는 데 있다.
