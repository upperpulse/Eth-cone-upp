// ═══════════════════════════════════════════════════════════
//  ETH TURTLE PRO v1.0 — Turtle Trend-Following
//  Strategy: D40 breakout + trail ATR×3 + exit Donchian20
//  พิสูจน์แล้ว: 4.3 ปี +$241, 4/4 ปีกำไร, ผ่าน OOS, ชนะ B&H +$338
//  ⚠️ PAPER MODE — ยังไม่ส่ง order จริง (พิสูจน์ก่อน)
// ═══════════════════════════════════════════════════════════

const BOT_VERSION = 'v1.0';
const fs   = require('fs');
const http = require('http');
// Binance live module (ปิดไว้ default — paper)
let live;
try { live = require('./binance-live.js'); }
catch (e) { live = { isEnabled: () => false, modeLabel: () => 'PAPER', openLive: async()=>({}), closeLive: async()=>({}), trailStopLive: async()=>({}), setLeverage: async()=>{}, getPositionLive: async()=>null }; }

const BOT_TOKEN = process.env.TG_TOKEN || '';
const CHAT_ID   = process.env.TG_CHAT  || '';
const BINANCE   = 'https://fapi.binance.com';
const STATE_FILE  = '/home/ubuntu/eth-bot/donchian_state.json';
const TRADES_FILE = '/home/ubuntu/eth-bot/donchian_trades.json';
const SIGNAL_LOG  = '/home/ubuntu/eth-bot/donchian_signals.csv';   // ทุกการเช็ค (วิเคราะห์ภายหลัง)
const EQUITY_LOG  = '/home/ubuntu/eth-bot/donchian_equity.csv';    // equity snapshot รายวัน
const TRADE_CSV   = '/home/ubuntu/eth-bot/donchian_trades.csv';    // trade log อ่านง่าย
const ML_LOG      = '/home/ubuntu/eth-bot/turtle_ml.jsonl';        // ML dataset (feature+ผล สำหรับ train model)

// ── STRATEGY PARAMETERS (พิสูจน์จาก backtest 4.3 ปี) ──
const SYMBOL        = 'ETHUSDT';
const ENTRY_PERIOD  = 40;      // Donchian breakout (high/low 40 แท่ง)
const EXIT_PERIOD   = 20;      // Donchian exit ตรงข้าม (Turtle classic)
const TRAIL_ATR     = 3.0;     // trailing stop = ATR×3 (let winner run)
const ATR_PERIOD    = 14;
const TIMEFRAME     = '1h';

// ── RISK MANAGEMENT (สำคัญสำหรับ edge บาง Kelly 3%) ──
const ACCOUNT_SIZE     = 1000;   // ทุนจำลอง $1000
const RISK_PER_TRADE   = 0.02;   // เสี่ยง 2%/trade = $20 (Kelly-safe)
const LEVERAGE         = 3;      // เท่ากับ backtest
const MAX_DRAWDOWN_PCT = 0.30;   // หยุดถ้า DD เกิน 30% (Donchian DD ธรรมชาติ ~20%)
const FEE              = 0.0004;
const SLIP             = 0.0002;

// ── STATE ──
let position = null;     // { dir, entry, sl, peak, qty, bars, entryTs, entryHigh40, entryLow40 }
let trades = [];
let accountEquity = ACCOUNT_SIZE;
let peakEquity = ACCOUNT_SIZE;
let halted = false;      // max drawdown stop
let lastUpdateId = 0;

// ═══════════════ HELPERS ═══════════════
async function fetchKlines(limit) {
  const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${SYMBOL}&interval=${TIMEFRAME}&limit=${limit}`);
  return r.json();
}
async function fetchPrice() {
  const r = await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  const d = await r.json();
  return parseFloat(d.price);
}
function calcATR(kl, p = ATR_PERIOD) {
  if (kl.length < p + 1) return 0;
  let s = 0;
  for (let i = kl.length - p; i < kl.length; i++) {
    const h = +kl[i][2], l = +kl[i][3], pc = +kl[i-1][4];
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / p;
}
// ── ML feature indicators (เก็บไว้ train model อนาคต) ──
function calcRSI(cls, p = 14) {
  if (cls.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = cls.length - p; i < cls.length; i++) {
    const ch = cls[i] - cls[i-1];
    if (ch > 0) g += ch; else l -= ch;
  }
  const rs = g / (l || 1);
  return 100 - 100 / (1 + rs);
}
function calcOBVSlope(kl, lookback = 20) {
  if (kl.length < lookback + 1) return 0;
  let obv = 0; const series = [];
  for (let i = kl.length - lookback; i < kl.length; i++) {
    const ch = +kl[i][4] - +kl[i-1][4];
    obv += ch > 0 ? +kl[i][5] : ch < 0 ? -kl[i][5] : 0;
    series.push(obv);
  }
  return series.length > 1 ? (series[series.length-1] - series[0]) / series.length : 0;
}
function f(n) { return n.toFixed(2); }

async function tg(msg) {
  if (!BOT_TOKEN) { console.log('[TG-off]', msg.slice(0,80)); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    const d = await r.json();
    if (d.ok) console.log('📲 TG:', msg.slice(0, 60));
  } catch (e) { console.error('TG:', e.message); }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ position, accountEquity, peakEquity, halted }));
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades));
  } catch (e) { console.error('save:', e.message); }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE));
      position = s.position; accountEquity = s.accountEquity ?? ACCOUNT_SIZE;
      peakEquity = s.peakEquity ?? ACCOUNT_SIZE; halted = s.halted ?? false;
    }
    if (fs.existsSync(TRADES_FILE)) trades = JSON.parse(fs.readFileSync(TRADES_FILE));
  } catch (e) { console.error('load:', e.message); }
}

// ═══════════════ POSITION SIZING ═══════════════
// risk-based: qty คำนวณจาก "ระยะ SL" ให้ขาดทุน = RISK_PER_TRADE
function calcPositionSize(entry, sl) {
  const riskAmount = accountEquity * RISK_PER_TRADE;   // $ ที่ยอมเสีย
  const slDistance = Math.abs(entry - sl);             // ระยะถึง SL
  if (slDistance <= 0) return 0;
  let qty = riskAmount / slDistance;                   // qty ที่ทำให้เสีย = riskAmount
  // จำกัดไม่ให้ notional เกิน account × leverage
  const maxQty = (accountEquity * LEVERAGE) / entry;
  return Math.min(qty, maxQty);
}

// ═══════════════ CORE STRATEGY LOOP ═══════════════
// ═══════════════ POSITION REPORT (ระหว่างถือ) ═══════════════
function buildPositionReport(price) {
  if (!position) return '📍 FLAT — รอ signal (ETH break D40)';
  const { dir, entry, sl, peak, qty, entryTs } = position;
  const floatPnl = dir === 'long' ? (price - entry) * qty : (entry - price) * qty;
  const heldH = Math.round((Date.now() - entryTs) / 3600000);
  const slDist = Math.abs(price - sl);
  const locked = dir === 'long' ? (sl > entry) : (sl < entry);   // SL ล็อกกำไรแล้วมั้ย
  const emoji = floatPnl >= 0 ? '🟢' : '🔴';
  return `${emoji} <b>${dir.toUpperCase()} กำลังถือ</b>\n\n` +
    `Entry $${f(entry)} → ตอนนี้ $${f(price)}\n` +
    `กำไรลอย: $${f(floatPnl)} ${floatPnl>=0?'✅':''}\n` +
    `ถือ: ${heldH}h | peak $${f(peak)}\n` +
    `SL $${f(sl)} (ห่าง $${f(slDist)}) ${locked ? '🔒 ล็อกกำไรแล้ว' : ''}\n` +
    `Equity $${f(accountEquity)}`;
}

let lastReportTs = 0;
let lastSLForReport = 0;
async function maybePositionReport(price) {
  if (!position) return;
  const now = Date.now();
  const hoursSince = (now - lastReportTs) / 3600000;
  // แจ้งเมื่อ: ทุก 6 ชม. หรือ SL ขยับ (trail ล็อกกำไรเพิ่ม)
  const slMoved = lastSLForReport && Math.abs(position.sl - lastSLForReport) > 0.01;
  if (hoursSince >= 6 || slMoved) {
    await tg(buildPositionReport(price) + (slMoved ? '\n\n🔄 SL ขยับ (trail ตามกำไร)' : ''));
    lastReportTs = now;
    lastSLForReport = position.sl;
  }
}

// ═══════════════ POSITION REPORT END ═══════════════
async function checkSignal() {
  if (halted) return;
  logEquitySnapshot();   // snapshot รายวัน (วิเคราะห์ drawdown ภายหลัง)

  let kl;
  try { kl = await fetchKlines(ENTRY_PERIOD + ATR_PERIOD + 5); }
  catch (e) { console.error('fetch:', e.message); return; }
  if (!Array.isArray(kl) || kl.length < ENTRY_PERIOD + 2) return;

  const cls = kl.map(k => +k[4]);
  const price = cls[cls.length - 1];
  const atr = calcATR(kl);
  if (atr <= 0) return;

  // Donchian channels (ไม่รวมแท่งปัจจุบัน)
  const recent = cls.slice(-ENTRY_PERIOD - 1, -1);
  const entryHigh = Math.max(...recent);
  const entryLow  = Math.min(...recent);
  const exitRecent = cls.slice(-EXIT_PERIOD - 1, -1);
  const exitHigh = Math.max(...exitRecent);
  const exitLow  = Math.min(...exitRecent);

  // อัพเดต cache สำหรับ /dashboard (ราคา + channel + history)
  dashCache = {
    price,
    channel: {
      upper: +entryHigh.toFixed(2), lower: +entryLow.toFixed(2),
      exit20Hi: +exitHigh.toFixed(2), exit20Lo: +exitLow.toFixed(2),
      price: +price.toFixed(2),
      history: cls.slice(-12).map(c => +c.toFixed(2))
    },
    updatedAt: Date.now()
  };

  const ts = new Date().toISOString().slice(11, 19);

  // ───────── มี position: จัดการ exit/trail ─────────
  if (position) {
    // bars คำนวณจากเวลาจริงตอนปิด (ไม่นับทุก loop)
    let exitReason = null;
    let slMovedForLive = false;

    // track MAE (max adverse) — ราคาสวนทางสุด
    if (position.dir === 'long') {
      if (price < position.trough) position.trough = price;
      if (price > position.peak) position.peak = price;
      const newSL = position.peak - atr * TRAIL_ATR;
      if (newSL > position.sl) { position.sl = newSL; slMovedForLive = true; }
      if (price <= position.sl) exitReason = 'TRAIL_SL';
      else if (price < exitLow) exitReason = 'DONCHIAN_EXIT';
    } else {
      if (price > position.trough) position.trough = price;
      if (price < position.peak) position.peak = price;
      const newSL = position.peak + atr * TRAIL_ATR;
      if (newSL < position.sl) { position.sl = newSL; slMovedForLive = true; }
      if (price >= position.sl) exitReason = 'TRAIL_SL';
      else if (price > exitHigh) exitReason = 'DONCHIAN_EXIT';
    }

    // ── LIVE: ขยับ SL จริง (cancel เก่า + ตั้งใหม่) เมื่อ trail ขยับ ──
    if (live.isEnabled() && slMovedForLive && !exitReason) {
      const stopSide = position.dir === 'long' ? 'SELL' : 'BUY';
      try { await live.trailStopLive(stopSide, position.qty, position.sl); }
      catch (e) { console.error('[LIVE] trail:', e.message); }
    }

    const heldH = Math.round((Date.now() - position.entryTs) / 3600000);
    console.log(`[${ts}] $${f(price)} ${position.dir.toUpperCase()} | SL $${f(position.sl)} peak $${f(position.peak)} ${heldH}h`);

    if (exitReason) await closePosition(price, exitReason);
    else await maybePositionReport(price);   // report ระหว่างถือ (ทุก 6 ชม. + SL ขยับ)
    saveState();
    return;
  }

  // ───────── ไม่มี position: หา entry ─────────
  // ระยะถึง breakout (ดูว่าใกล้ trade มั้ย)
  const distToHigh = ((entryHigh - price) / price * 100);
  const distToLow  = ((price - entryLow) / price * 100);
  console.log(`[${ts}] $${f(price)} FLAT | D40 hi $${f(entryHigh)}(+${distToHigh.toFixed(1)}%) lo $${f(entryLow)}(-${distToLow.toFixed(1)}%) | ATR $${f(atr)}`);

  // Signal log (CSV) — เก็บทุกการเช็คเพื่อวิเคราะห์ภายหลัง
  logSignal(price, entryHigh, entryLow, atr, distToHigh, distToLow);

  if (price > entryHigh) {
    await openPosition('long', price, atr, kl, entryHigh, entryLow);
  } else if (price < entryLow) {
    await openPosition('short', price, atr, kl, entryHigh, entryLow);
  }
  saveState();
}

async function openPosition(dir, entry, atr, kl, entryHigh, entryLow) {
  const sl = dir === 'long' ? entry - atr * TRAIL_ATR : entry + atr * TRAIL_ATR;
  const qty = calcPositionSize(entry, sl);
  if (qty <= 0) return;

  // ML features ตอน entry (เก็บไว้ train model อนาคต)
  const cls = kl.map(k => +k[4]);
  const features = {
    rsi: +calcRSI(cls).toFixed(2),
    obvSlope: +calcOBVSlope(kl).toFixed(0),
    atrPct: +(atr / entry * 100).toFixed(3),       // ATR เป็น % ของราคา (volatility)
    breakoutStrength: +(Math.abs(entry - (dir==='long'?entryHigh:entryLow)) / atr).toFixed(3), // ทะลุแรงแค่ไหน (×ATR)
    channelWidth: +((entryHigh - entryLow) / entry * 100).toFixed(2), // กว้างของ channel (%)
    momentum: +((cls[cls.length-1] - cls[cls.length-6]) / cls[cls.length-6] * 100).toFixed(2) // momentum 5 แท่ง
  };

  const riskAmt = Math.abs(entry - sl) * qty;
  position = { dir, entry, sl, peak: entry, trough: entry, qty, bars: 0, atr,
    initialSL: sl, riskAmt, entryTs: Date.now(), features };

  // ── LIVE: ส่ง order จริง (ถ้าเปิด live mode) ──
  let liveInfo = '';
  if (live.isEnabled()) {
    const r = await live.openLive(dir, qty, sl);
    if (r.error) { liveInfo = `\n⚠️ LIVE error: ${r.error}`; }
    else if (!r.simulated) { liveInfo = `\n✅ LIVE order ส่งแล้ว (${live.modeLabel()})`; }
  }

  const notional = qty * entry;
  await tg(`🐢 <b>TURTLE PRO ENTRY — ${dir.toUpperCase()}</b>\n\n` +
    `Entry: $${f(entry)}\nSL: $${f(sl)} (ATR×${TRAIL_ATR})\n` +
    `Qty: ${qty.toFixed(4)} ETH ($${f(notional)})\n` +
    `Risk: $${f(riskAmt)} (${(RISK_PER_TRADE*100)}%)\n` +
    `Equity: $${f(accountEquity)}${liveInfo}`);
  console.log(`>>> ENTRY ${dir} @ $${f(entry)} SL $${f(sl)} qty ${qty.toFixed(4)} [${live.modeLabel()}]`);
}

async function closePosition(exit, reason) {
  const { dir, entry, qty, peak, trough, entryTs, riskAmt, atr } = position;
  const bars = Math.round((Date.now() - entryTs) / 3600000);  // ชั่วโมงจริง (แก้ bug นับทุก loop)
  const gross = dir === 'long' ? (exit - entry) * qty : (entry - exit) * qty;
  const fee = (entry + exit) * qty * (FEE + SLIP);
  const fundingCost = (qty * entry) * 0.0001 * (bars / 8);
  const pnl = gross - fee - fundingCost;

  accountEquity += pnl;
  if (accountEquity > peakEquity) peakEquity = accountEquity;

  // MFE = กำไรสูงสุดที่เคยถึง, MAE = ขาดทุนสูงสุดที่เคยเจอ
  const mfe = dir === 'long' ? (peak - entry) * qty : (entry - peak) * qty;
  const mae = dir === 'long' ? (trough - entry) * qty : (entry - trough) * qty;
  const rMultiple = riskAmt > 0 ? pnl / riskAmt : 0;   // กำไรเป็นกี่เท่าของความเสี่ยง
  const holdH = bars;

  const trade = {
    num: trades.length + 1, dir, entry: +entry.toFixed(2), exit: +exit.toFixed(2),
    qty: +qty.toFixed(4), pnl: +pnl.toFixed(2), reason, bars: holdH,
    mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), rMultiple: +rMultiple.toFixed(2),
    riskAmt: +riskAmt.toFixed(2), atr: +atr.toFixed(2),
    equity: +accountEquity.toFixed(2),
    entryTs, exitTs: Date.now()
  };
  trades.push(trade);
  logTradeCSV(trade);
  logML(position.features, trade);   // บันทึก ML (feature ตอนเข้า + ผลลัพธ์)

  // ── LIVE: ปิด order จริง (cancel SL + market close) ──
  if (live.isEnabled()) {
    try { await live.closeLive(dir, qty); } catch (e) { console.error('[LIVE] close:', e.message); }
  }

  const win = pnl > 0;
  const emoji = win ? '🟢' : '🔴';
  await tg(`${emoji} <b>TURTLE PRO EXIT — ${reason}</b>\n\n` +
    `${dir.toUpperCase()} $${f(entry)} → $${f(exit)}\n` +
    `PnL: $${f(pnl)} (${rMultiple > 0 ? '+' : ''}${rMultiple.toFixed(2)}R) ${win ? '✅' : ''}\n` +
    `ถือ: ${holdH} ชม. | MFE $${f(mfe)} MAE $${f(mae)}\n` +
    `Equity: $${f(accountEquity)} (peak $${f(peakEquity)})`);
  console.log(`<<< EXIT ${reason} pnl $${f(pnl)} (${rMultiple.toFixed(2)}R) equity $${f(accountEquity)}`);

  position = null;

  // ── Max Drawdown Stop ──
  const dd = (peakEquity - accountEquity) / peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    halted = true;
    await tg(`🛑 <b>MAX DRAWDOWN STOP</b>\n\nDD ${(dd*100).toFixed(1)}% เกินลิมิต ${(MAX_DRAWDOWN_PCT*100)}%\nหยุดเทรด — ต้อง review ก่อนเริ่มใหม่`);
    console.log('!!! HALTED — max drawdown');
  }
}

// ═══════════════ DETAILED LOGGING ═══════════════
function logSignal(price, hi, lo, atr, distHi, distLo) {
  try {
    if (!fs.existsSync(SIGNAL_LOG)) {
      fs.writeFileSync(SIGNAL_LOG, 'timestamp,price,d40_high,d40_low,atr,dist_to_high_pct,dist_to_low_pct,has_position\n');
    }
    const row = `${new Date().toISOString()},${price.toFixed(2)},${hi.toFixed(2)},${lo.toFixed(2)},${atr.toFixed(2)},${distHi.toFixed(2)},${distLo.toFixed(2)},${position ? 1 : 0}\n`;
    fs.appendFileSync(SIGNAL_LOG, row);
  } catch (e) {}
}

// ML dataset: feature ตอนเข้า + ผลลัพธ์ (สำหรับ train model อนาคต)
function logML(features, trade) {
  try {
    const record = {
      ts: new Date().toISOString(),
      dir: trade.dir,
      ...features,                          // rsi, obvSlope, atrPct, breakoutStrength, channelWidth, momentum
      pnl: trade.pnl,
      rMultiple: trade.rMultiple,
      win: trade.pnl > 0 ? 1 : 0,
      reason: trade.reason,
      holdHours: trade.bars,
      mfe: trade.mfe,
      mae: trade.mae
    };
    fs.appendFileSync(ML_LOG, JSON.stringify(record) + '\n');
  } catch (e) {}
}

function logTradeCSV(t) {
  try {
    if (!fs.existsSync(TRADE_CSV)) {
      fs.writeFileSync(TRADE_CSV, 'num,entry_time,exit_time,dir,entry,exit,qty,pnl,r_multiple,reason,hold_hours,mfe,mae,risk_amt,atr,equity\n');
    }
    const et = new Date(t.entryTs).toISOString();
    const xt = new Date(t.exitTs).toISOString();
    const row = `${t.num},${et},${xt},${t.dir},${t.entry},${t.exit},${t.qty},${t.pnl},${t.rMultiple},${t.reason},${t.bars},${t.mfe},${t.mae},${t.riskAmt},${t.atr},${t.equity}\n`;
    fs.appendFileSync(TRADE_CSV, row);
  } catch (e) {}
}

let lastEquityDay = '';
function logEquitySnapshot() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastEquityDay) return;   // วันละครั้ง
    lastEquityDay = day;
    if (!fs.existsSync(EQUITY_LOG)) {
      fs.writeFileSync(EQUITY_LOG, 'date,equity,peak,drawdown_pct,total_trades\n');
    }
    const dd = ((peakEquity - accountEquity) / peakEquity * 100).toFixed(2);
    fs.appendFileSync(EQUITY_LOG, `${day},${accountEquity.toFixed(2)},${peakEquity.toFixed(2)},${dd},${trades.length}\n`);
  } catch (e) {}
}

async function sendDailySummary() {
  const day = new Date().toISOString().slice(0, 10);
  const todayTrades = trades.filter(t => new Date(t.exitTs).toISOString().slice(0,10) === day);
  if (!todayTrades.length && !position) return;   // ไม่มีอะไรเกิด ไม่ต้องสรุป
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  const dd = ((peakEquity - accountEquity) / peakEquity * 100).toFixed(1);
  const pos = position ? `${position.dir.toUpperCase()} @ $${f(position.entry)} (ถือ ${Math.round((Date.now()-position.entryTs)/3600000)}h)` : 'FLAT';
  await tg(`📊 <b>Daily Summary ${day}</b>\n\n` +
    `Trades วันนี้: ${todayTrades.length} (PnL $${f(todayPnl)})\n` +
    `Equity: $${f(accountEquity)} | DD ${dd}%\n` +
    `Position: ${pos}\n` +
    `รวมทั้งหมด: ${trades.length} trades`);
}

// ═══════════════ STATS ═══════════════
function getStats() {
  if (!trades.length) return 'ยังไม่มี trade';
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const tot = trades.reduce((s, t) => s + t.pnl, 0);
  const aw = w.length ? w.reduce((s,t)=>s+t.pnl,0)/w.length : 0;
  const al = l.length ? Math.abs(l.reduce((s,t)=>s+t.pnl,0)/l.length) : 1;
  const wr = (w.length / trades.length * 100).toFixed(0);
  const payoff = (aw/al).toFixed(2);
  const W = w.length/trades.length, kelly = ((W - (1-W)/(aw/al))*100).toFixed(0);
  const avgR = (trades.reduce((s,t)=>s+(t.rMultiple||0),0)/trades.length).toFixed(2);
  const avgHold = (trades.reduce((s,t)=>s+t.bars,0)/trades.length).toFixed(0);
  const dd = ((peakEquity - accountEquity) / peakEquity * 100).toFixed(1);
  const ddMax = Math.max(...trades.map((_,i) => {
    let eq = ACCOUNT_SIZE, pk = ACCOUNT_SIZE, mdd = 0;
    for (let j = 0; j <= i; j++) { eq = trades[j].equity; if (eq > pk) pk = eq; if ((pk-eq)/pk > mdd) mdd = (pk-eq)/pk; }
    return mdd * 100;
  })).toFixed(1);
  return `รวม ${trades.length} | WR ${wr}% | PnL $${f(tot)}\n` +
    `Payoff ${payoff} | Kelly ${kelly}% | Avg ${avgR}R\n` +
    `ถือเฉลี่ย ${avgHold}h | DD ${dd}% (max ${ddMax}%)\n` +
    `Equity $${f(accountEquity)} (เริ่ม $${ACCOUNT_SIZE}, ${((accountEquity/ACCOUNT_SIZE-1)*100).toFixed(1)}%)`;
}

// ═══════════════ TELEGRAM COMMANDS ═══════════════
async function pollTelegram() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=5`);
    const d = await r.json();
    if (!d.ok) return;
    for (const u of d.result) {
      lastUpdateId = u.update_id;
      const text = (u.message?.text || '').trim().toLowerCase();
      if (text === '/stats' || text === '/status') {
        const pos = position ? `\n\n📍 Position: ${position.dir.toUpperCase()} @ $${f(position.entry)} SL $${f(position.sl)}` : '\n\n📍 FLAT (รอ signal)';
        await tg(`🐢 <b>ETH Turtle Pro ${BOT_VERSION}</b>\n\n${getStats()}${pos}${halted ? '\n\n🛑 HALTED (max DD)' : ''}`);
      } else if (text === '/position' || text === '/pos') {
        // ดูสถานะ position ปัจจุบัน (กำไรลอย real-time)
        let price = position ? position.entry : 0;
        try { price = await fetchPrice(); } catch {}
        await tg(buildPositionReport(price));
      } else if (text === '/resume' && halted) {
        halted = false; peakEquity = accountEquity;
        await tg('▶️ Resume — เริ่มเทรดใหม่ (reset peak)');
        saveState();
      } else if (text === '/reset') {
        position = null; trades = []; accountEquity = ACCOUNT_SIZE; peakEquity = ACCOUNT_SIZE; halted = false;
        await tg('🔄 Reset — เริ่มใหม่ทั้งหมด');
        saveState();
      }
    }
  } catch (e) {}
}

