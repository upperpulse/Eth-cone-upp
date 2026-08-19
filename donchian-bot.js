require('dotenv').config();  // โหลด .env (TG token + Binance testnet key)
// ═══════════════════════════════════════════════════════════
//  TURTLE PRO v2.0 — Multi-Market Trend-Following
//  Markets: ETH + SOL (parameter แยกต่อเหรียญ, equity แชร์กัน)
//  พิสูจน์ 5.14 ปี: ETH+SOL $2,076 (207%), DD 25.1%, walk-forward 5/5
//  ⚠️ PAPER MODE — ยังไม่ส่ง order จริง
// ═══════════════════════════════════════════════════════════

const BOT_VERSION = 'v5.6';
const fs   = require('fs');
const http = require('http');
let live;
try { live = require('./binance-live.js'); }
catch (e) { live = { isEnabled: () => false, modeLabel: () => 'PAPER', openLive: async()=>({}), closeLive: async()=>({}), trailStopLive: async()=>({}), setLeverage: async()=>{}, getPositionLive: async()=>null }; }

const BOT_TOKEN = process.env.TG_TOKEN || '';
const CHAT_ID   = process.env.TG_CHAT  || '';
const BINANCE   = 'https://fapi.binance.com';
const DIR         = '/root/eth-bot';
const STATE_FILE  = DIR + '/donchian_state.json';
const TRADES_FILE = DIR + '/donchian_trades.json';
const SIGNAL_LOG  = DIR + '/donchian_signals.csv';
const EQUITY_LOG  = DIR + '/donchian_equity.csv';
const TRADE_CSV   = DIR + '/donchian_trades.csv';
const ML_LOG      = DIR + '/turtle_ml.jsonl';
const ERROR_LOG   = DIR + '/bot_errors.jsonl';
let analyzer;
try { analyzer = require('./analyzer.js'); }
catch (e) { analyzer = null; }

let aiReport;
try { aiReport = require('./ai-report.js'); }
catch (e) { aiReport = { isEnabled: () => false, buildDailyReport: async () => null }; }

const CSV_HEADER  = 'num,symbol,entry_time,exit_time,dir,entry,exit,qty,pnl,r_multiple,reason,hold_hours,mfe,mae,risk_amt,atr,equity,mode,entry_fill,exit_fill,slip_entry_bps,slip_exit_bps,fee_live,fee_estimate,pnl_live,pnl_estimate,pnl_source,funding_live,funding_count,funding_estimate,trail_moves,be_bar,mae_r,mae_pct_equity,mfe_r,fill_latency_ms,entry_fills,sl_placed,efficiency_ratio,peak_bar,trough_bar\n';

// ══════════════════════════════════════════════════════════
//  MARKETS — parameter แยกต่อเหรียญ (เพิ่ม/ลบเหรียญได้ที่นี่)
//  ค่าทั้งหมดผ่าน backtest 5.14 ปี + OOS + walk-forward
// ══════════════════════════════════════════════════════════
const MARKETS = {
  ETHUSDT: {
    label: 'ETH',
    enabled: true,
    entryPeriod: 40,      // Donchian breakout
    exitPeriod: 30,       // Donchian exit (D30 > D20: $317→$382)
    trailATR: 3.5,        // trailing stop ×ATR
    breakevenAtR: 1.0,    // ลอยถึง +1R → SL ไป entry
    atrPeriod: 14,
    qtyPrecision: 3,      // ทศนิยม qty ที่ Binance รับ (ต้องตรง ไม่งั้นบัญชีเพี้ยน)
    timeframe: '1h'
  },
  SOLUSDT: {
    label: 'SOL',
    enabled: true,
    entryPeriod: 40,
    exitPeriod: 30,       // SOL: D30 $1,395 | OOS $402 | wf 5/5
    trailATR: 3.5,
    breakevenAtR: 1.0,
    atrPeriod: 14,
    qtyPrecision: 0,      // SOL รับจำนวนเต็มเท่านั้น
    timeframe: '1h'
  }
};
const SYMBOLS = Object.keys(MARKETS).filter(s => MARKETS[s].enabled);

// ── RISK (แชร์ทั้งพอร์ต) ──
const ACCOUNT_SIZE     = 1000;
const RISK_PER_TRADE   = 0.009;  // 0.90% ของ equity รวม ต่อ trade
const LEVERAGE         = 3;
const MAX_DRAWDOWN_PCT = 0.30;
const MAX_OPEN_POSITIONS = 2;    // เปิดพร้อมกันได้กี่ไม้ (= จำนวนตลาด)
const MIN_NOTIONAL     = 5;      // มูลค่าขั้นต่ำที่ Binance รับ (USDT)
const REENTRY_COOLDOWN_BARS = 1; // หลังปิดไม้ ต้องรอกี่ชั่วโมงก่อนเข้าใหม่ (กัน whipsaw)
const FEE              = 0.0004;
const SLIP             = 0.0002;

// ── STATE (position แยกต่อเหรียญ, equity/trades รวม) ──
let positions = {};           // { ETHUSDT: {...} | null, SOLUSDT: {...} | null }
SYMBOLS.forEach(s => positions[s] = null);
let trades = [];              // ทุกเหรียญรวมกัน (มี field .symbol)
let accountEquity = ACCOUNT_SIZE;
let startEquity = ACCOUNT_SIZE;   // ทุนเริ่มต้นจริง (sync จาก exchange) — ใช้คิด % ผลตอบแทน
let peakEquity = ACCOUNT_SIZE;
let halted = false;
let lastUpdateId = 0;
const lastExitTs = {};   // เวลาปิดไม้ล่าสุดต่อเหรียญ (ใช้กับ cooldown)

// ═══════════════ HELPERS ═══════════════
async function fetchKlines(symbol, limit) {
  const cfg = MARKETS[symbol];
  const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${cfg.timeframe}&limit=${limit}`);
  return r.json();
}
async function fetchPrice(symbol) {
  const r = await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=${symbol}`);
  const d = await r.json();
  return parseFloat(d.price);
}
function calcATR(kl, p = 14) {
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

// ── เวลาไทย (UTC+7) สำหรับ log ที่คนอ่าน — CSV/ML ยังเป็น UTC ISO ตามมาตรฐานวิเคราะห์ ──
const TZ_OFFSET_H = 7;
function thNow() { return new Date(Date.now() + TZ_OFFSET_H * 3600000); }
function thTime() { return thNow().toISOString().slice(11, 19); }                                  // HH:MM:SS ไทย
function thDate(ts) { return new Date((ts || Date.now()) + TZ_OFFSET_H * 3600000).toISOString().slice(0, 10); }

// ══════════════════════════════════════════════════════════
//  ระบบเฝ้าระวังปัญหา (HEALTH MONITOR)
//  จับทุกอย่างที่ผิดพลาดระหว่างรัน + แจ้งเตือนตามความรุนแรง
// ══════════════════════════════════════════════════════════
const health = {
  apiFailStreak: 0,        // klines ล้มติดกันกี่ครั้ง
  lastApiOk: Date.now(),
  orderErrors: 0,          // ส่ง order ไม่ผ่าน (สะสม)
  closeErrors: 0,          // ปิดไม่ออก (สะสม)
  slErrors: 0,             // วาง SL ไม่ผ่าน
  desyncAlerts: 0,         // bot กับ exchange ไม่ตรงกัน
  rateLimitHits: 0,        // โดน rate limit สะสม (reset เมื่อ API ปกติ)
  rateLimitTotal: 0,       // นับรวมไม่รีเซ็ต — ดูแนวโน้มระยะยาว
  lastRateLimitAt: null,   // ครั้งล่าสุดเมื่อไหร่
  backoffUntil: 0,         // พัก reconcile ถึงเมื่อไหร่
  slClosedCount: 0,
  lastError: null,
  alerted: {}              // กันสแปม: เตือนเรื่องเดิมซ้ำ
};

// severity: 'info' | 'warn' | 'critical'
async function logError(severity, kind, symbol, message, extra = {}) {
  const rec = {
    ts: new Date().toISOString(),
    tsLocal: thDate() + ' ' + thTime(),
    severity, kind, symbol: symbol || null,
    message: String(message).slice(0, 300),
    ...extra
  };
  health.lastError = rec;
  try { fs.appendFileSync(ERROR_LOG, JSON.stringify(rec) + '\n'); } catch (e) {}
  const tag = severity === 'critical' ? '🔴' : severity === 'warn' ? '⚠️' : 'ℹ️';
  console.error(`${tag} [${kind}] ${symbol || ''} ${rec.message}`);

  // critical → แจ้ง Telegram ทันที (กันสแปม 30 นาที/เรื่อง)
  if (severity === 'critical') {
    const key = kind + (symbol || '');
    const now = Date.now();
    if (!health.alerted[key] || now - health.alerted[key] > 30 * 60 * 1000) {
      health.alerted[key] = now;
      await tg(`🔴 <b>ปัญหาร้ายแรง: ${kind}</b>\n${symbol ? symbol + '\n' : ''}${rec.message}`);
    }
  }
}

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

// ── ส่งไฟล์เข้า Telegram (sendDocument) ──
async function tgDocument(filename, content, caption='') {
  if (!BOT_TOKEN) { console.log('[TG-off] doc', filename); return; }
  try {
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: 'text/csv' }), filename);
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
    const d = await r.json();
    if (d.ok) console.log('📎 TG doc:', filename);
    else console.error('TG doc:', JSON.stringify(d).slice(0,120));
  } catch (e) { console.error('TG doc:', e.message); }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 2, positions, accountEquity, startEquity, peakEquity, halted }));
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades));
  } catch (e) { console.error('save:', e.message); }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const st = JSON.parse(fs.readFileSync(STATE_FILE));
      accountEquity = st.accountEquity ?? ACCOUNT_SIZE;
      startEquity = st.startEquity ?? st.accountEquity ?? ACCOUNT_SIZE;
      peakEquity = st.peakEquity ?? ACCOUNT_SIZE;
      halted = st.halted ?? false;
      if (st.positions) {                       // v2 format
        SYMBOLS.forEach(sym => positions[sym] = st.positions[sym] ?? null);
      } else if (st.position) {                 // v1 format → migrate (position เดิม = ETHUSDT)
        positions['ETHUSDT'] = st.position;
        console.log('[migrate] แปลง state v1 → v2 (position เดิม = ETHUSDT)');
      }
    }
    if (fs.existsSync(TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(TRADES_FILE));
      // trade เก่าไม่มี symbol → เติมเป็น ETHUSDT (ข้อมูล 19 trades ไม่หาย)
      let migrated = 0;
      trades.forEach(t => { if (!t.symbol) { t.symbol = 'ETHUSDT'; migrated++; } });
      if (migrated) console.log(`[migrate] เติม symbol=ETHUSDT ให้ ${migrated} trades เก่า`);
    }
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
function buildPositionReport(symbol, price) {
  const position = positions[symbol];
  const cfg = MARKETS[symbol];
  if (!position) return `📍 ${cfg.label} FLAT — รอ signal (break D${cfg.entryPeriod})`;
  const { dir, entry, sl, peak, qty, entryTs } = position;
  // ใช้ราคา fill จริงเป็นฐานทุกการคำนวณ (ไม่งั้นกำไรลอยกับ BE คิดคนละฐาน)
  const base = position.liveEntryFill ?? entry;
  const floatPnl = dir === 'long' ? (price - base) * qty : (base - price) * qty;
  const heldH = Math.round((Date.now() - entryTs) / 3600000);
  const slDist = Math.abs(price - sl);
  const locked = dir === 'long' ? (sl > base) : (sl < base);
  const lockedGross = dir === 'long' ? (sl - base) * qty : (base - sl) * qty;
  const lockedNet = lockedGross - (base + sl) * qty * (FEE + SLIP);
  const emoji = floatPnl >= 0 ? '🟢' : '🔴';
  const curR = position.riskAmt > 0 ? floatPnl / position.riskAmt : 0;
  let beLine = '';
  if (cfg.breakevenAtR > 0) {
    if (position.beDone) {
      beLine = lockedNet > 0.01
        ? `🛡 SL เลยจุดเข้าแล้ว — ปิดตอนนี้ได้อย่างน้อย $${f(lockedNet)}\n`
        : `🛡 ล็อกทุนแล้ว — SL อยู่ที่จุดเข้า ปิดแล้วได้ ~$0\n   (ไม่ใช่กำไรลอย $${f(floatPnl)} ที่เห็น)\n`;
    }
    else if (curR > 0) beLine = `🛡 ล็อกทุนที่ +${cfg.breakevenAtR}R (ตอนนี้ ${curR.toFixed(2)}R)\n`;
  }
  return `${emoji} <b>${cfg.label} ${dir.toUpperCase()} กำลังถือ</b>\n\n` +
    `Entry $${f(base)}${position.liveEntryFill != null && Math.abs(base - entry) > 0.0001 ? ` <i>(สัญญาณ $${f(entry)})</i>` : ''} → ตอนนี้ $${f(price)}\n` +
    `กำไรลอย: $${f(floatPnl)} ${floatPnl>=0?'✅':''}\n` +
    `ถือ: ${heldH}h | peak $${f(peak)}\n` +
    `SL $${f(sl)} (ห่าง $${f(slDist)})\n` +
    beLine +
    `Equity รวม $${f(accountEquity)}`;
}

