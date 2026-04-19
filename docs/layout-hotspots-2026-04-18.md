# Layout Hotspots

Date: 2026-04-19
Source Report: `/Users/shinehandmac/Github/ChromeHWP/output/playwright/verify-samples-report.json`
Screenshots: `/Users/shinehandmac/Github/ChromeHWP/output/playwright/qa-snapshots/`

## 목적

- 다음 레이아웃 수술에서 어디부터 베어야 하는지 페이지 단위로 우선순위를 고정한다.
- `다운로드 원본 QA` 결과를 사람 눈으로 빠르게 따라갈 수 있게 한다.
- 이 문서는 다운로드 원본 전체를 확인한 뒤, 그중 조판 괴리가 큰 문서를 먼저 세운 우선순위표이옵니다.

## 전수 확인 범위

- 2026-04-19 기준 `/Users/shinehandmac/Downloads` 의 지원 문서 `5개`를 모두 검증했사옵니다.
- 전수 목록은 `/Users/shinehandmac/Github/ChromeHWP/output/playwright/verify-samples-inventory.md` 를 기준으로 삼사옵니다.
- 아래 `1차 표적` 과 `2차 표적` 은 전수 확인 대상 중 우선 수술 순서를 뜻할 뿐, 검증 범위를 제한하는 뜻이 아니옵니다.

## 1차 표적

### `goyeopje.hwp`

- 원본: `/Users/shinehandmac/Downloads/고엽제등록신청서.hwp`
- 현재 관측: 한컴 기준 `2쪽` 일치, `표 2`, `textRuns 272`
- 핵심 문제:
  - 쪽수는 한컴 Viewer와 일치한다.
  - 표 중심 양식이라 `표 높이/행 분할/문단 줄간격` 오차가 화면 배치에 바로 반영될 가능성이 높다.
- 우선 확인 페이지:
  - `0쪽`: `표 1`, `textRuns 179`
  - `1쪽`: `표 1`, `textRuns 93`
- 참고 스냅샷:
  - `/Users/shinehandmac/Github/ChromeHWP/output/playwright/qa-snapshots/goyeopje.png`

### `incheon-2a.hwpx`

- 원본: `/Users/shinehandmac/Downloads/(공고문)인천가정2A-.hwpx`
- 현재 관측: 한컴 기준 `18쪽` 일치, `표 73`, `그림 20`
- 핵심 문제:
  - 고정 `CellBreak` 행 높이 보존으로 페이지 수 드리프트는 해소했다.
  - 표와 그림이 매우 많아 `anchor`, `wrap`, `table split`, `header/footer`, `page def` 의 화면 위치 오차가 누적될 가능성이 높다.
- 우선 확인 페이지:
  - `1쪽`: `제어 8 = 표 6 + 그림 2`, `textRuns 478`
  - `9쪽`: `제어 8 = 표 7 + 그림 1`, `textRuns 0`
  - `4쪽`: `제어 7 = 표 6 + 그림 1`, `textRuns 260`
  - `8쪽`: `제어 7 = 표 6 + 그림 1`, `textRuns 201`
  - `2쪽`: `제어 7 = 표 6 + 그림 1`, `textRuns 284`
- 참고 스냅샷:
  - `/Users/shinehandmac/Github/ChromeHWP/output/playwright/qa-snapshots/incheon-2a.png`

## 2차 표적

### `attachment-sale-notice.hwp`

- 원본: `/Users/shinehandmac/Downloads/(첨부)정정_공고문_신축다세대잔여세대선착순일반매각.hwp`
- 현재 관측: `4쪽`, `표 22`, `그림 6`
- 우선 확인 페이지:
  - `0쪽`: `제어 8 = 표 6 + 그림 2`
  - `2쪽`: `제어 8 = 표 7 + 그림 1`
  - `3쪽`: `제어 7 = 표 5 + 그림 2`
  - `1쪽`: `제어 5 = 표 4 + 그림 1`
- 핵심 포인트:
  - 그림 anchor 와 표 함께 흐르는 배치
  - 개체 높이와 문단 줄간격이 서로 끌어올리는지 확인

### `goyeopje-full-2024.hwp`

- 원본: `/Users/shinehandmac/Downloads/231229 고엽제후유(의)증환자 등 등록신청서 일체(2024.1.1. 기준).hwp`
- 현재 관측: `11쪽`, `2구역`, `표 13`
- 우선 확인 페이지:
  - `5쪽`: `표 2`, `textRuns 204`
  - `8쪽`: `표 2`, `textRuns 187`
  - `10쪽`: `표 1`, `textRuns 224`
- 핵심 포인트:
  - 다중 구역 전환
  - 양식형 표가 누적될 때 페이지 절단 위치가 흔들리는지 확인

### `gyeolseokgye.hwp`

- 원본: `/Users/shinehandmac/Downloads/결석계.hwp`
- 현재 관측: `1쪽`, `표 3`, `textRuns 100`
- 현재 판정:
  - 전수검사에는 포함되어 있사옵니다.
  - 현재는 페이지 수 드리프트가 크지 않고 구조가 비교적 단순하여, 1차와 2차 표적 뒤에 두고 있사옵니다.

## 비교 규칙

1. 같은 페이지 수가 나와도 PNG 스냅샷의 표 높이와 개체 위치가 다르면 불합격이다.
2. 제어 수가 많고 `textRuns` 가 높거나 매우 낮은 페이지부터 본다.
3. `textRuns = 0` 이면서 제어 수가 큰 페이지는 표/개체 위주 레이아웃 페이지일 가능성이 크므로 우선 본다.
4. 수정 후에는 반드시 다시 `node /Users/shinehandmac/Github/ChromeHWP/scripts/verify_samples.mjs` 로 전체를 돌린다.
