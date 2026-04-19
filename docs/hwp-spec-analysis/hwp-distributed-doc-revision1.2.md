# HWP 배포용 문서 분석 - revision 1.2

- 원문: `/Users/shinehandmac/Downloads/한글문서파일형식_배포용문서_revision1.2.pdf`
- 관련 분석:
  - `README.md`
  - `spec-crosswalk.md`
  - `implementation-requirements.md`
  - `hwp-5.0-revision1.3.md`
- 검토 메모:
  - PDF 11쪽 전체를 처음부터 끝까지 재검토했다.
  - 본문 핵심은 PDF 물리 페이지 6-9에 몰려 있으며, 표 1-4와 그림 4가 구현 기준점이다.
  - 텍스트 추출만으로 흐려질 수 있는 표/도식은 렌더링 이미지로 다시 확인했다.

이 문서는 `hwp-distributed-doc-revision1.2.pdf`를 구현 관점에서 다시 풀어쓴 분석서다. 원문 PDF는 설명량이 적고 용어가 압축되어 있으므로, 여기서는 파서, 복호화 루틴, 제한 UI, 저장 정책, 회귀검증으로 바로 연결되도록 절차를 명시적으로 적는다.

## 1. 문서 개요

- 대상은 한글 2002 이후 제품군에서 사용하는 "배포용 문서" 형식이다.
- 배포용 문서는 일반 문서의 임의 편집을 막는 것이 1차 목적이며, 추가로 복사와 인쇄 제한 플래그를 가진다.
- 일반 문서와의 가장 큰 차이는 본문 저장 경로가 `BodyText/Section*`이 아니라 `ViewText/Section*`라는 점, 그리고 일부 스트림이 암호화된다는 점이다.
- 암호화 해제에 필요한 재료는 각 암호화 대상 스트림 선두의 `HWPTAG_DISTRIBUTE_DOC_DATA` 레코드에서 얻는다.
- 이 PDF는 "배포용 문서 데이터"와 그 복호화 절차만 설명한다. 일반 HWP 5.0 레코드 구조, 수식, 차트, HWPML은 별도 문서를 참조해야 한다.

## 2. 형식 범위와 버전

- 문서 제목: `Hwp Document File Formats - Document for Distribution`
- revision: `1.2:20141009`
- 적용 범위:
  - 배포용 문서의 저장 구조 차이
  - `HWPTAG_DISTRIBUTE_DOC_DATA` 256-byte 레코드
  - seed 추출, 난수 배열 생성, XOR 병합, 해시/플래그 추출
  - AES-128 ECB 기반 레코드 복호화
- 비적용 범위:
  - 일반 HWP 5.0 레코드 정의
  - 압축 계층의 순서
  - 배포용 문서 재생성/재배포 저장 공식
  - 해제 후 일반 문서로 저장하는 제품 정책

구현자는 이 PDF만으로 "읽기와 복호화"는 시작할 수 있지만, "재저장 정책"은 상위 HWP 5.0 규칙과 제품 정책을 별도로 붙여야 한다.

## 3. 저장 구조와 암호화 범위

### 3.1 일반 문서와의 차이

| 항목 | 배포용 문서 | 일반 문서 | 구현상 의미 |
|---|---|---|---|
| 본문 스트림 | `ViewText/Section0 ... N` | `BodyText/Section0 ... N` | 본문 진입 경로 자체가 다르다. |
| 암호화 | 있음 | 없음 | 복호화 전에는 본문 레코드를 직접 읽을 수 없다. |
| 제한 플래그 | 있음 | 없음 | 복사/인쇄 제한을 UI와 출력 경로에 반영해야 한다. |

### 3.2 암호화 대상 스트림

원문 PDF가 명시한 암호화 대상은 아래 다섯 종류뿐이다.

- `ViewText/Section0 ... N`
- `Scripts/JScriptVersion`
- `Scripts/DefaultJScript`
- `DocHistory/HistoryLastDoc`
- `DocHistory/VersionLog0 ... N`

이 목록은 곧 "복호화 시도 대상 스트림 목록"이기도 하다. 반대로 말하면, 이 PDF 범위 안에서는 `BodyText/Section*`를 배포용 본문으로 취급하면 안 된다.

### 3.3 각 스트림의 저장 정책