// สรุปทุกตลาดในข้อความเดียว
function buildAllPositionsReport(prices) {
  const open = SYMBOLS.filter(s => positions[s]);
  if (!open.length) return `📍 FLAT ทุกตลาด (${SYMBOLS.map(s=>MARKETS[s].label).join(', ')})\nEquity $${f(accountEquity)}`;
  let totalFloat = 0;
  const lines = open.map(sym => {
    const p = positions[sym], px = prices[sym] ?? p.entry;
    const fl = p.dir === 'long' ? (px - p.entry) * p.qty : (p.entry - px) * p.qty;
    totalFloat += fl;
    const heldH = Math.round((Date.now() - p.entryTs) / 3600000);
    return `${fl>=0?'🟢':'🔴'} <b>${MARKETS[sym].label}</b> ${p.dir.toUpperCase()} $${f(p.entry)} → $${f(px)}\n` +
           `   ลอย $${f(fl)} | ${heldH}h | SL $${f(p.sl)}${p.beDone?' 🛡':''}`;
  });
  return `📊 <b>POSITIONS (${open.length}/${SYMBOLS.length})</b>\n\n` + lines.join('\n') +
         `\n\nกำไรลอยรวม: $${f(totalFloat)}\nEquity $${f(accountEquity)}`;
}

let lastReportTs = {};
let lastSLForReport = {};
async function maybePositionReport(symbol, price) {
  const position = positions[symbol];
  if (!position) return;
  const now = Date.now();
  const hoursSince = (now - (lastReportTs[symbol] || 0)) / 3600000;
  const slMoved = lastSLForReport[symbol] && Math.abs(position.sl - lastSLForReport[symbol]) > 0.01;
  if (hoursSince >= 6 || slMoved) {
    await tg(buildPositionReport(symbol, price) + (slMoved ? '\n\n🔄 SL ขยับ (trail ตามกำไร)' : ''));
    lastReportTs[symbol] = now;
    lastSLForReport[symbol] = position.sl;
  }
}

// ═══════════════ POSITION REPORT END ═══════════════
// เช็คทุกตลาด (เรียกจาก loop หลัก)
// ══════════════════════════════════════════════════════════
//  ตรวจสอบว่า bot ตรงกับ Binance มั้ย (จับ position ผี/ตกค้าง)
//  เรียกทุก 15 นาที — เจอไม่ตรงเมื่อไหร่แจ้งทันที
// ══════════════════════════════════════════════════════════
let reconcileBackoffUntil = 0;
async function reconcile() {
  if (!live.isEnabled() || !live.getPositionLive) return;
  // โดน rate limit → พักยาว (เรียกถี่ยิ่งโดนหนัก)
  if (Date.now() < reconcileBackoffUntil) return;


  // ── ตรวจ equity บอท vs balance จริง (ตัวเลขเพี้ยน = risk sizing ผิดทุกไม้) ──
  // แยกเป็นบล็อกของตัวเอง — ห้าม return ออกจาก reconcile เพราะยังต้องตรวจ position/SL ต่อ
  if (live.testConnection) {
    try {
      const conn = await live.testConnection(5 * 60 * 1000);   // cache 5 นาที ลด API call
      if (conn.ok && conn.balance > 0) {
        const flat = SYMBOLS.every(s2 => !positions[s2]);
        // ⚠️ Binance walletBalance = ยอด realized แล้ว "ไม่รวม" กำไรลอยอยู่แล้ว
        // เดิมเอาไปลบกำไรลอยอีก = หัก 2 ครั้ง → drift ปลอม ($13 กลายเป็น $104)
        // accountEquity ของบอทก็เป็น realized เหมือนกัน → เทียบตรงๆ ได้เลย
        const drift = conn.balance - accountEquity;
        const driftPct = Math.abs(drift) / conn.balance * 100;
        const now = Date.now();
        if (driftPct > 1.5 && now - (health.lastDriftAlert || 0) > 3600000) {
          health.lastDriftAlert = now;
          await logError(driftPct > 4 ? 'critical' : 'warn', 'EQUITY_DRIFT', null,
            `equity bot $${f(accountEquity)} vs walletBalance $${f(conn.balance)} — ต่าง $${f(drift)} (${driftPct.toFixed(2)}%)` +
            (flat ? '' : ' [ยังถือ position — fee ของไม้ที่เปิดค้างยังไม่ถูกบันทึกในบอท]'),
            { bot: +accountEquity.toFixed(2), walletBalance: conn.balance,
              drift: +drift.toFixed(2), driftPct: +driftPct.toFixed(3), flat });
          if (flat) {
            const old = accountEquity;
            accountEquity = conn.balance;
            if (accountEquity > peakEquity) peakEquity = accountEquity;
            saveState();
            await tg(`🔄 <b>ปรับ equity ให้ตรง Binance</b>\n$${f(old)} → $${f(conn.balance)}\n(ต่าง $${f(drift)} จาก fee/funding สะสม)`);
          }
        }
      }
    } catch (e) { /* เช็คไม่ได้ = ข้ามการเทียบ equity แต่ยังตรวจ position ต่อ */ }
  }

  for (const symbol of SYMBOLS) {
    let exPos;
    try { exPos = await live.getPositionLive(symbol); }
    catch (e) {
      // เรียกไม่สำเร็จ ≠ ไม่มี position — ข้ามรอบนี้ ห้ามสรุปว่า desync
      if (/-1003|too many request|banned/i.test(e.message)) {
        // โดนซ้ำ → พักนานขึ้นเรื่อยๆ (30 → 60 → 120 นาที สูงสุด 3 ชม.)
        health.rateLimitHits = (health.rateLimitHits || 0) + 1;
        health.rateLimitTotal = (health.rateLimitTotal || 0) + 1;
        health.lastRateLimitAt = Date.now();
        const waitMin = Math.min(30 * Math.pow(2, health.rateLimitHits - 1), 180);
        reconcileBackoffUntil = Date.now() + waitMin * 60 * 1000;
        health.backoffUntil = reconcileBackoffUntil;
        // เตือนไม่เกิน 1 ครั้ง/2 ชม. (เดิมเตือนทุกครั้งที่โดน = สแปม)
        // โดนติดกัน 3+ ครั้ง = เรียก API เกินจริง ต้องรู้ทันที (ไม่ใช่แค่ warn)
        if (health.rateLimitHits >= 3 && Date.now() - (health.lastRateAlert || 0) > 3600000) {
          health.lastRateAlert = Date.now();
          await logError('critical', 'RATE_LIMIT_SEVERE', symbol,
            `โดน rate limit ${health.rateLimitHits} ครั้งติด — พัก ${waitMin} นาที\n` +
            `บอทเช็คสถานะกับ Binance ไม่ได้ระหว่างนี้ (SL บน exchange ยังคุ้มครองอยู่)`,
            { hits: health.rateLimitHits, total: health.rateLimitTotal, waitMin });
        } else if (Date.now() - (health.lastRateAlert || 0) > 2 * 3600000) {
          health.lastRateAlert = Date.now();
          await logError('warn', 'RATE_LIMITED', symbol,
            `โดน rate limit ครั้งที่ ${health.rateLimitHits} — พัก reconcile ${waitMin} นาที`);
        }
        return;
      }
      await logError('warn', 'RECONCILE_FAIL', symbol, `เช็ค position ไม่ได้ (ข้ามรอบนี้): ${e.message}`);
      continue;
    }
    const botPos = positions[symbol];
    const cfg = MARKETS[symbol];

    // bot มี แต่ exchange ไม่มี → ยืนยันซ้ำก่อน (กันเตือนผิดจาก API สะดุด)
    if (botPos && !exPos) {
      await new Promise(r => setTimeout(r, 3000));
      let confirm;
      try { confirm = await live.getPositionLive(symbol); }
      catch (e) {
        await logError('warn', 'RECONCILE_FAIL', symbol, `ยืนยันครั้งที่ 2 ไม่สำเร็จ: ${e.message}`);
        continue;
      }
      if (confirm) continue;   // ครั้งที่ 2 เจอ = false alarm ข้ามไป

      // ยืนยันแล้วว่าไม่มีจริง → SL บน exchange ปิดไม้ให้ = พฤติกรรมปกติ
      // ไม่นับเป็น desync (ตัวนับนี้ไว้จับ "ข้อมูลไม่ตรงกันจริง" เท่านั้น)
      health.slClosedCount = (health.slClosedCount || 0) + 1;
      const closePx = await (async () => {
        try {
          const kl = await fetchKlines(symbol, 2);
          return Array.isArray(kl) && kl.length ? +kl[kl.length - 1][4] : botPos.sl;
        } catch { return botPos.sl; }
      })();
      // SL ทำงานบน exchange = พฤติกรรมปกติ ไม่ใช่ปัญหาร้ายแรง
      // (critical ไว้ใช้กับเรื่องที่ต้องลงมือแก้จริงๆ เท่านั้น)
      await logError('info', 'POSITION_CLOSED_ON_EXCHANGE', symbol,
        `SL บน Binance ปิดไม้ให้แล้ว — บันทึกเป็น trade ที่ราคา $${f(closePx)}`,
        { botDir: botPos.dir, botQty: botPos.qty, botEntry: botPos.entry, botSL: botPos.sl });
      await closePosition(symbol, closePx, 'SL_FILLED_EXCHANGE');
      positions[symbol] = null;   // ยืนยันล้างแน่นอน (exchange ปิดไปแล้ว)
      saveState();
      continue;
    }
    // ทั้งคู่ FLAT แต่มี SL ค้าง → ลบทิ้ง (ถ้า trigger จะเปิดไม้ที่ไม่มีใครสั่ง!)
    else if (!botPos && !exPos && live.getOpenStops && live.sweepStops) {
      try {
        const stray = (await live.getOpenStops(symbol, 120000)).filter(o => o.symbol === symbol);
        if (stray.length) {
          const r = await live.sweepStops(symbol, null);
          await logError('warn', 'STRAY_STOP_CLEANED', symbol,
            `FLAT แล้วแต่มี SL ค้าง ${stray.length} อัน — ลบทิ้ง ${r.removed} อัน (ถ้า trigger จะเปิดไม้ที่ไม่ได้สั่ง)`);
          await tg(`🧹 <b>${cfg.label}: ลบ SL ตกค้าง</b>\nไม่มี position แล้วแต่มี SL ค้าง ${stray.length} อัน — ลบทิ้งแล้ว`);
        }
      } catch (e) { await logError('warn', 'API_CHECK_FAIL', symbol, e.message); }
    }
    // exchange มี แต่ bot ไม่มี = position ตกค้าง ไม่มีใครดูแล 🔴
    else if (!botPos && exPos) {
      health.desyncAlerts++;
      await logError('critical', 'DESYNC_ORPHAN', symbol,
        `Binance มี ${exPos.dir.toUpperCase()} ${exPos.qty} แต่ bot ไม่มีในระบบ — ไม่มีใครดูแล!`,
        { exDir: exPos.dir, exQty: exPos.qty, exEntry: exPos.entry });
      await tg(`🔴 <b>${cfg.label}: พบ position ตกค้าง!</b>\n\n` +
        `Binance: ${exPos.dir.toUpperCase()} ${exPos.qty} @ $${f(exPos.entry)}\n` +
        `PnL ลอย: $${f(exPos.unrealizedPnl)}\n` +
        `bot: ไม่มีในระบบ\n\n` +
        `⚠️ ไม่มี SL ดูแล — แนะนำปิดเองใน Binance`);
    }
    // มีทั้งคู่ → เช็คว่า SL ยังอยู่บน exchange มั้ย (auto-recovery)
    else if (botPos && exPos) {
      if (live.getOpenStops) {
        try {
          const stops = (await live.getOpenStops(symbol, 120000)).filter(o => o.symbol === symbol);
          if (!stops.length) {
            // ยืนยันซ้ำแบบไม่ใช้ cache — rate limit/สะดุดอาจทำให้ query แรกได้ [] ผิดๆ
            // ถ้าไม่เช็ค จะวาง SL ซ้ำแล้วต้องมาลบทีหลัง (วนลูปกิน API)
            await new Promise(r => setTimeout(r, 2500));
            let confirmStops = [];
            try { confirmStops = (await live.getOpenStops(symbol, 0)).filter(o => o.symbol === symbol); }
            catch (e) {
              await logError('warn', 'API_CHECK_FAIL', symbol,
                `ยืนยันครั้งที่ 2 ไม่ได้ — ข้ามรอบนี้ ไม่วาง SL ซ้ำ (${e.message.slice(0,60)})`);
              continue;
            }
            if (confirmStops.length) {
              botPos.slPlaced = true;
              botPos.stopOrderId = confirmStops[0].id;
              continue;   // SL มีอยู่จริง — query แรกผิดพลาด
            }
            // SL หายจริง → วางกลับ
            const stopSide = botPos.dir === 'long' ? 'SELL' : 'BUY';
            const r = await live.placeStopOrder(symbol, stopSide, botPos.qty, botPos.sl);
            if (r && !r.error) {
              botPos.stopOrderId = r.orderId; botPos.slPlaced = true;
              await logError('warn', 'SL_RESTORED', symbol,
                `SL หายจาก exchange — วางกลับให้แล้วที่ $${f(botPos.sl)}`, { orderId: r.orderId });
              await tg(`🔧 <b>${cfg.label}: กู้ SL คืนแล้ว</b>\nSL หายไปจาก Binance — วางกลับที่ $${f(botPos.sl)}`);
            } else {
              botPos.slPlaced = false;
              await logError('critical', 'SL_RESTORE_FAILED', symbol,
                `SL หายและวางกลับไม่ได้ — bot ต้องปิดเองถ้าถึงราคา`, { error: r && r.error });
            }
          } else {
            botPos.slPlaced = true;
            // มี SL เกิน 1 อัน (trail ลบเก่าไม่สำเร็จ) → กวาดให้เหลือตัวใหม่สุด
            if (stops.length > 1 && live.sweepStops) {
              stops.sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
              const r = await live.sweepStops(symbol, stops[0].id);
              await logError('warn', 'DUP_STOP_SWEPT', symbol,
                `พบ SL ซ้ำ ${stops.length} อัน — ลบส่วนเกิน ${r.removed} อัน (เหลือ ${r.remaining})`);
              botPos.stopOrderId = stops[0].id;
            }
            // ราคา SL บน exchange ต่างจากที่ bot คิดมาก → sync ใหม่
            const diff = Math.abs(stops[0].stopPrice - botPos.sl);
            if (diff > botPos.atr * 0.5) {
              const stopSide = botPos.dir === 'long' ? 'SELL' : 'BUY';
              await live.trailStopLive(stopSide, botPos.qty, botPos.sl, symbol);
              await logError('warn', 'SL_PRICE_SYNC', symbol,
                `SL บน exchange ($${stops[0].stopPrice}) ต่างจาก bot ($${f(botPos.sl)}) — sync ใหม่แล้ว`);
            }
          }
        } catch (e) { await logError('warn', 'API_CHECK_FAIL', symbol, e.message); }
      }
      const dirMismatch = botPos.dir !== exPos.dir;
      const qtyDiff = Math.abs(botPos.qty - exPos.qty) / Math.max(botPos.qty, 0.0001);
      if (dirMismatch || qtyDiff > 0.02) {
        health.desyncAlerts++;
        await logError('critical', 'DESYNC_SIZE', symbol,
          `ขนาด/ทิศไม่ตรง — bot ${botPos.dir} ${botPos.qty} vs Binance ${exPos.dir} ${exPos.qty}`,
          { botQty: botPos.qty, exQty: exPos.qty, diffPct: +(qtyDiff*100).toFixed(2) });
      }
    }
  }
}

