import { z } from 'zod';
import { logError } from '../logger.js';
import { storage } from '../storage.js';
import { route as routeAi } from '../maraai/ai-router.js';
import type { UserSocket } from './types.js';

type ChatEnvelope = {
  payload?: unknown;
};

const inputSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  module: z.enum(['missions', 'writers', 'reels']).optional(),
  language: z.string().max(32).optional(),
});

export async function handleChatMessage(ws: UserSocket, data: ChatEnvelope): Promise<void> {
  if (!ws.userId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication required for chat.' }));
    return;
  }

  try {
    const input = inputSchema.parse(data.payload);

    await storage.createChatMessage({
      content: input.message,
      sender: 'user',
      userId: ws.userId,
    });

    const history = await storage.getChatMessages(ws.userId);
    const conversationHistory = history.slice(-20).map((message) => ({
      role: message.sender === 'user' ? 'user' : 'assistant',
      content: message.content,
    }));

    const prefs = await storage.getUserPreferences(ws.userId);
    const userPrefs = {
      ...(prefs || {}),
      language: input.language || prefs?.language,
    };

    const { response: aiResponseContent, detectedMood } = await routeAi(input.message, {
      userId: ws.userId,
      module: input.module,
      prefs: userPrefs,
      history: conversationHistory,
    });

    const aiMsg = await storage.createChatMessage({
      content: aiResponseContent,
      sender: 'ai',
      userId: ws.userId,
    });

    ws.send(JSON.stringify({ type: 'chat-response', payload: { aiResponse: aiMsg, mood: detectedMood } }));
  } catch (err) {
    logError(err, { message: 'Chat processing failed via WebSocket' });
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to process chat message.' }));
  }
}
