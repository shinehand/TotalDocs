# HWP 수식 분석 - revision 1.3

이 문서는 `/Users/shinehandmac/Downloads/한글문서파일형식_수식_revision1.3.pdf` 전문을 다시 읽고, `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/README.md`, `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/spec-crosswalk.md`, `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/implementation-requirements.md`와 맞물리게 수식 구현 입력용으로 재정리한 분석서다.

목표는 세 가지다.

1. 수식 스크립트를 손실 없이 토큰화하고 AST로 옮긴다.
2. 템플릿 기반 레이아웃과 baseline 동작을 안정적으로 구현한다.
3. `HWPTAG_EQEDIT` 저장/복원에서 원문 스크립트와 메타데이터를 잃지 않는다.

원문 PDF가 직접 정의하는 사실과, 구현을 위해 필요한 보수적 추론을 구분해서 적었다. 본문에 `구현 추론`이라고 적힌 부분은 PDF의 예제/설명/렌더 결과를 바탕으로 한 권장 규칙이다.

## 1. 문서 개요

- 대상 문서: `Hwp Document File Formats - Equation`
- revision: `1.3:20181108`
- 페이지 수: 19
- 범위: 한글 2002 이후 제품의 수식 편집기 입력 규칙, 명령어, 기호, 예제
- 직접 다루는 구현 축:
  - 수식 토크나이저
  - 수식 파서
  - 수식 레이아웃 엔진
  - 수식 serializer/deserializer
  - 회귀 테스트 세트

원문 PDF는 수식 편집기의 "입력 언어"와 "템플릿 사용법"에 초점을 둔다. 바이너리 저장 구조 자체는 자세히 설명하지 않으므로, 저장 필드 쪽은 이 저장 규칙 문서를 직접 근거로 삼기보다 `implementation-requirements.md`와 현재 저장 구조 분석 흐름에 맞춰 교차 연결해야 한다.

## 2. 형식 범위와 버전

- 본 PDF는 수식 편집기의 스크립트 입력 규칙을 설명한다.
- 수식은 템플릿 기반 편집기이며, 단순 문자열이 아니라 구조적 블록으로 해석해야 한다.
- 영문은 기본적으로 이탤릭으로 입력된다.
- 첫 글자의 글자 모양이 수식 전체의 기본 글자 크기, 색, 글꼴을 결정한다.
- `SCALE`로 같은 수식 내부에서도 글자 크기를 바꿀 수 있다.
- 기본 함수와 일부 예약어는 자동으로 로만체가 된다.
- 예제 2.1~2.5는 파서와 레이아웃 회귀 테스트의 최소 기준이다.

리포지터리 문서와의 연결:

| 참조 문서 | 이 문서에 주는 제약 |
|---|---|
| `README.md` | 단순 요약이 아니라 파서/레이아웃/보존 기준을 남겨야 한다 |
| `spec-crosswalk.md` | equation PDF는 파서, 템플릿 조판, 저장기의 직접 입력이다 |
| `implementation-requirements.md` | `HWPTAG_EQEDIT`의 script, `len`, size, color, baseline, version, font name, 문서 수준 `수식 시작 번호` 보존이 필요하다 |

## 3. 핵심 데이터 구조

### 3.1 구현 계층

| 계층 | 역할 | 구현 포인트 |
|---|---|---|
| 원문 스크립트 층 | `WCHAR` 스크립트 그대로 보존 | serializer는 pretty-printer가 아니라 lossless round-trip 보존기여야 한다 |
| 토큰 층 | 제어 토큰, 명령어, 기호명, 리터럴, 괄호, 숫자, 식별자 분해 | 공백/엔터/탭은 구분자이고, `~`와 backtick은 표시용 빈칸이다 |
| 구조 층 | 분수, 루트, 적분, 합, cases, matrix, longdiv 등 템플릿 AST | 명령어마다 인자 수, 결합 방식, 배치 기준이 다르다 |
| 레이아웃 층 | inline box, stack, operator, delimiter, grid, aligned block 계산 | object baseline과 내부 수학 axis를 분리해 다뤄야 한다 |
| 저장 층 | `HWPTAG_EQEDIT`와 문서 속성 연결 | script와 메타데이터를 함께 보존해야 한다 |

### 3.2 원문 기반 문법 모델

원문 PDF가 사실상 요구하는 문법 모델은 다음과 같다.

| 문법 요소 | 의미 | 구현 메모 |
|---|---|---|
| 항(term) | 빈칸/엔터/탭으로 분리되는 최소 단위 | 일반 공백은 토큰 경계지만 렌더 공백은 아니다 |
| 묶음(group) | `{...}`로 여러 항을 하나의 인자로 묶음 | 분수, 루트, cases, matrix, relation 주석에 반복 사용된다 |
| 장문 리터럴 | `"..."`로 9자 이상 한 낱말 또는 긴 문장 보존 | 내부 공백/반복 공백을 정규화하면 안 된다 |
| 줄 블록 | `#`로 행 분리 | matrix, cases, pile, longdiv에서 구조 토큰이다 |
| 정렬 축 | `&`로 열 기준 지정 | EQALIGN, matrix류, ladder류에서 열 경계이자 alignment anchor다 |
| 스타일 상태 | `rm`, `it`, `bold`, `scale`, `Color/COLOR` | 상태 전이는 파싱 결과와 별개로 원문 lexeme까지 보존해야 한다 |
| 기호명 lookup | `UNION`, `neq`, `larrow`, `benzene` 등 이름으로 glyph 선택 | 일부는 별칭과 이름 충돌이 있으므로 group-aware lookup이 안전하다 |

### 3.3 저장 필드와의 연결

아래 표는 이 문서가 직접 설명하는 입력 규칙과 현재 리포지터리 구현 요구사항을 이어 붙인 것이다.

