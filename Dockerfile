# syntax=docker/dockerfile:1
#
# Pick Me Up 백엔드 프로덕션 이미지 (멀티스테이지).
# Prisma 는 alpine(musl) 에서 엔진 호환 이슈가 잦아 Debian 기반 node:20-slim 을 쓴다.
# 시작 시 대기 중인 마이그레이션만 적용(migrate deploy) 후 앱을 실행한다.

# ---- builder: 의존성 설치 + prisma generate + nest build ----
FROM node:26-slim AS builder
WORKDIR /app

# Prisma 엔진이 요구하는 openssl
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# lock 파일 기준 재현 가능한 설치(소스보다 먼저 복사해 캐시를 살린다)
COPY package*.json ./
RUN npm ci

# 스키마 먼저 복사해 client 생성 — 소스 변경과 캐시를 분리한다
COPY prisma ./prisma
RUN npx prisma generate

# 나머지 소스 복사 후 빌드
COPY . .
RUN npm run build

# ---- runner: 실행에 필요한 것만 (devDeps 제외로 이미지 슬림) ----
FROM node:26-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# 런타임에도 Prisma 엔진용 openssl 필요
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# 프로덕션 의존성만 설치(prisma CLI·@prisma/client 는 dependencies 라 포함, jest/eslint 등은 제외)
COPY package*.json ./
RUN npm ci --omit=dev

# 스키마 복사 후 이 node_modules 에 맞는 client 를 생성
COPY prisma ./prisma
RUN npx prisma generate

# 빌드 산출물
COPY --from=builder /app/dist ./dist

# 컨테이너 내부 고정 포트(호스트 매핑과 일치시킨다). 앱은 PORT 환경변수를 읽는다.
ENV PORT=3000
EXPOSE 3000

# 헬스체크 — /api/health 응답으로 컨테이너 상태 판정(node 20 의 내장 fetch 사용, curl 불필요).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 로그 디렉터리를 미리 만들고 node 소유로 둔다 — 비-root(node)로 실행해도 파일 로깅
# (logs/app.log)이 되게 하고, 프로덕션에서 이 경로에 마운트되는 로그 볼륨(app_logs)이
# 빈 볼륨 초기화 시 node 소유권을 물려받게 한다(Promtail 이 읽는 로그의 출처).
RUN mkdir -p /app/logs && chown -R node:node /app/logs

# 루트로 실행하지 않는다(node:20-slim 이 제공하는 비-root 사용자). 파일은 world-readable 이라
# migrate deploy·앱 실행에 문제없다.
USER node

# 시작 시: 대기 중인 마이그레이션만 적용(migrate dev 와 달리 스키마를 새로 만들지 않는다) → 앱 실행
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