async function checkAllMarkets() {
  // halted = ห้ามเปิดไม้ใหม่ (เช็คใน checkSignal)
  // แต่ position ที่ถืออยู่ต้องดูแลต่อ — trail/SL/ปิด ไม่งั้นขาดทุนไม่จำกัด
  const hasOpen = SYMBOLS.some(s2 => positions[s2]);
  if (halted && !hasOpen) return;
  logEquitySnapshot();
  for (const symbol of SYMBOLS) {
    try { await checkSignal(symbol); }
    catch (e) { console.error(`[${symbol}]`, e.message); }
  }
  saveState();
}

async function checkSignal(symbol) {
  const cfg = MARKETS[symbol];
  const position = positions[symbol];

  let kl;
  const need = Math.max(cfg.entryPeriod, cfg.exitPeriod) + cfg.atrPeriod + 5;
  try {
    // ดึง klines ตรงจาก Binance ทุกรอบ — เชื่อถือได้กว่าการประกอบเอง
    // (เคยลอง cache แท่งปิด + ต่อราคาปัจจุบัน แต่ทำ Donchian คลาดเคลื่อน จึงถอนออก)
    kl = await fetchKlines(symbol, Math.max(need, 210));
  } catch (e) {
    health.apiFailStreak++;
    const mins = Math.round((Date.now() - health.lastApiOk) / 60000);
    // ล้มติดกัน 5 ครั้ง (~5 นาที) = API มีปัญหาจริง ต้องรู้
    if (health.apiFailStreak === 5 || health.apiFailStreak % 30 === 0) {
      await logError('critical', 'API_DOWN', symbol,
        `ดึงราคาไม่ได้ ${health.apiFailStreak} ครั้งติด (ไม่ได้ข้อมูลมา ${mins} นาที) — บอทมองไม่เห็นตลาด`,
        { error: e.message, streak: health.apiFailStreak });
    } else {
      await logError('warn', 'API_FAIL', symbol, e.message, { streak: health.apiFailStreak });
    }
    return;
  }
  if (!Array.isArray(kl) || kl.length < cfg.entryPeriod + 2) {
    await logError('warn', 'BAD_DATA', symbol, `ข้อมูลราคาไม่ครบ (${Array.isArray(kl) ? kl.length : 'ไม่ใช่ array'})`);
    return;
  }
  // ดึงข้อมูลสำเร็จ → รีเซ็ตตัวนับ
  if (health.apiFailStreak >= 5) {
    await tg(`✅ <b>API กลับมาแล้ว</b>\nขาดข้อมูลไป ${health.apiFailStreak} ครั้ง — ตอนนี้ดึงราคาได้ปกติ`);
  }
  health.apiFailStreak = 0;
  health.lastApiOk = Date.now();

  const cls = kl.map(k => +k[4]);
  // ── ตรวจคุณภาพข้อมูลก่อนใช้ — ราคาเสีย 1 แท่งทำให้ Donchian/ATR เพี้ยนทั้งชุด ──
  const badBars = cls.filter(c => !isFinite(c) || c <= 0).length;
  if (badBars > 0) {
    await logError('warn', 'BAD_DATA', symbol,
      `พบราคาที่ใช้ไม่ได้ ${badBars}/${cls.length} แท่ง — ข้ามรอบนี้ (กันคำนวณ SL/ATR เพี้ยน)`);
    return;
  }
  const price = cls[cls.length - 1];
  if (!isFinite(price) || price <= 0) {
    await logError('warn', 'BAD_DATA', symbol, `ราคาปัจจุบันใช้ไม่ได้: ${price}`);
    return;
  }
  const atr = calcATR(kl, cfg.atrPeriod);
  if (!isFinite(atr) || atr <= 0) return;
  // ATR ต่ำผิดปกติ = ตลาดนิ่งสนิท/ข้อมูลเพี้ยน
  // SL จะชิด entry มาก → qty มหาศาล + โดนเขี่ยทันที
  if (atr / price < 0.0005 && !positions[symbol]) {
    await logError('warn', 'ATR_TOO_LOW', symbol,
      `ATR ${(atr/price*100).toFixed(4)}% ของราคา — ต่ำกว่าขั้นต่ำ 0.05% ข้ามไม้นี้ (SL จะชิดเกินไป)`);
    return;
  }
  // ATR ใหญ่ผิดปกติ (> 20% ของราคา) = ข้อมูลเพี้ยน ไม่ใช่ตลาดผันผวน
  if (atr / price > 0.20) {
    await logError('warn', 'ATR_ABNORMAL', symbol,
      `ATR $${f(atr)} = ${(atr/price*100).toFixed(1)}% ของราคา — ผิดปกติ ข้ามรอบนี้`);
    return;
  }

  // Donchian channels (ไม่รวมแท่งปัจจุบัน)
  const recent = cls.slice(-cfg.entryPeriod - 1, -1);
  const entryHigh = Math.max(...recent);
  const entryLow  = Math.min(...recent);
  const exitRecent = cls.slice(-cfg.exitPeriod - 1, -1);
  const exitHigh = Math.max(...exitRecent);
  const exitLow  = Math.min(...exitRecent);

  // cache สำหรับ /dashboard (แยกต่อเหรียญ)
  dashCache[symbol] = {
    price,
    channel: {
      upper: +entryHigh.toFixed(2), lower: +entryLow.toFixed(2),
      exit20Hi: +exitHigh.toFixed(2), exit20Lo: +exitLow.toFixed(2),
      price: +price.toFixed(2),
      history: cls.slice(-12).map(c => +c.toFixed(2))
    },
    atr: +atr.toFixed(2),
    updatedAt: Date.now()
  };

  const ts = thTime();   // เวลาไทย
  const L = cfg.label;

  // ───────── มี position: จัดการ exit/trail ─────────
  if (position) {
    let exitReason = null;
    let slMovedForLive = false;

    const curR = position.riskAmt > 0
      ? ((position.dir === 'long' ? price - position.entry : position.entry - price) * position.qty) / position.riskAmt
      : 0;
    const beHit = cfg.breakevenAtR > 0 && curR >= cfg.breakevenAtR;
    // อัพเดตชั่วโมงที่ถือ — ใช้ entryTs จริง (ทนต่อ restart)
    // ต้องอัพเดตก่อนบันทึก peakBar/troughBar ไม่งั้นได้ 0 ตลอด
    position.bars = Math.max(0, Math.round((Date.now() - position.entryTs) / 3600000));

    if (position.dir === 'long') {
      if (price < position.trough) { position.trough = price; position.troughBar = position.bars; }
      if (price > position.peak) { position.peak = price; position.peakBar = position.bars; }
      let newSL = position.peak - atr * cfg.trailATR;
      // BREAKEVEN: ลอยถึง +1R → ดัน SL มาที่ entry (ไม่ยอมให้พลิกขาดทุน)
      if (beHit && newSL < position.entry) newSL = position.entry;
      if (newSL > position.sl) {
        position.sl = newSL; slMovedForLive = true;
        position.trailMoves = (position.trailMoves || 0) + 1;
      }
      // ล็อกทุนแล้ว = SL อยู่ที่ entry หรือดีกว่า (ไม่ใช่แค่ตอนเท่ากับ entry เป๊ะ)
      // เดิมเช็ค === entry ทำให้ไม้ที่กำไรเร็ว (trail เลย entry ไปเลย) ไม่เคยถูกบันทึก
      if (!position.beDone && position.sl >= position.entry) {
        position.beDone = true; position.beBar = position.bars;
      }
      if (price <= position.sl) exitReason = 'TRAIL_SL';
      else if (price < exitLow) exitReason = 'DONCHIAN_EXIT';
    } else {
      if (price > position.trough) { position.trough = price; position.troughBar = position.bars; }
      if (price < position.peak) { position.peak = price; position.peakBar = position.bars; }
      let newSL = position.peak + atr * cfg.trailATR;
      if (beHit && newSL > position.entry) newSL = position.entry;
      if (newSL < position.sl) {
        position.sl = newSL; slMovedForLive = true;
        position.trailMoves = (position.trailMoves || 0) + 1;
      }
      if (!position.beDone && position.sl <= position.entry) {
        position.beDone = true; position.beBar = position.bars;
      }
      if (price >= position.sl) exitReason = 'TRAIL_SL';
      else if (price > exitHigh) exitReason = 'DONCHIAN_EXIT';
    }

    if (live.isEnabled() && slMovedForLive && !exitReason) {
      const stopSide = position.dir === 'long' ? 'SELL' : 'BUY';
      try {
        const tr = await live.trailStopLive(stopSide, position.qty, position.sl, symbol);
        if (tr && tr.error) throw new Error(tr.error);
        position.slSyncedAt = Date.now();
      } catch (e) {
        await logError('warn', 'TRAIL_UPDATE_FAILED', symbol,
          `ขยับ SL บน exchange ไม่สำเร็จ (SL เดิมยังอยู่ — bot ยังคุมได้)`,
          { newSL: position.sl, error: e.message });
      }
    }

    const heldH = Math.round((Date.now() - position.entryTs) / 3600000);
    console.log(`[${ts}] ${L} $${f(price)} ${position.dir.toUpperCase()} | SL $${f(position.sl)} peak $${f(position.peak)} ${heldH}h`);

    if (exitReason) await closePosition(symbol, price, exitReason);
    else await maybePositionReport(symbol, price);
    return;
  }

  // ───────── ไม่มี position: หา entry ─────────
  const distToHigh = ((entryHigh - price) / price * 100);
  const distToLow  = ((price - entryLow) / price * 100);
  console.log(`[${ts}] ${L} $${f(price)} FLAT | D${cfg.entryPeriod} hi $${f(entryHigh)}(+${distToHigh.toFixed(1)}%) lo $${f(entryLow)}(-${distToLow.toFixed(1)}%) | ATR $${f(atr)}`);

  logSignal(symbol, price, entryHigh, entryLow, atr, distToHigh, distToLow);

  // กันเข้าไม้ใหม่ทันทีหลังเพิ่งปิด (whipsaw ในแท่งเดียวกัน)
  const lastExit = lastExitTs[symbol] || 0;
  if (lastExit && (Date.now() - lastExit) < REENTRY_COOLDOWN_BARS * 3600000) {
    if (price > entryHigh || price < entryLow) {
      const waitMin = Math.ceil((REENTRY_COOLDOWN_BARS * 3600000 - (Date.now() - lastExit)) / 60000);
      console.log(`[${ts}] ${L} มี signal แต่รอ cooldown อีก ${waitMin} นาที`);
    }
    return;
  }

  if (halted) return;   // หยุดเทรดแล้ว — ไม่เปิดไม้ใหม่ (แต่ position เดิมยังดูแลอยู่ด้านบน)

  if (price > entryHigh) {
    await openPosition(symbol, 'long', price, atr, kl, entryHigh, entryLow);
  } else if (price < entryLow) {
    await openPosition(symbol, 'short', price, atr, kl, entryHigh, entryLow);
  }
}

