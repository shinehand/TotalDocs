# Fidelity Audit

Date: 2026-04-17
Scope: `/Users/shinehandmac/Downloads` 원본 샘플 + `docs/hwp-spec/` 공식 형식 문서 + 현재 TotalDocs JS 파서/DOM 렌더러 기반 뷰어

## 원본 기준

- 다운로드 원본과 저장소 자동검증 샘플의 대응 관계를 먼저 고정해야 한다.
- `고엽제등록신청서`는 두 벌이다.
  - 짧은 양식:
    - Downloads: `/Users/shinehandmac/Downloads/고엽제등록신청서.hwp`
    - Repo mirror: `/Users/shinehandmac/Github/TotalDocs/output/playwright/inputs/goyeopje.hwp`
    - SHA-256: `f3283f9ddef10a9735926f86af2d278ead365e4d9b8c284462434a553c88ae8e`
  - 2024 일체본:
    - Downloads: `/Users/shinehandmac/Downloads/231229 고엽제후유(의)증환자 등 등록신청서 일체(2024.1.1. 기준).hwp`
    - Repo mirror: `/Users/shinehandmac/Github/TotalDocs/output/playwright/inputs/goyeopje-full-2024.hwp`
    - SHA-256: `efaa735f155096914f9bd335723226d67ca8473248b10903e08ea6234af3a72e`
- 나머지 샘플은 Downloads 원본과 Repo mirror가 동일하다.
  - `gyeolseokgye.hwp`
  - `attachment-sale-notice.hwp`
  - `incheon-2a.hwpx`

## 형식 문서 재점검 범위

- `docs/hwp-spec/hwp-5.0-revision1.3.pdf`
  - `4.2.5 테두리/배경`
  - `4.2.6 글자 모양`
  - `4.2.7 탭 정의`
  - `4.2.8 문단 번호`
  - `4.2.9 글머리표`
  - `4.2.10 문단 모양`
  - `4.3.4 문단의 레이아웃`
  - `4.3.9.1 표 개체`
  - `4.3.9.4 그림 개체`
  - `4.3.9.5 OLE 개체`
  - `4.3.10.1 구역 정의`
  - `4.3.10.1.3 쪽 테두리/배경`
  - `4.3.10.3 머리말/꼬리말`
  - `4.3.10.4 각주/미주`
  - `4.3.10.5 자동 번호`
  - `4.3.10.9 쪽 번호 위치`
- `docs/hwp-spec/hwpml-3.0-revision1.2.pdf`
  - `CharShape`
  - `ParaShape`
  - `Indent`
  - `LineSpacingType`
  - `LineSpacing`
  - `CellSpacing`
  - `RepeatHeader`
  - `Page`
  - `Header/Footer/MasterPage`
  - `Shape / Picture / OLE`
- `docs/hwp-spec/hwp-distribution-doc-revision1.2.pdf`
  - 배포용 문서 암복호화 경로 확인

## 현재 검증 장치

- 자동감사 스크립트를 현행 뷰어 경로에 맞게 전면 갱신했다.
  - 파일: `/Users/shinehandmac/Github/TotalDocs/scripts/verify_samples.mjs`
  - 기준:
    - `http://127.0.0.1:4173/pages/viewer.html?hwpUrl=...`
    - 상태바 `쪽/구역`
    - 렌더된 실제 `.hwp-page` 개수
    - 문서 내 키워드 검색
    - 첫 쪽부터 마지막 쪽까지의 페이지 순회
    - 콘솔 오류 수집
- 결과 산출물:
  - `/Users/shinehandmac/Github/TotalDocs/output/playwright/verify-samples-report.json`

## 2026-04-17 실제 관측값

- `goyeopje.hwp`
  - 뷰어: `2쪽`, `구역: 1 / 1`
  - 끝 페이지 순회: 통과
  - reference CLI: `2쪽`, `구역 수 1`
- `goyeopje-full-2024.hwp`
  - 뷰어: `11쪽`, `구역: 1 / 2`
  - 끝 페이지 순회: 통과
