import { randomInt } from 'node:crypto';
import { LadderStructure } from '../game.types';

/**
 * 사다리타기 생성 (네이버 사다리 스타일).
 *
 * columns 칸의 세로줄을 세우고, 각 행(row)마다 인접한 두 세로줄 사이에 가로줄(rung)을
 * 무작위로 놓는다. 한 세로줄이 같은 행에서 좌·우 두 가로줄에 동시에 물리면 경로가 모호해지므로
 * 왼쪽에 이미 가로줄이 있으면 그 칸은 건너뛴다(인접 충돌 방지).
 *
 * 결과 mapping[i] = 시작칸 i 에서 내려가 도착하는 칸. 사다리 특성상 항상 순열(중복·누락 없음).
 * 무작위는 crypto.randomInt(균등·예측불가). 결과는 서버가 한 번 만들어 전원에게 broadcast 한다.
 */
export function generateLadder(columns: number): LadderStructure {
  if (columns < 2) {
    throw new Error('사다리는 칸이 최소 2개는 필요합니다.');
  }

  // 칸 수에 비례해 충분히 얽히도록 행 수를 잡는다(너무 적으면 그대로 내려가 재미없다).
  const rows = Math.max(columns * 2, 8);
  const rungs: { row: number; col: number }[] = [];

  for (let row = 0; row < rows; row++) {
    // col = 왼쪽 세로줄 인덱스. col 과 col+1 사이에 가로줄을 놓는다.
    for (let col = 0; col < columns - 1; col++) {
      // 바로 왼쪽(col-1↔col)에 이미 가로줄이 있으면 col 칸이 두 줄에 물리므로 건너뛴다.
      const leftBusy = rungs.some((r) => r.row === row && r.col === col - 1);
      if (leftBusy) continue;
      if (randomInt(2) === 0) rungs.push({ row, col }); // 50% 확률로 배치
    }
  }

  const mapping: number[] = [];
  for (let start = 0; start < columns; start++) {
    let pos = start;
    for (let row = 0; row < rows; row++) {
      // 한 행에서 pos 를 건드리는 가로줄은 최대 하나(인접 충돌 방지 덕분).
      if (rungs.some((r) => r.row === row && r.col === pos)) {
        pos += 1; // 오른쪽으로
      } else if (rungs.some((r) => r.row === row && r.col === pos - 1)) {
        pos -= 1; // 왼쪽으로
      }
    }
    mapping[start] = pos;
  }

  return { columns, rows, rungs, mapping };
}