async function openPosition(symbol, dir, entry, atr, kl, entryHigh, entryLow) {
  const cfg = MARKETS[symbol];
  let sl = dir === 'long' ? entry - atr * cfg.trailATR : entry + atr * cfg.trailATR;
  // ── ตรวจ SL สมเหตุผลก่อนใช้ (ข้อมูลเพี้ยนทำให้ SL ติดลบได้) ──
  if (!isFinite(sl) || sl <= 0) {
    await logError('critical', 'INVALID_SL', symbol,
      `คำนวณ SL ได้ค่าใช้ไม่ได้ ($${sl}) — ยกเลิกไม้นี้`, { entry, atr, trailATR: cfg.trailATR });
    return;
  }
  const slDistPct = Math.abs(entry - sl) / entry;
  if (slDistPct > 0.50) {
    await logError('warn', 'SL_TOO_FAR', symbol,
      `ระยะ SL ${(slDistPct * 100).toFixed(1)}% ของราคา — กว้างผิดปกติ ข้ามไม้นี้`, { entry, sl, atr });
    return;
  }
  // ── กันเปิดไม้เกินตัว: จำกัดจำนวน position พร้อมกัน ──
  const nOpen = SYMBOLS.filter(s2 => positions[s2]).length;
  if (nOpen >= MAX_OPEN_POSITIONS) {
    console.log(`[${cfg.label}] ข้าม — เปิดครบ ${MAX_OPEN_POSITIONS} ไม้แล้ว`);
    return;
  }

  let qty = calcPositionSize(entry, sl);
  // ── ปัด qty ให้ตรงกับที่ exchange รับ (ปัดลง = risk ไม่เกินที่ตั้งไว้) ──
  // ถ้าไม่ปัด: bot คิด 16.8975 SOL แต่ Binance ได้ 17 → PnL/risk/equity เพี้ยนสะสม
  const qp = cfg.qtyPrecision ?? 3;
  const step = Math.pow(10, qp);
  qty = Math.floor(qty * step) / step;
  if (qty <= 0) {
    console.log(`[${cfg.label}] ข้าม — qty หลังปัดเศษ = 0 (equity น้อยเกินสำหรับเหรียญนี้)`);
    return;
  }

  // ── Binance ปฏิเสธ order ที่มูลค่าต่ำกว่า minNotional (ปกติ $5) ──
  const notionalCheck = qty * entry;
  if (notionalCheck < MIN_NOTIONAL) {
    await logError('warn', 'BELOW_MIN_NOTIONAL', symbol,
      `มูลค่าไม้ $${f(notionalCheck)} ต่ำกว่าขั้นต่ำ $${MIN_NOTIONAL} — ข้ามไม้นี้`, { qty, entry });
    return;
  }

  // ── เช็คว่ามี margin พอจริงบน exchange (กัน error -2019 Margin insufficient) ──
  if (live.isEnabled() && live.testConnection) {
    try {
      const conn = await live.testConnection(5 * 60 * 1000);   // cache 5 นาที ลด API call
      if (conn.ok) {
        const marginNeeded = notionalCheck / LEVERAGE;
        const usable = conn.available / 1.1;                    // เผื่อ 10% สำหรับ fee
        if (usable < marginNeeded) {
          // ── ลดขนาดให้พอดีกับ margin ที่มี แทนที่จะข้ามไม้ ──
          // trend-following พลาดไม้ใหญ่ 1 ตัว = เสียหายกว่าเข้าไม้เล็ก
          const maxNotional = usable * LEVERAGE;
          const scaled = maxNotional / entry;
          const step = Math.pow(10, cfg.qtyPrecision ?? 3);
          const newQty = Math.floor(scaled * step) / step;
          const ratio = newQty / qty;
          if (newQty <= 0 || ratio < 0.25) {
            await logError('warn', 'MARGIN_TOO_LOW', symbol,
              `margin เหลือน้อยเกิน — ต้องใช้ $${f(marginNeeded)} มี $${f(conn.available)} ` +
              `(ลดได้แค่ ${(ratio*100).toFixed(0)}% ของขนาดที่ควรเป็น) — ข้ามไม้นี้`,
              { needed: +marginNeeded.toFixed(2), available: conn.available, ratio: +ratio.toFixed(3) });
            return;
          }
          await logError('warn', 'SIZE_REDUCED_MARGIN', symbol,
            `margin จำกัด — ลดขนาดจาก ${qty} เหลือ ${newQty} (${(ratio*100).toFixed(0)}%) ` +
            `risk ${(RISK_PER_TRADE*100*ratio).toFixed(3)}% แทน ${(RISK_PER_TRADE*100).toFixed(2)}%`,
            { orderedQty: qty, reducedQty: newQty, available: conn.available });
          qty = newQty;   // SL คงเดิม (ATR ไม่เปลี่ยน) — risk ลดตาม qty ที่ลดลง
        }
      }
    } catch (e) { await logError('warn', 'API_CHECK_FAIL', symbol, e.message); }
  }

  // ML features ตอน entry
  const cls = kl.map(k => +k[4]);
  const tradesArr = kl.map(k => +k[8]);
  const smaN = (arr, n) => arr.length >= n ? arr.slice(-n).reduce((s,x)=>s+x,0)/n : null;
  const ts5 = smaN(tradesArr, 5), ts100 = smaN(tradesArr, 100);
  const tradesSurge = (ts5 && ts100) ? +(ts5 / ts100).toFixed(3) : null;
  // Efficiency Ratio 200 แท่ง — ต่ำ = sideways, สูง = trend ชัด
  // ใช้แท็กสภาพตลาดตอนเข้า เพื่อวิเคราะห์ทีหลังว่า regime ไหนทำเงิน
  let efficiencyRatio = null;
  if (cls.length >= 201) {
    const w = cls.slice(-201);
    let path = 0;
    for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i-1]);
    efficiencyRatio = path > 0 ? +(Math.abs(w[w.length-1] - w[0]) / path).toFixed(4) : null;
  }
  const features = {
    efficiencyRatio,
    rsi: +calcRSI(cls).toFixed(2),
    obvSlope: +calcOBVSlope(kl).toFixed(0),
    atrPct: +(atr / entry * 100).toFixed(3),
    breakoutStrength: +(Math.abs(entry - (dir==='long'?entryHigh:entryLow)) / atr).toFixed(3),
    channelWidth: +((entryHigh - entryLow) / entry * 100).toFixed(2),
    momentum: +((cls[cls.length-1] - cls[cls.length-6]) / cls[cls.length-6] * 100).toFixed(2),
    tradesSurge
  };

  const riskAmt = Math.abs(entry - sl) * qty;
  const orderSentTs = Date.now();
  positions[symbol] = { symbol, dir, entry, sl, peak: entry, trough: entry, peakBar: 0, troughBar: 0,
    trailMoves: 0, beBar: null, orderSentTs, qty, bars: 0, atr,
    initialSL: sl, riskAmt, entryTs: Date.now(), beDone: false, features };

  let liveInfo = '';
  if (live.isEnabled()) {
    const r = await live.openLive(dir, qty, sl, symbol);
    if (r.error) {
      // 🔴 ส่ง order ไม่ผ่าน → ยกเลิก position ในระบบ (ห้ามเก็บ "position ผี")
      positions[symbol] = null;
      health.orderErrors++;
      await logError('critical', 'ENTRY_FAILED', symbol,
        `ส่งคำสั่งเปิด ${dir.toUpperCase()} ไม่สำเร็จ — ยกเลิกไม้นี้ (ไม่มี position ค้างในระบบ)`,
        { dir, qty, intendedEntry: entry, error: r.error });
      await tg(`⚠️ <b>${cfg.label}: เปิดไม้ไม่สำเร็จ</b>\n\n${dir.toUpperCase()} @ $${f(entry)}\nสาเหตุ: ${r.error}\n\n✅ ยกเลิกแล้ว — ไม่มี position ค้าง\nบอทจะรอ signal ถัดไป`);
      return;
    } else if (!r.simulated) {
      // เก็บราคา fill จริง → วัด slippage (paper ไม่มีข้อมูลนี้)
      const fp = r.fillPrice;
      positions[symbol].liveEntryFill = fp;
      positions[symbol].entryFeeLive = r.fee ?? null;
      positions[symbol].fillLatencyMs = r.orderLatencyMs ?? (Date.now() - orderSentTs);
      positions[symbol].entryFills = r.fills ?? null;
      // ── partial fill: ได้ qty ไม่เท่าที่สั่ง → ต้องใช้ของจริง ──
      // ไม่งั้น SL วางผิดจำนวน + PnL/risk คำนวณผิด
      if (r.fillQty && Math.abs(r.fillQty - qty) / qty > 0.001) {
        const oldQty = qty;
        positions[symbol].qty = r.fillQty;
        positions[symbol].liveFillQty = r.fillQty;
        positions[symbol].riskAmt = Math.abs(entry - sl) * r.fillQty;
        const newRiskPct = positions[symbol].riskAmt / accountEquity * 100;
        const over = newRiskPct > RISK_PER_TRADE * 100 * 1.05;   // เกิน 5% ของที่ตั้งไว้
        await logError(over ? 'critical' : 'warn', over ? 'FILL_RISK_EXCEEDED' : 'PARTIAL_FILL', symbol,
          over
            ? `fill ${r.fillQty} เกินที่สั่ง ${oldQty} → risk จริง ${newRiskPct.toFixed(2)}% (ตั้งไว้ ${(RISK_PER_TRADE*100).toFixed(2)}%)`
            : `สั่ง ${oldQty} ได้จริง ${r.fillQty} — ปรับ qty/risk ตามของจริงแล้ว`,
          { ordered: oldQty, filled: r.fillQty, riskPct: +newRiskPct.toFixed(3),
            targetPct: +(RISK_PER_TRADE*100).toFixed(2) });
      } else if (r.fillQty) {
        positions[symbol].liveFillQty = r.fillQty;
      }
      positions[symbol].entryOrderId = r.orderId || null;
      positions[symbol].stopOrderId = r.stopOrderId || null;
      positions[symbol].slPlaced = !!r.stopPlaced;
      if (fp) {
        const slipAbs = dir === 'long' ? fp - entry : entry - fp;   // + = เสียเปรียบ
        positions[symbol].slipEntry = +slipAbs.toFixed(4);
        positions[symbol].slipEntryBps = +((slipAbs / entry) * 10000).toFixed(2);
        liveInfo = `\n✅ LIVE fill $${f(fp)} (slip ${slipAbs>=0?'+':''}${(slipAbs/entry*10000).toFixed(1)} bps)`;
      } else {
        liveInfo = `\n✅ LIVE order ส่งแล้ว (${live.modeLabel()})`;
      }
      // ⚠️ SL ล้มเหลว = position เปลือย ต้องรู้ทันที
      if (!r.stopPlaced) {
        health.slErrors++;
        await logError('critical', 'SL_ORDER_FAILED', symbol,
          `วาง SL ไม่สำเร็จ — position ไม่มี order กันบน exchange`,
          { dir, qty, stopPrice: sl, error: r.stopError });
        liveInfo += `\n\n🔴 <b>SL ORDER ล้มเหลว!</b>\n${r.stopError || 'ไม่ทราบสาเหตุ'}\nbot จะปิดเองถ้าราคาถึง SL แต่ไม่มี order กันบน exchange`;
      }
    }
  }

  const notional = qty * entry;
  const openCount = SYMBOLS.filter(sy => positions[sy]).length;
  await tg(`🐢 <b>${cfg.label} ENTRY — ${dir.toUpperCase()}</b>\n\n` +
    `Entry: $${f(entry)}\nSL: $${f(sl)} (ATR×${cfg.trailATR})\n` +
    `Qty: ${qty.toFixed(4)} ${cfg.label} ($${f(notional)})\n` +
    `Risk: $${f(riskAmt)} (${(RISK_PER_TRADE*100).toFixed(2)}%)\n` +
    `Equity: $${f(accountEquity)} | เปิดอยู่ ${openCount}/${SYMBOLS.length} ตลาด${liveInfo}`);
  console.log(`>>> ${cfg.label} ENTRY ${dir} @ $${f(entry)} SL $${f(sl)} qty ${qty.toFixed(4)} [${live.modeLabel()}]`);
}

