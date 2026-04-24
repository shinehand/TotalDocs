# Downloads QA Baseline

Date: 2026-04-19
Viewer: `http://127.0.0.1:4173/pages/viewer.html`
Machine Report: `/Users/shinehandmac/Github/TotalDocs/output/playwright/verify-samples-report.json`
Inventory Report: `/Users/shinehandmac/Github/TotalDocs/output/playwright/verify-samples-inventory.md`
Screenshots: `/Users/shinehandmac/Github/TotalDocs/output/playwright/qa-snapshots/`

## 목적

- QA는 저장소 사본이 아니라 `/Users/shinehandmac/Downloads` 의 원본 `HWP/HWPX` 파일을 기준으로 한다.
- 검증 스크립트는 다운로드 폴더의 지원 문서를 자동 발견하며, 2026-04-19 현재 확인된 대상은 `5개`이옵니다.
- 페이지 수 정답은 [한컴 Viewer 기준선](/Users/shinehandmac/Github/TotalDocs/docs/hancom-oracle-page-baseline.json:1)을 따른다.
- 브라우저 적재는 자동화 안정성을 위해 `output/playwright/served-inputs/` 에 임시 복제본을 만들지만, 바이트 원천은 항상 다운로드 원본이다.
- 이후 레이아웃 수정은 이 기준서와 최신 JSON 리포트, 스냅샷 PNG를 함께 보고 판정한다.

## 기준 샘플

| 샘플 ID | 원본 파일 | 현재 관측 | 구조 진단 요약 | 스냅샷 |
|---|---|---|---|---|
| `goyeopje` | `/Users/shinehandmac/Downloads/고엽제등록신청서.hwp` | `2쪽`, `1구역` | `표 2`, `textRuns 272` | `/Users/shinehandmac/Github/TotalDocs/output/playwright/qa-snapshots/goyeopje.png` |
| `goyeopje-full-2024` | `/Users/shinehandmac/Downloads/231229 고엽제후유(의)증환자 등 등록신청서 일체(2024.1.1. 기준).hwp` | `11쪽`, `2구역` | `표 13`, `textRuns 1730` | `/Users/shinehandmac/Github/TotalDocs/output/playwright/qa-snapshots/goyeopje-full-2024.png` |
| `gyeolseokgye` | `/Users/shinehandmac/Downloads/결석계.hwp` | `1쪽`, `1구역` | `표 3`, `textRuns 54` | `/Users/shinehandmac/Github/TotalDocs/output/playwright/qa-snapshots/gyeolseokgye.png` |
| `attachment-sale-notice` | `/Users/shinehandmac/Downloads/(첨부)정정_공고문_신축다세대잔여세대선착순일반매각.hwp` | `4쪽`, `1구역` | `제어 28 = 표 22 + 그림 6` | `/Users/shinehandmac/Github/TotalDocs/output/playwright/qa-snapshots/attachment-sale-notice.png` |
| `incheon-2a` | `/Users/shinehandmac/Downloads/(공고문)인천가정2A-.hwpx` | `18쪽`, `1구역` | `제어 93 = 표 73 + 그림 20` | `/Users/shinehandmac/Github/TotalDocs/output/playwright/qa-snapshots/incheon-2a.png` |

## 현재 판정

- 다운로드 원본 5종 모두 로드, 페이지 순회, 키워드 검색, 구조 진단, PNG 스냅샷 저장, inventory 기록까지 완료했다.
- 한컴 Viewer 페이지 수 기준선은 5종 모두 일치한다.
  - `goyeopje.hwp`: 한컴 `2쪽`, TotalDocs `2쪽`
  - `incheon-2a.hwpx`: 한컴 `18쪽`, TotalDocs `18쪽`
- `gyeolseokgye.hwp` 는 현재 전수검사 범위 안에 있으나, 상대적으로 단순하여 우선 수술 표적에서만 뒤로 밀려 있사옵니다.
- 따라서 다음 수술은 페이지 수가 아니라 `표 위치`, `행 분할`, `반복 머리행`, `문단 줄간격`, `쪽 정의`의 화면 충실도 순으로 들어가야 한다.

## QA 규칙

1. 새 렌더 수정 후에는 반드시 이 다섯 원본 파일로 다시 검증한다.
2. `verify-samples-report.json` 의 구조 진단 값과 `qa-snapshots/*.png` 를 함께 본다.
3. `verify-samples-inventory.md` 로 다운로드 폴더 전체 검증 범위를 먼저 확인한다.
4. 저장소 내부 fixture만 보고 합격 판정을 내리지 않는다.
5. 페이지 수가 같아도 스냅샷 PNG의 표 배치와 개체 위치가 다르면 불합격으로 본다.

## 실행 명령

```bash
node /Users/shinehandmac/Github/TotalDocs/scripts/verify_samples.mjs
```
