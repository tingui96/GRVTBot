// UpdateRangeDialog — operator escape hatch when price drifts out of the
// current grid range. Two-phase: live preview from the server-side
// plan builder, then explicit commit. The user always sees exactly
// what will happen (orders to cancel, ETH to auto-buy, slippage cost)
// before pressing Apply.
//
// What the engine does on commit (server side, mirrored from the plan):
//   1. Re-runs buildRangeUpdatePlan() — same code path as preview, so
//      the user is committing to exactly what they saw
//   2. Refuses on safety violations (mark outside range, deficit > cap, etc.)
//   3. Short-circuits on no-op (same range as current)
//   4. Acquires per-bot mutex (monitor() skips during the mutation)
//   5. Market-buys ETH deficit if any (verifying fill before touching DB)
//   6. Atomically replaces all grid_levels in a single transaction
//   7. Updates bot.lower_price / bot.upper_price
//   8. Places fresh limit orders
//   9. Releases mutex

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { Modal } from '@/components/primitives/modal';
import { Input } from '@/components/primitives/input';
import { Button } from '@/components/primitives/button';
import { Mono } from '@/components/primitives/mono';
import { api } from '@/lib/api-client';
import { formatUsd } from '@/lib/format';
import type { BotSummary, RangeUpdatePlan } from '@/lib/api-types';

interface UpdateRangeDialogProps {
  open: boolean;
  onClose: () => void;
  bot: BotSummary;
  // Live mark price from the grid-state query, used to render the
  // "current state" strip and the out-of-grid warning. Authoritative
  // mark for the preview comes from the server response.
  markPrice: number | null;
}

