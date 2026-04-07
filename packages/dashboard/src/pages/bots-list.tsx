import { Card } from '@/components/primitives/card';

export function BotsListPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Bots</h1>
      <Card className="border-dashed border-border-default">
        <p className="text-sm text-text-muted">
          Multi-bot list, BotCard grid and the Create Wizard land in B.5.
        </p>
      </Card>
    </div>
  );
}
