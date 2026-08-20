import { rawSqlite } from '../db.js';

export type P2PTaskRecord = {
  id: string;
  type: string;
  payload: string;
  status: string;
  assigned_node: string | null;
  assigned_user_id: string | null;
  claimed_by: string | null;
  created_at: number;
};

const selectExistingTaskStmt = rawSqlite.prepare(`
  SELECT id, type, payload, status, assigned_node, assigned_user_id, claimed_by, created_at
  FROM p2p_tasks
  WHERE assigned_node = ?
    AND COALESCE(claimed_by, assigned_user_id) = ?
    AND status IN ('running', 'assigned')
  ORDER BY assigned_at DESC
  LIMIT 1
`);

const selectNextPendingTaskStmt = rawSqlite.prepare(`
  SELECT id, type, payload, status, assigned_node, assigned_user_id, claimed_by, created_at
  FROM p2p_tasks
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
`);

const recycleTimedOutTasksStmt = rawSqlite.prepare(`
  UPDATE p2p_tasks
  SET status = 'pending',
      assigned_node = NULL,
      assigned_user_id = NULL,
      claimed_by = NULL,
      assigned_at = NULL
  WHERE status IN ('running', 'assigned')
    AND assigned_at IS NOT NULL
    AND assigned_at < ?
`);

const claimTaskStmt = rawSqlite.prepare(`
  UPDATE p2p_tasks
  SET status = 'running',
      assigned_node = ?,
      assigned_user_id = ?,
      claimed_by = ?,
      assigned_at = ?
  WHERE id = ?
    AND status = 'pending'
    AND claimed_by IS NULL
    AND assigned_user_id IS NULL
`);

const completeTaskStmt = rawSqlite.prepare(`
  UPDATE p2p_tasks
  SET status = 'completed',
      result = ?,
      completed_at = ?
  WHERE id = ?
    AND assigned_node = ?
    AND COALESCE(claimed_by, assigned_user_id) = ?
    AND status IN ('running', 'assigned')
`);

const claimTaskTxn = rawSqlite.transaction((nodeId: string, userId: string, assignedAt: number, cutoff: number) => {
  recycleTimedOutTasksStmt.run(cutoff);

  const existing = selectExistingTaskStmt.get(nodeId, userId) as P2PTaskRecord | undefined;
  if (existing) return existing;

  const next = selectNextPendingTaskStmt.get() as P2PTaskRecord | undefined;
  if (!next) return null;

  const result = claimTaskStmt.run(nodeId, userId, userId, assignedAt, next.id);
  if (result.changes !== 1) {
    return null;
  }

  return selectExistingTaskStmt.get(nodeId, userId) as P2PTaskRecord | undefined;
});

export function claimNextTaskAtomically(
  nodeId: string,
  userId: string,
  taskTimeoutSec: number,
): P2PTaskRecord | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - taskTimeoutSec;
  return claimTaskTxn(nodeId, userId, nowSec, cutoff) ?? null;
}

export function completeTaskAtomically(input: {
  taskId: string;
  nodeId: string;
  userId: string;
  resultJson: string;
}): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = completeTaskStmt.run(
    input.resultJson,
    nowSec,
    input.taskId,
    input.nodeId,
    input.userId,
  );
  return result.changes === 1;
}