| 스트림 | 역할 | 읽기 시 처리 | 저장 시 최소 원칙 |
|---|---|---|---|
| `ViewText/Section*` | 실제 표시용 본문 | 선두 `HWPTAG_DISTRIBUTE_DOC_DATA`를 읽고 payload를 복호화한 뒤 일반 HWP 레코드처럼 파싱 | 배포용 round-trip이면 원본 암호화 구조를 보존하거나 완전히 재생성해야 한다. |
| `Scripts/JScriptVersion` | 스크립트 버전 메타 | 복호화 후 문자열/메타 해석 | 기능을 쓰지 않더라도 버리지 말아야 한다. |
| `Scripts/DefaultJScript` | 기본 스크립트 본문 | 복호화 후 스크립트 텍스트 해석 | script storage를 무시하는 저장기는 배포용 호환을 깨뜨린다. |
| `DocHistory/HistoryLastDoc` | 최근 이력 스냅샷 | 필요 시 복호화 후 이력 파싱 | 편집기에서 안 보이더라도 opaque 보존 대상이다. |
| `DocHistory/VersionLog*` | 버전 로그들 | 복호화 후 이력 항목 해석 | round-trip이면 이름, 순서, 내용 모두 유지해야 한다. |

중요한 점은, 이 스트림들의 "선두 256-byte 배포용 문서 데이터 레코드" 자체는 키 재료이고, 그 뒤 payload가 AES-128 ECB로 암호화된 본문이라는 점이다. 즉, 레코드 전체를 통째로 AES 복호화하는 것이 아니다.

### 3.4 스트림 선두 레코드 위치

원문은 "해당 스트림들은 다음의 배포용 문서 데이터 레코드로 시작된다"고 적는다. 구현 관점에서 이 말은 다음과 같이 풀린다.

1. 스트림 맨 앞에서 먼저 일반 HWP 레코드 헤더를 읽는다.
2. 첫 레코드가 `HWPTAG_DISTRIBUTE_DOC_DATA`여야 한다.
3. 그 레코드 body 길이는 정확히 `256 bytes`여야 한다.
4. seed는 "스트림 첫 4 bytes"가 아니라 "그 256-byte body의 첫 4 bytes"이다.
5. AES 복호화 대상은 첫 레코드 다음 위치부터 시작하는 payload다.

## 4. 핵심 데이터 구조

### 4.1 `HWPTAG_DISTRIBUTE_DOC_DATA`

| 자료형 | 길이 | 설명 |
|---|---:|---|
| `BYTE array[256]` | 256 | 배포용 문서 데이터 body |
| 전체 길이 | 256 | 고정 길이 |

역할은 세 가지다.

1. seed 제공
2. 해시코드 80 bytes와 옵션 플래그 2 bytes 복원
3. AES-128 키 파생

이 256 bytes는 "해시코드가 바로 들어 있는 저장소"가 아니라, 난수 배열과 XOR한 뒤 의미 있는 82 bytes를 꺼내는 난독화 컨테이너다.

### 4.2 XOR 복원 후 얻는 의미 데이터

원문 표 3이 설명하는 값은 XOR 결과 버퍼의 `offset` 위치에서 읽는다.

| 자료형 | 길이 | 의미 | 구현 메모 |
|---|---:|---|---|
| `WCHAR array[40]` | 80 | 배포용 문서를 생성할 때 사용한 암호의 SHA1 해시코드 | wire format은 80-byte 원문 그대로 보존해야 한다. 20-byte digest로 단순 환원하지 말 것. |
| `WCHAR` | 2 | 옵션 플래그 | bitmask로 읽고, 정의되지 않은 비트는 reserved로 그대로 보존한다. |
| 전체 길이 | 82 | 해시코드 + 옵션 플래그 | `offset` 기준 연속 구간 |

중요한 함정은 `SHA1 해시코드`라는 설명 때문에 20-byte digest를 기대하기 쉽다는 점이다. 하지만 실제 저장 형식은 `WCHAR array[40]`, 즉 80-byte wide-char 영역이다. PDF는 "암복호화용 키(처음부터 16바이트까지)"라고 적고 있으므로, AES 키도 이 80-byte 저장값의 앞 16 bytes를 그대로 잘라 써야 한다. 해시 문자열을 20-byte digest로 다시 디코드한 뒤 16 bytes를 취하는 방식으로 바꾸면 안 된다.

### 4.3 옵션 플래그 비트

원문이 정의한 비트는 둘뿐이다.

| 비트 | 의미 | 최소 동작 |
|---|---|---|
| `0x0001` | 복사 방지 | 선택 텍스트/개체 복사, 클립보드 복제, 복사에 준하는 export 경로를 막는다. |
| `0x0002` | 인쇄 방지 | 인쇄, 인쇄 미리보기, PDF로 내보내기처럼 인쇄와 동등한 출력 경로를 막는다. |

추가 메모:

- 원문 서론은 "복사/붙이기, 인쇄 제한"을 언급하지만 표 정의는 `복사방지`, `인쇄방지`만 명시한다.
- 따라서 구현에서는 `0x0001`을 최소한 copy/clipboard 제한으로 연결하고, paste까지 같은 비트로 묶는지는 실문서/제품 동작으로 검증하는 편이 안전하다.
- 정의되지 않은 상위 비트는 0으로 초기화하지 말고 그대로 round-trip 해야 한다.

## 5. seed/XOR/AES 복호화 절차

이 절은 원문 2.1-2.4를 구현 순서로 다시 적은 것이다. 아래 순서를 그대로 함수 경계로 옮기면 된다.

### 5.1 전체 흐름

1. 스트림 첫 레코드에서 `HWPTAG_DISTRIBUTE_DOC_DATA` body 256 bytes를 확보한다.
2. body 첫 4 bytes에서 seed를 읽는다.
3. seed로 MS Visual C `srand()/rand()` 호환 난수열을 만든다.
4. 난수열을 이용해 길이 256의 패턴 배열을 채운다.
5. 패턴 배열과 256-byte distribute body를 bytewise XOR한다.
6. `offset = (seed & 0x0f) + 4`를 계산한다.
7. XOR 결과의 `offset .. offset+79`를 hashcode 80 bytes로 읽는다.
8. 바로 뒤 `offset+80 .. offset+81`를 옵션 플래그 2 bytes로 읽는다.
9. hashcode 앞 16 bytes를 AES-128 키로 사용한다.
10. 선두 레코드 뒤 payload 전체를 AES-128 ECB로 복호화한다.
11. 복호화된 payload를 일반 HWP 레코드 스트림으로 해석한다.

### 5.2 seed 읽기

- seed 자료형은 `UINT`, 길이는 4 bytes다.
- 원문 표현은 `sizeof(UINT)`를 쓰지만, 이 문맥의 의미는 "항상 4 bytes"다.
- 자바스크립트, WASM, Rust, C++ 어디서 구현하든 host 언어의 `sizeof(unsigned int)`에 의존하지 말고 상수 `4`로 취급하는 편이 안전하다.
- 상위 HWP 5.0 바이너리 규칙을 따르면 `UINT`, `WCHAR`는 little-endian으로 읽는 전제가 자연스럽다.

### 5.3 MSVC `srand()/rand()` 재현

원문은 "MS Visual C의 랜덤함수(srand(), rand())"를 사용한다고만 적는다. 구현에서는 정확히 MSVC 계열 LCG를 재현해야 한다.

```c
uint32_t state = seed;

int msvc_rand(void) {
  state = state * 214013u + 2531011u;
  return (state >> 16) & 0x7fffu;
}
```

구현 메모:

- `srand(seed)` 이후 첫 `rand()` 호출이 "홀수번째 호출"이다.
- 상태값은 32-bit unsigned overflow를 허용해야 한다.
- 결과값은 `(state >> 16) & 0x7fff`다.
- 다른 CRT 구현이나 플랫폼 기본 `rand()`를 그대로 호출하면 값이 달라질 수 있으므로 금지하는 편이 낫다.

### 5.4 256-byte 난수 패턴 배열 만들기

원문 그림 4를 코드로 풀면 아래와 같다.

```text
written = 0
while written < 256:
  A = msvc_rand() & 0xFF
  B = (msvc_rand() & 0x0F) + 1
  repeat A exactly B times
  if the final run crosses 256, truncate at 256
```

세부 규칙:

- 홀수번째 `rand()` 결과는 "배열에 채워 넣을 값"이다.
- 짝수번째 `rand()` 결과는 "그 값을 몇 번 반복할지"를 나타낸다.
- `B`의 범위는 항상 `1..16`이다.
- 마지막 반복 구간이 256을 넘으면 넘친 부분은 버리고 정확히 256 bytes에서 멈춘다.
- 이 배열은 해시를 직접 담지 않으며, distribute body를 XOR 복원하기 위한 마스크 역할만 한다.

### 5.5 XOR 병합과 offset 계산

원문 2.3을 구현식으로 쓰면 다음과 같다.

```text
offset = (seed & 0x0F) + 4
merged[i] = randomBytes[i] ^ distributeBody[i]    for i in 0..255
hashBytes = merged[offset .. offset+79]
optionFlags = merged[offset+80 .. offset+81]
```

중요 포인트:

- `offset`은 seed에서 직접 계산한다. XOR 결과의 첫 4 bytes를 다시 읽는 방식이 아니다.
- `offset` 범위는 `4..19`다.
- 해시/플래그를 읽는 기준 버퍼는 원본 body가 아니라 `merged`다.
- 80-byte hash와 2-byte flag 외의 나머지 XOR 결과 영역은 PDF에서 의미를 정의하지 않는다. 따라서 구현상 불필요한 해석을 붙이지 않는 편이 안전하다.

### 5.6 AES-128 ECB 복호화

원문 2.4의 뜻은 아래와 같다.

- AES 키: `hashBytes[0..15]`
- 알고리즘: `AES-128 ECB`
- IV: 없음
- 입력: 첫 `HWPTAG_DISTRIBUTE_DOC_DATA` 레코드 뒤의 payload 전체
- 출력: 일반 HWP 레코드 스트림

구현 메모:

- AES 키는 "hashBytes의 앞 16 bytes"다. SHA1 digest 재계산 결과를 쓰는 것이 아니다.
- ECB는 블록 독립형이므로 16-byte 블록 단위로 처리한다.
- PDF는 padding 규칙을 설명하지 않는다. 따라서 payload 길이가 16의 배수가 아니면, 임의 padding을 가정하기 전에 스트림 절단/압축 순서/입력 범위를 먼저 의심해야 한다.
- 복호화 후에는 곧바로 일반 HWP 레코드 파서를 태워 record header가 정상적으로 이어지는지 검증하는 것이 가장 빠른 sanity check다.

### 5.7 구현용 의사코드

```text
read first record from encrypted stream
assert tag == HWPTAG_DISTRIBUTE_DOC_DATA
assert body_len == 256

seed = le_u32(body[0:4])
random = build_msvc_pattern(seed)          # exactly 256 bytes
merged = xor_bytes(body, random)

offset = (seed & 0x0F) + 4
hash_bytes = merged[offset : offset + 80]
flags = le_u16(merged[offset + 80 : offset + 82])
aes_key = hash_bytes[0:16]

payload = stream_bytes_after_first_record
plain = aes_128_ecb_decrypt(payload, aes_key)

parse plain as ordinary HWP record stream
```

## 6. 옵션 플래그와 제한 동작

### 6.1 최소 제품 동작

| 플래그 | 반드시 막아야 할 경로 | 추가 권고 |
|---|---|---|
| `0x0001` 복사 방지 | 선택 후 복사, 우클릭 복사, 단축키 복사, 클립보드 export | 텍스트 추출 API, 드래그-앤드-드롭 복제, "선택 영역 저장"도 복사에 준해 묶는 편이 안전하다. |
| `0x0002` 인쇄 방지 | 실제 프린터 출력, 인쇄 미리보기, PDF 프린트 | canvas/screenshot export를 인쇄와 등가로 볼지는 제품 정책이 필요하다. |

### 6.2 보존 원칙

- 플래그는 16-bit bitmask로 보존한다.
- 알려진 비트 두 개만 해석하고 나머지는 `reserved`로 간주한다.
- `unlock -> 일반 문서 저장` 경로를 지원한다면, 해제 이후 플래그를 유지할지 제거할지 정책을 분리해서 기록해야 한다.
- `round-trip 배포용 저장`에서는 원래 플래그 원값을 그대로 유지해야 한다.

### 6.3 UI와 저장기의 책임 분리