- `gyeolseokgye.hwp`
  - 뷰어: `1쪽`, `구역: 1 / 1`
  - 끝 페이지 순회: 통과
- `attachment-sale-notice.hwp`
  - 뷰어: `4쪽`, `구역: 1 / 1`
  - 끝 페이지 순회: 통과
- `incheon-2a.hwpx`
  - 뷰어: `15쪽`, `구역: 1 / 1`
  - 끝 페이지 순회: 통과
  - reference CLI: `15쪽`, `구역 수 1`
- 공통 결함:
  - 2026-04-17 초기 감사에서는 본문 전용 검색 경로 때문에 샘플 전부에서 검색이 0건이었다.
  - 2026-04-18 보정 후에는 페이지 텍스트 레이아웃 기반 검색으로 샘플 키워드 적중이 복구되었다.
  - 띄어 조판된 제목(`등 록 신 청 서`, `알 려 드 립 니 다`)도 공백 무시 검색으로 적중한다.

## 현재 판정 기준

- `로드 성공`
  - 파일명 포함 상태 메시지 표시
  - 페이지 캔버스 1개 이상 생성
- `문서 끝 순회`
  - 상태바가 `1 / N 쪽`부터 `N / N 쪽`까지 끝까지 이동
- `핵심 본문 존재`
  - 샘플별 핵심 키워드 검색 결과가 1건 이상
- `런타임 안정성`
  - error 레벨 콘솔 로그 0건

## 확인해야 할 기능 체크리스트

- 문서 열기
  - `.hwp`
  - `.hwpx`
  - 배포용 문서 자동 편집 전환
- 조판
  - 페이지 수
  - 용지 크기/여백
  - 구역 수
  - 머리말/꼬리말
  - 쪽 번호
- 문단/글자
  - 정렬
  - 들여쓰기/내어쓰기
  - 줄간격
  - 탭
  - 번호/글머리표
  - 폰트 대체
- 표
  - 셀 병합
  - 행 나눔
  - 셀 간격
  - 머리행 반복
  - 테두리/배경
- 개체
  - 그림
  - 본문배치/글자처럼
  - 앞으로/뒤로
- 편집/저장
  - 직접 입력
  - 현재 `.hwp` 저장
  - 검색
  - 인쇄/HTML 내보내기

## 현재 드리프트 의심축

- 문단/문자 폭 계산
  - `measureTextWidth` 기반 웹 폰트 측정값이 원본 조판과 다를 가능성
- 표 위치/분할
  - 표 X 위치, 행 분할, 반복 머리행, 셀 간격 반영 누락 가능성
- 쪽/구역 메타
  - 쪽 정의, 테두리/배경, 머리말/꼬리말, 쪽번호 배치 반영 차이 가능성
- 개체 배치
  - 그림/도형의 wrap, relativeTo, z-order 차이 가능성

## 코드상 우선 조사 위치

- `/Users/shinehandmac/Github/TotalDocs/js/hwp-renderer.js`
  - DOM 렌더 진입점
  - 웹 폰트 및 표/개체 배치 경로
- `/Users/shinehandmac/Github/TotalDocs/js/app.js`
  - 상태바/페이지 이동/캔버스 배치
  - 저장/검색/편집 연결
- `/Users/shinehandmac/Github/TotalDocs/js/parser.worker.js`
  - Worker JS 파서 경로
  - 표/문단/스타일 휴리스틱

## 다음 조사 순서

1. `verify_samples.mjs` 결과를 기준으로 샘플별 실제 페이지 수와 키워드/끝 페이지 순회를 고정한다.
2. `goyeopje.hwp`, `goyeopje-full-2024.hwp`, `incheon-2a.hwpx`를 우선 표적 삼아 화면 캡처와 기준 SVG를 나란히 비교한다.
3. 차이가 보이는 페이지는 `구역 정의 -> 문단 모양 -> 표 속성 -> 개체 배치` 순으로 조항을 역추적한다.
4. 가장 먼저 `표 위치/행 분할`, `문단 들여쓰기/줄간격`, `쪽 정의/머리말/꼬리말`을 손본다.
