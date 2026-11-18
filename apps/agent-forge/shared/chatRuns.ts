import type { ChatSessionMeta, TraceSummaryPayload } from './wireTypes';

export interface ChatRunGroup<T extends TraceSummaryPayload = TraceSummaryPayload> {
  chatId: string;
  preview: string;
  messageCount: number;
  startTime: number;
  lastActivity: number;
  status: 'ok' | 'error' | 'empty';
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  traces: T[];
}

/** One group per chat, newest activity first; a trace with no conversation id belongs to the agent's first chat (its id is the agent id). */
export function groupRunsByChat<T extends TraceSummaryPayload>(agentId: string, chats: ChatSessionMeta[], traces: T[]): ChatRunGroup<T>[] {
  const groups = new Map<string, ChatRunGroup<T>>();
  const group = (chatId: string, start: number): ChatRunGroup<T> => {
    let g = groups.get(chatId);
    if (g === undefined) {
      g = { chatId, preview: '', messageCount: 0, startTime: start, lastActivity: start, status: 'empty', turns: 0, inputTokens: 0, outputTokens: 0, traces: [] };
      groups.set(chatId, g);
    }
    return g;
  };
  for (const chat of chats) {
    const g = group(chat.sessionId, Date.parse(chat.startedAt));
    g.preview = chat.preview;
    g.messageCount = chat.messageCount;
    g.lastActivity = Math.max(g.lastActivity, Date.parse(chat.updatedAt));
  }
  for (const trace of [...traces].sort((a, b) => a.startTime - b.startTime)) {
    const g = group(trace.conversationId ?? agentId, trace.startTime);
    g.traces.unshift(trace);
    g.turns += 1;
    g.status = trace.status;
    g.startTime = Math.min(g.startTime, trace.startTime);
    g.lastActivity = Math.max(g.lastActivity, trace.startTime + trace.durationMs);
    g.inputTokens += trace.inputTokens;
    g.outputTokens += trace.outputTokens;
    if (trace.costUsd !== undefined) g.costUsd = (g.costUsd ?? 0) + trace.costUsd;
  }
  return [...groups.values()].filter((g) => g.turns > 0 || g.messageCount > 0).sort((a, b) => b.lastActivity - a.lastActivity);
}
