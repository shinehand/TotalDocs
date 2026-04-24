# Font Strategy

2026-04-18 기준 `TotalDocs` 의 글꼴 전략이옵니다.

## 목적

- 다운로드 원본 `HWP/HWPX` 문서의 줄바꿈과 쪽 나눔 오차를 줄인다.
- 문서에서 자주 보이는 `휴먼/한양/HY/#고딕/#명조` 계열에 대해 공개 라이선스 기반 대체군을 준비한다.
- 라이선스가 민감한 한컴 기본 글꼴은 무리하게 저장소에 묶지 않고, 안전한 공개 글꼴 중심으로 폭을 넓힌다.

## 문서 샘플에서 확인된 글꼴 군

현재 샘플 문서에서 확인된 대표 글꼴 군은 이러하옵니다.

- `#중고딕`
- `HCI Poppy`
- `HY헤드라인M`
- `굴림`
- `돋움`
- `돋움체`
- `맑은 고딕`
- `명조`
- `바탕`
- `한양신명조`
- `한양중고딕`
- `함초롬돋움`
- `함초롬바탕`
- `휴먼명조`

## 이번에 추가한 공개 글꼴

### 1. NanumSquare Neo

용도:

- `휴먼고딕`
- `한양중고딕`
- `한양견고딕`
- `#세고딕`, `#중고딕`, `#태고딕`, `#견고딕`
- `고딕`

추가 파일:

- `lib/fonts/NanumSquareNeoTTF-aLt.woff2`
- `lib/fonts/NanumSquareNeoTTF-bRg.woff2`
- `lib/fonts/NanumSquareNeoTTF-cBd.woff2`
- `lib/fonts/NanumSquareNeoTTF-dEb.woff2`
- `lib/fonts/NanumSquareNeoTTF-eHv.woff2`

판단:

- 공고문, 표 머리행, 헤드라인 계열에서 기존 `Noto Sans KR` 단일 대체보다 더 가까운 인상을 주옵니다.

### 2. Wanted Sans

용도:

- `HCI Poppy`
- `한양그래픽`
- 강한 제목 대체 후보군

추가 파일:

- `lib/fonts/WantedSans-Regular.woff2`
- `lib/fonts/WantedSans-Medium.woff2`
- `lib/fonts/WantedSans-SemiBold.woff2`
- `lib/fonts/WantedSans-Bold.woff2`
- `lib/fonts/WantedSans-ExtraBold.woff2`
- `lib/fonts/WantedSans-ExtraBlack.woff2`

판단:

- 강한 제목용 고딕이 필요한 문서에서 기존 `Noto Sans KR Bold` 보다 더 분명한 대비를 줍니다.
- 단, 2026-04-19 한컴 Viewer 비교에서는 `HY헤드라인M` 제목 대체로 `Wanted Sans`보다 `dotum-Regular.ttf`가 더 가까웠사옵니다.

### 3. Dotum TTF

용도:

- `HY헤드라인M`
- `HYHeadLine M`
- `HYHeadLine Medium`

적용 파일:

- `lib/fonts/dotum-Regular.ttf`

판단:

- `incheon-2a.hwpx` 첫 제목 기준 후보 비교에서 `Happiness Sans Title` titleDiff `29.472`, `NanumSquareNeo Heavy` `31.27`, `gulim-Regular.ttf` `26.92`, `dotumche-Regular.ttf` `27.81`, `dotum-Regular.ttf` `26.88`로 확인되었사옵니다.
- 정식 매핑 후 HWPX 로고 앵커, 제어개체 오프셋, `CONTINUOUS` 그림자 보정까지 포함한 최신 `incheon-2a.hwpx` titleDiff는 `26.707`이옵니다.
- `attachment-sale-notice.hwp` 단독 재검증에서도 현 `dotum-Regular.ttf` 매핑이 titleDiff `32.788`로 가장 안정적이었고, `gulim-Regular.ttf`는 `32.847`, `Happiness Sans Title`은 `35.102`, `WantedSans-ExtraBlack`은 `36.213`으로 악화되었사옵니다.

## 계속 CDN으로 두는 글꼴

### 함초롬 계열

- `함초롬돋움`
- `함초롬바탕`
- `한컴돋움`
- `한컴바탕`

현재 처리:

- 저장소에 직접 묶지 않고 CDN 로드 유지

이유:

- 한컴 기본 글꼴은 사용 범위와 재배포 조건이 민감하여, 추후 상용 배포를 생각하면 라이선스 검토 없이 저장소에 고정하는 것은 위험하옵니다.

## 매핑 원칙

### 명조 축

- `휴먼명조`, `한양신명조`, `명조`, `바탕`
- 우선 `NanumMyeongjo` / `Noto Serif KR` / `GowunBatang`

### 고딕 축

- `휴먼고딕`, `한양중고딕`, `#중고딕`, `돋움`, `굴림`
- 우선 `NanumSquareNeo` / `Pretendard` / `Noto Sans KR`

### 헤드라인 축

- `HCI Poppy`, `HY헤드라인M`, `한양그래픽`
- 우선 `dotum-Regular.ttf` / `Wanted Sans` / `NanumSquareNeo`

## 다음 수술 우선순위

1. QA 리포트의 `fontsUsed` 를 기준으로 문서별 실제 사용 글꼴을 계속 추적한다.
2. `goyeopje.hwp` 와 `incheon-2a.hwpx` 에서 글꼴 변경 전후 줄바꿈 차이를 비교한다.
3. 필요하면 공개 라이선스가 분명한 `MaruBuri`, `SUIT`, `SUITE` 도 다음 증원 후보로 검토한다.
