import { useParams } from 'react-router-dom';
import { Card } from '@/components/primitives/card';

export function BotDetailPage() {
  const { id } = useParams();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Bot {id}</h1>
      <Card className="border-dashed border-border-default">
        <p className="text-sm text-text-muted">
          Bot detail page (GridChart hero, equity curve, stats panel, fills/orders/funding/snapshots tabs)
          lands in B.4 + B.5.
        </p>
      </Card>
    </div>
  );
}
