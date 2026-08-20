import {
  registerComputePeer,
  unregisterComputePeer,
} from '../maraai/p2p-compute.js';
import type { UserSocket } from './types.js';

type ComputeMessage = {
  nodeId?: unknown;
};

export function handleComputeReady(
  ws: UserSocket,
  data: ComputeMessage,
  log: (message: string, source?: string) => void,
): void {
  if (!ws.userId) return;
  const node = registerComputePeer({
    userId: ws.userId,
    nodeId: typeof data.nodeId === 'string' ? data.nodeId : null,
  });
  log(`Browser compute node ready: user=${node.userId}`, 'p2p-compute');
  ws.send(JSON.stringify({ type: 'p2p-browser-ack' }));
}

export function handleComputeGone(
  ws: UserSocket,
  log: (message: string, source?: string) => void,
): void {
  if (!ws.userId) return;
  unregisterComputePeer(ws.userId);
  log(`Browser compute node gone: user=${ws.userId}`, 'p2p-compute');
}