// ═══════════════ HTTP SERVER ═══════════════
const PORT = process.env.DONCHIAN_PORT || 3100;

// cache ราคา+channel ล่าสุด (อัพเดตทุก checkSignal)
let dashCache = { price: 0, channel: null, updatedAt: 0 };

function buildDashboardData() {
  // stats
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const tot = trades.reduce((s, t) => s + t.pnl, 0);
  const aw = w.length ? w.reduce((s,t)=>s+t.pnl,0)/w.length : 0;
  const al = l.length ? Math.abs(l.reduce((s,t)=>s+t.pnl,0)/l.length) : 1;
  const W = trades.length ? w.length/trades.length : 0;
  const payoff = al ? aw/al : 0;
  const kelly = payoff ? (W - (1-W)/payoff)*100 : null;
  const avgR = trades.length ? trades.reduce((s,t)=>s+(t.rMultiple||0),0)/trades.length : 0;
  let eq = ACCOUNT_SIZE, pk = ACCOUNT_SIZE, mdd = 0;
  trades.forEach(t => { eq = t.equity; if (eq>pk) pk=eq; if ((pk-eq)/pk>mdd) mdd=(pk-eq)/pk; });
  const curDD = (peakEquity - accountEquity) / peakEquity * 100;

  // floating pnl ของ position ปัจจุบัน
  let posData = null;
  if (position) {
    const price = dashCache.price || position.entry;
    const floatPnl = position.dir==='long' ? (price-position.entry)*position.qty : (position.entry-price)*position.qty;
    const heldH = Math.round((Date.now() - position.entryTs)/3600000);
    const locked = position.dir==='long' ? position.sl>position.entry : position.sl<position.entry;
    const lockedPnl = locked ? (position.dir==='long' ? (position.sl-position.entry)*position.qty : (position.entry-position.sl)*position.qty) : 0;
    posData = {
      dir: position.dir, entry: position.entry, price, sl: position.sl, peak: position.peak,
      qty: position.qty, heldH, floatPnl: +floatPnl.toFixed(2), lockedPnl: +lockedPnl.toFixed(2),
      features: position.features || null
    };
  }

  return {
    mode: 'paper',
    version: BOT_VERSION,
    equity: +accountEquity.toFixed(2),
    start: ACCOUNT_SIZE,
    peakEquity: +peakEquity.toFixed(2),
    halted,
    position: posData,
    stats: {
      wr: trades.length ? Math.round(W*100) : 0,
      kelly: kelly==null ? null : Math.round(kelly),
      payoff: +payoff.toFixed(2),
      avgR: +avgR.toFixed(2),
      maxDD: +Math.max(mdd*100, curDD).toFixed(1),
      trades: trades.length
    },
    trades: trades.map(t => ({
      n: t.num, dir: t.dir, entry: t.entry, exit: t.exit,
      pnl: t.pnl, r: t.rMultiple, reason: t.reason==='DONCHIAN_EXIT'?'DONCHIAN':'TRAIL_SL',
      held: t.bars, mfe: t.mfe
    })),
    channel: dashCache.channel,
    updatedAt: dashCache.updatedAt
  };
}