async function closePosition(symbol, exit, reason) {
  const position = positions[symbol];
  if (!position) return;
  // กันปิดซ้ำ: ถ้ากำลังปิดอยู่แล้วให้ข้าม (reconcile + loop หลักอาจเรียกพร้อมกัน)
  if (position._closing) {
    console.log(`[${symbol}] ข้าม — กำลังปิดอยู่แล้ว`);
    return;
  }
  position._closing = true;
  const cfg = MARKETS[symbol];
  const { dir, entry, qty, peak, trough, entryTs, riskAmt, atr } = position;
  let exitFill = null, slipExit = null, liveFeeExit = null, liveRealizedPnl = null;
  // ถ้า exchange ปิด position ไปแล้ว (SL trigger) ห้ามส่ง market order ซ้ำ
  // ไม่งั้นจะกลายเป็นเปิดไม้ใหม่ทางตรงข้าม!
  const alreadyClosedOnExchange = (reason === 'SL_FILLED_EXCHANGE');
  if (alreadyClosedOnExchange) {
    if (live.cancelStop) { try { await live.cancelStop(symbol, position.stopOrderId); } catch (e) {} }
    // SL trigger เอง → ดึงราคาปิดจริงจากประวัติ (ไม่งั้นใช้ราคาประมาณ = PnL เพี้ยน)
    if (live.getExitFillFromHistory) {
      try {
        const f = await live.getExitFillFromHistory(symbol, dir, entryTs);
        if (f) {
          exitFill = f.price;
          liveFeeExit = f.fee;
          liveRealizedPnl = f.realizedPnl;
          const sa = dir === 'long' ? exit - f.price : f.price - exit;
          slipExit = +((sa / exit) * 10000).toFixed(2);
          console.log(`[${symbol}] ดึงราคาปิดจริงจาก SL: $${f.price} (PnL จริง $${f.realizedPnl})`);
        }
      } catch (e) {}
    }
  }
  if (live.isEnabled() && !alreadyClosedOnExchange) {
    let closed = false, closeErr = null, alreadyGone = false;
    // ลองปิด 3 ครั้ง (เผื่อเน็ต/API สะดุดชั่วคราว)
    for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
      try {
        const rc = await live.closeLive(dir, qty, symbol);
        if (rc && rc.error) throw new Error(rc.error);
        closed = true;
        if (rc && rc.fillPrice) {
          exitFill = rc.fillPrice;
          const sa = dir === 'long' ? exit - exitFill : exitFill - exit;
          slipExit = +((sa / exit) * 10000).toFixed(2);
        }
        if (rc) {
          liveFeeExit = rc.fee ?? null;
          liveRealizedPnl = rc.realizedPnl ?? null;
        }
        if (attempt > 1) await logError('warn', 'CLOSE_RETRY_OK', symbol, `ปิดสำเร็จในครั้งที่ ${attempt}`);
      } catch (e) {
        closeErr = e.message;
        // -2022 ReduceOnly rejected / -2011 Unknown order
        // = ไม่มี position ให้ปิดแล้ว (SL บน exchange ปิดไปก่อน) — ไม่ต้อง retry
        if (/-2022|-2011|ReduceOnly Order is rejected|Unknown order/i.test(closeErr)) {
          alreadyGone = true;
          break;
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    // position ถูกปิดบน exchange ไปแล้ว → เก็บผลจริงแล้วปิดในระบบ (ไม่ใช่ error)
    if (alreadyGone) {
      closed = true;
      if (live.getExitFillFromHistory) {
        try {
          const fh = await live.getExitFillFromHistory(symbol, dir, entryTs);
          if (fh) {
            exitFill = fh.price;
            liveFeeExit = fh.fee;
            liveRealizedPnl = fh.realizedPnl;
            const sa = dir === 'long' ? exit - fh.price : fh.price - exit;
            slipExit = +((sa / exit) * 10000).toFixed(2);
          }
        } catch (e) {}
      }
      if (live.sweepStops) { try { await live.sweepStops(symbol, null); } catch (e) {} }
      await logError('info', 'CLOSED_BY_EXCHANGE', symbol,
        `SL บน exchange ปิดไม้ให้แล้ว (ReduceOnly rejected) — บันทึกผลจริง${exitFill ? ` ที่ $${f(exitFill)}` : ''}`);
    }

    // 🔴 ปิดไม่ออกทั้ง 3 ครั้ง → ห้ามลบ position ออกจากระบบ
    if (!closed) {
      health.closeErrors++;
      position.closeFailed = true;
      position.closeFailReason = closeErr;
      position.closeFailAt = Date.now();
      await logError('critical', 'CLOSE_FAILED', symbol,
        `ปิด ${dir.toUpperCase()} ไม่สำเร็จ 3 ครั้ง — position ยังเปิดบน exchange!`,
        { dir, qty, intendedExit: exit, reason, error: closeErr });
      await tg(`🔴 <b>${cfg.label}: ปิดไม้ไม่สำเร็จ!</b>\n\n` +
        `${dir.toUpperCase()} ${qty} @ $${f(entry)}\nต้องการปิดที่ $${f(exit)} (${reason})\n` +
        `สาเหตุ: ${closeErr}\n\n` +
        `⚠️ <b>position ยังเปิดอยู่บน Binance</b>\n` +
        `บอทเก็บไว้ในระบบและจะลองปิดใหม่รอบหน้า\n` +
        `ถ้าเร่งด่วน → ปิดเองใน Binance แล้วสั่ง /close_${cfg.label.toLowerCase()}`);
      position._closing = false;   // ปลดล็อกให้ลองใหม่รอบหน้า
      saveState();
      return;   // ไม่บันทึก trade ปลอม ไม่แตะ equity
    }
  }

  const bars = Math.max(0, Math.round((Date.now() - entryTs) / 3600000));   // กัน entryTs เพี้ยน
  // ── funding จริงที่จ่าย/ได้รับระหว่างถือ (backtest ประมาณคงที่ ของจริงแกว่งมาก) ──
  let fundingLive = null, fundingCount = null;
  if (live.isEnabled() && live.getFundingPaid) {
    try {
      const fd = await live.getFundingPaid(symbol, entryTs, Date.now());
      if (fd) { fundingLive = fd.total; fundingCount = fd.count; }
    } catch (e) {}
  }
  // ── ใช้ราคา fill จริงถ้ามี (ไม่งั้น equity เพี้ยนจากบัญชีจริงสะสมทุกไม้) ──
  const realEntry = position.liveEntryFill || entry;
  const realExit  = exitFill || exit;
  const realQty   = position.liveFillQty || qty;
  const gross = dir === 'long' ? (realExit - realEntry) * realQty : (realEntry - realExit) * realQty;
  // fee: ใช้ค่าจริงจาก Binance ถ้ามี ไม่งั้นประมาณ
  const feeReal = (position.entryFeeLive != null || liveFeeExit != null)
    ? ((position.entryFeeLive || 0) + (liveFeeExit || 0)) : null;
  const feeEst = (realEntry + realExit) * realQty * FEE;   // SLIP ไม่ต้องบวกแล้ว (อยู่ในราคา fill จริง)
  const fee = feeReal != null ? feeReal : (realEntry + realExit) * realQty * (FEE + SLIP);
  const fundingCost = (realQty * realEntry) * 0.0001 * (bars / 8);
  const pnlEstimate = gross - fee - fundingCost;
  // ── ยึด realizedPnl จาก exchange เป็นหลัก (รวม fee + funding จริงหมดแล้ว) ──
  // ถ้าไม่มี (paper / ดึงไม่ได้) ค่อยใช้ค่าประมาณ
  const usingLivePnl = live.isEnabled() && liveRealizedPnl != null;
  const pnl = usingLivePnl ? (liveRealizedPnl - (position.entryFeeLive || 0)) : pnlEstimate;
  // เตือนเมื่อต่างทั้งเป็น % และเป็นจำนวนเงินที่มีนัยสำคัญ (ไม่งั้นเตือนทุกไม้)
  if (usingLivePnl && Math.abs(pnl - pnlEstimate) > 5 && Math.abs(pnl - pnlEstimate) > Math.abs(pnlEstimate) * 0.20) {
    await logError('warn', 'PNL_MISMATCH', symbol,
      `PnL จริงจาก Binance $${pnl.toFixed(2)} ต่างจากที่คำนวณเอง $${pnlEstimate.toFixed(2)} — ใช้ค่าจริง`,
      { live: +pnl.toFixed(4), estimate: +pnlEstimate.toFixed(4),
        diff: +(pnl - pnlEstimate).toFixed(4), fundingEstimate: +fundingCost.toFixed(4) });
  }

  // ── ปิดสำเร็จแล้ว (หรือโหมด paper) → อัพเดต equity ──
  accountEquity += pnl;
  if (accountEquity > peakEquity) peakEquity = accountEquity;

  const mfe = dir === 'long' ? (peak - entry) * qty : (entry - peak) * qty;
  const mae = dir === 'long' ? (trough - entry) * qty : (entry - trough) * qty;
  const rMultiple = riskAmt > 0 ? pnl / riskAmt : 0;
  // แจ้งเตือนถ้าขาดทุนเกินที่ควรมาก (gap/flash crash ข้าม SL)
  if (rMultiple < -1.5) {
    await logError('critical', 'EXCESSIVE_LOSS', symbol,
      `ขาดทุน ${rMultiple.toFixed(2)}R (ควรไม่เกิน -1R) — ราคากระโดดข้าม SL`,
      { entry: realEntry, exit: realExit, sl: position.sl, pnl: +pnl.toFixed(2),
        pctOfEquity: +(Math.abs(pnl) / accountEquity * 100).toFixed(2) });
  }
  const holdH = bars;

  // TP+2R shadow (paper validate — ไม่เปลี่ยน exit จริง)
  const mfeR = riskAmt > 0 ? mfe / riskAmt : 0;
  const tp2Hit = mfeR >= 2;
  const tp2Pnl = tp2Hit ? riskAmt * 2 : pnl;
  const tp2Diff = +(tp2Pnl - pnl).toFixed(2);

  const trade = {
    num: trades.length + 1, symbol, label: cfg.label,
    dir, entry: +entry.toFixed(2), exit: +exit.toFixed(2),
    qty: +qty.toFixed(4), pnl: +pnl.toFixed(2), reason, bars: holdH,
    mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), rMultiple: +rMultiple.toFixed(2),
    peakPrice: +peak.toFixed(2),
    riskAmt: +riskAmt.toFixed(2), atr: +atr.toFixed(2),
    equity: +accountEquity.toFixed(2),
    tp2Hit, tp2Pnl: +tp2Pnl.toFixed(2), tp2Diff,
    // ── LIVE fill / slippage (มีเฉพาะ testnet/mainnet) ──
    mode: live.modeLabel(),
    entryFill: position.liveEntryFill ?? null,
    exitFill,
    slipEntryBps: position.slipEntryBps ?? null,
    slipExitBps: slipExit,
    // ค่าจริงจาก Binance (เทียบกับที่ bot ประมาณเอง)
    feeLive: (position.entryFeeLive != null || liveFeeExit != null)
      ? +(((position.entryFeeLive || 0) + (liveFeeExit || 0))).toFixed(6) : null,
    feeEstimate: +fee.toFixed(4),
    pnlLive: liveRealizedPnl,
    pnlEstimate: +pnlEstimate.toFixed(2),
    pnlSource: usingLivePnl ? 'exchange' : 'estimate',
    // ── funding จริง vs ประมาณ (ตัวกินกำไรเงียบๆ ของ trend-following) ──
    fundingLive, fundingCount,
    fundingEstimate: +fundingCost.toFixed(4),
    // ── พฤติกรรมระหว่างถือ ──
    trailMoves: position.trailMoves ?? 0,
    beBar: position.beBar ?? null,
    maeR: riskAmt > 0 ? +(mae / riskAmt).toFixed(3) : null,
    maePctEquity: +(Math.abs(mae) / accountEquity * 100).toFixed(3),
    mfeR: riskAmt > 0 ? +(mfe / riskAmt).toFixed(3) : null,
    // ── execution quality ──
    fillLatencyMs: position.fillLatencyMs ?? null,
    entryFills: position.entryFills ?? null,
    slPlaced: position.slPlaced ?? null,
    entryOrderId: position.entryOrderId ?? null,
    // ── บริบทตลาด + จังหวะ ──
    efficiencyRatio: position.features ? position.features.efficiencyRatio : null,
    peakBar: position.peakBar ?? null,      // ชม.ที่ราคาไปไกลสุด
    troughBar: position.troughBar ?? null,  // ชม.ที่ราคาสวนแรงสุด
    entryTs, exitTs: Date.now()
  };
  trades.push(trade);
  logTradeCSV(trade);
  logML(position.features, trade);


  const win = pnl > 0;
  const emoji = win ? '🟢' : '🔴';
  const openCount = SYMBOLS.filter(sy => positions[sy] && sy !== symbol).length;
  // แสดงราคา fill จริงถ้ามี (ไม่งั้น PnL จะดูขัดกับราคาที่แสดง)
  const showEntry = realEntry, showExit = realExit;
  const usedFill = (position.liveEntryFill != null) || (exitFill != null);
  await tg(`${emoji} <b>${cfg.label} EXIT — ${reason}</b>\n\n` +
    `${dir.toUpperCase()} $${f(showEntry)} → $${f(showExit)}` +
    (usedFill ? ` <i>(fill จริง)</i>` : '') + `\n` +
    (usedFill ? `สัญญาณ: $${f(entry)} → $${f(exit)}\n` : '') +
    `PnL: $${f(pnl)} (${rMultiple > 0 ? '+' : ''}${rMultiple.toFixed(2)}R) ${win ? '✅' : ''}\n` +
    `ถือ: ${holdH} ชม. | MFE $${f(mfe)} MAE $${f(mae)}\n` +
    `📊 TP+2R shadow: ${tp2Hit ? `เก็บ $${f(tp2Pnl)} (${tp2Diff>=0?'+':''}$${f(tp2Diff)} vs trail)` : 'ไม่ถึง +2R (เท่า trail)'}\n` +
    ((feeReal != null || fundingLive != null)
      ? `💸 fee $${feeReal != null ? f(feeReal) : '—'}` +
        (fundingLive != null ? ` | funding ${fundingLive >= 0 ? '+' : ''}$${f(fundingLive)}${fundingLive >= 0 ? ' (ได้รับ)' : ''}` : '') + `\n`
      : '') +
    `Equity: $${f(accountEquity)} (peak $${f(peakEquity)})` +
    (openCount ? `\nยังเปิดอยู่ ${openCount} ตลาด` : ''));
  console.log(`<<< ${cfg.label} EXIT ${reason} pnl $${f(pnl)} (${rMultiple.toFixed(2)}R) equity $${f(accountEquity)}`);

  positions[symbol] = null;
  lastExitTs[symbol] = Date.now();

  // Max Drawdown Stop (คิดจาก equity รวมทั้งพอร์ต)
  const dd = (peakEquity - accountEquity) / peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    halted = true;
    await tg(`🛑 <b>MAX DRAWDOWN STOP</b>\n\nDD ${(dd*100).toFixed(1)}% เกินลิมิต ${(MAX_DRAWDOWN_PCT*100)}%\nหยุดเทรดทุกตลาด — ต้อง review ก่อนเริ่มใหม่`);
    console.log('!!! HALTED — max drawdown');
  }
}

// ═══════════════ DETAILED LOGGING ═══════════════
function logSignal(symbol, price, hi, lo, atr, distHi, distLo) {
  try {
    if (!fs.existsSync(SIGNAL_LOG)) {
      fs.writeFileSync(SIGNAL_LOG, 'timestamp,symbol,price,entry_high,entry_low,atr,dist_to_high_pct,dist_to_low_pct,has_position\n');
    }
    const row = `${new Date().toISOString()},${symbol},${price.toFixed(2)},${hi.toFixed(2)},${lo.toFixed(2)},${atr.toFixed(2)},${distHi.toFixed(2)},${distLo.toFixed(2)},${positions[symbol] ? 1 : 0}\n`;
    fs.appendFileSync(SIGNAL_LOG, row);
  } catch (e) {}
}

// ML dataset: feature ตอนเข้า + ผลลัพธ์ (สำหรับ train model อนาคต)
function logML(features, trade) {
  try {
    const record = {
      ts: new Date(trade.exitTs || Date.now()).toISOString(),
      symbol: trade.symbol, label: trade.label,
      dir: trade.dir,
      ...features,                          // rsi, obvSlope, atrPct, breakoutStrength, channelWidth, momentum
      pnl: trade.pnl,
      rMultiple: trade.rMultiple,
      win: trade.pnl > 0 ? 1 : 0,
      reason: trade.reason,
      holdHours: trade.bars,
      mfe: trade.mfe,
      mae: trade.mae,
      mfeR: trade.mfeR ?? null,
      maeR: trade.maeR ?? null,
      peakBar: trade.peakBar ?? null,
      troughBar: trade.troughBar ?? null,
      trailMoves: trade.trailMoves ?? null,
      beBar: trade.beBar ?? null,
      fundingLive: trade.fundingLive ?? null,
      fundingEstimate: trade.fundingEstimate ?? null,
      feeLive: trade.feeLive ?? null,
      pnlSource: trade.pnlSource ?? null,
      fillLatencyMs: trade.fillLatencyMs ?? null,
      slipEntryBps: trade.slipEntryBps ?? null,
      slipExitBps: trade.slipExitBps ?? null,
      efficiencyRatio: trade.efficiencyRatio ?? null,
      peakBar: trade.peakBar ?? null,
      mode: trade.mode,
      mae: trade.mae,
      tp2Hit: trade.tp2Hit, tp2Pnl: trade.tp2Pnl, tp2Diff: trade.tp2Diff  // TP+2R shadow (paper validate)
    };
    fs.appendFileSync(ML_LOG, JSON.stringify(record) + '\n');
  } catch (e) {}
}

function logTradeCSV(t) {
  try {
    if (!fs.existsSync(TRADE_CSV)) {
      fs.writeFileSync(TRADE_CSV, CSV_HEADER);
    }
    const et = new Date(t.entryTs).toISOString();
    const xt = new Date(t.exitTs).toISOString();
    const nz = v => (v === null || v === undefined) ? '' : v;
    const row = `${t.num},${t.symbol||'ETHUSDT'},${et},${xt},${t.dir},${t.entry},${t.exit},${t.qty},${t.pnl},${t.rMultiple},${t.reason},${t.bars},${t.mfe},${t.mae},${t.riskAmt},${t.atr},${t.equity},${nz(t.mode)},${nz(t.entryFill)},${nz(t.exitFill)},${nz(t.slipEntryBps)},${nz(t.slipExitBps)},${nz(t.feeLive)},${nz(t.feeEstimate)},${nz(t.pnlLive)},${nz(t.pnlEstimate)},${nz(t.pnlSource)},${nz(t.fundingLive)},${nz(t.fundingCount)},${nz(t.fundingEstimate)},${nz(t.trailMoves)},${nz(t.beBar)},${nz(t.maeR)},${nz(t.maePctEquity)},${nz(t.mfeR)},${nz(t.fillLatencyMs)},${nz(t.entryFills)},${nz(t.slPlaced)},${nz(t.efficiencyRatio)},${nz(t.peakBar)},${nz(t.troughBar)}\n`;
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

// ── รายงานวิเคราะห์ด้วย AI (ถ้าตั้ง ANTHROPIC_API_KEY) ──
// ── รายงานวิเคราะห์ (คำนวณเอง ไม่ต้องใช้ API ภายนอก) ──
async function sendAnalysis(manual = false) {
  if (!analyzer) {
    if (manual) await tg('⚠️ ไม่พบ analyzer.js บน VM');
    return;
  }
  try {
    const r = analyzer.analyze(DIR);
    await tg(r.text);
  } catch (e) {
    await logError('warn', 'ANALYSIS_FAILED', null, e.message);
    if (manual) await tg(`⚠️ วิเคราะห์ไม่สำเร็จ: ${e.message}`);
  }
}

async function sendAiReport(manual = false) {
  if (!aiReport.isEnabled()) {
    if (manual) await tg('⚠️ ยังไม่ได้ตั้ง ANTHROPIC_API_KEY ใน .env — รายงาน AI ปิดอยู่');
    return;
  }
  try {
    let exBal = null;
    if (live.isEnabled() && live.testConnection) {
      try { const c = await live.testConnection(); if (c.ok) exBal = c.balance; } catch (e) {}
    }
    const text = await aiReport.buildDailyReport({
      dir: DIR,
      equity: +accountEquity.toFixed(2),
      startEquity: +startEquity.toFixed(2),
      peakEquity: +peakEquity.toFixed(2),
      halted, positions,
      exchangeBalance: exBal,
      config: {
        markets: SYMBOLS.map(s2 => ({ symbol: s2, ...MARKETS[s2] })),
        risk_per_trade_pct: RISK_PER_TRADE * 100,
        leverage: LEVERAGE,
        max_drawdown_halt_pct: MAX_DRAWDOWN_PCT * 100,
        mode: live.modeLabel()
      },
      healthCounters: {
        api_fail_streak: health.apiFailStreak,
        order_errors: health.orderErrors,
        close_errors: health.closeErrors,
        sl_errors: health.slErrors,
        desync_alerts: health.desyncAlerts
      }
    });
    if (text) {
      await tg(`🤖 <b>รายงานวิเคราะห์ประจำวัน</b>\n\n${text}`);
      console.log('[AI] ส่งรายงานแล้ว');
    }
  } catch (e) {
    await logError('warn', 'AI_REPORT_FAILED', null, `สร้างรายงาน AI ไม่สำเร็จ: ${e.message}`);
    if (manual) await tg(`⚠️ สร้างรายงานไม่สำเร็จ: ${e.message}`);
  }
}

async function sendDailySummary() {
  const day = thDate();   // ตัดวันตามเวลาไทย
  const todayTrades = trades.filter(t => thDate(t.exitTs) === day);
  const openNow = SYMBOLS.filter(s => positions[s]);
  if (!todayTrades.length && !openNow.length) return;
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  const dd = ((peakEquity - accountEquity) / peakEquity * 100).toFixed(1);
  // แยกผลรายตลาด
  const perMarket = SYMBOLS.map(sym => {
    const tt = todayTrades.filter(t => t.symbol === sym);
    const pnl = tt.reduce((s,t)=>s+t.pnl,0);
    const p = positions[sym];
    const st = p ? `${p.dir.toUpperCase()} ${Math.round((Date.now()-p.entryTs)/3600000)}h` : 'FLAT';
    return `${MARKETS[sym].label}: ${tt.length} trades $${f(pnl)} | ${st}`;
  }).join('\n');
  await tg(`📊 <b>Daily Summary ${day}</b>\n\n` +
    `Trades วันนี้: ${todayTrades.length} (PnL $${f(todayPnl)})\n` +
    `Equity: $${f(accountEquity)} | DD ${dd}%\n\n` +
    perMarket +
    `\n\nรวมทั้งหมด: ${trades.length} trades`);
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
  // แยกรายตลาด
  const perMkt = SYMBOLS.map(sym => {
    const tt = trades.filter(t => (t.symbol||'ETHUSDT') === sym);
    if (!tt.length) return `${MARKETS[sym].label}: ยังไม่มี trade`;
    const tw = tt.filter(t=>t.pnl>0);
    const tp = tt.reduce((s,t)=>s+t.pnl,0);
    return `${MARKETS[sym].label}: ${tt.length} | WR ${(tw.length/tt.length*100).toFixed(0)}% | $${f(tp)}`;
  }).join('\n');
  return `รวม ${trades.length} | WR ${wr}% | PnL $${f(tot)}\n` +
    `Payoff ${payoff} | Kelly ${kelly}% | Avg ${avgR}R\n` +
    `ถือเฉลี่ย ${avgHold}h | DD ${dd}% (max ${ddMax}%)\n` +
    `Equity $${f(accountEquity)} (เริ่ม $${f(startEquity)}, ${((accountEquity/startEquity-1)*100).toFixed(2)}%)\n\n` +
    `── รายตลาด ──\n${perMkt}`;
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
        const openList = SYMBOLS.filter(s2 => positions[s2]);
        const pos = openList.length
          ? '\n\n📍 ' + openList.map(s2 => `${MARKETS[s2].label} ${positions[s2].dir.toUpperCase()} @ $${f(positions[s2].entry)}`).join('\n📍 ')
          : '\n\n📍 FLAT ทุกตลาด';
        await tg(`🐢 <b>Turtle Pro ${BOT_VERSION}</b> (${SYMBOLS.map(s2=>MARKETS[s2].label).join('+')})\n\n${getStats()}${pos}${halted ? '\n\n🛑 HALTED (max DD)' : ''}`);
      } else if (text === '/health' || text === '/สุขภาพ') {
        const upMin = Math.round((Date.now() - health.lastApiOk) / 60000);
        const errFile = (() => { try { return fs.readFileSync(ERROR_LOG,'utf8').trim().split('\n').filter(Boolean); } catch { return []; } })();
        const last24 = errFile.filter(l => { try { return Date.now() - new Date(JSON.parse(l).ts).getTime() < 86400000; } catch { return false; } });
        const crit = last24.filter(l => { try { return JSON.parse(l).severity === 'critical'; } catch { return false; } });
        let ex = '';
        if (live.isEnabled() && live.testConnection) {
          const c = await live.testConnection();
          ex = c.ok ? `\n💰 Binance: $${c.balance} (พร้อมใช้ $${c.available})` : `\n🔴 Binance: ต่อไม่ได้ — ${c.reason}`;
        }
        const ok = health.apiFailStreak === 0 && crit.length === 0;
        await tg(`${ok ? '💚' : '🔴'} <b>สถานะระบบ</b>\n\n` +
          `Mode: ${live.modeLabel()}${ex}\n` +
          `ข้อมูลตลาดล่าสุด: ${upMin === 0 ? 'เมื่อสักครู่' : upMin + ' นาทีที่แล้ว'}\n` +
          `API ล้มติดกัน: ${health.apiFailStreak} ครั้ง\n\n` +
          `<b>ปัญหาสะสม</b>\n` +
          `เปิดไม้ไม่ผ่าน: ${health.orderErrors}\n` +
          `ปิดไม้ไม่ออก: ${health.closeErrors}\n` +
          `วาง SL ไม่ผ่าน: ${health.slErrors}\n` +
          `ข้อมูลไม่ตรงกัน: ${health.desyncAlerts}\n` +
          `โดน rate limit: ${health.rateLimitTotal || 0} ครั้ง` +
          (Date.now() < (health.backoffUntil || 0)
            ? ` 🟡 กำลังพัก ${Math.ceil((health.backoffUntil - Date.now())/60000)} นาที`
            : (health.lastRateLimitAt ? ` (ล่าสุด ${Math.round((Date.now()-health.lastRateLimitAt)/60000)} นาทีก่อน)` : '')) + `\n` +
          `SL ปิดไม้ให้ (ปกติ): ${health.slClosedCount || 0}\n\n` +
          `error 24 ชม.: ${last24.length} (ร้ายแรง ${crit.length})\n` +
          (health.lastError ? `\nล่าสุด: ${health.lastError.kind}\n${health.lastError.tsLocal}\n${health.lastError.message.slice(0,120)}` : '\nยังไม่มี error ✅'));
      } else if (text === '/analyze' || text === '/วิเคราะห์' || text === '/a') {
        await sendAnalysis(true);
      } else if (text === '/report' || text === '/รายงาน') {
        await tg('🤖 กำลังวิเคราะห์ข้อมูล...');
        await sendAiReport(true);
      } else if (text === '/errors' || text === '/err') {
        let lines = [];
        try { lines = fs.readFileSync(ERROR_LOG,'utf8').trim().split('\n').filter(Boolean).slice(-10); } catch {}
        if (!lines.length) { await tg('✅ ยังไม่มี error บันทึกไว้'); }
        else {
          const body = lines.reverse().map(l => {
            try { const e = JSON.parse(l);
              const ic = e.severity==='critical'?'🔴':e.severity==='warn'?'⚠️':'ℹ️';
              return `${ic} <b>${e.kind}</b> ${e.symbol||''}\n${e.tsLocal}\n${e.message.slice(0,100)}`;
            } catch { return ''; }
          }).filter(Boolean).join('\n\n');
          await tg(`📋 <b>10 ปัญหาล่าสุด</b>\n\n${body}`);
        }
      } else if (text.startsWith('/sync_')) {
        const arg = text.slice(6).toLowerCase();
        const sym = SYMBOLS.find(s2 => MARKETS[s2].label.toLowerCase() === arg);
        if (!sym) { await tg('ไม่พบเหรียญนี้'); }
        else if (!positions[sym]) { await tg(`${MARKETS[sym].label} ไม่มี position ในระบบอยู่แล้ว`); }
        else {
          let exPos = null, checkFailed = false;
          if (live.isEnabled() && live.getPositionLive) {
            try { exPos = await live.getPositionLive(sym); }
            catch (e) { checkFailed = true; }
          }
          if (checkFailed) { await tg(`⚠️ เช็ค Binance ไม่ได้ตอนนี้ — ไม่ล้าง position เพื่อความปลอดภัย ลองใหม่อีกครั้ง`); }
          else
          if (exPos) { await tg(`⚠️ Binance ยังมี position อยู่ (${exPos.dir} ${exPos.qty})\nไม่ล้างให้ — ปิดใน Binance ก่อน`); }
          else {
            const p = positions[sym];
            positions[sym] = null; saveState();
            await logError('info','MANUAL_SYNC',sym,`ล้าง position ออกจากระบบด้วยมือ (${p.dir} @ ${p.entry})`);
            await tg(`✅ ล้าง ${MARKETS[sym].label} ออกจากระบบแล้ว\n(Binance ไม่มี position — ตรงกันแล้ว)`);
          }
        }
      } else if (text === '/position' || text === '/pos') {
        const prices = {};
        for (const sym of SYMBOLS) { try { prices[sym] = await fetchPrice(sym); } catch {} }
        await tg(buildAllPositionsReport(prices));
      } else if (text === '/close' || text === '/exit') {
        const openList = SYMBOLS.filter(s2 => positions[s2]);
        if (!openList.length) {
          await tg('📍 ไม่มี position ให้ปิด (FLAT ทุกตลาด)');
        } else {
          const lines = openList.map(s2 => `/close_${MARKETS[s2].label.toLowerCase()} → ปิด ${MARKETS[s2].label} ${positions[s2].dir.toUpperCase()} @ $${f(positions[s2].entry)}`);
          await tg(`⚠️ <b>เลือกตลาดที่จะปิด</b>\n\n${lines.join('\n')}\n\n/close_all → ปิดทุกตลาด`);
        }
      } else if (text.startsWith('/close_')) {
        const arg = text.slice(7).toLowerCase();
        const targets = arg === 'all'
          ? SYMBOLS.filter(s2 => positions[s2])
          : SYMBOLS.filter(s2 => MARKETS[s2].label.toLowerCase() === arg && positions[s2]);
        if (!targets.length) {
          await tg('📍 ไม่พบ position ที่ตรงกับคำสั่ง');
        } else {
          for (const sym of targets) {
            let price = positions[sym].entry;
            try { price = await fetchPrice(sym); } catch {}
            await closePosition(sym, price, 'MANUAL_CLOSE');
          }
          saveState();
          await tg(`✅ ปิด ${targets.map(s2=>MARKETS[s2].label).join(', ')} แล้ว (manual)`);
        }
      } else if (text === '/export' || text === '/log') {
        // สร้าง CSV วิเคราะห์ละเอียด — จับคู่ด้วย trade number (แม่นยำ 100%)
        await tg('📊 กำลังสร้างไฟล์วิเคราะห์...');
        try {
          // อ่าน ml file — จับคู่ indicator
          let mlRows = [];
          try { mlRows = fs.readFileSync(ML_LOG,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)); } catch {}
          const mlByTs = {};
          mlRows.forEach(m => { if (m.ts) mlByTs[m.ts] = m; });

          // อ่าน csv file — แหล่ง timestamp สำรอง (trade เก่าอาจไม่มี entryTs ใน record)
          const csvTimeByNum = {};
          try {
            const csvLines = fs.readFileSync(TRADE_CSV,'utf8').trim().split('\n');
            csvLines.slice(1).forEach(line => {
              const c = line.split(',');
              if (c[0] && /^\d+$/.test(c[0])) csvTimeByNum[c[0]] = { entry: c[1], exit: c[2] };  // num → {entry_time, exit_time}
            });
          } catch {}

          let csv = 'num,symbol,entry_time,exit_time,dir,entry,exit,pnl,R,reason,held_h,mfe,mae,peakPrice,tradesSurge,tp2Hit,tp2Pnl,tp2Diff,equity,mode,entry_fill,exit_fill,slip_entry_bps,slip_exit_bps,sl_placed,efficiency_ratio,peak_bar\n';
          let matchedSurge = 0, unmatchedSurge = 0;
          trades.forEach(t => {
            // จับคู่ ml — วิธี 1: exitTs ตรงเป๊ะ / วิธี 2: fallback ตรวจ dir+pnl ให้ตรง
            let m = {};
            const isoTs = t.exitTs ? new Date(t.exitTs).toISOString() : null;
            if (isoTs && mlByTs[isoTs]) {
              m = mlByTs[isoTs];  // ตรงเป๊ะด้วย timestamp
            } else {
              // fallback: หา ml ที่ dir+pnl ตรงกัน (unique พอสำหรับ trade เก่า)
              const cand = mlRows.filter(r => r.dir===t.dir && Math.abs((r.pnl??1e9)-t.pnl)<0.01);
              if (cand.length === 1) m = cand[0];  // ตรงตัวเดียว = มั่นใจ
              // ถ้าเจอหลายตัว (pnl ซ้ำ) = ไม่จับคู่ (ปล่อยว่าง ดีกว่าผิด)
            }
            const surge = m.tradesSurge;
            if (surge != null) matchedSurge++; else unmatchedSurge++;
            // timestamp: จาก record ก่อน (แม่นสุด) → fallback csv file
            let entryT = t.entryTs ? new Date(t.entryTs).toISOString() : '';
            let exitT = t.exitTs ? new Date(t.exitTs).toISOString() : '';
            if (!entryT && csvTimeByNum[t.num]) entryT = csvTimeByNum[t.num].entry;
            if (!exitT && csvTimeByNum[t.num]) exitT = csvTimeByNum[t.num].exit;
            csv += [t.num, t.symbol||'ETHUSDT', entryT, exitT, t.dir, t.entry, t.exit, t.pnl, t.rMultiple, t.reason, t.bars,
                    t.mfe, t.mae, t.peakPrice??'', surge??'', t.tp2Hit??'', t.tp2Pnl??'', t.tp2Diff??'', t.equity,
                    t.mode??'', t.entryFill??'', t.exitFill??'', t.slipEntryBps??'', t.slipExitBps??'',
                    t.slPlaced??'', t.efficiencyRatio??'', t.peakBar??''].join(',') + '\n';
          });

          // ── SUMMARY (คำนวณจาก trades จริงเท่านั้น — ไม่พึ่ง ml) ──
          const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<=0);
          const net = trades.reduce((s,t)=>s+t.pnl,0);
          const grossW = wins.reduce((s,t)=>s+t.pnl,0), grossL = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
          const longs = trades.filter(t=>t.dir==='long'), shorts = trades.filter(t=>t.dir==='short');
          const longPnl = longs.reduce((s,t)=>s+t.pnl,0), shortPnl = shorts.reduce((s,t)=>s+t.pnl,0);
          const avgR = trades.length ? trades.reduce((s,t)=>s+(t.rMultiple||0),0)/trades.length : 0;
          const bestR = trades.reduce((mx,t)=>Math.max(mx,t.rMultiple||0),0);
          const worstR = trades.reduce((mn,t)=>Math.min(mn,t.rMultiple||0),0);

          csv += '\n--- SUMMARY ---\n';
          csv += `total_trades,${trades.length}\n`;
          csv += `wins,${wins.length}\nlosses,${losses.length}\n`;
          csv += `win_rate,${trades.length?(wins.length/trades.length*100).toFixed(1):0}%\n`;
          csv += `net_pnl,${net.toFixed(2)}\n`;
          csv += `gross_win,${grossW.toFixed(2)}\ngross_loss,${grossL.toFixed(2)}\n`;
          csv += `profit_factor,${grossL>0?(grossW/grossL).toFixed(2):'inf'}\n`;
          csv += `avg_win,${wins.length?(grossW/wins.length).toFixed(2):0}\n`;
          csv += `avg_loss,${losses.length?(grossL/losses.length).toFixed(2):0}\n`;
          csv += `avg_R,${avgR.toFixed(3)}\nbest_R,${bestR.toFixed(2)}\nworst_R,${worstR.toFixed(2)}\n`;
          csv += `long_trades,${longs.length}\nlong_pnl,${longPnl.toFixed(2)}\n`;
          csv += `short_trades,${shorts.length}\nshort_pnl,${shortPnl.toFixed(2)}\n`;
          csv += `equity,${accountEquity.toFixed(2)}\npeak_equity,${peakEquity.toFixed(2)}\n`;
          csv += '\n--- PER MARKET ---\n';
          SYMBOLS.forEach(sym => {
            const tt = trades.filter(t => (t.symbol||'ETHUSDT') === sym);
            const tw = tt.filter(t=>t.pnl>0);
            csv += `${MARKETS[sym].label}_trades,${tt.length}\n`;
            csv += `${MARKETS[sym].label}_pnl,${tt.reduce((a,t)=>a+t.pnl,0).toFixed(2)}\n`;
            csv += `${MARKETS[sym].label}_win_rate,${tt.length?(tw.length/tt.length*100).toFixed(1):0}%\n`;
          });
          csv += `max_drawdown,${peakEquity>0?((peakEquity-accountEquity)/peakEquity*100).toFixed(1):0}%\n`;
          // ── DATA INTEGRITY (ตรวจความครบถ้วน) ──
          csv += '\n--- DATA INTEGRITY ---\n';
          csv += `trades_in_record,${trades.length}\n`;
          csv += `ml_rows,${mlRows.length}\n`;
          csv += `surge_matched,${matchedSurge}\nsurge_unmatched,${unmatchedSurge}\n`;
          const missingTime = trades.filter(t => !t.entryTs && !csvTimeByNum[t.num]).length;
          csv += `trades_missing_timestamp,${missingTime}\n`;
          const netCheck = Math.abs((1000 + net) - accountEquity) < 1;
          csv += `equity_reconciles,${netCheck?'OK':'MISMATCH ($1000+net='+(1000+net).toFixed(2)+' vs equity='+accountEquity.toFixed(2)+')'}\n`;

          const ts = thNow().toISOString().slice(0,16).replace(/[:T]/g,'-');
          const warn = (!netCheck || unmatchedSurge>0) ? '\n⚠️ เช็ค DATA INTEGRITY ในไฟล์' : '\n✅ ข้อมูลครบถ้วน';
          await tgDocument(`eth_turtle_analysis_${ts}.csv`, csv,
            `📊 ETH Turtle วิเคราะห์\nTrades: ${trades.length} | WR: ${trades.length?(wins.length/trades.length*100).toFixed(0):0}% | Net: $${net.toFixed(2)}\nEquity: $${accountEquity.toFixed(2)} | DD: ${peakEquity>0?((peakEquity-accountEquity)/peakEquity*100).toFixed(1):0}%${warn}`);
        } catch (e) {
          await tg('❌ export ล้มเหลว: ' + e.message);
        }
      } else if (text === '/resume' && halted) {
        halted = false; peakEquity = accountEquity;
        await tg('▶️ Resume — เริ่มเทรดใหม่ (reset peak)');
        saveState();
      } else if (text === '/reset') {
        SYMBOLS.forEach(s2 => positions[s2] = null); trades = []; accountEquity = ACCOUNT_SIZE; startEquity = ACCOUNT_SIZE; peakEquity = ACCOUNT_SIZE; halted = false;
        await tg('🔄 Reset — เริ่มใหม่ทั้งหมด');
        saveState();
      }
    }
  } catch (e) {}
}