- UI는 제한을 사용자 동작에 반영한다.
- 저장기는 플래그 원값과 암호화 구조를 보존한다.
- 즉, UI가 복사/인쇄를 막더라도 저장기가 플래그 비트를 0으로 덮어쓰면 round-trip이 깨진다.

## 7. 파서가 반드시 뽑아야 할 필드

### 7.1 스트림 레벨

- 스트림 이름
- 첫 레코드가 `HWPTAG_DISTRIBUTE_DOC_DATA`인지 여부
- 첫 레코드 원본 header + body
- payload 시작 위치
- payload 원본 길이

### 7.2 복호화 메타

- `seed` 4 bytes
- `randomBytes[256]`
- `merged[256]`
- `offset = (seed & 0x0f) + 4`
- `hashBytes[80]`
- `aesKey[16]`
- `optionFlags`

### 7.3 후속 파싱 결과

- 복호화 성공 여부
- 복호화 후 record header 연속성
- `ViewText/Section*` 파싱 결과
- `Scripts/*` 문자열/버전 메타
- `DocHistory/*` 존재 여부와 순서

## 8. 레이아웃과 기능 동작에 직접 영향을 주는 필드

- `ViewText/Section*`
  - 실제 렌더링 본문 경로다.
  - 일반 문서처럼 `BodyText/Section*`만 찾으면 빈 문서처럼 보일 수 있다.
- `optionFlags`
  - 조판 수치에는 직접 개입하지 않지만, 복사/인쇄 가능 여부를 바꾼다.
  - 따라서 "화면은 보이는데 복사/출력은 막힘" 같은 상태를 만드는 핵심 메타다.
- `Scripts/*`, `DocHistory/*`
  - 직접적인 레이아웃 필드는 아니지만, 문서 기능과 round-trip 보존성에 영향을 준다.

배포용 문서에서 레이아웃 충실도 문제는 좌표/서식보다 "어느 스트림을 본문으로 삼는가"에서 먼저 터진다.

## 9. 편집/저장 시 보존해야 할 필드와 정책

### 9.1 무조건 보존해야 할 것

- 각 대상 스트림의 첫 `HWPTAG_DISTRIBUTE_DOC_DATA` 원본 bytes
- `hashBytes` 80-byte 원문
- `optionFlags` 원값
- 암호화 대상 스트림 이름과 순서
- `Scripts/*`, `DocHistory/*` 존재 여부

### 9.2 저장 정책을 세 가지로 분리할 것

| 모드 | 권장 처리 | 금지 사항 |
|---|---|---|
| 읽기 전용 열기 | 원본 OLE/CFB 바이트는 보존하고, 메모리에서만 복호화하여 렌더/검사 | 복호화 결과로 원본 스트림을 즉시 덮어쓰기 |
| 해제 후 일반 문서 저장 | 배포용 제한을 풀고 일반 저장 구조(`BodyText/Section*` 등)로 재직렬화하는 별도 경로로 분리 | 배포용 스트림과 일반 스트림을 섞어 쓰기 |
| 배포용 round-trip 저장 | 원본 암호화 스트림을 그대로 유지하거나, seed/XOR/AES 규칙을 정확히 재현하여 전 스트림을 다시 암호화 | 일부 스트림만 평문으로 저장하거나 플래그/해시만 갱신하기 |

### 9.3 현 시점 구현 우선순위

상위 문서(`implementation-requirements.md`) 기준으로는 다음 순서가 안전하다.

1. 읽기 전용 복호화 경로 완성
2. 제한 플래그 UI 반영
3. 원본 배포용 구조 손실 없는 보존
4. 해제 후 일반 저장 경로
5. 재배포 저장 경로

원문 PDF는 4, 5번을 명시적으로 정의하지 않으므로, 현재 구현 단계에서는 "재배포 저장"보다 "손실 없는 읽기 + 일반 저장 분리"가 우선이다.

## 10. 구현 함정

### 10.1 알고리즘 함정

- `rand()` 구현이 다르면 모든 결과가 무너진다.
  - 플랫폼 기본 `rand()` 호출 금지
  - MSVC 수식을 직접 박아 넣는 편이 안전하다
- 홀수/짝수 호출 의미를 뒤집으면 안 된다.
  - 홀수 호출 = 값
  - 짝수 호출 = 반복 횟수