| 저장 항목 | 출처 축 | 의미 | 구현 포인트 |
|---|---|---|---|
| 원문 script string | equation PDF + `implementation-requirements.md` | 수식 편집기 입력 스크립트 | 파싱 성공 여부와 무관하게 원문 문자열을 보존한다 |
| `len` | `implementation-requirements.md` | script 길이 | 저장 시 실제 `WCHAR` 길이와 불일치하면 안 된다 |
| size | `implementation-requirements.md` | 수식 글자 크기 | 첫 글자 기준 크기와 local `scale` 적용 결과의 기준점이다 |
| color | `implementation-requirements.md` | 수식 글자 색상 | object 수준 색과 `Color/COLOR` local 색을 함께 유지해야 한다 |
| baseline | `implementation-requirements.md` | 수식 개체의 외부 baseline | 내부 템플릿 baseline을 다시 계산하더라도 저장 값은 함부로 바꾸면 안 된다 |
| version | `implementation-requirements.md` | 수식 버전 정보 | 재저장 시 삭제하지 않는다 |
| font name | `implementation-requirements.md` | 수식 글꼴 이름 | 글꼴 대체가 일어나더라도 원값은 유지한다 |
| 문서 수준 `수식 시작 번호` | `implementation-requirements.md` | 수식 번호 정책 | equation object 수정과 별개로 문서 속성도 함께 검증한다 |

감히 아뢰옵건대, 실제 구현에서는 "파싱용 AST"와 "보존용 원문 슬라이스"를 함께 갖는 이중 모델이 가장 안전하다.

## 4. 토큰 / 명령 / 기호 체계

### 4.1 제어 토큰과 리터럴 규칙

| 입력 요소 | 분류 | 표시 의미 | 파서 규칙 | 정규화 금지 포인트 |
|---|---|---|---|---|
| 일반 `<Space>` | 구분자 | 화면에 빈칸으로 나타나지 않음 | 항 분리만 담당 | `~`로 치환하면 안 된다 |
| 일반 `<Enter>` | 구분자 | 화면에 줄바꿈으로 나타나지 않음 | 항 분리만 담당 | `#`로 치환하면 안 된다 |
| 일반 `<Tab>` | 구분자 | 화면에 탭으로 나타나지 않음 | 항 분리만 담당 | `&`로 치환하면 안 된다 |
| `~` | 표시용 공백 | 정상적인 빈칸 | 출력에 실제 space width 생성 | 일반 공백으로 접어 버리면 안 된다 |
| backtick | 표시용 공백 | 빈칸의 1/4 | 출력에 quarter-space width 생성 | `~`나 일반 공백으로 바꾸면 안 된다 |
| `{...}` | 그룹 | 여러 항을 하나의 인자로 묶음 | 중첩 가능 그룹 토큰 | 불필요해 보여도 제거 금지 |
| `"..."` | quoted literal | 9자 이상 한 낱말 묶음 또는 긴 문장 입력 | 내부 공백을 내용으로 취급하는 literal mode | 따옴표 제거, 내부 trim, 연속 공백 축약 금지 |
| `#` | 구조 토큰 | 결과 수식의 줄 바꾸기 | multi-row block 분리 | 실제 newline으로 대체 금지 |
| `&` | 구조 토큰 | 세로 칸 맞춤 | alignment column anchor | 탭 문자로 대체 금지 |
| `^` | 첨자 토큰 | 위 첨자 | `SUP`와 기능상 대응 | `SUP`로 강제 canonicalize 금지 |
| `_` | 첨자 토큰 | 아래 첨자 | `SUB`와 기능상 대응 | `SUB`로 강제 canonicalize 금지 |
| bare identifier | 일반 항 | 식별자/단어 | 9자를 넘으면 둘 이상의 항으로 분리됨 | 9자 초과 식별자를 자동 결합 금지 |

`구현 추론`: bare identifier의 "9자"는 저장이 `WCHAR` 기반이므로 사용자 가시 문자 수 또는 `WCHAR` 수를 기준으로 보수적으로 구현하는 편이 안전하다. 어느 쪽을 택하든 serializer는 원문 문자열을 그대로 되돌려야 한다.

### 4.2 스타일 / 글꼴 / 색상 명령

| 명령 | 원문 의미 | 적용 범위 | 구현 메모 |
|---|---|---|---|
| `rm` | 로만체 전환 | 뒤 항들에 상태 전이 | 화학식은 보통 `rm`으로 시작한다 |
| `it` | 로만체 입력 중 다시 이탤릭체로 복귀 | 뒤 항들에 상태 전이 | `rm` 이후 복귀 토큰으로 취급한다 |
| `bold` | 볼드체 | 뒤 항들에 상태 전이 | weight만 바꾸고 다른 스타일 상태는 유지한다 |
| `scale N` | 상대 크기 비율 변경 | 뒤 그룹 또는 뒤 항 | 첫 글자 크기를 100으로 본다 |
| `Color` / `COLOR {R,G,B} {expr}` | 지정 색상 적용 | 둘째 인자 그룹 | PDF 행 제목은 `Color`, 예제는 `COLOR`; lexeme 보존이 안전하다 |

영문/한글 글꼴 관련 사실:

| 규칙 | 의미 | 구현 메모 |
|---|---|---|
| 영문 기본 입력 | 기본적으로 이탤릭으로 표시 | plain alphabetic identifier는 italic default state에서 시작한다 |
| 첫 글자 글자 모양 상속 | 크기, 색, 글꼴이 수식의 기본값이 됨 | host text run의 char shape를 수식 object 기본 스타일로 연결한다 |
| 한글 글꼴 변경 | 일반 문서 편집 화면의 글자 모양 설정으로 제어 | 스크립트 내부에 별도 한글 글꼴 명령을 추가로 만들지 않는다 |

### 4.3 자동 로만체 함수 / 예약어

자동으로 로만체가 되는 기본 함수:

```text
sin cos coth log tan
cot ln lg sec cosec
max min csc arcsin limLim
arccos arctan exp Exp arc
sinh det gcd cosh tanh mod
asin acos atan lcm
```