// ═══════════════ HTTP SERVER ═══════════════
const PORT = process.env.DONCHIAN_PORT || 3100;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

const LOGIN_PAGE = `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Turtle Pro</title>
<style>
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F5F0E6;color:#3E2F1C;
display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
.box{background:#C4A878;border:1px solid #A8895E;border-radius:16px;padding:28px;max-width:340px;width:100%;text-align:center}
.turtle{font-size:44px;margin-bottom:10px}
h1{font-size:19px;margin:0 0 6px}
p{font-size:13px;color:#6B5544;margin:0 0 18px}
input{width:100%;padding:13px;border:1px solid #A8895E;border-radius:10px;font-size:16px;
background:#F5F0E6;color:#3E2F1C;box-sizing:border-box;margin-bottom:11px;font-family:inherit}
button{width:100%;padding:13px;border:0;border-radius:10px;background:#3E2F1C;color:#F5F0E6;
font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
button:active{opacity:.85}
.err{color:#B5543A;font-size:13px;margin-top:11px;min-height:18px}
</style></head><body>
<div class="box">
  <div class="turtle">🐢</div>
  <h1>Turtle Pro</h1>
  <p>ใส่รหัสผ่านเพื่อเข้าดู</p>
  <input type="password" id="t" placeholder="รหัสผ่าน" autocomplete="current-password">
  <button onclick="go()">เข้าสู่ระบบ</button>
  <div class="err" id="e"></div>
</div>
<script>
const saved = localStorage.getItem('turtle_token');
if (saved) location.replace('/ui?t=' + encodeURIComponent(saved));
async function go(){
  const v = document.getElementById('t').value.trim();
  if (!v) return;
  const r = await fetch('/dashboard?t=' + encodeURIComponent(v));
  if (r.ok) { localStorage.setItem('turtle_token', v); location.replace('/ui?t=' + encodeURIComponent(v)); }
  else { document.getElementById('e').textContent = 'รหัสไม่ถูกต้อง'; localStorage.removeItem('turtle_token'); }
}
document.getElementById('t').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
</script></body></html>`;

// cache ราคา+channel ล่าสุด (อัพเดตทุก checkSignal)
let dashCache = {};   // { ETHUSDT: {price, channel, atr, updatedAt}, SOLUSDT: {...} }

