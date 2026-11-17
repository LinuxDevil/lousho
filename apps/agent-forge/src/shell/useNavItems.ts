import { useEffect, useState } from 'react';
import { NAV_ITEMS, type NavItem } from './NavRail';

export async function hasWorkspaceService(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/workspaces', { headers: { accept: 'application/json' } });
    return res.ok && (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}

let probe: Promise<boolean> | undefined;
const WITHOUT_WORKSPACES = NAV_ITEMS.filter((item) => item.id !== 'workspaces');

export function useNavItems(): NavItem[] {
  const [service, setService] = useState(false);
  useEffect(() => {
    let live = true;
    probe ??= hasWorkspaceService();
    void probe.then((ok) => live && setService(ok));
    return () => {
      live = false;
    };
  }, []);
  return service ? NAV_ITEMS : WITHOUT_WORKSPACES;
}