항상 로만체가 되는 예약어:

```text
if for and hom
ker deg arg dim Pr
```

구현 규칙:

| 상황 | 처리 |
|---|---|
| 기본 함수/예약어를 평범하게 입력 | 자동 로만체 |
| 화학식처럼 전체를 로만체로 쓰고 싶음 | 맨 앞에 `rm` |
| 자동 로만체 단어를 이탤릭으로 쓰고 싶음 | 단어 사이에 빈칸을 넣어 자동 인식을 깨뜨림 |
| 저장 시 | 자동 로만체 여부만 보고 식별자를 다시 합치거나 띄어쓰기를 제거하면 안 된다 |

### 4.4 기본 명령어 표

아래 표는 PDF의 명령 테이블과 예제를 구현자 관점으로 다시 쪼갠 것이다.

| 명령 | 형태 | 의미 | 배치 / 구조 규칙 | 보존 포인트 |
|---|---|---|---|---|
| `TIMES` | 기호 명령 | 곱셈 기호 표시 | 일반 binary operator | symbol `times`와 command `TIMES`를 구분한다 |
| `OVER` | 이항 infix | 분수 표시 | 분자/분모 stack, 기본 가운데 맞춤 | 분수 양쪽 내부 공백을 임의 제거 금지 |
| `ATOP` | 이항 infix | 가로선 없는 위아래 쌓기 | bar 없는 stack | `OVER`로 치환 금지 |
| `SQRT` | 단항 prefix | 제곱근 표시 | 근호 + radicand box | `^n SQRT`와 결합 가능 |
| `^` / `SUP` | 첨자 | 위 첨자 | base의 오른쪽 위에 script box | 원문이 기호형인지 명령형인지 보존 |
| `_` / `SUB` | 첨자 | 아래 첨자 | base의 오른쪽 아래에 script box | 위와 동일 |
| `INT`, `OINT`, `DINT`, `TINT`, `ODINT`, `OTINT` | 대형 연산자 | 적분류 | 연산자 + limit/script + integrand | `from`/`to`, `_`/`^` 모두 허용되는지 파서에서 받아야 한다 |
| `SUM` | 대형 연산자 | 총합 기호 | 연산자 + limit/script | ordinary `Sigma` glyph와 다르다 |
| `PROD` | 대형 연산자/기호 | 곱셈 축약 기호 | `SUM` 계열과 같은 축 | 기호군에도 존재하므로 context 구분 필요 |
| `UNION`, `INTER` | 집합 연산자 | 합집합/교집합 | 큰 연산자 또는 `SMALL` 조합 | `SMALLUNION`, `SMALLINTER` 형태를 원문대로 보존 |
| `BIGG` | prefix modifier | 뒤 기호 크기 확대 | 바로 다음 기호만 크게 렌더 | 뒤 토큰과 결합 순서를 바꾸면 안 된다 |
| `lim`, `Lim` | 대형 연산자 | 극한 기호 | 대소문자 구별 | 두 lexeme를 별도 명령으로 보존 |
| `NOT` | prefix modifier | 뒤 글자/기호에 사선 | 다음 glyph에만 적용 | `neq`처럼 미리 합성된 기호로 바꿔 저장 금지 |
| `REL` | 관계 템플릿 | 화살표 위/아래에 주석 삽입 | `left operand + REL + arrow + upper + lower + right operand` | 위/아래 주석의 그룹 경계 보존 |
| `BUILDREL` | 관계 템플릿 | 화살표 위 주석만 삽입 | `left operand + BUILDREL + arrow + upper + right operand` | `REL`로 치환 금지 |
| `CASES` | block template | 경우 나누기 | 자동 확장되는 왼쪽 중괄호 + `#` row split | 줄 수와 row 문자열 보존 |
| `PILE`, `LPILE`, `RPILE` | block template | 세로 쌓기 | 중앙/왼쪽/오른쪽 정렬 선택 | 정렬 모드를 보존 |
| `EQALIGN` | aligned block | `&` 기준 세로 위치 조절 | 여러 줄/열 block에서 alignment column 사용 | `&` 개수와 위치 보존 |
| `CHOOSE` | 조합 템플릿 | 조합 기호 | PDF는 infix 예시를 보여준다 | `BINOM`과 동일시 저장 금지 |
| `BINOM` | 조합 템플릿 | 조합 기호 | PDF는 `BINOM [전체항] [선택항]` 형식도 보여준다 | `CHOOSE`와 원문 형식 분리 |
| `MATRIX` | grid template | 행렬 | row mode는 `#`/`&`, column mode는 `col/lcol/rcol` 사용 | row mode와 column mode를 구분 보존 |
| `PMATRIX` | grid template | 소괄호 행렬 | `MATRIX` + auto-sized `()` | wrapper 종류 보존 |
| `BMATRIX` | grid template | 대괄호 행렬 | `MATRIX` + auto-sized `[]` | wrapper 종류 보존 |
| `DMATRIX` | grid template | 세로줄 행렬 | `MATRIX` + auto-sized vertical bars | wrapper 종류 보존 |
| `LSUB` | left-script | 문자 왼쪽 아래첨자 | left attachment | ordinary `_`로 치환 금지 |
| `LSUP` | left-script | 문자 왼쪽 윗첨자 | left attachment | ordinary `^`로 치환 금지 |
| `LADDER` | algorithm block | 최소공배수/최대공약수 함수 | grid-like multi-row block | `&`, `#` 구조를 그대로 유지 |
| `SLADDER` | algorithm block | 진수 변환용 사다리꼴 | grid-like multi-row block | 위와 동일 |
| `LONGDIV` | algorithm block | 장제법 | 자동 배치 + 필요 시 `~`로 수동 spacing | `~` 개수를 건드리면 시각 배치가 깨진다 |
| `Color` / `COLOR` | style template | 색상 지정 | `{R,G,B}`와 내용 그룹 2인자 구조 | 표기와 대소문자 보존 |

