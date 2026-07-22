# 배포 가이드 (Pick Me Up 백엔드)

EC2 + Caddy(자동 HTTPS/wss) + Docker Compose 로 배포한다. 프론트는 Vercel.

```
[사용자 브라우저]
   │  https / wss
   ▼
[EC2] Caddy(80/443, 인증서 자동)
        │  내부망 app:3000
        ▼
      NestJS(app) ── postgres ── redis
```

- **Caddy** 가 도메인으로 Let's Encrypt 인증서를 자동 발급/갱신하고, REST(https)·소켓(wss)을 모두 `app:3000` 으로 프록시한다.
- 앱은 외부로 직접 노출하지 않는다(compose `expose`). **공개 포트는 Caddy 의 80/443 뿐**.
- 배포 파이프라인: GitHub Actions `Deploy to EC2`(수동 트리거) → 이미지 빌드·Docker Hub 푸시 → `docker-compose.prod.yml`·`Caddyfile` 을 EC2 로 복사 → `docker compose up -d`.

---

## 사전 준비물

| 항목 | 설명 |
|---|---|
| 도메인 | 백엔드용 서브도메인(예: `api.example.com`) |
| EC2 | Docker + Docker Compose 설치, `~/app` 디렉터리 |
| Docker Hub | 이미지 push 용 계정 + 액세스 토큰 |
| GitHub Secrets | `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `EC2_HOST`, `EC2_USER`, `EC2_KEY` |

---

## 1. DNS
도메인 등록업체에서 A 레코드 추가:
- `api.<도메인>` → **EC2 퍼블릭 IP**

> 인증서 발급은 이 DNS 전파가 끝난 뒤에 이뤄진다. 배포 전에 먼저 등록해 둘 것.
> 프론트용(`<도메인>`/`www`)은 뒤 6단계 Vercel 안내대로 설정한다.

## 2. EC2 보안그룹 (인바운드)
- **80 (HTTP)** — 인증서 발급·HTTP→HTTPS 리다이렉트
- **443 (HTTPS/wss)**
- **22 (SSH)** — 배포용
- 3000 은 더 이상 공개하지 않는다(Caddy 가 내부에서만 접근).

## 3. EC2 준비 (최초 1회)
```bash
# docker / docker compose 설치 후
mkdir -p ~/app
# .env 를 채운다 (.env.prod.example 참고). 절대 커밋하지 않는다.
vi ~/app/.env
```
`~/app/.env` 필수 값:
```dotenv
DOCKER_IMAGE=<도커허브계정>/siheung-backend:latest   # 배포가 SHA 태그로 자동 갱신
DOMAIN=api.<도메인>
ACME_EMAIL=you@<도메인>                               # 선택(인증서 만료 알림)
CORS_ORIGIN=https://<프론트-Vercel-주소>
FRONTEND_BASE_URL=https://<프론트-Vercel-주소>        # 참가 링크(QR) 생성용
ROOM_TTL_SECONDS=259200
POSTGRES_USER=pickmeup
POSTGRES_PASSWORD=<강한-비밀번호>
POSTGRES_DB=pickmeup
DATABASE_URL=postgresql://pickmeup:<강한-비밀번호>@postgres:5432/pickmeup?schema=public
REDIS_HOST=redis
REDIS_PORT=6379
```
> `POSTGRES_PASSWORD` 와 `DATABASE_URL` 안의 비밀번호는 **반드시 동일**해야 한다.

## 4. GitHub Secrets
`Settings → Secrets and variables → Actions` 에 등록:
`DOCKER_USERNAME`, `DOCKER_PASSWORD`(토큰 권장), `EC2_HOST`, `EC2_USER`(Amazon Linux=`ec2-user`, Ubuntu=`ubuntu`), `EC2_KEY`(.pem 전체 내용).

## 5. 배포 실행
GitHub `Actions` 탭 → **Deploy to EC2** → `Run workflow`(수동). 또는:
```bash
gh workflow run "Deploy to EC2"
```
동작: 이미지 빌드 → Docker Hub push(`latest` + 커밋 SHA) → `docker-compose.prod.yml`·`Caddyfile` EC2 복사 → `.env` 의 `DOCKER_IMAGE` 를 이번 SHA 로 갱신 → `docker compose up -d`.
첫 기동 시 Caddy 가 인증서를 발급한다(DNS 전파 완료가 전제).

## 6. 프론트 (Vercel)
Vercel 프로젝트 환경변수:
```
VITE_WS_URL=https://api.<도메인>
VITE_API_BASE_URL=https://api.<도메인>/api
```
(socket.io 가 https→wss 자동 업그레이드) 배포 후, EC2 `.env` 의 `CORS_ORIGIN`/`FRONTEND_BASE_URL` 을 이 Vercel 주소로 맞추고 재배포(또는 `docker compose up -d`).

---

## 검증 체크리스트
- [ ] `https://api.<도메인>/api` 응답 정상 + 브라우저 자물쇠(TLS) 확인
- [ ] 방 생성 → 다른 기기에서 QR 참가 → 실시간 반영(wss 동작)
- [ ] 콘솔에 mixed-content(http 리소스) 경고 없음
- [ ] Zoom/크롬 임베드는 이 https 주소로 그대로 동작

## 재배포 · 롤백
- 재배포: main 최신으로 5단계 다시 실행.
- 롤백: 이미지가 커밋 SHA 태그로도 푸시되므로, EC2 `.env` 의 `DOCKER_IMAGE` 를 이전 SHA 태그로 바꾸고 `docker compose -f docker-compose.prod.yml up -d`.

## 트러블슈팅
| 증상 | 원인/해결 |
|---|---|
| 인증서 발급 실패 | DNS A 레코드가 EC2 IP 를 아직 안 가리킴 / 80·443 미개방. DNS 전파 후 `docker compose restart caddy` |
| 소켓(wss) 연결 안 됨 | 프론트 `VITE_WS_URL` 이 http 이거나 도메인 오타 / 백엔드 `CORS_ORIGIN` 불일치 |
| CORS 에러 | `.env` `CORS_ORIGIN` 을 실제 프론트 주소로 맞췄는지 |
| 방이 사라짐 | Redis 볼륨(`redis_data`) 유지 확인. 재시작해도 볼륨은 보존됨 |
| 로그 보기 | `docker compose -f docker-compose.prod.yml logs -f caddy app` |
