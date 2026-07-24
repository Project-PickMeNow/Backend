# 관측성(Observability) 스택 — Grafana + Prometheus + Loki

Pick Me Now 백엔드의 **지표(metrics)** 와 **로그(logs)** 를 수집·시각화하는 로컬 모니터링 스택입니다.

```
NestJS 앱 ──(/api/metrics)──▶ Prometheus ──┐
   │                                        ├──▶ Grafana (대시보드)
   └──(logs/app.log JSON)──▶ Promtail ─▶ Loki ┘
```

## 구성요소

| 서비스 | 역할 | 주소 |
| --- | --- | --- |
| **Prometheus** | 앱의 `/api/metrics` 를 15초마다 스크랩해 지표 저장 | http://localhost:9090 |
| **Loki** | 로그 저장소 | http://localhost:3100 |
| **Promtail** | `./logs/app.log`(JSON)를 tail → Loki 로 전송 | — |
| **Grafana** | Prometheus·Loki 를 묶어 대시보드로 시각화 | http://localhost:3002 (admin/admin) |

## 실행 방법

1. 앱을 먼저 띄웁니다(호스트에서 실행 — 지표·로그를 만들어야 하므로).
   ```bash
   npm run start:dev
   ```
   - 지표 확인: <http://localhost:3001/api/metrics>
   - 로그 파일: `logs/app.log` (JSON 한 줄씩)

2. 모니터링 스택을 올립니다.
   ```bash
   docker compose -f docker-compose.monitoring.yml up -d
   ```

3. Grafana 접속: <http://localhost:3002> (계정 `admin` / `admin`)
   - 좌측 **Dashboards → Pick Me Now → Backend Overview** 에 요청률·에러율·지연(p50/95/99)·메모리·이벤트루프·로그 패널이 자동 프로비저닝돼 있습니다.

4. 종료:
   ```bash
   docker compose -f docker-compose.monitoring.yml down          # 컨테이너만
   docker compose -f docker-compose.monitoring.yml down -v       # 저장 데이터까지 삭제
   ```

## 노출되는 지표

- **기본 프로세스 지표**(`prom-client`): `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_eventloop_lag_seconds`, CPU·GC·핸들 수 등
- `http_requests_total{method,route,status}` — 요청 수(Counter)
- `http_request_duration_seconds{method,route,status}` — 응답시간 히스토그램(latency·에러율 계산)

> `route` 라벨은 매칭된 라우트 패턴(`req.route.path`)만 사용해 카디널리티 폭증(경로의 id 등)을 방지합니다.

## 동작 원리 메모

- 앱이 **호스트**에서 돌기 때문에 Prometheus 는 컨테이너에서 `host.docker.internal:3000` 으로 접근합니다.
  Linux 는 compose 의 `extra_hosts: host.docker.internal:host-gateway` 로 매핑됩니다.
- 로그는 앱이 `logs/app.log` 에 JSON 으로 남기고, Promtail 이 `./logs` 를 마운트해 tail 합니다.
  앱을 컨테이너로 배포하는 환경이라면 Promtail 을 Docker 로그 스크랩으로 바꿔도 됩니다.
- 앱을 프로덕션(컨테이너)에서 돌린다면 `prometheus.yml` 의 target 을 컨테이너 서비스명(`app:3000`)으로,
  Promtail 은 도커 서비스 디스커버리로 바꾸면 됩니다.