- 마지막 반복 구간을 256에서 잘라야 한다.
  - 256을 초과해 배열을 채우면 이후 XOR가 틀어진다
- `sizeof(UINT)`를 host 언어 크기로 해석하면 안 된다.
  - 이 문맥에서는 항상 `4`

### 10.2 바이트 해석 함정

- seed는 distribute body의 첫 4 bytes다.
  - record header 첫 4 bytes와 혼동하지 말 것
- hash는 80-byte `WCHAR[40]` 저장값이다.
  - 20-byte SHA1 digest로 다시 해석하지 말 것
- AES 키는 저장된 hash 80 bytes의 앞 16 bytes다.
  - "SHA1을 재계산해서 앞 16 bytes"가 아니다
- option flags는 XOR 결과 버퍼에서 읽는다.
  - 원본 body에서 직접 읽는 것이 아니다

### 10.3 스트림/파이프라인 함정

- `ViewText/Section*`를 안 열고 `BodyText/Section*`만 보면 본문을 놓친다.
- `Scripts/*`, `DocHistory/*`를 "안 써도 되는 부가 데이터"로 보고 버리면 round-trip이 깨진다.
- 각 암호화 대상 스트림의 선두 256-byte record가 항상 동일하다고 가정하지 않는 편이 안전하다.
  - 실문서에서는 동일할 가능성이 크지만, 저장기는 per-stream 원본을 그대로 유지해야 한다
- 압축과 배포용 암호화의 적용 순서는 이 PDF가 설명하지 않는다.
  - 상위 HWP 파이프라인에서는 `raw`, `deflated`, `distributed`, `distributed+deflated`, `deflated+distributed` 같은 조합을 분리 검증하는 편이 안전하다
- AES payload 길이가 16의 배수가 아니면 padding을 임의로 넣기 전에 입력 범위와 압축 순서를 재검토해야 한다.

## 11. 회귀 테스트 포인트

### 11.1 순수 알고리즘 테스트

1. seed 고정값으로 256-byte 난수 배열이 결정론적으로 재생성되는지 확인
2. 같은 seed/body에서 `merged`, `hashBytes`, `optionFlags`가 항상 동일한지 확인
3. `offset`이 `4..19` 범위를 벗어나지 않는지 확인
4. 마지막 반복 구간이 256을 넘을 때 정확히 잘리는지 확인

### 11.2 암복호화 테스트

1. synthetic `hashBytes[0..15]`를 키로 만든 AES-128 ECB ciphertext를 복호화해 원문과 일치하는지 확인
2. 첫 레코드 뒤 payload만 복호화할 때만 정상이 되는지 확인
3. payload가 16-byte 정렬일 때와 아닐 때의 오류 처리를 분리 확인

### 11.3 스트림 커버리지 테스트

1. `ViewText/Section0 ... N` 전부에 복호화가 적용되는지 확인
2. `Scripts/JScriptVersion`, `Scripts/DefaultJScript`를 누락 없이 탐지하는지 확인
3. `DocHistory/HistoryLastDoc`, `DocHistory/VersionLog0 ... N`를 보존하는지 확인
4. 일반 문서는 `BodyText/Section*` 경로로 그대로 열리고, 배포용 문서만 `ViewText/Section*`로 분기되는지 확인

### 11.4 옵션 플래그 테스트

1. `0x0001` 설정 시 복사 경로가 실제로 차단되는지 확인
2. `0x0002` 설정 시 인쇄/print-to-PDF가 차단되는지 확인
3. 두 비트를 동시에 켠 문서에서 두 제한이 모두 유지되는지 확인
4. 미정의 비트가 있는 synthetic 플래그를 round-trip 했을 때 원값이 유지되는지 확인

### 11.5 저장/round-trip 테스트

1. 읽기 전용 열기 후 저장하지 않고 다시 닫아도 원본 바이트가 변하지 않는지 확인
2. 배포용 문서를 일반 문서로 해제 저장한 뒤 `BodyText/Section*` 경로가 유효한지 확인
3. 배포용 round-trip 저장을 지원한다면, 모든 암호화 대상 스트림의 선두 record와 flag가 유지되는지 확인
4. `Scripts/*`, `DocHistory/*`를 사용하지 않는 UI에서도 저장 후 유실되지 않는지 확인

## 12. 즉시 우선순위

