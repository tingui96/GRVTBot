import { Card } from '@/components/primitives/card';

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <Card>
        <h2 className="text-sm font-semibold mb-2">Connection</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-text-muted uppercase tracking-wider text-2xs">
            API base
          </dt>
          <dd className="font-mono text-text-secondary">
            {import.meta.env.VITE_API_BASE_URL || '(vite proxy)'}
          </dd>
          <dt className="text-text-muted uppercase tracking-wider text-2xs">
            API key
          </dt>
          <dd className="font-mono text-text-secondary">
            {import.meta.env.VITE_DASHBOARD_API_KEY
              ? `${String(import.meta.env.VITE_DASHBOARD_API_KEY).slice(0, 8)}…`
              : '(unset)'}
          </dd>
        </dl>
      </Card>
    </div>
  );
}
