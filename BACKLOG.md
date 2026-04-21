# Rendering Backlog

## Current Status

- HWP:
  - `BodyText/Section` 중심 파싱, `DocInfo borderFill`, `FaceName/CharShape/ParaShape`, `ParaLineSeg`, 표 구조 복원이 들어가 있음.
  - 신청서 샘플은 `3페이지`와 표 양식이 유지됨.
  - 남은 큰 차이는 개체/도형/이미지 앵커와 세부 선 굵기, 줄 메트릭임.
- HWPX:
  - `header.xml` 스타일, 표/셀 border fill, 페이지 장식, 헤더/푸터/쪽번호, 이미지 오프셋 반영이 들어가 있음.
  - 공고문 샘플은 `5페이지`와 상단 슬로건/타이틀 밴드가 유지됨.
  - 남은 큰 차이는 앵커 배치 정밀도, 셀 padding, 장식형 1셀 표와 도형 계열의 시각 일치도임.
- 구조:
  - HWP 파서 핵심 로직이 `js/app.js`, `js/parser.worker.js` 양쪽에 중복돼 있어 수정 시 drift 위험이 큼.
  - 렌더링은 `appendParagraphBlock()`, `appendTableBlock()` 중심으로 수렴돼 있어 레이아웃 보정 포인트는 비교적 명확함.
- 운영:
  - Playwright 검증은 가능하고 단일 세션 스모크 스크립트가 추가되었지만, 샘플 범위와 골든 비교 기준은 아직 약함.

## Next Session Start

- 이번 세션에서 완료한 것 (이전):
  - HWPX `_hwpxPictureBlock`: `curSz=0,0` 시 `orgSz` fallback → pic 1,2(장식 밴드, 로고) 렌더링 복구
  - HWPX `_hwpxParseObjectLayout`: `hp:offset x/y` 요소에서 horzOffset/vertOffset 읽기 (pic 위치 오프셋 수정)
    - 부호 있는 32-bit 정수 변환(`toSignedU32`) 추가 (0xFFFFF... overflow 값 → 음수 오프셋)
  - 렌더러 표 행 최소 높이: `isThinSeparatorRow` 판별로 얇은 구분선 행(< 15px)은 30px 강제 해제 → 4px 수준 유지
  - HWPX `_blockText`에 shape/textbox sentinel 추가 + `_estimateBlockWeight` shape/textbox 케이스 추가
  - HWPX `hc:indent` → `hc:intent` 들여쓰기 요소명 버그 수정 (1000 HWPUNIT 들여쓰기 복구)
  - HWPX 이미지 pagination 가중치: 1/100mm 단위 → 올바른 제수 529 적용
- 이번 세션에서 완료한 것 (현재):
  - HWPX `compose` 요소 → 원문자(①②③...) 유니코드 변환 (`_hwpxDecodeComposeChar`)
    - Hancom PUA 인코딩: 0xF02D7(원 모양) + 0xF02DF+n → U+2460+(n-1), incheon-2a.hwpx에 19개
  - HWPX `hp:t > hp:fwSpace` → 전각 공백(U+3000) 변환 (`_hwpxTElementText`)
    - fwSpace는 `hp:t` 내부에만 등장 (section에 75개, direct-in-run 0개)
  - `_hwpxParagraphHasText`에 `compose` 포함 (`_hwpxDecodeComposeChar` 결과 검증)
  - HWPX `cellMargin/inMargin` 0xFFFFFFFF(-1 signed) 버그 수정: `_hwpxCellMarginVal` 헬퍼
    - 기존: 4294967295 → TABLE_UNIT_SCALE 곱 후 30px로 클램핑 → 셀 안쪽 여백 과대
    - 수정: 0x80000000 이상(signed int32 음수 범위) → 0으로 변환 → 휴리스틱 여백으로 fallback
  - `curSz` fallback: 한 dimension만 0이면 양쪽 모두 `orgSz` 사용 (aspect ratio 일관성)
  - `_estimateBlockWeight` HWPX 이미지: named constants (`HWPX_IMAGE_WEIGHT_DIVISOR=529`, `HWPX_IMAGE_WEIGHT_MAX=10`)
- 바로 이어서 할 일:
  - HWPX `_hwpxParagraphBlocks`: `hp:shp` 도형 요소 지원 (일반 HWPX 문서에 빈번, incheon-2a에는 없음)
  - HWP 개체/도형 앵커 복원 (`HWPTAG_CTRL_HEADER` + shape/picture 파싱 정밀화)
  - `attachment-sale-notice.hwp` 4페이지 / `goyeopje.hwp` 2페이지 유지 여부 재검증 (Hancom oracle 기준)