function buildDashboardData() {
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

  // ข้อมูลรายตลาด
  const markets = {};
  let totalFloat = 0;
  for (const sym of SYMBOLS) {
    const cfg = MARKETS[sym];
    const p = positions[sym];
    const cache = dashCache[sym] || {};
    let posData = null;
    if (p) {
      const price = cache.price || p.entry;
      const floatPnl = p.dir==='long' ? (price-p.entry)*p.qty : (p.entry-price)*p.qty;
      totalFloat += floatPnl;
      const locked = p.dir==='long' ? p.sl>p.entry : p.sl<p.entry;
      const lockedPnl = locked ? (p.dir==='long' ? (p.sl-p.entry)*p.qty : (p.entry-p.sl)*p.qty) : 0;
      posData = {
        dir: p.dir, entry: p.entry, price, sl: p.sl, peak: p.peak, qty: p.qty,
        heldH: Math.round((Date.now()-p.entryTs)/3600000),
        floatPnl: +floatPnl.toFixed(2), lockedPnl: +lockedPnl.toFixed(2),
        riskAmt: p.riskAmt, beDone: !!p.beDone, features: p.features || null
      };
    }
    const mt = trades.filter(t => (t.symbol||'ETHUSDT') === sym);
    const mw = mt.filter(t => t.pnl>0);
    markets[sym] = {
      label: cfg.label,
      config: { entryPeriod: cfg.entryPeriod, exitPeriod: cfg.exitPeriod,
                trailATR: cfg.trailATR, breakevenAtR: cfg.breakevenAtR },
      price: cache.price ? +cache.price.toFixed(2) : null,
      atr: cache.atr ?? null,
      channel: cache.channel || null,
      updatedAt: cache.updatedAt || 0,
      position: posData,
      stats: {
        trades: mt.length,
        wr: mt.length ? Math.round(mw.length/mt.length*100) : 0,
        pnl: +mt.reduce((a,t)=>a+t.pnl,0).toFixed(2)
      }
    };
  }

  return {
    mode: live.modeLabel(),
    liveEnabled: live.isEnabled(),
    health: {
      ok: health.apiFailStreak === 0 && health.closeErrors === 0 && health.desyncAlerts === 0
        && Date.now() >= (health.backoffUntil || 0),
      apiFailStreak: health.apiFailStreak,
      minsSinceData: Math.round((Date.now() - health.lastApiOk) / 60000),
      orderErrors: health.orderErrors,
      closeErrors: health.closeErrors,
      slErrors: health.slErrors,
      desyncAlerts: health.desyncAlerts,
      slClosedByExchange: health.slClosedCount || 0,
      rateLimitHits: health.rateLimitHits || 0,
      rateLimitTotal: health.rateLimitTotal || 0,
      rateLimitedNow: Date.now() < (health.backoffUntil || 0),
      backoffMinsLeft: Date.now() < (health.backoffUntil || 0)
        ? Math.ceil((health.backoffUntil - Date.now()) / 60000) : 0,
      lastError: health.lastError ? { kind: health.lastError.kind, ts: health.lastError.tsLocal, severity: health.lastError.severity } : null
    },
    version: BOT_VERSION,
    symbols: SYMBOLS,
    equity: +accountEquity.toFixed(2),
    start: +startEquity.toFixed(2),
    peakEquity: +peakEquity.toFixed(2),
    floatPnl: +totalFloat.toFixed(2),
    halted,
    markets,
    stats: {
      wr: trades.length ? Math.round(W*100) : 0,
      kelly: kelly==null ? null : Math.round(kelly),
      payoff: +payoff.toFixed(2),
      avgR: +avgR.toFixed(2),
      maxDD: +Math.max(mdd*100, curDD).toFixed(1),
      trades: trades.length
    },
    trades: trades.map(t => ({
      n: t.num, symbol: t.symbol||'ETHUSDT', label: t.label || (MARKETS[t.symbol]?.label) || 'ETH',
      dir: t.dir, entry: t.entry, exit: t.exit,
      pnl: t.pnl, r: t.rMultiple, reason: t.reason==='DONCHIAN_EXIT'?'DONCHIAN':'TRAIL_SL',
      held: t.bars, mfe: t.mfe, peakPrice: t.peakPrice,
      entryTs: t.entryTs, exitTs: t.exitTs
    })),
    updatedAt: Math.max(...SYMBOLS.map(s2 => dashCache[s2]?.updatedAt || 0), 0)
  };
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'ngrok-skip-browser-warning, Content-Type, X-Dashboard-Token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');
  const route = url.pathname;

  // ── ตรวจ token (ถ้าตั้งไว้) — รับได้ทั้ง header และ query ?t= ──
  // ไม่ตั้ง DASHBOARD_TOKEN = เปิดสาธารณะเหมือนเดิม (เตือนตอน start)
  function authorized() {
    if (!DASHBOARD_TOKEN) return true;
    const given = req.headers['x-dashboard-token'] || url.searchParams.get('t') || '';
    if (given.length !== DASHBOARD_TOKEN.length) return false;
    // เทียบแบบ constant-time กัน timing attack
    let diff = 0;
    for (let i = 0; i < DASHBOARD_TOKEN.length; i++) diff |= given.charCodeAt(i) ^ DASHBOARD_TOKEN.charCodeAt(i);
    return diff === 0;
  }
  function deny() {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized', message: 'ต้องใส่รหัสผ่าน' }));
  }

  if (route === '/ping') {
    // เช็คว่าบอทยังมีชีวิต — ไม่เปิดเผยข้อมูลอะไร (ใช้กับ uptime monitor ได้)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: BOT_VERSION, needAuth: !!DASHBOARD_TOKEN }));
    return;
  }

  if (route === '/health') {
    if (!authorized()) return deny();
    const open = SYMBOLS.filter(s2 => positions[s2]).map(s2 => ({ symbol: s2, dir: positions[s2].dir }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: BOT_VERSION, mode: live.modeLabel(),
      equity: +accountEquity.toFixed(2), startEquity: +startEquity.toFixed(2),
      trades: trades.length, positions: open, halted,
      apiFailStreak: health.apiFailStreak
    }));
    return;
  }

  if (route === '/ui' || route === '/') {
    if (!authorized()) {
      // ส่งหน้าใส่รหัสแทน (ไม่ใช่ 401 เปล่าๆ)
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
      return;
    }
    try {
      const html = fs.readFileSync(DIR + '/turtle-dashboard.html', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ไม่พบ turtle-dashboard.html บน VM');
    }
    return;
  }

  if (route === '/dashboard') {
    if (!authorized()) return deny();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDashboardData()));
    return;
  }

  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`ETH Turtle Pro server :${PORT} (/health /dashboard)`));

// ── กัน process ตายจาก error ที่ไม่ได้จับ ──
// บอทมี position เปิดอยู่ ถ้าตายกลางทาง = ไม่มีใคร trail/ปิด
// (PM2 restart ให้ แต่ระหว่างนั้นมองไม่เห็นตลาด)
process.on('unhandledRejection', async (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('🔴 unhandledRejection:', msg);
  try { await logError('critical', 'UNHANDLED_REJECTION', null, `error ที่ไม่ได้จับ: ${msg.slice(0, 200)}`); } catch (e) {}
});
process.on('uncaughtException', async (err) => {
  console.error('🔴 uncaughtException:', err && err.message);
  try {
    await logError('critical', 'UNCAUGHT_EXCEPTION', null, `error ร้ายแรง: ${(err && err.message || '').slice(0, 200)}`);
    saveState();
  } catch (e) {}
  // ไม่ exit — ปล่อยให้ loop ทำงานต่อ (position ยังต้องมีคนดูแล)
});

// ═══════════════ STARTUP ═══════════════
loadState();
const mktSummary = SYMBOLS.map(s2 => {
  const c = MARKETS[s2];
  return `${c.label}: D${c.entryPeriod}/x${c.exitPeriod}/ATR×${c.trailATR}/BE+${c.breakevenAtR}R`;
}).join('\n');
console.log(`🐢 Turtle Pro ${BOT_VERSION} — Multi-Market (${SYMBOLS.map(s2=>MARKETS[s2].label).join('+')})`);
console.log(mktSummary.split('\n').map(x=>'   '+x).join('\n'));
if (!DASHBOARD_TOKEN) console.log('⚠️  ไม่ได้ตั้ง DASHBOARD_TOKEN — dashboard เปิดสาธารณะ (ใครมี URL ก็ดูได้)');
else console.log('🔒 dashboard ล็อกด้วยรหัสผ่านแล้ว');
console.log(`Risk ${(RISK_PER_TRADE*100).toFixed(2)}%/trade (equity รวม) | MaxDD ${MAX_DRAWDOWN_PCT*100}% | Equity $${accountEquity.toFixed(2)} | Mode: ${live.modeLabel()}`);
if (live.isEnabled()) { live.setLeverage(SYMBOLS); }

// ── LIVE/TESTNET: sync equity + position จริงจาก Binance ตอนเริ่ม ──
if (live.isEnabled() && live.testConnection) {
  (async () => {
    // ห่อ try ทั้งบล็อก — ถ้า throw ตอน start จะเป็น unhandled rejection ทำ process ล้ม
    let conn;
    try { conn = await live.testConnection(); }
    catch (e) {
      await logError('critical', 'STARTUP_CONNECT_FAIL', null,
        `เชื่อมต่อ Binance ตอนเริ่มไม่ได้: ${e.message} — บอทยังรันต่อ จะลองใหม่ใน reconcile`);
      return;
    }
    if (conn.ok) {
      console.log(`[LIVE] เชื่อมต่อ ${conn.mode || live.modeLabel()} สำเร็จ | balance ${conn.balance} USDT | available ${conn.available}`);
      // sync equity จาก balance จริง (ครั้งแรกเท่านั้น — ถ้า state ยังเป็นค่า default)
      if (accountEquity === ACCOUNT_SIZE && conn.balance > 0) {
        accountEquity = conn.balance;
        peakEquity = conn.balance;
        startEquity = conn.balance;   // ทุนเริ่มต้นจริง
        console.log(`[LIVE] sync equity → $${conn.balance} (จาก testnet balance)`);
      }
      // ── รับช่วง SL order ที่ค้างอยู่ (สำคัญตอน restart กลางไม้) ──
      if (live.adoptStopOrders) {
        const openSyms = SYMBOLS.filter(s2 => positions[s2]);
        if (openSyms.length) {
          const adopted = await live.adoptStopOrders(openSyms);
          for (const [sym, info] of Object.entries(adopted)) {
            console.log(`[LIVE] ${sym} รับช่วง SL order ${info.orderId} @ $${info.stopPrice}`);
            positions[sym].stopOrderId = info.orderId;
            positions[sym].slPlaced = true;
            if (info.duplicates > 0) {
              await logError('warn', 'DUP_STOP_SWEPT', sym,
                `พบ SL ซ้ำ ${info.duplicates} อัน (จาก restart ก่อนหน้า) — ลบทิ้งแล้ว`);
            }
          }
          // position ที่ไม่มี SL บน exchange เลย = อันตราย
          for (const sym of openSyms) {
            if (!adopted[sym]) {
              positions[sym].slPlaced = false;
              await logError('critical', 'NO_STOP_ON_RESTART', sym,
                `เปิด ${positions[sym].dir.toUpperCase()} อยู่ แต่ไม่มี SL order บน Binance — bot จะปิดเองถ้าถึง SL`);
            }
          }
        }
      }
      // เช็ค position ค้างบน Binance (กัน bot กับ exchange ไม่ตรงกัน)
      for (const sym of SYMBOLS) {
        let livePos = null;
        try { livePos = await live.getPositionLive(sym); }
        catch (e) { await logError('warn', 'API_CHECK_FAIL', sym, e.message); continue; }
        if (livePos && !positions[sym]) {
          console.log(`[LIVE] ⚠️ พบ position ${sym} บน Binance แต่ bot ไม่มี record: ${livePos.dir} ${livePos.qty} @ $${livePos.entry}`);
          await tg(`⚠️ <b>${MARKETS[sym].label}: พบ position ค้างบน Binance</b>\n${livePos.dir.toUpperCase()} ${livePos.qty} @ $${livePos.entry}\n\nแนะนำปิดเองใน Binance ก่อน หรือ /close_${MARKETS[sym].label.toLowerCase()}`);
        }
      }
      await tg(`🔗 <b>เชื่อมต่อ ${conn.mode || live.modeLabel()}</b>\nBalance: ${conn.balance} USDT\nAvailable: ${conn.available} USDT`);
    } else {
      console.error(`[LIVE] เชื่อมต่อล้มเหลว: ${conn.reason}`);
      await tg(`🔴 <b>เชื่อมต่อ Binance ล้มเหลว</b>\n${conn.reason}\n\nเช็ค API key/secret ใน .env`);
    }
  })();
}

const modeWarning = live.isEnabled()
  ? `\n\n🔴 <b>LIVE MODE: ${live.modeLabel()}</b> — ส่ง order จริง!`
  : `\n\n⚠️ PAPER MODE (ยังไม่ส่ง order จริง)`;
tg(`🐢 <b>Turtle Pro ${BOT_VERSION} เริ่มทำงาน</b>\n\n` +
   `<b>Markets:</b>\n${mktSummary}\n\n` +
   `Risk: ${(RISK_PER_TRADE*100).toFixed(2)}%/trade (equity รวม)\nMaxDD: ${MAX_DRAWDOWN_PCT*100}%\n` +
   `Equity: $${accountEquity.toFixed(2)}${modeWarning}`);

// ตรวจความตรงกันกับ Binance ทุก 15 นาที
if (live.isEnabled()) {
  setTimeout(() => { reconcile(); setInterval(reconcile, 20 * 60 * 1000); }, 60000);   // ทุก 20 นาที — SL อยู่บน exchange แล้ว ไม่ต้องเช็คถี่ (rate limit)
}

// loop ทุก 1 นาที — เช็คทุกตลาด
checkAllMarkets();
setInterval(checkAllMarkets, 60 * 1000);
setInterval(pollTelegram, 3000);
setInterval(saveState, 60 * 1000);

// Daily summary ทุกวัน 20:00 ไทย (13:00 UTC)
let lastSummaryDay = '';
setInterval(async () => {
  const now = new Date();
  const utcH = now.getUTCHours();
  const day = thDate();
  if (utcH === 13 && day !== lastSummaryDay) {
    lastSummaryDay = day;
    await sendDailySummary();
    await sendAnalysis();      // วิเคราะห์เอง (ไม่ต้องใช้ API)
    await sendAiReport();      // AI เสริม (ถ้ามี ANTHROPIC_API_KEY)
  }
}, 5 * 60 * 1000);
