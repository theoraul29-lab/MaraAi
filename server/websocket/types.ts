import type { WebSocket } from 'ws';

export type UserSocket = WebSocket & {
  userId?: string;
};

export type UserConnectionMap = Map<string, UserSocket>;
