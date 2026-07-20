#!/usr/bin/env bash
# .github 워크플로/템플릿에서 사용하는 라벨을 GitHub 저장소에 일괄 생성
#
# 사전 조건:
#   - GitHub CLI 설치 (https://cli.github.com)
#   - gh auth login 완료
#   - 현재 디렉토리가 git repo 안 (또는 -R 옵션으로 repo 지정)
#
# 실행:
#   chmod +x .github/setup-labels.sh
#   ./.github/setup-labels.sh
#
# 라벨이 이미 있으면 색상/설명만 갱신.

set -euo pipefail

# label_name : color (hex without #) : description
LABELS=(
  # ── type/* (PR 타입) ────────────────────────────────────────────
  "type/feature:0E8A16:새 기능 추가"
  "type/bug:D73A4A:버그 / 오류"
  "type/refactor:FBCA04:리팩토링 (동작 변경 없음)"
  "type/docs:0075CA:문서"
  "type/test:BFD4F2:테스트"
  "type/chore:CFD3D7:빌드/설정/잡일"
  "type/ci:CFD3D7:CI / 배포"
  "type/style:E4E669:코드 스타일 (포맷)"
  "type/perf:5319E7:성능 개선"
  "type/security:B60205:보안"
  "type/question:D876E3:질문 / 토론"

  # ── area/* (영역) ─────────────────────────────────────────────
  "area/config:C5DEF5:설정 파일 (package.json, tsconfig 등)"
  "area/security:F9D0C4:보안 / 인증 (Guard, Strategy)"
  "area/api:1D76DB:Controller / Gateway / DTO"
  "area/domain:0E8A16:Entity / Repository"
  "area/service:5319E7:Service / Module"
  "area/infra:CFD3D7:인프라 / 배포 (Docker, CI)"
  "area/test:BFDADC:테스트 코드"

  # ── size/* (PR 크기) ─────────────────────────────────────────
  "size/XS:3CBF00:변경 <10줄"
  "size/S:5FE800:변경 <50줄"
  "size/M:FBCA04:변경 <200줄"
  "size/L:FF9F00:변경 <500줄"
  "size/XL:E11D21:변경 ≥500줄"

  # ── priority/* (우선순위) ─────────────────────────────────────
  "priority/critical:B60205:즉시 대응"
  "priority/high:D93F0B:이번 스프린트"
  "priority/medium:FBCA04:다음 스프린트"
  "priority/low:0E8A16:백로그"

  # ── status/* (상태) ──────────────────────────────────────────
  "status/stale:CFD3D7:장기 미활동"
  "status/blocked:E11D21:블로커 존재"
  "status/wip:FBCA04:작업 진행 중"

  # ── 기타 ────────────────────────────────────────────────────
  "breaking-change:B60205:호환성 깨짐 (semver major)"
  "dependencies:0366D6:Dependabot 의존성 업데이트"
  "skip-changelog:CFD3D7:Release Drafter 제외"
  "pinned:FBCA04:Stale 제외 - 고정"
  "help-wanted:008672:도움 요청"
  "good-first-issue:7057FF:첫 컨트리뷰터 추천"
)

echo "🏷  라벨 생성/갱신 시작..."
for entry in "${LABELS[@]}"; do
  IFS=":" read -r name color desc <<< "$entry"
  if gh label create "$name" --color "$color" --description "$desc" --force >/dev/null 2>&1; then
    echo "✓ $name"
  else
    echo "✗ $name (실패)"
  fi
done

echo "🎉 완료. 'gh label list' 로 결과 확인하세요."
