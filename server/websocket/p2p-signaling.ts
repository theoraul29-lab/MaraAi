import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db.js';
import { getConsent } from '../maraai/consent.js';
import {
  conversations,
  followers,
  userMissions,
} from '../../shared/schema.js';
import type { UserConnectionMap, UserSocket } from './types.js';

const signalSchema = z
  .object({
    type: z.enum(['p2p-offer', 'p2p-answer', 'p2p-candidate']),
    target: z.string().min(1).max(128),
    from: z.string().optional(),
    userId: z.string().optional(),
    payload: z.unknown().optional(),
    candidate: z.unknown().optional(),
    sdp: z.string().optional(),
  })
  .passthrough();

async function usersHaveValidP2PRelationship(userId: string, targetUserId: string): Promise<boolean> {
  const [mutualFollow, conversation, sharedMission] = await Promise.all([
    db
      .select({ id: followers.id })
      .from(followers)
      .where(
        or(
          and(eq(followers.followerId, userId), eq(followers.followingId, targetUserId)),
          and(eq(followers.followerId, targetUserId), eq(followers.followingId, userId)),
        ),
      )
      .limit(2),
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        or(
          and(eq(conversations.userAId, userId), eq(conversations.userBId, targetUserId)),
          and(eq(conversations.userAId, targetUserId), eq(conversations.userBId, userId)),
        ),
      )
      .limit(1),
    db
      .select({ userId: userMissions.userId, missionId: userMissions.missionId })
      .from(userMissions)
      .where(
        and(
          or(eq(userMissions.userId, userId), eq(userMissions.userId, targetUserId)),
          or(eq(userMissions.status, 'active'), eq(userMissions.status, 'completed')),
        ),
      )
      .limit(20),
  ]);

  if (mutualFollow.length > 0) return true;
  if (conversation.length > 0) return true;

  const missionParticipants = new Map<string, Set<string>>();
  for (const row of sharedMission) {
    const participants = missionParticipants.get(row.missionId) ?? new Set<string>();
    participants.add(row.userId);
    missionParticipants.set(row.missionId, participants);
  }
  for (const participants of missionParticipants.values()) {
    if (participants.has(userId) && participants.has(targetUserId)) return true;
  }
  return false;
}

function sendSecurityError(ws: UserSocket, message: string): void {
  ws.send(JSON.stringify({ type: 'error', message }));
}

export async function relayP2PSignalingMessage(input: {
  data: unknown;
  senderSocket: UserSocket;
  userConnections: UserConnectionMap;
  log: (message: string, source?: string) => void;
}): Promise<void> {
  const parsed = signalSchema.safeParse(input.data);
  if (!parsed.success) {
    sendSecurityError(input.senderSocket, 'Invalid P2P signaling payload.');
    return;
  }

  const senderUserId = input.senderSocket.userId;
  if (!senderUserId) {
    sendSecurityError(input.senderSocket, 'Authentication required.');
    return;
  }
  if (
    (parsed.data.from && parsed.data.from !== senderUserId) ||
    (parsed.data.userId && parsed.data.userId !== senderUserId)
  ) {
    input.log(`Rejected P2P spoofing attempt from ${senderUserId}`, 'p2p-ws');
    input.senderSocket.close(1008, 'Identity mismatch');
    return;
  }
  if (parsed.data.target === senderUserId) {
    sendSecurityError(input.senderSocket, 'Self-signaling is not allowed.');
    return;
  }

  const targetSocket = input.userConnections.get(parsed.data.target);
  if (!targetSocket) {
    input.log(`P2P target user not found or not connected: ${parsed.data.target}`, 'p2p-ws');
    return;
  }

  const [senderConsent, targetConsent, relationshipAllowed] = await Promise.all([
    getConsent(senderUserId),
    getConsent(parsed.data.target),
    usersHaveValidP2PRelationship(senderUserId, parsed.data.target),
  ]);

  if (!senderConsent.p2pEnabled || !targetConsent.p2pEnabled) {
    sendSecurityError(input.senderSocket, 'Both peers must opt in to P2P signaling.');
    return;
  }
  if (senderConsent.killSwitch || targetConsent.killSwitch) {
    sendSecurityError(input.senderSocket, 'P2P signaling is disabled for one of the peers.');
    return;
  }
  if (!relationshipAllowed) {
    sendSecurityError(input.senderSocket, 'P2P signaling is only allowed between connected peers.');
    return;
  }

  input.log(
    `Redirecting P2P message ${parsed.data.type} from ${senderUserId} to ${parsed.data.target}`,
    'p2p-ws',
  );
  targetSocket.send(
    JSON.stringify({
      ...parsed.data,
      from: senderUserId,
      userId: senderUserId,
    }),
  );
}
