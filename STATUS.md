# TotalDocs 현재 상태 요약

기준 시각: 2026-04-06

## 지금까지 진행한 작업

- HWP 5.0 공식 PDF, HWPML/OWPML 문서, 한컴 배포 자료를 기준으로 파서와 렌더러를 계속 보강했다.
- `.hwpx`와 `.owpml`을 같은 메인 파서 경로로 처리하도록 맞췄고, 파일 열기/저장/UI/링크 감지도 함께 정리했다.
- HWP/HWPX 문단 서식 해석을 확장했다.
  - 줄 간격 종류(`percent`, `fixed`, `space-only`, `minimum`)
  - 글자 모양(`장평`, `자간`, `상대 크기`, `글자 위치`)
  - 표 `cellSpacing`
- HWP 개체 공통 속성 해석을 확장했다.
- 수식(`EQEDIT`)과 OLE/차트 placeholder 복원을 넣었고, HWPX 비인라인 그림이 잘못 인라인으로 섞이는 문제를 줄였다.
- 배포용 문서용 복호화 기반 로직 반영.
- 양식표 보정 지속.
- HWP/HWPX 레이아웃 메트릭 정밀화.
- HWPX/HWP 단락 서식 파싱 버그 수정 (indent 타이포, marginRight 파싱, 단위 스케일 1/75).
- **코드 파일 분할**: `js/hwp-parser.js`, `js/hwp-renderer.js`, `js/app.js`
- HWP 스타일/문단 머리 확장 (`TAB_DEF`, `NUMBERING`, `BULLET`, `STYLE`).
- **HWP Section Definition 파싱 추가 (이번 세션)**
  - `_parseHwpSecDef(body)`: BodyText 내 HWPTAG_PAGE_DEF (tag 73) 레코드 파싱 → 용지 크기·여백 추출 (이전에 tag 78로 잘못 설정되어 있었고 바이트 오프셋도 4바이트씩 오류였음, 수정 완료)
  - `_parseHwpBlockRange`: `secd` 컨트롤 인식 → HWPTAG_SEC_DEF 서브레코드 탐색, `extras.sectionMeta` 저장
  - `_extractSectionParas` / `_parseBodyText` / `_parseHwp5` 파이프라인으로 `sectionMeta` → `pageStyle` 전달
  - 각 HWP 페이지에 `page.pageStyle = { sourceFormat: 'hwp', width, height, margins }` 적용
  - `parser.worker.js`에 동일 로직 동기화
- **`applyPageStyle` HWP 지원 추가 및 HWPX 정확도 개선 (이번 세션)**
  - `sourceFormat === 'hwp'`일 때 HWPUNIT(1/75 px) 스케일로 용지 크기·여백 적용
  - HWPX도 1/75 스케일로 통일 (기존 1/106에서 수정, 실제 HWPX XML 검증 기반)
  - 모든 여백 상한을 120px로 통일 (기존 72-96px에서 확대)
- **표 셀 단위 변환 수정 (이번 세션)**
  - `isHwpxTable` 플래그를 행 루프 바깥으로 이동, `TABLE_UNIT_SCALE` 도입
  - HWP·HWPX 모두 HWPUNIT (1/7200 inch, 96DPI 기준 1/75 px) 단위 사용 확인 (실제 HWPX XML 분석)
  - 기존 `1/106` 스케일에서 `1/75`로 수정: `cellSpacingPx`, 행높이, 셀높이, 셀패딩 전부 적용
  - HWPX 셀패딩이 ~3px에서 ~4-7px로 개선 (예: 283 HWPUNIT = 1mm → 3.8px)

## 확인된 대표 결과

- `incheon-2a.hwpx`: 비인라인 LH 로고 배치, 표/개체 offset
- `attachment-sale-notice.hwp`: 15페이지, 이미지 3개, 배너/본문
- `gyeolseokgye.hwp`: 병합셀 열폭, 세로라벨, 들여쓰기/간격

## 저장소에 함께 둔 레퍼런스

- 공식 형식 문서: `docs/hwp-spec/`
- 테스트 샘플: `output/playwright/inputs/`
- 자산 목록: `docs/hwp-assets.md`

## 아직 남은 큰 작업

- 표 레이아웃 정밀화
  - 행 높이, 세로 정렬, 중첩 표 비율을 원본과 더 가깝게 맞추기
- 개체 절대배치 실문서 검증
  - `page/paper` 기준 개체가 실제로 들어 있는 샘플 확보 후 end-to-end 검증
- OLE/차트 실렌더링
- 배포용 HWP 실문서 검증
- 줄바꿈/폰트 폭 정밀화
- 자동 회귀 검증 안정화

## 다음 우선순위

1. HWP 실문서에서 `secd` 컨트롤 인식 검증 완료 (HWPTAG_PAGE_DEF tag 73 → offset 0부터 실데이터 확인 및 수정)
2. HWPX 표 셀패딩 1/75 스케일 (HWPUNIT 기반) 적용 결과 시각 확인
3. `결석계.hwp` 하단 중첩 표 행높이와 세로 정렬 재확인
4. 차트/OLE placeholder를 실제 렌더 경로로 확장
5. 실샘플 기준 `page/paper` 절대배치 검증

