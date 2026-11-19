import { useCallback, useEffect, useState } from 'react';

import type { ChatSessionRecord, RunListRow } from '../../../shared/wireTypes';
import { errorMessage } from '../../components/errorMessage';
import { RuntimeApiError, runtimeClient } from '../../runtime/runtimeClient';
import { sameRun, type RunRef } from './runsModel';

const POLL_MS = 4000;

export function useRuns() {
  const [rows, setRows] = useState<RunListRow[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      runtimeClient
        .listRuns()
        .then((runs) => {
          if (cancelled) return;
          setRows(runs);
          setError(undefined);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        });
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { rows, error, refresh };
}

export type TranscriptState =
  | { status: 'loading' }
  | { status: 'ready'; record: ChatSessionRecord | null }
  | { status: 'error'; message: string };

type Keyed = { ref: RunRef; state: TranscriptState };

export function useTranscript(ref: RunRef, live: boolean, lastActivity: number | undefined) {
  const [keyed, setKeyed] = useState<Keyed | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const { workspaceId, agentId, chatId } = ref;

  useEffect(() => {
    let cancelled = false;
    const here: RunRef = { workspaceId, agentId, chatId };
    runtimeClient
      .forWorkspace(workspaceId)
      .loadChatSession(agentId, chatId)
      .then((record) => {
        if (!cancelled) setKeyed({ ref: here, state: { status: 'ready', record } });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof RuntimeApiError && cause.status === 404) setKeyed({ ref: here, state: { status: 'ready', record: null } });
        else setKeyed({ ref: here, state: { status: 'error', message: errorMessage(cause) } });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId, chatId, live, lastActivity, nonce]);

  useEffect(() => {
    if (!live) return undefined;
    const here: RunRef = { workspaceId, agentId, chatId };
    return runtimeClient.forWorkspace(workspaceId).subscribe(agentId, (message) => {
      if (message.type !== 'chat' || message.payload.sessionId !== chatId) return;
      const { messages } = message.payload;
      setKeyed((prev) => {
        const base = prev !== undefined && sameRun(prev.ref, here) && prev.state.status === 'ready' ? prev.state.record : null;
        const now = new Date().toISOString();
        const record: ChatSessionRecord = base
          ? { ...base, messages }
          : { sessionId: chatId, startedAt: now, updatedAt: now, messageCount: messages.length, preview: '', messages };
        return { ref: here, state: { status: 'ready', record } };
      });
    });
  }, [workspaceId, agentId, chatId, live]);

  const retry = useCallback(() => {
    setKeyed(undefined);
    setNonce((n) => n + 1);
  }, []);
  const state: TranscriptState = keyed !== undefined && sameRun(keyed.ref, ref) ? keyed.state : { status: 'loading' };
  return { state, retry };
}

export function useFailureReason(ref: RunRef, failed: boolean): string | undefined {
  const [reason, setReason] = useState<{ ref: RunRef; text: string } | undefined>(undefined);
  const { workspaceId, agentId, chatId } = ref;

  useEffect(() => {
    if (!failed) return undefined;
    let cancelled = false;
    runtimeClient
      .forWorkspace(workspaceId)
      .status(agentId)
      .then((status) => {
        if (!cancelled && status.status === 'error' && status.sessionId === chatId && status.error) setReason({ ref: { workspaceId, agentId, chatId }, text: status.error });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId, chatId, failed]);

  return failed && reason !== undefined && sameRun(reason.ref, ref) ? reason.text : undefined;
}