1. MSVC `rand()` 재현 로직을 golden test와 함께 고정한다.
2. `HWPTAG_DISTRIBUTE_DOC_DATA` 선두 record 분리를 파서 공통 유틸로 만든다.
3. `seed -> random[256] -> merged -> hash[80] -> flags -> aesKey[16]` 파이프라인을 순수 함수로 고정한다.
4. `ViewText/Section*`와 `Scripts/*`, `DocHistory/*`를 한 묶음의 배포용 대상 스트림으로 관리한다.
5. 제한 플래그를 UI와 저장기 양쪽에 연결한다.
6. 재배포 저장은 별도 모드로 미루고, 우선은 lossless 읽기/보존을 확실히 한다.

## 13. 원문에서 다시 봐야 할 장/절

### 13.1 PDF 장/절 재참조

| 위치 | 확인할 것 | 구현으로 연결되는 모듈 |
|---|---|---|
| PDF p.5 `본 문서에 대하여...` | 문서 범위가 배포용 자료 구조에만 한정된다는 점 | 요구사항 경계 정의 |
| PDF p.6 `1. 배포용 문서 데이터` 본문 | 배포용 문서와 일반 문서의 차이, 암호화 대상 스트림 목록 | 스트림 라우팅, storage 탐색 |
| PDF p.6 표 1 | `ViewText/Section` vs `BodyText/Section` 차이 | 본문 진입 경로 분기 |
| PDF p.6 표 2 | `HWPTAG_DISTRIBUTE_DOC_DATA` body 길이 256 | 첫 record 검증 |
| PDF p.6 표 3 | `WCHAR[40]` 80 bytes + `WCHAR` 2 bytes | hash/flag 추출, key derivation |
| PDF p.7 `2.1. Seed 찾기` + 표 4 | seed가 body 첫 4 bytes라는 점 | seed 추출 함수 |
| PDF p.7 `2.2. 난수 배열 만들기` | MSVC `srand/rand`, 홀수/짝수 호출 의미 | random mask generator |
| PDF p.8 그림 4 | 값/반복 횟수 패턴 도식 | run-length 채움 로직 검증 |
| PDF p.8 `2.3. 해시코드 추출하기` | `offset`, XOR merge, 80+2 byte 읽기 | hash/flag extractor |
| PDF p.8-9 `2.4. ... AES-128 ...` | AES 키는 hash 첫 16 bytes, 알고리즘은 AES-128 ECB | decryptor |
| PDF p.10 `변경 사항 이력` | revision 1.2가 문서 공개본이라는 점 | 문서 버전 추적 |

### 13.2 함께 봐야 할 내부 분석 문서

| 문서 | 다시 볼 지점 | 이유 |
|---|---|---|
| `README.md` | 공통 섹션 구성 규칙 | 분석서 형식 일관성 유지 |
| `spec-crosswalk.md` | `distributed-doc`가 담당하는 구현 모듈 | 복호화/해제/AES 경계 확인 |
| `implementation-requirements.md` | 배포용 문서 파서/저장/회귀 요구 | 실구현 우선순위 연결 |
| `hwp-5.0-revision1.3.md` | 일반 HWP record header, stream 구조, `HWPTAG_*` 체계 | 선두 record 분리 후 후속 레코드 파싱 연결 |

## 14. 구현 메모

- 이 PDF가 직접 확정하는 것은 "배포용 문서 데이터로부터 키와 플래그를 뽑아 AES-128 ECB로 payload를 복호화하는 절차"까지다.
- 아래 항목은 PDF 밖의 정책 혹은 상위 스펙 확인이 더 필요하다.
  - 압축과 배포용 암호화의 적용 순서
  - 해제 후 일반 문서로 저장할 때 어떤 스트림/플래그를 남길지
  - 배포용 문서를 다시 생성할 때 seed/hash/flags를 어떻게 새로 만들지
  - `0x0001`이 paste까지 동일하게 막는지 여부
- 따라서 현 단계에서 가장 안전한 구현 원칙은 다음 두 가지다.
  - 읽기 경로에서는 원본 256-byte record와 암호화 payload를 손대지 않는다.
  - 저장 경로에서는 "일반 저장"과 "배포용 round-trip"을 절대로 같은 코드 경로로 섞지 않는다.