// Cheap debounce hook so we don't fire a /preview request on every
// keystroke. 400ms is a good balance: feels live, doesn't hammer.
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function UpdateRangeDialog({
  open,
  onClose,
  bot,
  markPrice,
}: UpdateRangeDialogProps) {
  const queryClient = useQueryClient();

  // Local form state — initialized from the bot's current range each
  // time the dialog opens, so cancel + reopen always shows fresh values.
  const [lower, setLower] = useState<string>('');
  const [upper, setUpper] = useState<string>('');
  const [touchedLower, setTouchedLower] = useState(false);
  const [touchedUpper, setTouchedUpper] = useState(false);

  useEffect(() => {
    if (open) {
      setLower(String(bot.lower_price));
      setUpper(String(bot.upper_price));
      setTouchedLower(false);
      setTouchedUpper(false);
    }
  }, [open, bot.lower_price, bot.upper_price]);

  const lowerNum = parseFloat(lower);
  const upperNum = parseFloat(upper);
  const lowerValid = Number.isFinite(lowerNum) && lowerNum > 0;
  const upperValid = Number.isFinite(upperNum) && upperNum > 0;
  const orderingValid = lowerValid && upperValid && lowerNum < upperNum;

  // Inline validation (on blur, not keystroke) for the form itself.
  // Server-side violations come back via the preview query.
  const lowerError =
    touchedLower && !lowerValid
      ? 'Must be a positive number'
      : touchedLower && lowerValid && upperValid && lowerNum >= upperNum
        ? 'Must be less than upper price'
        : undefined;
  const upperError =
    touchedUpper && !upperValid ? 'Must be a positive number' : undefined;

  // Debounce the inputs so /preview is only called when the user pauses.
  const debouncedLower = useDebounced(lowerNum, 400);
  const debouncedUpper = useDebounced(upperNum, 400);
  const debouncedValid =
    Number.isFinite(debouncedLower) &&
    Number.isFinite(debouncedUpper) &&
    debouncedLower > 0 &&
    debouncedUpper > 0 &&
    debouncedLower < debouncedUpper;

  // Live preview — re-runs whenever the debounced inputs change.
  // Server returns a full plan including server-side safety violations.
  const previewQuery = useQuery({
    queryKey: ['range-preview', bot.id, debouncedLower, debouncedUpper],
    queryFn: () =>
      api.previewBotRangeUpdate(bot.id, {
        lowerPrice: debouncedLower,
        upperPrice: debouncedUpper,
      }),
    enabled: open && debouncedValid,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  const plan: RangeUpdatePlan | null = previewQuery.data?.plan ?? null;

  // Snapshot the order count BEFORE the mutation starts so the
  // progress UI can detect the cancel→place transition. We capture
  // it from the plan (ordersToCancel) which the preview already
  // computed. Total target = plan.levelsToCreate.
  const ordersAtStart = plan?.ordersToCancel ?? 0;
  const totalTarget = plan?.levelsToCreate ?? 0;

  const mutation = useMutation({
    mutationFn: () =>
      api.updateBotRange(bot.id, { lowerPrice: lowerNum, upperPrice: upperNum }),
    onSuccess: () => {
      toast.success(
        `Range updated: ${formatUsd(lowerNum)} — ${formatUsd(upperNum)}`
      );
      void queryClient.invalidateQueries({ queryKey: ['bot', bot.id] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      void queryClient.invalidateQueries({ queryKey: ['gridState', bot.id] });
      onClose();
    },
    onError: (err: Error) => toast.error(`Range update failed: ${err.message}`),
  });

  // Poll grid-state every 1s while the mutation is in flight so we
  // can show real progress instead of a 90-second "Updating…". The
  // server-side flow is:
  //   1. Cancel all current orders     (ordersAtStart → 0)
  //   2. Optional market-buy ETH       (no order count change)
  //   3. Place new orders              (0 → totalTarget)
  // We use openOrders.length to detect which phase we're in and
  // compute a single 0-100 progress.
  const progressQuery = useQuery({
    queryKey: ['range-update-progress', bot.id],
    queryFn: () => api.getGridState(bot.id),
    enabled: mutation.isPending,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  });

  // Phase + progress computation. The cancel phase counts down from
  // ordersAtStart to 0, then the place phase counts up from 0 to
  // totalTarget. We split the bar 50/50 between the two phases so
  // 100% maps to "all new orders placed".
  const liveOrderCount = progressQuery.data?.openOrders.length ?? ordersAtStart;
  let progressPct = 0;
  let phaseText = 'Starting…';
  if (mutation.isPending && totalTarget > 0) {
    if (liveOrderCount > 0 && liveOrderCount >= ordersAtStart * 0.95) {
      // Still in cancel phase (orders > 95% of original)
      phaseText = `Cancelling old orders (${liveOrderCount}/${ordersAtStart})…`;
      progressPct = 5;
    } else if (liveOrderCount > totalTarget * 0.5 && liveOrderCount < ordersAtStart) {
      // Cancel mostly done, mid-transition
      phaseText = 'Cancelling old orders…';
      progressPct = 25;
    } else if (liveOrderCount === 0 || liveOrderCount < totalTarget * 0.1) {
      // Cancel done, place not yet started or just started
      phaseText = plan?.autoBuy
        ? `Buying ${plan.autoBuy.size.toFixed(2)} ETH…`
        : 'Placing new orders…';
      progressPct = 50;
    } else {
      // Place phase: counting up to totalTarget
      const placed = liveOrderCount;
      const placePct = Math.min(100, (placed / totalTarget) * 100);
      phaseText = `Placing new orders (${placed}/${totalTarget})…`;
      progressPct = 50 + placePct * 0.5;
    }
  }

  // Submit gating: form valid + plan loaded + zero violations + not pending.
  // Note: a no-op is technically allowed (server short-circuits) but we
  // hide the button to avoid confusion.
  const hasViolations = (plan?.safetyViolations.length ?? 0) > 0;
  const canSubmit =
    orderingValid &&
    plan !== null &&
    !hasViolations &&
    !plan.noop &&
    !mutation.isPending &&
    !previewQuery.isFetching;

  const submitLabel = useMemo(() => {
    if (mutation.isPending) return 'Updating…';
    if (previewQuery.isFetching) return 'Calculating…';
    if (plan?.noop) return 'No change';
    if (hasViolations) return 'Cannot apply';
    return 'Apply new range';
  }, [mutation.isPending, previewQuery.isFetching, plan?.noop, hasViolations]);

  function handleSubmit() {
    setTouchedLower(true);
    setTouchedUpper(true);
    if (!canSubmit) return;
    mutation.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={mutation.isPending ? () => {} : onClose}
      title="Update grid range"
      description={`${bot.pair} · ${bot.direction.toUpperCase()} · ${bot.leverage}x`}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Current state strip */}
        <div className="flex items-center gap-3 text-2xs uppercase tracking-wider">
          <div className="flex-1">
            <div className="text-text-muted">Current range</div>
            <div className="text-text-primary text-sm normal-case tracking-normal">
              <Mono>
                {formatUsd(bot.lower_price)} — {formatUsd(bot.upper_price)}
              </Mono>
            </div>
          </div>
          <ArrowRight className="size-4 text-text-muted shrink-0" />
          <div className="flex-1">
            <div className="text-text-muted">Mark price</div>
            <div className="text-sm normal-case tracking-normal">
              {markPrice !== null ? (
                <Mono
                  className={
                    markPrice < bot.lower_price || markPrice > bot.upper_price
                      ? 'text-danger'
                      : 'text-text-primary'
                  }
                >
                  {formatUsd(markPrice)}
                </Mono>
              ) : (
                <span className="text-text-disabled">—</span>
              )}
            </div>
          </div>
        </div>

        {/* Out-of-grid warning */}
        {markPrice !== null &&
          (markPrice < bot.lower_price || markPrice > bot.upper_price) && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-warning-soft border border-warning/30">
              <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
              <div className="text-2xs text-warning-strong">
                <strong>Mark price is outside the current grid.</strong> The
                bot has no orders being filled. Update the range to cover the
                current price so it can resume earning.
              </div>
            </div>
          )}

        {/* New range form */}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="New lower price"
            numeric
            inputMode="decimal"
            value={lower}
            onChange={(e) => setLower(e.target.value)}
            onBlur={() => setTouchedLower(true)}
            error={lowerError}
            disabled={mutation.isPending}
          />
          <Input
            label="New upper price"
            numeric
            inputMode="decimal"
            value={upper}
            onChange={(e) => setUpper(e.target.value)}
            onBlur={() => setTouchedUpper(true)}
            error={upperError}
            disabled={mutation.isPending}
          />
        </div>

        {/* Progress overlay while the commit is in flight. The preview
            stays visible underneath but the user gets real feedback
            on which phase the engine is in (cancel → optional buy →
            place) and a 0-100 bar driven by polling /grid-state. */}
        {mutation.isPending && (
          <div className="rounded-md border border-primary/40 bg-primary-soft/30 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-text-primary font-semibold">
                <Loader2 className="size-4 animate-spin text-primary" />
                {phaseText}
              </div>
              <Mono className="text-text-secondary">
                {Math.round(progressPct)}%
              </Mono>
            </div>
            <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-2xs text-text-muted">
              This usually takes 60-90 seconds. The monitor loop is
              paused for this bot during the mutation.
            </p>
          </div>
        )}

        {/* Live preview area — switches between loading / error / plan / empty */}
        <PreviewArea
          plan={plan}
          fetching={previewQuery.isFetching}
          error={previewQuery.error as Error | null}
          formValid={orderingValid && debouncedValid}
        />
      </div>
    </Modal>
  );
}

// ── Preview area ────────────────────────────────────────────────────

interface PreviewAreaProps {
  plan: RangeUpdatePlan | null;
  fetching: boolean;
  error: Error | null;
  formValid: boolean;
}

function PreviewArea({ plan, fetching, error, formValid }: PreviewAreaProps) {
  if (!formValid) {
    return (
      <div className="rounded-md border border-dashed border-border-subtle bg-bg-surface p-3 text-2xs text-text-muted text-center">
        Enter a valid range to see the live preview
      </div>
    );
  }
  if (fetching && !plan) {
    return (
      <div className="rounded-md border border-border-subtle bg-bg-surface p-3 text-xs text-text-muted flex items-center gap-2 justify-center">
        <Loader2 className="size-4 animate-spin" />
        Calculating impact…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 p-3 rounded-md bg-danger-soft border border-danger/30">
        <AlertTriangle className="size-4 text-danger shrink-0 mt-0.5" />
        <div className="text-2xs text-danger-strong">
          <strong>Preview failed:</strong> {error.message}
        </div>
      </div>
    );
  }
  if (!plan) return null;

  return (
    <div className="space-y-3">
      {/* Server-side safety violations — block submit */}
      {plan.safetyViolations.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-danger-soft border border-danger/30">
          <AlertTriangle className="size-4 text-danger shrink-0 mt-0.5" />
          <div className="text-2xs text-danger-strong space-y-1">
            <div className="font-semibold">Cannot apply this range:</div>
            <ul className="list-disc list-inside space-y-0.5">
              {plan.safetyViolations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* No-op note */}
      {plan.noop && plan.safetyViolations.length === 0 && (
        <div className="rounded-md border border-border-subtle bg-bg-surface p-3 text-2xs text-text-muted text-center">
          Range unchanged — nothing to apply
        </div>
      )}

      {/* The actual plan card — only render if there are no blocking issues */}
      {!plan.noop && plan.safetyViolations.length === 0 && (
        <div className="rounded-md border border-border-subtle bg-bg-surface p-3 space-y-3">
          <div className="text-2xs uppercase tracking-wider text-text-muted">
            Preview · what will happen
          </div>

          <dl className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
            <dt className="text-text-muted">New range</dt>
            <dd className="text-right text-text-primary">
              <Mono>
                {formatUsd(plan.newRange.lower)} — {formatUsd(plan.newRange.upper)}
              </Mono>
            </dd>
            <dt className="text-text-muted">Total levels</dt>
            <dd className="text-right text-text-primary">
              <Mono>{plan.newTotalLevels}</Mono>
            </dd>
            <dt className="text-text-muted">Spacing</dt>
            <dd className="text-right text-text-primary">
              <Mono>{formatUsd(plan.newSpacing)}</Mono>
            </dd>
            <dt className="text-text-muted">Buy levels (below mark)</dt>
            <dd className="text-right text-success">
              <Mono>{plan.newBuyLevels}</Mono>
            </dd>
            <dt className="text-text-muted">Sell levels (above mark)</dt>
            <dd className="text-right text-danger">
              <Mono>{plan.newSellLevels}</Mono>
            </dd>
            <dt className="text-text-muted">Orders to cancel</dt>
            <dd className="text-right text-text-primary">
              <Mono>{plan.ordersToCancel}</Mono>
            </dd>
          </dl>

          {/* Auto-buy callout — the part that costs real money */}
          {plan.autoBuy && (
            <div className="border-t border-border-subtle pt-3">
              <div className="text-2xs uppercase tracking-wider text-warning mb-1.5">
                Will market-buy
              </div>
              <dl className="grid grid-cols-2 gap-y-1 gap-x-4 text-xs">
                <dt className="text-text-muted">Size</dt>
                <dd className="text-right">
                  <Mono className="text-text-primary">
                    {plan.autoBuy.size.toFixed(4)} ETH
                  </Mono>
                </dd>
                <dt className="text-text-muted">At price</dt>
                <dd className="text-right">
                  <Mono className="text-text-primary">
                    ~{formatUsd(plan.autoBuy.estimatedPrice)}
                  </Mono>
                </dd>
                <dt className="text-text-muted">Total cost</dt>
                <dd className="text-right">
                  <Mono className="text-warning">
                    ~{formatUsd(plan.autoBuy.estimatedCost)}
                  </Mono>
                </dd>
                <dt className="text-text-muted">Slippage est.</dt>
                <dd className="text-right">
                  <Mono className="text-text-muted">
                    ~{formatUsd(plan.autoBuy.estimatedSlippageUsd)}
                  </Mono>
                </dd>
              </dl>
              <p className="text-2xs text-text-muted mt-2">
                The grid needs more ETH to back the new sell levels. The
                engine will market-buy this BEFORE placing any orders, with
                IOC + 0.5% aggressive limit. Position will increase by this
                amount.
              </p>
            </div>
          )}

          {/* Excess (informational, not an action) */}
          {plan.ethExcess > 0 && (
            <div className="border-t border-border-subtle pt-3 text-2xs text-text-muted">
              Position currently exceeds the new sell-side requirement by{' '}
              <Mono className="text-text-primary">
                {plan.ethExcess.toFixed(4)} ETH
              </Mono>
              . The grid will absorb it naturally as sells fill — no action
              taken.
            </div>
          )}

          {/* Generic warnings (when not auto-buy / not excess) */}
          {plan.warnings.length > 0 && !plan.autoBuy && plan.ethExcess === 0 && (
            <div className="border-t border-border-subtle pt-3 text-2xs text-text-muted space-y-0.5">
              {plan.warnings.map((w) => (
                <div key={w}>· {w}</div>
              ))}
            </div>
          )}

          <p className="text-2xs text-text-muted pt-2 border-t border-border-subtle">
            The whole operation is real money and can take a few seconds.
            Monitor loop is paused for this bot during the mutation.
          </p>
        </div>
      )}
    </div>
  );
}
