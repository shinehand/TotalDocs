# ChromeHWP
HWP 를 크롬에서 열고 수정이 가능 하도록 만든 크롬 확장 프로그램

## 샘플 회귀검증
최소 smoke 검증은 아래 스크립트로 실행합니다.

```bash
node /Users/shinehandmac/Github/ChromeHWP/scripts/verify_samples.mjs
```

운영 규칙:
- 검증 시작 전에 Playwright `close-all` 실행
- 검증 세션명은 `verify-current` 고정

지원 상태/미지원 범위:
- [Rendering Status](/Users/shinehandmac/Github/ChromeHWP/docs/rendering-status.md)
