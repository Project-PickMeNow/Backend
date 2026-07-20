---
name: ⚡ Performance
about: 성능 문제 / 최적화 / 부하 테스트 결과 기반 개선 이슈
title: "[PERF] "
labels: type/perf, area/service
assignees: ''
---

## ⚡ 성능 문제 개요
<!-- 어떤 동작이 느린지 1~2줄 요약. 예: 도서 검색 API가 50 VU에서 P95 30초 -->


## 📊 현재 측정 결과 (AS-IS)
| 지표 | 값 | 측정 조건 |
|------|----|---------|
| P50 |  |  |
| P95 |  |  |
| P99 |  |  |
| RPS |  |  |
| 에러율 |  |  |
| 측정 도구 | k6 / JMH / Grafana | |

<details>
<summary>측정 환경 / 명령어</summary>

```bash
# 예시
NODE_ENV=production npm run start:prod
k6 run k6/constant-test.js -e CONSTANT_VUS=50
```

</details>

## 🎯 목표 (TO-BE)
- P95 < 
- 에러율 < 
- RPS ≥ 

## 🔍 원인 가설
- [ ] DB 풀스캔 / 인덱스 미사용
- [ ] N+1 쿼리
- [ ] 외부 API 호출 직렬화
- [ ] DB 커넥션 풀 부족
- [ ] 이벤트 루프 블로킹
- [ ] 캐시 미스
- [ ] 기타:

## 🛠️ 개선 방안 후보
| 옵션 | 장점 | 단점 / 트레이드오프 |
|------|------|------|
| A.  |  |  |
| B.  |  |  |
| C.  |  |  |

## ✅ 수락 기준 (Acceptance Criteria)
- [ ] AS-IS 대비 P95 X% 이상 개선
- [ ] 부하 테스트 동일 시나리오 재실행 결과 첨부
- [ ] Tempo trace 로 개선 구간 검증
- [ ] 회귀 방지 부하 테스트 스크립트 추가/갱신

## 🔗 관련 자료
- Trace ID:
- Grafana 대시보드:
- 관련 이슈/PR:
