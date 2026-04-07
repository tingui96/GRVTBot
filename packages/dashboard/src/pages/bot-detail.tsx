// Bot Detail page — GridChart hero + 6-card stat strip + secondary equity
// curve / stats panel + tabs for Fills/Snapshots.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@/lib/api-client';
import type {
  DailySnapshot,
  FundingRow,
  GridLevel,
  GridState,
  OrderRow,
  Trade,
} from '@/lib/api-types';
import { useWsChannel } from '@/lib/use-ws-channel';
import {
  formatPercent,
  formatPnl,
  formatSize,
  formatTimeUtc,
  formatUsd,
} from '@/lib/format';
import { Card } from '@/components/primitives/card';
import { Mono } from '@/components/primitives/mono';
import { StatCard } from '@/components/primitives/stat-card';
import { StatusPill } from '@/components/primitives/status-pill';
import { Delta } from '@/components/primitives/delta';
import { Tabs } from '@/components/primitives/tabs';
import { DataTable, type Column } from '@/components/primitives/data-table';
import { EquityCurve } from '@/components/charts/equity-curve';
import { StatsPanel } from '@/components/stats-panel';
import {
  FILL_FLASH_DURATION_MS,
  GridChart,
} from '@/components/charts/grid-chart';

interface BotTick {
  id: number;
  status: 'running' | 'paused' | 'stopped' | 'error';
  positionSize: number;
  avgEntryPrice: number;
  gridProfit: number;
  trendPnl: number;
  totalPnl: number;
}

interface FillEvent {
  bot_id?: number;
  level_index?: number;
  side?: 'buy' | 'sell';
  price?: number;
}

export function BotDetailPage() {
  const { id } = useParams();
  const botId = Number(id ?? '42');
  const queryClient = useQueryClient();

  // Bot summary (low-frequency)
  const botQuery = useQuery({
    queryKey: ['bot', botId],
    queryFn: () => api.getBot(botId),
    staleTime: 5_000,
  });

  // Grid state — levels + ticker + position. Polled every 3s as the WS
  // dispatcher only pushes summary ticks; level state changes warrant a
  // refresh from REST.
  const gridStateQuery = useQuery<GridState>({
    queryKey: ['gridState', botId],
    queryFn: () => api.getGridState(botId),
    refetchInterval: 3_000,
  });

  // Candles — 1H, last ~7 days. Cached on the server (30s for 1H).
  const candlesQuery = useQuery({
    queryKey: ['candles', botQuery.data?.bot.pair, 'CI_1_H'],
    queryFn: () =>
      api.getCandles(botQuery.data?.bot.pair ?? 'ETH_USDT_Perp', 'CI_1_H', 200),
    enabled: !!botQuery.data?.bot.pair,
    refetchInterval: 60_000,
  });

  // Live tick from WS — overrides the REST snapshot when present.
  const [tick, setTick] = useState<BotTick | null>(null);
  useWsChannel<BotTick>(`bot:${botId}`, (msg) => {
    if (msg.type === 'tick') setTick(msg.data);
  });

  // Fill flash animation: detect levels that just transitioned filled→active
  // (or vice versa) and surface them to GridChart for ~600ms.
  const prevFilledRef = useRef<Set<number>>(new Set());
  const [recentlyFilled, setRecentlyFilled] = useState<Set<number>>(new Set());

  useEffect(() => {
    const levels = gridStateQuery.data?.levels;
    if (!levels) return;
    const currentFilled = new Set(
      levels.filter((l) => l.is_filled === 1).map((l) => l.level_index)
    );
    const prev = prevFilledRef.current;
    const transitioned: number[] = [];
    for (const idx of currentFilled) {
      if (!prev.has(idx)) transitioned.push(idx);
    }
    for (const idx of prev) {
      if (!currentFilled.has(idx)) transitioned.push(idx);
    }
    prevFilledRef.current = currentFilled;

    if (transitioned.length === 0) return;
    setRecentlyFilled(new Set(transitioned));
    const timer = window.setTimeout(() => {
      setRecentlyFilled(new Set());
    }, FILL_FLASH_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [gridStateQuery.data?.levels]);

  // WS-driven fill events: when the bus pushes a `fill` for this bot,
  // bump the gridState query so the levels refresh immediately.
  useWsChannel<FillEvent>('fills', (msg) => {
    if (msg.type !== 'fill') return;
    if (msg.data.bot_id != null && msg.data.bot_id !== botId) return;
    void queryClient.invalidateQueries({ queryKey: ['gridState', botId] });
  });

  if (botQuery.isPending) return <PageSkeleton />;
  if (botQuery.isError) {
    return (
      <Card className="border-danger/40">
        <h2 className="text-lg font-semibold text-danger mb-2">
          Failed to load bot {botId}
        </h2>
        <p className="text-sm text-text-muted">
          {(botQuery.error as Error).message}
        </p>
      </Card>
    );
  }

  const bot = botQuery.data.bot;
  const status = tick?.status ?? bot.status;
  const positionSize = tick?.positionSize ?? bot.position_size;
  const avgEntry = tick?.avgEntryPrice ?? bot.avg_entry_price;
  const totalPnl = tick?.totalPnl ?? bot.total_pnl_usdt;
  const gridProfit = tick?.gridProfit ?? bot.grid_profit_usdt;
  const trendPnl = tick?.trendPnl ?? bot.trend_pnl_usdt;
  const equity = bot.investment_usdt + totalPnl;
  const equityPct = (totalPnl / bot.investment_usdt) * 100;

  const markPrice = useMarkPrice(gridStateQuery.data);
  const candles = candlesQuery.data?.candles ?? [];
  const levels: GridLevel[] = gridStateQuery.data?.levels ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">
          Bot {bot.id}
        </h1>
        <StatusPill status={status} />
        <span className="text-sm text-text-muted">
          {bot.pair} · {bot.direction.toUpperCase()} · {bot.leverage}x
        </span>
      </div>

      {/* Top stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border-subtle rounded-lg overflow-hidden">
        <StatCard
          label="Equity"
          value={formatUsd(equity)}
          delta={<Delta value={equityPct} format={formatPercent} />}
        />
        <StatCard
          label="Total PnL"
          value={
            <span
              className={
                totalPnl > 0
                  ? 'text-success'
                  : totalPnl < 0
                    ? 'text-danger'
                    : 'text-text-primary'
              }
            >
              {formatPnl(totalPnl)}
            </span>
          }
        />
        <StatCard label="Realized" value={formatPnl(gridProfit)} />
        <StatCard
          label="Unrealized"
          value={
            <span
              className={
                trendPnl > 0
                  ? 'text-success'
                  : trendPnl < 0
                    ? 'text-danger'
                    : 'text-text-primary'
              }
            >
              {formatPnl(trendPnl)}
            </span>
          }
        />
        <StatCard
          label="Position"
          value={`${formatSize(positionSize)}`}
          delta={
            <span className="text-xs text-text-muted">
              @ <Mono>{formatUsd(avgEntry)}</Mono>
            </span>
          }
        />
        <StatCard
          label="Liquidation"
          value={
            bot.liquidation_price != null && bot.liquidation_price > 0
              ? formatUsd(bot.liquidation_price)
              : '—'
          }
        />
      </div>

      {/* GridChart hero */}
      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              Grid Chart
            </h2>
            <p className="text-2xs uppercase tracking-wider text-text-muted mt-0.5">
              {bot.pair} · 1H · {levels.length} levels
            </p>
          </div>
          <ChartLegend />
        </div>
        <div className="h-[480px] md:h-[560px]">
          {candlesQuery.isPending ? (
            <ChartSkeleton message="Loading candles…" />
          ) : candlesQuery.isError ? (
            <ChartSkeleton
              message={`Failed to load candles: ${(candlesQuery.error as Error).message}`}
              error
            />
          ) : (
            <GridChart
              candles={candles}
              levels={levels}
              markPrice={markPrice}
              entryPrice={avgEntry}
              liquidationPrice={bot.liquidation_price}
              recentlyFilled={recentlyFilled}
            />
          )}
        </div>
      </Card>

      {/* Equity curve + stats panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">
            Equity curve
          </h3>
          <BotDetailEquityCurve botId={botId} />
        </Card>
        <StatsPanel bot={bot} />
      </div>

      {/* Tabs */}
      <BotDetailTabs botId={botId} />
    </div>
  );
}

// ── Tabs (Fills + Snapshots for B.5; Orders/Funding deferred) ─────────

type DetailTab = 'fills' | 'orders' | 'funding' | 'snapshots';

function BotDetailTabs({ botId }: { botId: number }) {
  const [tab, setTab] = useState<DetailTab>('fills');

  const tradesQuery = useQuery({
    queryKey: ['trades', botId],
    queryFn: () => api.getTrades(botId, { limit: 200 }),
    refetchInterval: 10_000,
  });

  const ordersQuery = useQuery({
    queryKey: ['orders', botId],
    queryFn: () => api.getOrders(botId, { status: 'all', limit: 200 }),
    refetchInterval: 15_000,
  });

  const fundingQuery = useQuery({
    queryKey: ['funding', botId],
    queryFn: () => api.getFunding(botId, { limit: 500 }),
    staleTime: 60_000,
  });

  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', botId],
    queryFn: () => api.getSnapshots(botId),
    staleTime: 5 * 60_000,
  });

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-5 pt-3">
        <Tabs
          items={[
            {
              value: 'fills',
              label: 'Fills',
              badge: tradesQuery.data?.trades.length ?? '—',
            },
            {
              value: 'orders',
              label: 'Orders',
              badge: ordersQuery.data?.orders.length ?? '—',
            },
            {
              value: 'funding',
              label: 'Funding',
              badge: fundingQuery.data?.count ?? '—',
            },
            {
              value: 'snapshots',
              label: 'Snapshots',
              badge: snapshotsQuery.data?.snapshots.length ?? '—',
            },
          ]}
          value={tab}
          onChange={(v) => setTab(v as DetailTab)}
        >
          {tab === 'fills' && (
            <FillsTable trades={tradesQuery.data?.trades ?? []} loading={tradesQuery.isPending} />
          )}
          {tab === 'orders' && (
            <OrdersTable
              orders={ordersQuery.data?.orders ?? []}
              degraded={ordersQuery.data?.degraded}
              hint={ordersQuery.data?.hint}
              loading={ordersQuery.isPending}
            />
          )}
          {tab === 'funding' && (
            <FundingTable
              funding={fundingQuery.data?.funding ?? []}
              total={fundingQuery.data?.totalPaymentUsdt ?? 0}
              loading={fundingQuery.isPending}
            />
          )}
          {tab === 'snapshots' && (
            <SnapshotsTable
              snapshots={snapshotsQuery.data?.snapshots ?? []}
              loading={snapshotsQuery.isPending}
            />
          )}
        </Tabs>
      </div>
    </Card>
  );
}

const FILLS_COLUMNS: Column<Trade>[] = [
  {
    key: 'time',
    header: 'Time (UTC)',
    render: (r) => formatTimeUtc(new Date(r.created_at).getTime()),
    sortValue: (r) => new Date(r.created_at).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'side',
    header: 'Side',
    render: (r) => (
      <span
        className={
          r.side === 'buy'
            ? 'text-success font-semibold uppercase'
            : 'text-danger font-semibold uppercase'
        }
      >
        {r.side}
      </span>
    ),
    align: 'center',
    width: '80px',
  },
  {
    key: 'price',
    header: 'Price',
    render: (r) => formatUsd(r.price),
    sortValue: (r) => r.price,
    align: 'right',
    mono: true,
  },
  {
    key: 'qty',
    header: 'Size',
    render: (r) => formatSize(r.quantity),
    sortValue: (r) => r.quantity,
    align: 'right',
    mono: true,
  },
  {
    key: 'fee',
    header: 'Fee',
    render: (r) => formatUsd(r.fee),
    sortValue: (r) => r.fee,
    align: 'right',
    mono: true,
  },
  {
    key: 'profit',
    header: 'RT profit',
    render: (r) =>
      r.round_trip_profit != null ? (
        <span
          className={
            r.round_trip_profit > 0
              ? 'text-success'
              : r.round_trip_profit < 0
                ? 'text-danger'
                : ''
          }
        >
          {formatPnl(r.round_trip_profit)}
        </span>
      ) : (
        <span className="text-text-disabled">—</span>
      ),
    sortValue: (r) => r.round_trip_profit ?? 0,
    align: 'right',
    mono: true,
  },
];

function FillsTable({ trades, loading }: { trades: Trade[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading trades…
      </div>
    );
  }
  return (
    <DataTable
      rows={trades}
      columns={FILLS_COLUMNS}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage="No fills yet"
    />
  );
}

const SNAPSHOT_COLUMNS: Column<DailySnapshot>[] = [
  {
    key: 'date',
    header: 'Date',
    render: (r) => r.date,
    sortValue: (r) => r.date,
    mono: true,
    width: '140px',
  },
  {
    key: 'equity',
    header: 'Equity',
    render: (r) => formatUsd(r.equity_usdt),
    sortValue: (r) => r.equity_usdt,
    align: 'right',
    mono: true,
  },
  {
    key: 'realized',
    header: 'Realized',
    render: (r) => formatPnl(r.realized_pnl_usdt),
    sortValue: (r) => r.realized_pnl_usdt,
    align: 'right',
    mono: true,
  },
  {
    key: 'unrealized',
    header: 'Unrealized',
    render: (r) => (
      <span
        className={
          r.unrealized_pnl_usdt > 0
            ? 'text-success'
            : r.unrealized_pnl_usdt < 0
              ? 'text-danger'
              : ''
        }
      >
        {formatPnl(r.unrealized_pnl_usdt)}
      </span>
    ),
    sortValue: (r) => r.unrealized_pnl_usdt,
    align: 'right',
    mono: true,
  },
  {
    key: 'rt',
    header: 'Round trips',
    render: (r) => String(r.num_round_trips),
    sortValue: (r) => r.num_round_trips,
    align: 'right',
    mono: true,
  },
  {
    key: 'fees',
    header: 'Fees',
    render: (r) => formatUsd(r.total_fees_usdt),
    sortValue: (r) => r.total_fees_usdt,
    align: 'right',
    mono: true,
  },
];

function SnapshotsTable({
  snapshots,
  loading,
}: {
  snapshots: DailySnapshot[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading snapshots…
      </div>
    );
  }
  return (
    <DataTable
      rows={snapshots}
      columns={SNAPSHOT_COLUMNS}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage="No snapshots yet"
    />
  );
}

// ── Orders ────────────────────────────────────────────────────────────

const ORDER_STATUS_TONE: Record<OrderRow['status'], string> = {
  pending: 'text-warning',
  filled: 'text-success',
  cancelled: 'text-text-muted',
  rejected: 'text-danger',
};

const ORDERS_COLUMNS: Column<OrderRow>[] = [
  {
    key: 'time',
    header: 'Updated',
    render: (r) => formatTimeUtc(new Date(r.updated_at).getTime()),
    sortValue: (r) => new Date(r.updated_at).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'side',
    header: 'Side',
    render: (r) => (
      <span
        className={
          r.side === 'buy'
            ? 'text-success font-semibold uppercase'
            : 'text-danger font-semibold uppercase'
        }
      >
        {r.side}
      </span>
    ),
    align: 'center',
    width: '70px',
  },
  {
    key: 'type',
    header: 'Type',
    render: (r) => (
      <span className="uppercase text-2xs tracking-wider">{r.type}</span>
    ),
    align: 'center',
    width: '70px',
  },
  {
    key: 'price',
    header: 'Price',
    render: (r) => formatUsd(r.price),
    sortValue: (r) => r.price,
    align: 'right',
    mono: true,
  },
  {
    key: 'qty',
    header: 'Size',
    render: (r) => formatSize(r.quantity),
    sortValue: (r) => r.quantity,
    align: 'right',
    mono: true,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className={`${ORDER_STATUS_TONE[r.status]} uppercase tracking-wider text-2xs font-semibold`}>
        {r.status}
      </span>
    ),
    align: 'center',
  },
  {
    key: 'order_id',
    header: 'Order ID',
    render: (r) => <span className="text-text-muted text-2xs">{r.order_id.slice(0, 12)}…</span>,
    align: 'left',
  },
];

function OrdersTable({
  orders,
  loading,
  degraded,
  hint,
}: {
  orders: OrderRow[];
  loading: boolean;
  degraded?: boolean;
  hint?: string;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading orders…
      </div>
    );
  }
  if (degraded) {
    return (
      <div className="text-center py-8 text-sm text-warning">
        Orders table degraded
        {hint && <div className="text-2xs text-text-muted mt-1">{hint}</div>}
      </div>
    );
  }
  return (
    <DataTable
      rows={orders}
      columns={ORDERS_COLUMNS}
      pageSize={20}
      rowKey={(r) => r.id}
      emptyMessage="No orders in local DB yet"
    />
  );
}

// ── Funding ───────────────────────────────────────────────────────────

const FUNDING_COLUMNS: Column<FundingRow>[] = [
  {
    key: 'time',
    header: 'Time (UTC)',
    render: (r) => {
      const ms = new Date(r.funding_time).getTime();
      return formatTimeUtc(ms);
    },
    sortValue: (r) => new Date(r.funding_time).getTime(),
    mono: true,
    width: '160px',
  },
  {
    key: 'rate',
    header: 'Rate',
    render: (r) => `${(r.funding_rate * 100).toFixed(4)}%`,
    sortValue: (r) => r.funding_rate,
    align: 'right',
    mono: true,
  },
  {
    key: 'pos',
    header: 'Position',
    render: (r) => formatSize(r.position_size),
    sortValue: (r) => r.position_size,
    align: 'right',
    mono: true,
  },
  {
    key: 'payment',
    header: 'Payment',
    render: (r) => (
      <span
        className={
          r.payment_usdt > 0
            ? 'text-success'
            : r.payment_usdt < 0
              ? 'text-danger'
              : ''
        }
      >
        {formatPnl(r.payment_usdt)}
      </span>
    ),
    sortValue: (r) => r.payment_usdt,
    align: 'right',
    mono: true,
  },
];

function FundingTable({
  funding,
  total,
  loading,
}: {
  funding: FundingRow[];
  total: number;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-center py-8 text-sm text-text-muted animate-pulse">
        Loading funding…
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-end pb-3 px-3 text-xs">
        <span className="text-text-muted uppercase tracking-wider mr-2">
          Total
        </span>
        <span
          className={
            total > 0
              ? 'text-success'
              : total < 0
                ? 'text-danger'
                : 'text-text-primary'
          }
        >
          <Mono>{formatPnl(total)}</Mono>
        </span>
      </div>
      <DataTable
        rows={funding}
        columns={FUNDING_COLUMNS}
        pageSize={20}
        rowKey={(r) => r.id}
        emptyMessage="No funding events recorded"
      />
    </div>
  );
}

function BotDetailEquityCurve({ botId }: { botId: number }) {
  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', botId],
    queryFn: () => api.getSnapshots(botId),
    staleTime: 5 * 60_000,
  });
  if (snapshotsQuery.isPending) {
    return (
      <div className="h-60 flex items-center justify-center text-sm text-text-muted animate-pulse">
        Loading…
      </div>
    );
  }
  return <EquityCurve snapshots={snapshotsQuery.data?.snapshots ?? []} />;
}

function ChartLegend() {
  return (
    <div className="hidden md:flex items-center gap-4 text-2xs">
      <LegendDot color="bg-success" label="BUY" />
      <LegendDot color="bg-danger" label="SELL" />
      <LegendDot color="bg-border-strong" label="FILLED" />
      <LegendDot color="bg-warning" label="PENDING" />
      <LegendDot color="bg-primary" label="MARK" />
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-text-muted uppercase tracking-wider">
      <span className={`inline-block h-0.5 w-3 ${color}`} />
      {label}
    </span>
  );
}

function ChartSkeleton({
  message,
  error,
}: {
  message: string;
  error?: boolean;
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <p
        className={
          error ? 'text-sm text-danger' : 'text-sm text-text-muted animate-pulse'
        }
      >
        {message}
      </p>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      <div className="h-8 w-48 bg-bg-elevated rounded" />
      <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border-subtle rounded-lg overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-24 bg-bg-elevated" />
        ))}
      </div>
      <div className="h-[480px] bg-bg-elevated rounded-lg" />
    </div>
  );
}

// Pull a numeric mark price out of the grid-state ticker payload.
// GRVT ticker shape varies; we look for the most likely fields.
function useMarkPrice(state: GridState | undefined): number | null {
  const ticker = state?.ticker as
    | { mark_price?: string | number; last_price?: string | number; price?: string | number }
    | undefined;
  if (!ticker) return null;
  const candidate = ticker.mark_price ?? ticker.last_price ?? ticker.price;
  if (candidate == null) return null;
  const num = typeof candidate === 'string' ? parseFloat(candidate) : candidate;
  return Number.isFinite(num) ? num : null;
}
