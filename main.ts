// Poised Relay: long-only cbBTC. A round trip costs roughly 26 bps, so one-minute noise is
// skipped. Two entries, one position:
//   dip: close is 150 bps under the high of the last 120 closes. Take profit at 160 bps over
//   cost, or stop at 180 bps under it. This is the trade that can make money on a down day.
//   trend: close is 50 bps above the first close and within 20 bps of that same high. No fixed
//   target; a 100 bp trail arms after 100 bps, and a 150 bp stop cuts a failed breakout.
// Sells go out again while the reason still holds. Ten flat bars after a sell before the next buy.
// Prices compare as integers. Floats are not used, so two runs on the same bars match.

import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const LOOK = 120;
const DIP_BPS = 150n;
const DIP_TP_BPS = 160n;
const DIP_STOP_BPS = 180n;
const TREND_UP_BPS = 50n;
const TREND_NEAR_BPS = 20n;
const TREND_STOP_BPS = 150n;
const TRAIL_ARM_BPS = 100n;
const TRAIL_BPS = 100n;
const COOLDOWN = 10;
const MAX_SLIPPAGE_BPS = 200;
const BPS = 10_000n;

const closes: bigint[] = [];
let symbol = 'CBBTC';
let mode: 'dip' | 'trend' | null = null;
let peak: bigint | null = null;
let cool = 0;

function rollHigh(): bigint {
  let high = closes[closes.length - 1]!;
  const from = Math.max(0, closes.length - LOOK);
  for (let i = from; i < closes.length; i++) if (closes[i]! > high) high = closes[i]!;
  return high;
}

function pushCloses(bars: readonly Bar[]): boolean {
  let saw = false;
  for (const bar of bars) {
    if (bar.symbol !== symbol) continue;
    closes.push(BigInt(bar.c));
    saw = true;
  }
  return saw;
}

function buy(state: BarsState): OrderInput[] {
  if (cool > 0 || closes.length < 2) return [];
  const last = closes[closes.length - 1]!;
  const high = rollHigh();
  const first = closes[0]!;
  const dip = last * BPS <= high * (BPS - DIP_BPS);
  const trend = last * BPS >= first * (BPS + TREND_UP_BPS) && last * BPS >= high * (BPS - TREND_NEAR_BPS);
  if (!dip && !trend) return [];
  mode = dip ? 'dip' : 'trend';
  peak = null;
  const room = state.weightRoom(symbol);
  const spend = state.cash < room ? state.cash : room;
  if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function sell(state: BarsState, qty: bigint, cost: bigint): OrderInput[] {
  const last = closes[closes.length - 1]!;
  if (peak === null || last > peak) peak = last;
  const value = state.value(symbol, qty);
  if (mode === 'trend') {
    const stopped = value * BPS <= cost * (BPS - TREND_STOP_BPS);
    const armed = value * BPS >= cost * (BPS + TRAIL_ARM_BPS);
    const trailed = armed && last * BPS <= peak * (BPS - TRAIL_BPS);
    if (!stopped && !trailed) return [];
  } else {
    const target = value * BPS >= cost * (BPS + DIP_TP_BPS);
    const stopped = value * BPS <= cost * (BPS - DIP_STOP_BPS);
    if (!target && !stopped) return [];
  }
  cool = COOLDOWN;
  return [{ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0]?.symbol ?? symbol;
  },
  onBatch(state, batch) {
    const saw = pushCloses(batch.bars);
    const held = state.positions.get(symbol);
    if (state.warmingUp) return [];
    if (!held) {
      mode = null;
      peak = null;
      if (cool > 0) cool -= 1;
      if (!saw) return [];
      return buy(state);
    }
    if (!saw || closes.length === 0) return [];
    return sell(state, held.qty, held.cost);
  },
});
