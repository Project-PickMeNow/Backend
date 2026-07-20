---
name: 🚀 Deploy
about: 배포 작업을 위한 이슈입니다.
title: "[DEPLOY] "
labels: type/ci
assignees: ''
---

## 🚀 배포 한 줄 요약
> 예) 룰렛 위젯 Socket.io 도입 릴리스 (v0.2.0) — EC2 prod 적용


---

## 🌡️ 배포 정보
| 항목 | 선택 |
|------|------|
| 🌍 배포 환경 | [ ] dev · [ ] staging · [ ] **production** |
| 🎯 배포 유형 | [ ] 정기 · [ ] 핫픽스 · [ ] 롤백 |
| 📅 예정 일시 | 2026-MM-DD HH:MM (KST) |
| 👤 배포 담당 |  |
| 👤 백업 담당 |  |

---

## 📋 배포 내용 / 릴리스 노트
- 
- 
- 

---

## ✅ 배포 전 체크리스트
- [ ] 모든 테스트 통과 (`npm test`)
- [ ] 빌드 성공 (`npm run build`)
- [ ] Docker 이미지 빌드/푸시 검증
- [ ] 환경 변수 / Secret 갱신 확인
- [ ] DB 마이그레이션 스크립트 검증
- [ ] Redis 데이터 호환성 확인
- [ ] 부하 테스트 결과 첨부 (검색·인증 변경 시)
- [ ] 운영팀 / 디자인팀 공유 완료
- [ ] **롤백 계획** 명시 (아래 ⏪ 섹션)

## 🚦 배포 후 검증
- [ ] `/actuator/health` 200 응답
- [ ] 핵심 API 스모크 테스트 (검색 / 로그인 / 리뷰 작성)
- [ ] Grafana 대시보드 정상 (에러율, P95, RPS)
- [ ] Tempo trace 정상 수집
- [ ] Slack #deploy 채널 결과 보고

## ⏪ 롤백 계획
<!-- 어떤 신호가 보이면 롤백? 어떤 절차로 롤백? -->
- **롤백 트리거**: 예) 5xx 에러율 5% 초과 5분 지속
- **롤백 명령**:
  ```bash
  # 이전 이미지 태그로 재기동
  docker-compose -f docker-compose.prod.yml pull
  docker-compose -f docker-compose.prod.yml up -d
  ```

---

## ⚠️ 주의 사항
<!-- 다운타임 예상, 다른 팀 의존성 등 -->


## 🔗 관련 자료
- 릴리스 PR: #
- 변경 이슈 목록: #, #