### 4.5 보조 예약어 / 접두사 / 별칭

PDF의 본문 설명과 예제에는 메인 명령 테이블에 없지만 구현에 반드시 필요한 보조 토큰이 등장한다.

| 토큰 | 등장 위치 | 의미 | 구현 메모 |
|---|---|---|---|
| `from` | 예제 2.3 | 적분 시작점 | `_`와 별개 표현으로 원문 보존 |
| `to` | 예제 2.3 | 적분 끝점 | `^`와 별개 표현으로 원문 보존 |
| `LEFT` | 예제 2.5 | 자동 크기 왼쪽 delimiter | 바로 뒤의 delimiter 문자와 붙을 수 있다 |
| `RIGHT` / `right` | 예제 2.5 | 자동 크기 오른쪽 delimiter | 예제는 소문자 `right`를 보여 주므로 lexeme 보존 |
| `SMALL` | `UNION/INTER/PROD` 설명 | 작은 집합 기호 접두사 | `SMALLUNION`처럼 결합된 원문을 보존하는 편이 안전 |
| `col` | `MATRIX` 설명 | column mode, 가운데 맞춤 | cell 단위 정렬 모드 |
| `lcol` | `MATRIX` 설명 | column mode, 왼쪽 맞춤 | cell 단위 정렬 모드 |
| `rcol` | `MATRIX` 설명 | column mode, 오른쪽 맞춤 | cell 단위 정렬 모드 |
| `->` | 예제 2.5 설명 | 화살표 별칭 | `RARROW`와 뜻은 비슷해도 원문 치환 금지 |

### 4.6 글자 장식 명령

| 명령 | 장식 위치 | 예시 메모 |
|---|---|---|
| `acute` | 위 | `A` 위 acute |
| `grave` | 위 | `A` 위 grave |
| `dot` | 위 | 한 점 |
| `ddot` | 위 | 두 점 |
| `hat` | 위 | `A`, `AA`, `AAA` 예시 존재 |
| `check` | 위 | `A`, `AA`, `AAA` 예시 존재 |
| `bar` | 위 | 윗줄 |
| `vec` | 위 | 벡터 화살표 |
| `dyad` | 위 | dyad 표식 |
| `under` | 아래 | 밑줄 |
| `arch` | 위 | `A`, `AA`, `AAA` 예시 존재 |
| `tilde` | 위 | `A`, `AA`, `AAA` 예시 존재 |

구현 메모:

- 같은 장식이라도 base 폭이 `A`, `AA`, `AAA`로 달라질 때 장식 glyph stretch 규칙이 필요하다.
- 장식 명령은 단항으로 보되, 바로 뒤 그룹이나 항을 장식 대상으로 삼는 편이 안전하다.

### 4.7 기호군 요약 표

개수는 PDF 표의 glyph row 기준이다. 같은 행에 alias가 둘 이상 적힌 경우도 1개 row로 센다.

| 기호군 | 개수 | 이름 목록 | 구현 메모 |
|---|---:|---|---|
| 그리스 대문자 | 24 | `Alpha`, `Beta`, `Gamma`, `Delta`, `Epsilon`, `Zeta`, `Eta`, `Theta`, `Iota`, `Kappa`, `Lambda`, `Mu`, `Nu`, `Xi`, `Omicron`, `Pi`, `Rho`, `Sigma`, `Tau`, `Upsilon`, `Phi`, `Chi`, `Psi`, `Omega` | ordinary symbol lookup으로 취급한다 |
| 그리스 소문자 / 특수 | 15 | `ALEPH`, `HBAR`, `IMATH`, `JMATH`, `OHM`, `ELL`, `LITER`, `WP`, `IMAG`, `ANGSTROM`, `vartheta`, `varpi`, `varsigma`, `varupsilon`, `varphi`, `varepsilon` | `ELL`과 `LITER`는 같은 glyph row로 제시된다 |
| 합 / 집합 | 34 | `Sigma`, `PROD`, `COPROD`, `INTER`, `CAP`, `SQCAP`, `SQCUP`, `OPLUS`, `OMINUS`, `OTIMES`, `ODOT`, `OSLASH`, `VEE`, `WEDGE`, `SUBSET`, `SUPSET`, `SUBSETEQ`, `SUPSETEQ`, `IN`, `OWNS`, `notin`, `LEQ`, `GEQ`, `SQSUBSET`, `SQSUPSET`, `SQSUBSETEQ`, `SQSUPSETEQ`, `<<`, `>>`, `LLL`, `>>>`, `PREC`, `SUCC`, `UPLUS` | 일부는 대형 연산자 명령과 이름이 겹친다 |
| 연산 / 논리 | 38 | `PLUSMINUS`, `MINUSPLUS`, `times`, `DIV`, `DIVIDE`, `CIRC`, `BULLET`, `DEG`, `AST`, `STAR`, `BIGCIRC`, `EMPTYSET`, `THEREFORE`, `BECAUSE`, `IDENTICAL`, `EXIST`, `neq`, `!=`, `DOTEQ`, `image`, `REIMAGE`, `SIM`, `APPROX`, `SIMEQ`, `CONG`, `==`, `EQUIV`, `ASYMP`, `ISO`, `DIAMOND`, `DSUM`, `FORALL`, `prime`, `PARTIAL`, `inf`, `LNOT`, `PROPTO`, `XOR`, `TRIANGLED`, `DAGGER`, `DDAGGER` | alias pair가 많으므로 canonical glyph id와 원문 lexeme를 분리 저장한다 |
| 화살표 | 21 | `larrow`, `rarrow`, `uparrow`, `downarrow`, `LARROW`, `RARROW`, `UPARROW`, `DOWNARROW`, `udarrow`, `lrarrow`, `UDARROW`, `LRARROW`, `nwarrow`, `searrow`, `nearrow`, `swarrow`, `hookleft`, `hookright`, `mapsto`, `vert`, `VERT` | 소문자/대문자가 다른 크기 또는 double-stroke variant를 의미한다 |
| 기타 | 26 | `cdots`, `LDOTS`, `VDOTS`, `DDOTS`, `TRIANGLE`, `TRIANGLED`, `ANGLE`, `MSANGLE`, `SANGLE`, `RTANGLE`, `VDASH`, `HLEFT`, `BOT`, `TOP`, `MODELS`, `LAPLACE`, `CENTIGRADE`, `FAHRENHEIT`, `LSLANT`, `RSLANT`, `att`, `hund`, `thou`, `well`, `base`, `benzene` | 화학/단위/논리 기호가 섞여 있으므로 glyph set group 정보를 따로 들고 가는 편이 안전하다 |

### 4.8 이름 충돌 / 별칭 충돌 표

| 충돌 대상 | 주의점 |
|---|---|
| `TIMES` vs `times` | 전자는 명령어, 후자는 기호군 이름이다 |
| `SUM` vs `Sigma` | 전자는 대형 연산자, 후자는 ordinary glyph다 |
| `PROD`, `UNION`, `INTER` | 명령어이면서 기호군 이름이기도 하다 |
| `DIV` vs `DIVIDE` | 같은 glyph alias로 보되 원문 lexeme는 보존한다 |
| `neq` vs `!=` | alias pair다 |
| `==` vs `EQUIV` | alias pair다 |
| `ELL` vs `LITER` | PDF가 같은 glyph row에 두 이름을 제시한다 |
| `TRIANGLED` | 연산/논리와 기타 기호 양쪽에 등장하므로 lookup 충돌을 주의한다 |
| `lim` vs `Lim` | PDF가 대소문자를 명시적으로 구분하므로 별개 명령으로 본다 |
| `vert` vs `VERT` | single vs double vertical bar에 해당하는 다른 glyph다 |
| `Color` vs `COLOR` | PDF 표와 예제가 다르므로 원문 표기 보존이 안전하다 |

## 5. 레이아웃에 직접 영향을 주는 규칙

### 5.1 타이포그래피 / baseline 기본 규칙

| 규칙 | 원문 사실 | 구현 메모 |
|---|---|---|
| 영문 기본 상태 | 영문은 기본적으로 이탤릭체 | plain latin identifier는 italic default state에서 시작한다 |
| 첫 글자 상속 | 첫 글자의 글자 모양이 수식 전체의 기본값 | host text의 char shape를 equation root style로 연결한다 |
| `scale` | 첫 글자 크기 100 기준 비율 | local font-size multiplier로 처리한다 |
| 자동 로만체 | 기본 함수/예약어는 자동으로 로만체 | lexer 단계의 reserved word 인식이 필요하다 |
| object baseline | 저장 필드에 baseline이 따로 존재 | 내부 수식 axis와 외부 object baseline을 분리해서 계산한다 |

`구현 추론`: 내부 레이아웃 엔진은 템플릿별 수학 axis를 계산하고, 마지막에 object-level baseline offset을 적용하는 2단계 모델이 가장 안전하다. PDF는 baseline 숫자 계산식을 주지 않으므로, 저장된 baseline 값을 함부로 재작성하지 않는 것이 우선이다.

### 5.2 템플릿별 레이아웃 규칙

| 템플릿 / 명령 | 원문에서 확정되는 규칙 | 구현 추론 / 권장 규칙 | roman 예외 / 주의점 |
|---|---|---|---|
| 일반 항 나열 | 일반 `<Space>`, `<Enter>`, `<Tab>`은 항 구분자일 뿐 표시되지 않는다 | inline sequence는 구분자 제거 후 box를 이어 붙인다 | `~`와 backtick만 실제 간격 box를 만든다 |
| `OVER` | 기본적으로 가운데 맞춤 분수 | 전체 baseline은 분수 bar axis 또는 분자/분모 중간축에 둔다 | 왼쪽/오른쪽 맞춤을 위해 넣은 공백을 삭제하지 않는다 |
| `ATOP` | `OVER`와 같지만 가로선 없음 | numerator/denominator stack만 두고 bar box를 생략한다 | `OVER`와 시각/저장 의미가 다르다 |
| `SQRT` | 제곱근 표시 | radicand를 감싸는 stretch radical이 필요하다 | `^3SQRT` 류는 degree를 근호 왼쪽 위에 붙인다 |
| `^`, `_`, `SUP`, `SUB` | 오른쪽 위/아래 첨자 | base의 italic correction, ascent/descent를 고려한다 | base가 자동 로만체 단어여도 원문 분해 방식 유지 |
| `LSUP`, `LSUB` | 문자 왼쪽 윗/아래첨자 | base 앞쪽에 script box를 배치한다 | ordinary `SUP/SUB`와 다른 AST node로 두는 편이 안전 |
| 적분류 (`INT` 등) | 적분 기호 표시, 예제는 `from`/`to` 사용 | operator axis를 세우고 limit를 위/아래에 붙인다 | `from/to`와 `_ /^`는 보존용으로 구분 저장 |
| `SUM`, `PROD`, `UNION`, `INTER`, `lim`, `Lim` | 대형 연산자와 극한 | inline에서 small style, display-like 상황에서 stacked limit를 고려한다 | `SMALL` 접두사는 크기와 limit 배치를 바꿀 수 있다 |
| `BIGG` | 뒤 기호만 확대 | postfix처럼 보이지 않도록 다음 delimiter/symbol 하나에만 결합 | `BIGG`와 delimiter 사이 공백 여부 보존 |
| `REL` | 관계 화살표 위/아래에 주석 삽입 | relation axis를 중심으로 위/아래 annotation box를 둔다 | upper/lower 주석 그룹의 brace 유무 보존 |
| `BUILDREL` | 화살표 아래 내용 생략 | relation axis 위 annotation만 둔다 | `REL`과 node type 분리 |
| `CASES` | 자동 확장 중괄호와 여러 행 | left brace stretch, row split by `#` | row 내부 baseline은 각 행 독립, block baseline은 중앙축 권장 |
| `PILE`, `LPILE`, `RPILE` | 중앙/왼쪽/오른쪽 맞춤 선택 | row widths를 계산해 align mode에 맞춘다 | 정렬 모드가 내용과 독립된 의미이므로 보존 필수 |
| `EQALIGN` | `&` 기준으로 수식의 세로 위치 조절 | 각 row를 `&` 열 기준으로 정렬하는 multi-row block으로 처리 | `&` 개수가 다르면 비어 있는 alignment cell도 유지 |
| `CHOOSE`, `BINOM` | 조합 기호 입력 | 2행 stack + 괄호/조합 delimiter | `CHOOSE` infix vs `BINOM` 형식을 구분 보존 |
| `MATRIX` | row mode 또는 column mode가 있음 | grid node 필요, row mode는 `#`/`&`, column mode는 `col/lcol/rcol` | 각 column align mode를 별도 메타로 가진다 |
| `PMATRIX`, `BMATRIX`, `DMATRIX` | `MATRIX`에 괄호 종류만 다름 | wrapper delimiter를 auto-size한다 | 렌더 wrapper 종류를 canonicalize 금지 |
| `LADDER`, `SLADDER` | 사다리꼴 계산 구조 | multi-row, multi-column grid + vertical operator marks | 숫자/연산자와 `&` 위치를 그대로 보존 |
| `LONGDIV` | 숫자만으로 자동 레이아웃 가능, `~`로 미세 조정 가능 | divisor, quotient, dividend/remainder rows를 분리한 전용 node가 안전 | `~` 개수는 레이아웃 데이터이므로 절대 보존 |
| `Color/COLOR` | 두 번째 인자만 지정 색상으로 표시 | style span node로 처리 | object 기본색과 local 색 span을 혼동하지 않는다 |

### 5.3 roman 예외를 구현할 때의 우선순위

| 우선순위 | 규칙 |
|---:|---|
| 1 | 원문에 `rm`, `it`, `bold`, `scale`, `Color/COLOR`가 있으면 그것을 우선 적용 |
| 2 | 자동 로만체 함수/예약어는 plain identifier일 때만 적용 |
| 3 | 사용자가 `s in`, `si n`, `s i n`처럼 분해하면 자동 로만체 인식을 깨뜨린다 |
| 4 | serializer는 렌더 결과가 같더라도 분해된 원문을 다시 합치지 않는다 |

### 5.4 baseline 구현 시 특히 조심할 지점

| 지점 | 이유 |
|---|---|
| 분수 / atop | 템플릿 자체의 수학 axis와 object baseline이 다를 수 있다 |
| 대형 연산자 + 첨자 | limit가 위아래로 커지면 object bounding box는 커져도 baseline 값은 원문 저장값을 보존해야 한다 |
| matrix / cases / pile / eqalign | multi-row block의 내부 row baseline과 외부 object baseline을 분리해야 한다 |
| longdiv / ladder | 숫자 열이 바뀌어도 원문 `~`, `#`, `&` 구조를 유지해야 같은 모양이 난다 |
| roman 자동 인식 | layout 중간에 식별자를 재분석하면 원문과 다른 font run이 나올 수 있다 |

## 6. 편집 / 저장 시 보존해야 할 필드

### 6.1 반드시 round-trip 보존할 항목

| 범주 | 보존 대상 | 이유 |
|---|---|---|
| 원문 스크립트 | 전체 script string | 파서/렌더러가 이해하지 못한 토큰도 다시 저장해야 한다 |
| 스크립트 길이 | `len` | 저장 무결성 |
| object 스타일 | size, color, font name | 첫 글자 기본 스타일과 연결된다 |
| object 정렬 | baseline | 본문 줄 맞춤에 직접 영향 |
| version 정보 | equation version string | 호환성 판단에 필요 |
| 문서 속성 | `수식 시작 번호` | 문서 전체 수식 번호 정책 유지 |
| 구조 토큰 | `~`, backtick, `{}`, `"..."`, `#`, `&`, `^`, `_` | 같은 AST라도 시각 결과가 달라질 수 있다 |
| 표기 | `lim`/`Lim`, `Color`/`COLOR`, `DIV`/`DIVIDE`, `neq`/`!=`, `->`/`RARROW` | 의미가 같아 보여도 원문 보존이 우선 |

### 6.2 정규화 금지 목록

다음 변환은 금지하는 편이 안전하다.

1. `^`를 `SUP`로, `_`를 `SUB`로, 또는 그 반대로 바꾸기
2. `~`와 backtick을 일반 공백으로 바꾸기
3. 일반 공백/엔터/탭을 `~`, `#`, `&`로 바꾸기
4. `{...}`를 "의미상 불필요"하다고 제거하기
5. `"..."`의 따옴표를 제거하거나 내부 연속 공백을 축약하기
6. `SMALLUNION` 같은 결합 표기를 `SMALL UNION` 식으로 재작성하기
7. `from/to`를 `_ /^`로 재작성하기
8. `->`를 `RARROW`로 재작성하기
9. `neq`를 `!=`로, `DIV`를 `DIVIDE`로, `Color`를 `COLOR`로 통일하기
10. line wrap 때문에 PDF에 두 줄로 인쇄된 예제 문자열을 실제 newline 또는 `#`로 오해하기
11. 자동 로만체 예약어라고 해서 분해된 입력을 다시 합치기
12. `LONGDIV`의 `~` 개수를 줄이거나 matrix/ladder의 `&` 개수를 재배치하기

감히 아뢰옵건대, 저장 경로는 "AST에서 다시 생성"보다 "원문 script + 메타데이터 + 필요 시 AST 보조정보" 모델이 훨씬 안전하다.

### 6.3 편집기 내부 모델 권장안

