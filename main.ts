// Poised Relay: long-only cbBTC on one-minute bars. A full-size round trip costs about 26 bps,
// so the bot waits for a real washout, not one-minute noise.
//
// Entry: the low of the last 3 closes is at least 200 bps under the high of the last 180 closes,
// and the latest close has bounced at least 5 bps off that low. Buy once history has 60 closes.
// Exit: take profit arms at +120 bps over cost; after that a 25 bp trail from the peak close
// sells the rebound. A hard stop at -80 bps cuts a failed bounce. After a sell, wait 30 flat
// bars before the next buy.
// Prices compare as integers. Floats are not used, so two runs on the same bars match.

import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const LOOK = 180;
const DIP_BPS = 200n;
const BOUNCE_BARS = 3;
const BOUNCE_BPS = 5n;
const TP_BPS = 120n;
const STOP_BPS = 80n;
const TRAIL_BPS = 25n;
const MIN_HIST = 60;
const COOLDOWN = 30;
const MAX_SLIPPAGE_BPS = 250;
const BPS = 10_000n;

const closes: bigint[] = [];
let symbol = 'CBBTC';
let peak: bigint | null = null;
let armed = false;
let cool = 0;

function rollHigh(n: number): bigint {
  let high = closes[closes.length - 1]!;
  const from = Math.max(0, closes.length - n);
  for (let i = from; i < closes.length; i++) if (closes[i]! > high) high = closes[i]!;
  return high;
}

function rollLow(n: number): bigint {
  let low = closes[closes.length - 1]!;
  const from = Math.max(0, closes.length - n);
  for (let i = from; i < closes.length; i++) if (closes[i]! < low) low = closes[i]!;
  return low;
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
  if (cool > 0 || closes.length < MIN_HIST) return [];
  const last = closes[closes.length - 1]!;
  const high = rollHigh(LOOK);
  const low = rollLow(BOUNCE_BARS);
  if (low * BPS > high * (BPS - DIP_BPS)) return [];
  if (last * BPS < low * (BPS + BOUNCE_BPS)) return [];
  peak = null;
  armed = false;
  const room = state.weightRoom(symbol);
  const spend = state.cash < room ? state.cash : room;
  if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function sell(state: BarsState, qty: bigint, cost: bigint): OrderInput[] {
  const last = closes[closes.length - 1]!;
  if (peak === null || last > peak) peak = last;
  const value = state.value(symbol, qty);
  if (value * BPS >= cost * (BPS + TP_BPS)) armed = true;
  const stopped = value * BPS <= cost * (BPS - STOP_BPS);
  const take = !armed && value * BPS >= cost * (BPS + TP_BPS);
  const trailed = armed && last * BPS <= peak * (BPS - TRAIL_BPS);
  if (!stopped && !take && !trailed) return [];
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
      peak = null;
      armed = false;
      if (cool > 0) cool -= 1;
      if (!saw) return [];
      return buy(state);
    }
    if (!saw || closes.length === 0) return [];
    return sell(state, held.qty, held.cost);
  },
});