- 다음 시작 시 체크포인트:
  - `_hwpxParseObjectLayout`은 이제 `hp:pos`(tbl계열) / `hp:offset`(pic계열) 양쪽을 처리함
  - incheon-2a.hwpx의 `hp:ctrl` 요소: colPr×1, pageNum×1, footer×1, header×1, newNum×2, fieldBegin/End×18
  - `compose` PUA base: 0xF02DF (second char - base = n, 1≤n≤20 → ①..⑳)
  - cellMargin 0xFFFFFFFF = hasOwnMargin=1이지만 값이 없음 → 0 처리 후 heuristic fallback
  - `_hwpxCellMarginVal`: 0x80000000 이상은 모두 0으로 처리 (signed int32 음수 범위)


## P0

### 1. HWP 개체/도형 앵커 복원

- 왜 지금 필요한가:
  - HWP 문서는 표/문단 외에도 도형, 선, 이미지, 스탬프형 개체 비중이 높아서 현재 fidelity 상 가장 큰 잔여 차이임.
- 어디부터 볼지:
  - `js/app.js`
  - `js/parser.worker.js`
  - `HWPTAG_CTRL_HEADER`, 개체 공통 속성, shape/picture control 파싱 경로
- 검증 기준:
  - 개체가 있는 HWP 샘플에서 “사라짐” 없이 위치와 크기가 원본 대비 큰 틀에서 맞아야 함.
  - 기존 신청서 샘플 `3페이지`가 깨지면 안 됨.

### 2. HWPX 도형/이미지 앵커와 장식 표 정밀화

- 왜 지금 필요한가:
  - HWPX는 큰 구조는 맞아도 상단 슬로건, 장식 밴드, 시각용 1셀 표의 위치와 여백 차이가 아직 눈에 띔.
- 어디부터 볼지:
  - `js/app.js`
  - HWPX `pic`, `shape`, `tbl`, `secPr/pageBorderFill` 렌더 경로
  - `appendParagraphBlock()`
  - `appendTableBlock()`
- 검증 기준:
  - 공고문 샘플 첫 페이지에서 슬로건, 핑크 타이틀 밴드, 제목 블록 간 상대 위치가 지금보다 더 원본에 가까워야 함.
  - `5페이지`는 유지되어야 함.

### 3. HWP/HWPX 공통 레이아웃 메트릭 정밀화

- 왜 지금 필요한가:
  - 현재는 구조는 맞아도 셀 여백, 줄높이, 라벨 위치가 문서마다 조금씩 눌리거나 떠 보일 수 있음.
- 어디부터 볼지:
  - `js/app.js`
  - `appendParagraphBlock()`
  - `appendTableBlock()`
  - HWP/HWPX 단위 변환 함수
- 검증 기준:
  - 샘플 문서 첫 페이지 비교 시 제목/표 라벨/입력칸 텍스트가 더 덜 눌려 보이고, 페이지 수는 유지되어야 함.

### 4. 메인/워커 HWP 파서 중복 해소

- 왜 지금 필요한가:
  - 같은 로직을 두 파일에 반복 수정하고 있어 회귀 위험이 커지고, 기능 추가 속도가 느려짐.
- 어디부터 볼지:
  - `js/app.js`
  - `js/parser.worker.js`
  - 공통 HWP 파싱 유틸 추출 가능 범위
- 검증 기준:
  - HWP 샘플 2종 이상에서 메인 fallback/worker 결과가 동일해야 함.
  - 새 기능 추가 시 수정 파일 수가 줄어야 함.

## P1

### 5. Playwright 회귀 검증 고정 세션화

- 왜 지금 필요한가:
  - 검증 창이 누적되면 작업자가 현재 세션을 구분하기 어렵고 재검증 비용이 커짐.
- 어디부터 볼지:
  - `scripts/playwright_smoke.sh`
  - `output/playwright/inputs`
- 검증 기준:
  - 한 번의 스크립트 실행으로 HWP/HWPX 샘플 검증이 가능해야 함.
  - 실행 종료 후 Playwright 세션이 남지 않아야 함.

### 6. 샘플 기반 회귀셋 확장

- 왜 지금 필요한가:
  - 현재는 신청서 1종, 공고문 1종에 치우쳐 있어 다른 계열 문서 회귀를 놓칠 수 있음.
- 어디부터 볼지:
  - `output/playwright/inputs`
  - 샘플 분류 문서화
- 검증 기준:
  - 표 중심 HWP, 이미지 포함 HWP, 장식 많은 HWPX, 일반 본문형 HWPX를 최소 1종씩 확보해야 함.

### 7. 파비콘/검증 UX 정리

- 왜 지금 필요한가:
  - 현재 로컬 검증 시 `favicon.ico` 404가 반복되고, 탭 식별성이 약함.
- 어디부터 볼지:
  - `pages/viewer.html`
  - `icons`
- 검증 기준:
  - 콘솔의 반복 404가 사라지고, 뷰어 탭 식별이 쉬워져야 함.
