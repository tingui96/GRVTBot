// H.6b — Grid backtest parameter sweep.
// Pure computation on historical candles: derives candidate price ranges
// from the candle stats, then sweeps range × num_grids × leverage ×
// direction, running runBacktest() for each combo. Returns the combos
// ranked by net profit so the dashboard can suggest parameters instead of
// making the user guess. No GRVT calls, no DB writes.

import { runBacktest, type BacktestCandle } from './backtester.js';

export interface OptimizeConfig {
  pair: string;
  investmentUSDT: number;
  feePct?: number;
  // Sweep space. Sensible defaults applied when omitted.
  gridCounts?: number[];
  leverages?: number[];
  directions?: Array<'long' | 'short'>;
  // A combo is only flagged `recommended` if its drawdown is under this.
  maxDrawdownPct?: number;
  // How many ranked combos to return.
  topN?: number;
}

export interface OptimizeCandidate {
  direction: 'long' | 'short';
  leverage: number;
  lowerPrice: number;
  upperPrice: number;
  numGrids: number;
  rangeLabel: string;
  netProfit: number;
  returnPct: number; // netProfit as % of investment
  maxDrawdownPct: number;
  roundTrips: number;
  avgProfitPerTrip: number;
  recommended: boolean;
}

export interface PriceStats {
  min: number;
  max: number;
  first: number;
  last: number;
  mean: number;
  std: number;
  trendPct: number; // (last - first) / first * 100
}

export interface OptimizeResult {
  candidates: OptimizeCandidate[];
  priceStats: PriceStats;
  combinationsTested: number;
  candlesProcessed: number;
}

const DEFAULT_GRIDS = [10, 20, 30, 40, 60, 80, 100];
const DEFAULT_LEVERAGES = [1, 2, 3, 5];
const DEFAULT_DIRECTIONS: Array<'long' | 'short'> = ['long', 'short'];

function computeStats(candles: BacktestCandle[]): PriceStats {
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const closes = candles.map((c) => c.close);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const first = candles[0]!.close;
  const last = candles[candles.length - 1]!.close;
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const std = Math.sqrt(
    closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length
  );
  const trendPct = first > 0 ? ((last - first) / first) * 100 : 0;
  return { min, max, first, last, mean, std, trendPct };
}

// Candidate ranges anchored to the observed price action. A grid only
// trades while price stays inside its range, so the best range brackets
// the actual oscillation. We round to 2 decimals and dedupe.
function candidateRanges(s: PriceStats): Array<[number, number, string]> {
  const raw: Array<[number, number, string]> = [
    [s.min, s.max, 'full'],
    [s.min * 1.005, s.max * 0.995, 'trimmed'],
    [s.mean - 2 * s.std, s.mean + 2 * s.std, '±2σ'],
    [s.mean - 1.5 * s.std, s.mean + 1.5 * s.std, '±1.5σ'],
    [s.mean - 1 * s.std, s.mean + 1 * s.std, '±1σ'],
    [s.last * 0.95, s.last * 1.05, 'last ±5%'],
    [s.last * 0.9, s.last * 1.1, 'last ±10%'],
    [s.last * 0.85, s.last * 1.15, 'last ±15%'],
  ];
  const seen = new Set<string>();
  const out: Array<[number, number, string]> = [];
  for (const [lo, hi, label] of raw) {
    const rlo = Math.round(lo * 100) / 100;
    const rhi = Math.round(hi * 100) / 100;
    if (rlo <= 0 || rhi <= rlo) continue;
    const key = `${rlo}-${rhi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([rlo, rhi, label]);
  }
  return out;
}

export function optimizeBacktest(
  config: OptimizeConfig,
  candles: BacktestCandle[]
): OptimizeResult {
  if (candles.length === 0) {
    return {
      candidates: [],
      priceStats: { min: 0, max: 0, first: 0, last: 0, mean: 0, std: 0, trendPct: 0 },
      combinationsTested: 0,
      candlesProcessed: 0,
    };
  }

  const stats = computeStats(candles);
  const ranges = candidateRanges(stats);
  const gridCounts = config.gridCounts ?? DEFAULT_GRIDS;
  const leverages = config.leverages ?? DEFAULT_LEVERAGES;
  const directions = config.directions ?? DEFAULT_DIRECTIONS;
  const ddCap = config.maxDrawdownPct ?? 30;
  const topN = config.topN ?? 20;

  const candidates: OptimizeCandidate[] = [];
  let tested = 0;

  for (const [lo, hi, label] of ranges) {
    for (const numGrids of gridCounts) {
      for (const leverage of leverages) {
        for (const direction of directions) {
          tested++;
          const r = runBacktest(
            {
              pair: config.pair,
              direction,
              leverage,
              lowerPrice: lo,
              upperPrice: hi,
              numGrids,
              investmentUSDT: config.investmentUSDT,
              feePct: config.feePct,
            },
            candles
          );
          candidates.push({
            direction,
            leverage,
            lowerPrice: lo,
            upperPrice: hi,
            numGrids,
            rangeLabel: label,
            netProfit: r.netProfit,
            returnPct:
              config.investmentUSDT > 0
                ? Math.round((r.netProfit / config.investmentUSDT) * 10000) / 100
                : 0,
            maxDrawdownPct: r.maxDrawdownPct,
            roundTrips: r.roundTrips,
            avgProfitPerTrip: r.avgProfitPerTrip,
            recommended: false,
          });
        }
      }
    }
  }

  // Rank by net profit (primary metric the user asked to maximize).
  candidates.sort((a, b) => b.netProfit - a.netProfit);

  // Flag the single best combo that also keeps drawdown under the cap and
  // makes a reasonable number of round trips — the "safe pick".
  const safe = candidates.find(
    (c) => c.netProfit > 0 && c.maxDrawdownPct <= ddCap && c.roundTrips >= 10
  );
  if (safe) safe.recommended = true;

  return {
    candidates: candidates.slice(0, topN),
    priceStats: stats,
    combinationsTested: tested,
    candlesProcessed: candles.length,
  };
}
