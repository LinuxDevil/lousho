import type { ReactNode } from 'react';
import { ProviderKeysSection } from '../../components/SettingsPanel';
import { useRoute } from '../../router/useRoute';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Tabs } from '../../ui/Tabs';
import { AutomationKeysTab } from './AutomationKeysTab';
import { ConnectorsTab } from './ConnectorsTab';
import { InboundTab } from './InboundTab';
import { NotificationsTab } from './NotificationsTab';
import { SecretsTab } from './SecretsTab';
import './profile.css';

const TABS: { id: string; label: string; body: () => ReactNode }[] = [
  { id: 'connectors', label: 'Connectors', body: ConnectorsTab },
  {
    id: 'ai',
    label: 'AI access',
    body: () => (
      <>
        <p className="profile-intro">The model provider keys every agent run uses unless its spec names its own key.</p>
        <ProviderKeysSection />
      </>
    ),
  },
  { id: 'secrets', label: 'Secrets', body: SecretsTab },
  { id: 'keys', label: 'Automation keys', body: AutomationKeysTab },
  { id: 'inbound', label: 'Inbound events', body: InboundTab },
  { id: 'notifications', label: 'Notifications', body: NotificationsTab },
];

export function ProfileScreen() {
  const { path } = useRoute();
  const segment = path.split('/').filter(Boolean)[1];
  const tab = TABS.find((t) => t.id === segment) ?? TABS[0];
  return (
    <div className="profile-screen">
      <ScreenHeader
        title="Profile"
        description="The accounts, keys and endpoints this Studio uses to act for you."
        tabs={<Tabs label="Profile" items={TABS.map((t) => ({ id: t.id, label: t.label, href: `#/profile/${t.id}` }))} currentId={tab.id} />}
      />
      <tab.body />
    </div>
  );
}
