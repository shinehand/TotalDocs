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

- 이번 세션에서 완료한 것:
  - `HWP secd PAGE_DEF flags` → `hideFirstHeader / hideFirstFooter / hideFirstPageNum` 추출 및 적용
  - `HWP GSO 텍스트박스` 파싱 (LIST_HEADER + 단락 레코드 수집 → `type: 'textbox'` 블록)
  - `HWP GSO 벡터 도형 플레이스홀더` (`type: 'shape'`, 크기 유지)
- 바로 이어서 할 일:
  - `HWP secd` 섹션 시작 쪽번호(`startPageNum`) 반영 — 현재는 누적 페이지 번호만 사용
  - `pageStyle.height/margins`를 pagination budget에 직접 반영 (단위 재검증 필요)
  - `HWP header/footer odd/even` 실 샘플 검증 (홀짝 헤더를 쓰는 문서 없으면 확인 곤란)
- 이번 턴에서 보류한 것:
  - `pageStyle.height/margins`를 pagination budget에 직접 반영하는 실험
  - 이유: 다운로드 샘플 기준으로 즉시 과분할이 발생했고, 단위 해석을 다시 검증해야 함
- 다음 시작 시 체크포인트:
  - `secd` 컨트롤 body의 `startPageNum` 위치 (PAGE_NUM_PARA tag-76 또는 secd 본체 offset)
  - `_paginateSectionBlocks`에서 `pageStyle.height` 사용 시 단위(HWPUNIT 1/7200 inch → px)
  - GSO 텍스트박스가 있는 실 샘플 문서로 `type: 'textbox'` 렌더 확인
- 완료 기준:
  - `goyeopje.hwp` 3페이지 유지
  - `attachment-sale-notice.hwp` 14페이지 유지
  - header/footer/page number 적용이 원본과 더 가깝게 보일 것

## P0

### 1. HWP 개체/도형 앵커 복원

- 왜 지금 필요한가:
  - HWP 문서는 표/문단 외에도 도형, 선, 이미지, 스탬프형 개체 비중이 높아서 현재 fidelity 상 가장 큰 잔여 차이임.
- 어디부터 볼지:
  - `/Users/shinehandmac/Github/ChromeHWP/js/app.js`
  - `/Users/shinehandmac/Github/ChromeHWP/js/parser.worker.js`
  - `HWPTAG_CTRL_HEADER`, 개체 공통 속성, shape/picture control 파싱 경로
- 검증 기준:
  - 개체가 있는 HWP 샘플에서 “사라짐” 없이 위치와 크기가 원본 대비 큰 틀에서 맞아야 함.
  - 기존 신청서 샘플 `3페이지`가 깨지면 안 됨.

### 2. HWPX 도형/이미지 앵커와 장식 표 정밀화

- 왜 지금 필요한가:
  - HWPX는 큰 구조는 맞아도 상단 슬로건, 장식 밴드, 시각용 1셀 표의 위치와 여백 차이가 아직 눈에 띔.
- 어디부터 볼지:
  - `/Users/shinehandmac/Github/ChromeHWP/js/app.js`
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
  - `/Users/shinehandmac/Github/ChromeHWP/js/app.js`
  - `appendParagraphBlock()`
  - `appendTableBlock()`
  - HWP/HWPX 단위 변환 함수
- 검증 기준:
  - 샘플 문서 첫 페이지 비교 시 제목/표 라벨/입력칸 텍스트가 더 덜 눌려 보이고, 페이지 수는 유지되어야 함.

### 4. 메인/워커 HWP 파서 중복 해소

- 왜 지금 필요한가:
  - 같은 로직을 두 파일에 반복 수정하고 있어 회귀 위험이 커지고, 기능 추가 속도가 느려짐.
- 어디부터 볼지:
  - `/Users/shinehandmac/Github/ChromeHWP/js/app.js`
  - `/Users/shinehandmac/Github/ChromeHWP/js/parser.worker.js`
  - 공통 HWP 파싱 유틸 추출 가능 범위
- 검증 기준:
  - HWP 샘플 2종 이상에서 메인 fallback/worker 결과가 동일해야 함.
  - 새 기능 추가 시 수정 파일 수가 줄어야 함.

## P1

### 5. Playwright 회귀 검증 고정 세션화

- 왜 지금 필요한가:
  - 검증 창이 누적되면 작업자가 현재 세션을 구분하기 어렵고 재검증 비용이 커짐.
- 어디부터 볼지:
  - `/Users/shinehandmac/Github/ChromeHWP/scripts/playwright_smoke.sh`
  - `/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs`
- 검증 기준:
  - 한 번의 스크립트 실행으로 HWP/HWPX 샘플 검증이 가능해야 함.
  - 실행 종료 후 Playwright 세션이 남지 않아야 함.

### 6. 샘플 기반 회귀셋 확장

- 왜 지금 필요한가:
  - 현재는 신청서 1종, 공고문 1종에 치우쳐 있어 다른 계열 문서 회귀를 놓칠 수 있음.
- 어디부터 볼지:
  - `/Users/shinehandmac/Github/ChromeHWP/output/playwright/inputs`
  - 샘플 분류 문서화
- 검증 기준:
  - 표 중심 HWP, 이미지 포함 HWP, 장식 많은 HWPX, 일반 본문형 HWPX를 최소 1종씩 확보해야 함.

### 7. 파비콘/검증 UX 정리

- 왜 지금 필요한가:
  - 현재 로컬 검증 시 `favicon.ico` 404가 반복되고, 탭 식별성이 약함.
- 어디부터 볼지:
  - `/Users/shinehandmac/Github/ChromeHWP/pages/viewer.html`
  - `/Users/shinehandmac/Github/ChromeHWP/icons`
- 검증 기준:
  - 콘솔의 반복 404가 사라지고, 뷰어 탭 식별이 쉬워져야 함.
