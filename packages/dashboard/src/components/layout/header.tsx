import { Activity } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWsStatus } from '@/lib/use-ws-channel';
import type { WsStatus } from '@/lib/ws-client';

const STATUS_STYLES: Record<WsStatus, { color: string; label: string }> = {
  open: { color: 'text-success', label: 'Live' },
  connecting: { color: 'text-warning', label: 'Connecting' },
  closed: { color: 'text-text-muted', label: 'Offline' },
  error: { color: 'text-danger', label: 'Error' },
};

export function Header() {
  const status = useWsStatus();
  const styles = STATUS_STYLES[status];

  return (
    <header
      className={cn(
        'flex items-center gap-4',
        'h-14 shrink-0 px-4 md:px-6',
        'bg-bg-surface border-b border-border-subtle'
      )}
    >
      <div className="flex items-center gap-2">
        <Activity className="size-5 text-primary" aria-hidden="true" />
        <span className="font-semibold tracking-tight text-text-primary">
          GRVT GRID
        </span>
      </div>

      <div className="flex-1" />

      <div
        className={cn(
          'flex items-center gap-1.5 text-xs font-medium',
          styles.color
        )}
        title={`WebSocket: ${status}`}
      >
        <span
          className={cn(
            'inline-block size-2 rounded-full bg-current',
            status === 'open' && 'pulse-slow'
          )}
        />
        {styles.label}
      </div>
    </header>
  );
}