| 필드 | 권장 |
|---|---|
| `rawScript` | 원문 전체 문자열 |
| `tokens[]` | 원문 slice offset을 가진 토큰 배열 |
| `ast` | 템플릿 구조 |
| `styleRuns[]` | `rm`, `it`, `bold`, `scale`, `Color/COLOR` 전이 기록 |
| `symbolRefs[]` | glyph group, symbol name, alias 원문 |
| `layoutDebug` | baseline, axis, row/column metrics 캐시 |
| `storageMeta` | `len`, size, color, baseline, version, font name, 문서 수준 연계 정보 |

## 7. 샘플 수식 기반 회귀 테스트 아이디어

### 7.1 원문 예제 2.1 ~ 2.5 최소 세트

| 예제 | 원문 스크립트 | 검증 포인트 | 실패 징후 |
|---|---|---|---|
| 2.1 분수식 | `10a^3 over b^2 times ~□ ~÷ b^3 over 2a =( 2a^2 over b )^3` | `OVER`, `TIMES`, `^`, `~`, 코드표 기호, 괄호와 지수 결합 | 분수 정렬이 깨지거나 `~`가 사라져 곱셈/나눗셈 기호 간격이 달라짐 |
| 2.2 De Morgan | <code>(A UNION B)^C&#96; =&#96; A^C INTER B^C</code> | `UNION`, `INTER`, quarter-space, 보조 괄호와 여집합 첨자 | backtick이 보통 공백으로 바뀌어 등호 주변 간격이 무너짐 |
| 2.3 거듭제곱근 적분 | <code>int from 0 to 3 &#96;^3sqrt{x^2 +1}dx</code> | `INT`, `from/to`, quarter-space, `^3SQRT`, 그룹 `{x^2 +1}` | 3제곱근의 degree 위치가 틀리거나 `from/to`가 `_ /^`로 저장됨 |
| 2.4 행렬 | `X = bmatrix { 42 & 52 & 48 & 58 # 4 & 5 & 4 & 3 }` | `BMATRIX`, `#`, `&`, row/column layout | 열 간격이 깨지거나 `#`를 실제 newline으로 저장 |
| 2.5 극한 + 총합 | `lim_N->inf 1 over N sum_n=1^N LEFT(SUM_k=1^n 1 over 2^k right)` | `lim`, `_`, `->`, `inf`, `SUM`, `LEFT/right`, nested large operator | `LEFT/right` 누락으로 괄호 크기가 작아지거나 `->`가 다른 기호로 바뀜 |

### 7.2 예제별 테스트 축

각 예제마다 네 종류 테스트를 붙이는 편이 좋다.

| 테스트 축 | 무엇을 검증하는가 |
|---|---|
| 토큰 스냅샷 | 토큰 종류, 원문 slice, style state, symbol alias |
| AST 스냅샷 | 템플릿 구조와 인자 수 |
| 레이아웃 스냅샷 | bounding box, baseline, delimiter 크기, row/column metrics |
| 저장 왕복 | parse -> serialize -> reopen 후 원문 script와 메타데이터 동일성 |

### 7.3 예제에서 바로 뽑을 수 있는 추가 파생 테스트

| 파생 테스트 | 입력 | 의도 |
|---|---|---|
| 9자 초과 literal | `"abcdefghij"` | quoted literal이 한 항으로 보존되는지 |
| 자동 로만체 깨기 | `si n`, `c os`, `a n d` | auto roman 인식이 분해 입력에서 꺼지는지 |
| 화학식 로만체 | `rm 2H_2 O = 2H_2 + O_2` | `rm`이 전체 스타일을 roman으로 바꾸는지 |
| `SMALL` 접두사 | `U=(A SMALLUNION B) SMALLINTER C` | inline small operator 크기와 원문 결합 표기 보존 |
| `LONGDIV` 정밀 간격 | `LONGDIV {6}{422}{2532#24#~13#~12#~~12#~~12#~~~0}` | `~` 개수에 따른 열 맞춤이 유지되는지 |
| `Color/COLOR` | `{COLOR {255,0,255} {3}} over {4}` | local color span만 색이 바뀌는지 |
| `REL` vs `BUILDREL` | `A REL <-> {+2} {-5} B`, `A BUILDREL <-> {+2} B` | 아래 annotation 유무가 정확히 구분되는지 |

### 7.4 저장 회귀의 핵심 assertion

| assertion | 이유 |
|---|---|
| `serialized.rawScript === original.rawScript` | 가장 중요한 lossless 조건 |
| `serialized.len === wcharLength(rawScript)` | 저장 무결성 |
| `baseline`, `size`, `color`, `version`, `font name` 동일 | object 메타 보존 |
| `수식 시작 번호` 불변 | 문서 속성 회귀 방지 |
| reopen 후 토큰 alias가 동일 | `neq/!=`, `->/RARROW`, `Color/COLOR` 등 표기 손실 방지 |

## 8. 구현 체크리스트

1. lexer에서 일반 공백/엔터/탭과 표시용 `~`/backtick을 분리한다.
2. quoted literal mode를 지원하고 내부 공백을 원문 그대로 보존한다.
3. bare identifier 9자 초과 분리 규칙을 구현한다.
4. 자동 로만체 함수/예약어 lookup을 만든다.
5. `rm`, `it`, `bold`, `scale`, `Color/COLOR` 상태 전이를 style run으로 기록한다.
6. `OVER`, `ATOP`, `SQRT`, `SUP/SUB`, `LSUP/LSUB`, `INT` 계열, `SUM`, `REL`, `CASES`, `PILE`, `EQALIGN`, `MATRIX`, `LONGDIV`를 전용 AST node로 분리한다.
7. `MATRIX`는 row mode와 column mode를 모두 처리한다.
8. `LEFT/RIGHT`, `SMALL`, `from/to`, `->` 같은 보조 lexeme를 파서에서 받아들인다.
9. glyph lookup은 group 정보와 alias 정보를 함께 저장한다.
10. serializer는 AST 기반 재생성보다 raw script 보존을 우선한다.
11. layout engine은 내부 math axis와 object baseline을 분리한다.
12. 예제 2.1~2.5와 파생 테스트를 golden regression으로 고정한다.