http.createServer((req, res) => {
  // CORS — ให้ dashboard (GitHub Pages) เรียกได้
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'ngrok-skip-browser-warning, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url.split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: BOT_VERSION, equity: accountEquity, trades: trades.length,
      position: position ? position.dir : null, halted
    }));
  } else if (req.url.split('?')[0] === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDashboardData()));
  } else { res.writeHead(404); res.end(); }
}).listen(PORT, () => console.log(`ETH Turtle Pro server :${PORT} (/health /dashboard)`));

// ═══════════════ STARTUP ═══════════════
loadState();
console.log(`🐢 ETH Turtle Pro ${BOT_VERSION} — D${ENTRY_PERIOD}/exit${EXIT_PERIOD}/trail${TRAIL_ATR}`);
console.log(`Risk ${RISK_PER_TRADE*100}%/trade | MaxDD ${MAX_DRAWDOWN_PCT*100}% | Equity $${accountEquity} | Mode: ${live.modeLabel()}`);
// ตั้ง leverage ถ้า live
if (live.isEnabled()) { live.setLeverage(); }
const modeWarning = live.isEnabled()
  ? `\n\n🔴 <b>LIVE MODE: ${live.modeLabel()}</b> — ส่ง order จริง!`
  : `\n\n⚠️ PAPER MODE (ยังไม่ส่ง order จริง)`;
tg(`🐢 <b>ETH Turtle Pro ${BOT_VERSION} เริ่มทำงาน</b>\n\nStrategy: D40 breakout + trail ATR×3 + exit D20\nRisk: ${RISK_PER_TRADE*100}%/trade | MaxDD ${MAX_DRAWDOWN_PCT*100}%\nEquity: $${accountEquity}${modeWarning}`);

// loop ทุก 5 นาที (1h timeframe — เช็คถี่กว่าเพื่อจับ breakout ทันที)
checkSignal();
setInterval(checkSignal, 5 * 60 * 1000);
setInterval(pollTelegram, 3000);
setInterval(saveState, 60 * 1000);

// Daily summary ทุกวัน 20:00 (เวลาไทย ~13:00 UTC)
let lastSummaryDay = '';
setInterval(async () => {
  const now = new Date();
  const utcH = now.getUTCHours();
  const day = now.toISOString().slice(0, 10);
  if (utcH === 13 && day !== lastSummaryDay) {   // 13 UTC = 20:00 ไทย
    lastSummaryDay = day;
    await sendDailySummary();
  }
}, 5 * 60 * 1000);
