import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createFetchClient, type ApiClient } from 'lousho/workspaces/client';

// fallow-ignore-next-line unused-export -- contract surface: P2.21's password auth changes its headers; tests inject their own client.
export function defaultWorkspacesClient(): ApiClient {
  return createFetchClient({ baseUrl: '' });
}

const WorkspacesClientContext = createContext<ApiClient | null>(null);

export function WorkspacesClientProvider({ client, children }: { client?: ApiClient; children: ReactNode }) {
  const value = useMemo(() => client ?? defaultWorkspacesClient(), [client]);
  return <WorkspacesClientContext.Provider value={value}>{children}</WorkspacesClientContext.Provider>;
}

export function useWorkspacesClient(): ApiClient {
  const client = useContext(WorkspacesClientContext);
  if (client === null) throw new Error('useWorkspacesClient needs a WorkspacesClientProvider');
  return client;
}