## 9. 즉시 우선순위

1. raw script 보존형 lexer/parser부터 고정한다.
2. `OVER`, `SUP/SUB`, `SQRT`, `SUM/lim`, `MATRIX`, `LONGDIV`의 전용 AST와 레이아웃 node를 만든다.
3. 자동 로만체와 `rm/it` 상태 전이를 붙인다.
4. `HWPTAG_EQEDIT` 메타데이터와 원문 script round-trip을 먼저 완성한다.
5. 예제 2.1~2.5를 screenshot-based regression과 text round-trip regression에 동시에 연결한다.

## 10. 장 / 절별 재참조 목록

### 10.1 파서 / 토큰화

| 절 | 다시 볼 이유 | 바로 확인할 것 |
|---|---|---|
| `1.1.1.1 영문 글꼴 명령` | italic/roman/bold 상태 모델 | `rm`, `it`, `bold` 전이 |
| `1.1.1.2 한글 글꼴 명령` | 스크립트 내부 명령이 아니라 host 글꼴 설정임 | 한글 글꼴 명령을 임의로 만들지 않기 |
| `1.1.2.1 항의 구분` | 일반 공백/탭/엔터의 의미 | 렌더 공백과 구분자 분리 |
| `1.1.2.2 여러 항의 묶음` | `{}` 그룹 의미 | grouped argument AST |
| `1.1.2.3 한 항이 9자를 넘을 때` | quoted literal 필요성 | 9자 초과 규칙 |
| `1.1.2.4 줄 바꾸기` | `#` 의미 | newline과 구조 토큰 구분 |
| `1.1.2.5 사이띄개, 엔터` | 일반 공백/엔터 무시 규칙 | 공백 정규화 금지 경계 |
| `1.1.2.6 세로 칸 맞춤` | `&` 의미 | alignment column token |
| `1.1.2.7 빈칸` | `~`, backtick 의미 | visible spacing token |
| `1.1.3 수식에 쓰이는 기본 함수` | auto roman reserved words | lexer reserved word table |
| `1.2.2 입력 기호 요약` | 제어 토큰 총정리 | token table 최종 점검 |

### 10.2 레이아웃 / 조판

| 절 | 다시 볼 이유 | 바로 확인할 것 |
|---|---|---|
| `1.1.1.1` | italic/roman이 실제 글자 box 폭에 영향 | font run split |
| `1.2 기본 명령어` | 템플릿별 렌더 예시 | AST node별 baseline 규칙 |
| `1.2.1 글자 장식 명령어` | stretch accent 필요성 | `A`, `AA`, `AAA` 폭 변화 |
| `1.2.3 스크립트 입력 창에서 입력` | 명령군 분류 | palette to AST mapping |
| `2.1` | 분수 + 지수 + 공백 + 코드표 기호 | operator spacing |
| `2.2` | quarter-space와 집합 연산 | inline spacing |
| `2.3` | `from/to`, `^3SQRT`, 적분 | radical degree와 operator limits |
| `2.4` | matrix row/column 배치 | grid metrics |
| `2.5` | `lim`, `SUM`, `LEFT/right` | 대형 연산자와 auto-sized delimiter |

### 10.3 기호 lookup / alias

| 절 | 다시 볼 이유 | 바로 확인할 것 |
|---|---|---|
| `1.2.4.1 그리스 대문자` | 24개 ordinary glyph | symbol table |
| `1.2.4.2 그리스 소문자` | 특수 이름/복수 이름 | `ELL/LITER` |
| `1.2.4.3 합/집합 기호` | command 이름과 ordinary glyph 충돌 | `PROD`, `INTER`, `UNION` |
| `1.2.4.4 연산/논리 기호` | alias pair가 많음 | `DIV/DIVIDE`, `neq/!=`, `==/EQUIV` |
| `1.2.4.5 화살표` | 대소문자 variant | `larrow` vs `LARROW` |
| `1.2.4.6 기타 기호` | 화학/단위/논리 기호 혼합 | group-aware glyph id |

### 10.4 저장 / 회귀

| 절 | 다시 볼 이유 | 바로 확인할 것 |
|---|---|---|
| `2.1 ~ 2.5` | golden regression 원본 | raw script, AST, layout snapshot |
| `3 변경 사항 이력` | revision 1.3 추가 범위 | 신규 기본 함수/명령어 여부 점검 |

## 11. 연결 확인 문서

- `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/README.md`
  - 분석 문서는 파서/레이아웃/보존 기준이 되어야 한다는 작성 규칙을 다시 확인할 것.
- `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/spec-crosswalk.md`
  - equation PDF는 파서, 템플릿 조판, 저장기의 직접 입력이며, 단순 치환기보다 구조 파서가 먼저여야 한다.
- `/Users/shinehandmac/Github/ChromeHWP/docs/hwp-spec-analysis/implementation-requirements.md`
  - 수식은 `HWPTAG_EQEDIT` 저장 구조, script string, `len`, size, color, baseline, version, font name, 문서 수준 `수식 시작 번호`를 함께 보존해야 한다.

실제 바이너리 필드 배치와 object 공통 속성은 현재 리포지터리의 HWP 5.0 분석 흐름과 맞물려 검토해야 하지만, 이 수식 문서만 놓고도 다음 원칙은 고정할 수 있다.

1. 스크립트는 원문 그대로 보존한다.
2. 템플릿은 전용 AST node로 표현한다.
3. baseline은 내부 수학 axis와 외부 object baseline으로 분리해 다룬다.
4. 자동 로만체와 명시적 스타일 전이는 서로 다른 계층으로 처리한다.
5. 예제 2.1~2.5를 회귀 테스트의 기준점으로 고정한다.
