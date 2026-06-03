// ETH Cone Bot v3.33
// ⚠️ Rule: ทุกครั้งที่ update Dashboard ต้อง update version บรรทัดนี้ด้วย
// 🔗 Logic: ดึงจาก logic.js — แก้ที่ logic.js เท่านั้น

const BOT_VERSION = 'v3.33'; // ← แก้ที่นี่ที่เดียว
const DASH_VERSION = 'v5.32';

const BOT_TOKEN = process.env.TG_TOKEN || '';
const CHAT_ID   = process.env.TG_CHAT  || '';
const BINANCE   = 'https://fapi.binance.com';
const FG_API    = 'https://api.alternative.me/fng/?limit=1';
const fs        = require('fs');
const http      = require('http');
const path      = require('path');

// ── Load Logic from GitHub (ตอน startup เท่านั้น) ──
const LOGIC_URL  = 'https://raw.githubusercontent.com/upperpulse/Eth-cone-upp/main/logic.js';
const LOGIC_PATH = path.join(__dirname, 'logic.js');

let calcMACD, calcRSI, calcOBV, calcATR, calcTrap, calcConfidence, calcSignal, calcTriggers, calcBestDirection, detectPreBurst;

async function loadLogic() {
  try {
    const r = await fetch(LOGIC_URL);
    if (r.ok) {
      const code = await r.text();
      fs.writeFileSync(LOGIC_PATH, code);
      console.log('✅ logic.js loaded from GitHub');
    }
  } catch(e) {
    console.log('⚠️ GitHub unavailable, using local logic.js');
  }
  delete require.cache[require.resolve(LOGIC_PATH)];
  const logic = require(LOGIC_PATH);
  calcMACD = logic.calcMACD;
  calcRSI = logic.calcRSI;
  calcOBV = logic.calcOBV;
  calcATR = logic.calcATR;
  calcTrap = logic.calcTrap;
  calcConfidence = logic.calcConfidence;
  calcSignal = logic.calcSignal;
  calcTriggers = logic.calcTriggers;
  calcBestDirection = logic.calcBestDirection;
  detectPreBurst = logic.detectPreBurst;
  console.log(`✅ Logic v${logic.version} ready`);
}

// ── Config ────────────────────────────────
const AUTO_TRADE_TARGET = 10;   // รอบที่ต้องการ (default)
let AUTO_TRADE_TARGET_DYNAMIC = 10;
let autoTradeEnabled = false; // ปรับได้จาก Dashboard
const AUTO_DURATION_MS  = 7200000; // 2H
const AUTO_SIZE         = 100;  // $100
// ── ENGINE B — Burst Hunter (v3.30) ──
const BURST_ENABLED     = true;
const BURST_SIZE        = 100;       // $100 เท่า Engine A
const BURST_TP_MULT     = 4.5;       // TP ใหญ่ (burst วิ่งแรง)
const BURST_SL_MULT     = 0.5;       // SL แคบ (ไม่ทะลุ = ออกเร็ว)
const BURST_DURATION_MS = 2700000;   // 45 นาที (สั้น)
const BURST_STRENGTH_MIN = 80;       // strength ขั้นต่ำ
const BURST_COOLDOWN_MS = 1800000;   // 30 นาที

// ── Trade Mode Config ──────────────────────────
const TRADE_MODE = 'paper';
const SUMMARY_START_TS = 1779033600000; // ~16 พ.ค. — เริ่มนับ summary จาก R9  // 'paper' = จำลอง | 'live' = เทรดจริง Binance
// Binance API config (ใช้ตอน TRADE_MODE='live' — ยังไม่เปิดใช้)
// TRADE_MODE: 'paper' (จำลอง) | 'testnet' (Binance Testnet เงินปลอม) | 'live' (เงินจริง)
const IS_TESTNET = TRADE_MODE === 'testnet';
const IS_REAL_ORDER = TRADE_MODE === 'testnet' || TRADE_MODE === 'live';
const BINANCE_CONFIG = {
  apiKey:    IS_TESTNET ? (process.env.BINANCE_TESTNET_KEY    || '') : (process.env.BINANCE_API_KEY    || ''),
  apiSecret: IS_TESTNET ? (process.env.BINANCE_TESTNET_SECRET || '') : (process.env.BINANCE_API_SECRET || ''),
  baseURL:   IS_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com',
  symbol:    'ETHUSDT',
  testnet:   IS_TESTNET
};
const LEVERAGE = 3;          // เลเวอเรจ (global)
// ── Fee & Slippage (v3.33) ──
const TAKER_FEE = 0.0004;    // 0.04% Binance Futures taker fee
const EST_SLIPPAGE = 0.0002; // 0.02% slippage โดยประมาณ (market order)
// คำนวณ fee รวม (entry + exit) สำหรับ position
function calcFees(entry, exit, qty) {
  const entryFee = entry * qty * TAKER_FEE;
  const exitFee = exit * qty * TAKER_FEE;
  return entryFee + exitFee;
}
// ปรับ PnL ให้สมจริง (หัก fee + slippage) — ใช้ทั้ง paper และ live
function netPnl(grossPnl, entry, exit, qty) {
  const fees = calcFees(entry, exit, qty);
  const slip = entry * qty * EST_SLIPPAGE;  // slippage ตอนเข้า
  return grossPnl - fees - slip;
}
// ดึง realized PnL จริงจาก Binance (live mode)
async function getBinanceRealizedPnl(sym, sinceTs) {
  if (!IS_REAL_ORDER) return null;
  try {
    const ts = Date.now();
    const qs = `symbol=${sym}&startTime=${sinceTs}&timestamp=${ts}`;
    const sig = signRequest(qs);
    const r = await fetch(`${BINANCE_CONFIG.baseURL}/fapi/v1/income?${qs}&signature=${sig}&incomeType=REALIZED_PNL`, {
      headers: { 'X-MBX-APIKEY': BINANCE_CONFIG.apiKey }
    });
    const data = await r.json();
    if (Array.isArray(data)) {
      return data.reduce((sum, x) => sum + parseFloat(x.income || 0), 0);
    }
  } catch(e) { console.log('realized pnl err', e.message); }
  return null;
}

// Micro-Momentum — เก็บราคา tick ล่าสุดเช็คก่อนเข้า
let tickHistory = [];
let pullbackPending = false;
let pullbackDir = 'short';
let pullbackStartPrice = 0;
let pullbackStartTime = 0;
// Engine B state
let burstActive = false;
let burstTrades = [];
let burstLastEndTime = 0;
const BURST_FILE = '/home/ubuntu/eth-bot/burst_trades.json';
try { burstTrades = JSON.parse(fs.readFileSync(BURST_FILE,'utf8')); } catch { burstTrades = []; }
function saveBurstTrades(){ try { fs.writeFileSync(BURST_FILE, JSON.stringify(burstTrades,null,2)); } catch(e){ console.log('burst save err',e.message); } }        // {price, ts} 12 ตัวล่าสุด (~2 นาที)
const MICRO_LOOKBACK = 6;    // เช็ค 6 ticks (60 วินาที)
const MICRO_THRESHOLD = 0.0012; // 0.12% — ถ้าราคาวิ่งสวนเกินนี้ → รอ
const PULLBACK_ENABLED = true;     // v3.29 Entry Timing Refinement
const PULLBACK_TARGET = 0.0010;    // 0.10% — รอราคาย่อกลับก่อนเข้า
const PULLBACK_MAX_WAIT = 90000;   // รอ pullback ไม่เกิน 90 วินาที
let GLOBAL_SL_AMOUNT    = 0;    // Paper Global SL ($) — 0 = ปิด
let globalSLActive      = false;
let dailyPnL            = 0;    // PnL รวมวันนี้
const ATR_MULT_TP1      = 1.5;  // TP1 = entry ± ATR*1.5
const ATR_MULT_TP2      = 3.0;  // TP2 = entry ± ATR*3.0
const ATR_MULT_SL       = 0.75; // SL  = entry ∓ ATR*0.75
const TRAIL_BREAKEVEN   = 0.3;   // ขยับ SL → breakeven เมื่อ maxP > TP1×30%
const TRAIL_LOCK        = 0.6;   // ขยับ SL → TP1×40% เมื่อ maxP > TP1×60%
const TRAIL_PROFIT_LOCK = 0.5;   // v3.32: เมื่อ maxP > $1 → ล็อก 50% ของ maxP (กันกำไรหลุด)
const TRAIL_PROFIT_MIN  = 1.0;   // เริ่ม profit lock เมื่อ maxP > $1.0
const PARTIAL_TP_RATIO  = 0.5;   // ปิด 50% เมื่อถึง TP1
const TRADE_COOLDOWN_MS = 1800000; // 30 นาที cooldown หลัง trade จบ

// ── State ─────────────────────────────────
let lastSig = '';
let lastConfAlert = false;
let goCooldown = 0;
let softGoCooldown = 0;
let fgCache = { val: 50, ts: 0 };
let tradeState = null;
let tradeInterval = null;
let autoTradeActive = false;
let lastTradeEndTime = 0; // cooldown หลัง trade จบ // Auto Paper Trade running
let autoTrades = [];         // ผลทุกรอบ

// ── Telegram ──────────────────────────────
async function tg(msg, btn = false) {
  try {
    const body = { chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' };
    if (btn) body.reply_markup = { inline_keyboard: [[{ text: '📊 เปิด Dashboard', url: 'https://upperpulse.github.io/Eth-cone-upp/' }]] };
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) console.log('📲 TG sent:', msg.slice(0, 60));
    else console.error('TG Error:', d.description);
  } catch (e) { console.error('TG:', e.message); }
}


// ── Telegram Command Handler ──────────────────────────
const DASH_URL = 'https://upperpulse.github.io/Eth-cone-upp/';
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=5`);
    const d = await r.json();
    if (!d.ok || !d.result.length) return;
    for (const update of d.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const cmd = msg.text.trim().toLowerCase();
      const chatId = msg.chat.id.toString();

      if (cmd === '/start' || cmd === '/dashboard') {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🚀 <b>ETH Cone Dashboard</b>\n\nกด ปุ่มด้านล่างเพื่อเปิด Dashboard`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '📊 เปิด Dashboard', url: DASH_URL },
                { text: '📈 Trade Now', url: DASH_URL + '?tab=trade' }
              ]]
            }
          })
        });
      } else if (cmd === '/status') {
        const sig = lastSig || 'ยังไม่มีข้อมูล';
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📊 <b>Bot Status</b>\n\n🤖 ${BOT_VERSION}\n📡 Auto Trade: ${autoTradeActive ? '🟢 กำลังรัน' : '⚪ พร้อม'}\n📦 รอบ: ${autoTrades.length}/${AUTO_TRADE_TARGET_DYNAMIC}\n💡 Signal: ${sig}\n🛡️ Global SL: ${GLOBAL_SL_AMOUNT > 0 ? '$'+GLOBAL_SL_AMOUNT : 'OFF'}\n💰 Daily PnL: ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '📊 เปิด Dashboard', url: DASH_URL }]]
            }
          })
        });
      } else if (cmd === '/stop') {
        autoTradeActive = false;
        lastConfAlert = false;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '⏹ <b>Auto Trade หยุดแล้ว</b>',
            parse_mode: 'HTML'
          })
        });
      } else if (cmd === '/help') {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📋 <b>Commands</b>\n\n/start — เปิด Dashboard\n/dashboard — เปิด Dashboard\n/status — ดูสถานะ Bot\n/stop — หยุด Auto Trade\n/weekly — สรุปผล 7 วัน\n/help — แสดง commands`,
            parse_mode: 'HTML'
          })
        });
      }
    }
  } catch(e) { /* silent */ }
}

// Poll ทุก 3 วินาที

// ══════════════════════════════════════════════
// WEEKLY SUMMARY — ส่งทุกอาทิตย์ตอน 09:00 ICT
// ══════════════════════════════════════════════
async function sendBurstSummary() {
  try {
    if (burstTrades.length === 0) {
      await tg('🔥 <b>Burst Hunter Summary</b>\n\nยังไม่มี burst trades', false);
      return;
    }
    const wins = burstTrades.filter(t => t.pnl > 0);
    const total = burstTrades.reduce((a,t)=>a+t.pnl, 0);
    const wr = (wins.length/burstTrades.length*100).toFixed(0);
    const tpHits = burstTrades.filter(t=>t.result==='TP').length;
    const msg = `🔥 <b>Burst Hunter Summary</b>\n\n` +
      `📈 Total: ${burstTrades.length} trades\n` +
      `✅ Wins: ${wins.length} | WR: ${wr}%\n` +
      `🏆 TP Hits: ${tpHits}\n` +
      `💰 Total PnL: ${total>=0?'+':''}$${total.toFixed(2)}\n` +
      `\n(Engine B — แยกจาก Trend Trader)`;
    await tg(msg, false);
  } catch(e) { console.log('burst summary err', e.message); }
}

async function sendWeeklySummary() {
  try {
    const archivePath = '/home/ubuntu/eth-bot/auto_trades_archive.json';
    let archive = [];
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}

    // นับ trades จาก SUMMARY_START_TS (เริ่มจาก R9)
    const weekTrades = archive.filter(t => (t.ts || 0) >= SUMMARY_START_TS);

    if (weekTrades.length === 0) {
      await tg('📊 <b>Performance Summary</b>\n\nไม่มี trades ตั้งแต่เริ่มนับ', false);
      return;
    }
    const daysCovered = Math.round((Date.now() - SUMMARY_START_TS) / 86400000);

    const wins = weekTrades.filter(t => t.result==='TP1'||t.result==='TP2'||(t.result==='TIMEOUT'&&t.pnl>0));
    const losses = weekTrades.filter(t => !(t.result==='TP1'||t.result==='TP2'||(t.result==='TIMEOUT'&&t.pnl>0)));
    const totalPnl = weekTrades.reduce((a,t)=>a+(t.pnl||0), 0);
    const longs = weekTrades.filter(t => t.dir==='long');
    const shorts = weekTrades.filter(t => t.dir==='short');
    const wr = (wins.length/weekTrades.length*100).toFixed(0);
    const avgWin = wins.length ? wins.reduce((a,t)=>a+t.pnl,0)/wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a,t)=>a+t.pnl,0)/losses.length) : 1;
    const payoff = avgLoss > 0 ? (avgWin/avgLoss).toFixed(2) : 'N/A';
    const W = wins.length/weekTrades.length;
    const R = avgLoss > 0 ? avgWin/avgLoss : 0;
    const kelly = R > 0 ? ((W - (1-W)/R) * 100).toFixed(0) : 'N/A';
    const verdict = kelly > 0 ? '✅ Kelly บวก — กำไรระยะยาว' : '⚠️ Kelly ลบ — ต้องปรับ';

    const msg = `📊 <b>Weekly Summary</b>\n\n` +
      `📅 7 วันที่ผ่านมา\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📈 Total Trades: ${weekTrades.length}\n` +
      `✅ Wins: ${wins.length} | ❌ Losses: ${losses.length}\n` +
      `🎯 Win Rate: <b>${wr}%</b>\n` +
      `💰 Total PnL: <b>${totalPnl>=0?'+':''}$${totalPnl.toFixed(2)}</b>\n` +
      `\n` +
      `📊 Direction:\n` +
      `🟢 LONG: ${longs.length} trades\n` +
      `🔴 SHORT: ${shorts.length} trades\n` +
      `\n` +
      `📐 Risk Metrics:\n` +
      `Avg Win: $${avgWin.toFixed(2)}\n` +
      `Avg Loss: $${avgLoss.toFixed(2)}\n` +
      `Payoff Ratio: ${payoff}\n` +
      `Kelly: ${kelly}%\n` +
      `Total Fees: -$${weekTrades.reduce((a,t)=>a+(t.fee||0),0).toFixed(2)}\n` +
      `\n` +
      `${verdict}`;
    await tg(msg, false);
  } catch(e) {
    console.log('Weekly summary error:', e.message);
  }
}

// Check ทุกชั่วโมง — ถ้าตรง 09:00 ICT วันจันทร์ → ส่ง summary
let lastWeeklyDate = '';
setInterval(() => {
  const now = new Date();
  const ictH = (now.getUTCHours() + 7) % 24;
  const today = now.toISOString().slice(0, 10);
  // ส่งทุกวันจันทร์ตอน 09:00 ICT (Sunday UTC = day 0)
  if (now.getUTCDay() === 1 && ictH === 9 && today !== lastWeeklyDate) {
    lastWeeklyDate = today;
    sendWeeklySummary();
  }
}, 60 * 1000); // เช็คทุกนาที

setInterval(pollTelegram, 3000);

// ── Auto sync logic.js จาก GitHub ──────────────
let lastLogicHash = '';
async function checkLogicUpdate() {
  try {
    const r = await fetch(LOGIC_URL);
    const code = await r.text();
    const hash = code.length + '-' + code.slice(0,50);
    if (lastLogicHash && hash !== lastLogicHash) {
      console.log('🔄 logic.js เปลี่ยน → reload...');
      await loadLogic();
      console.log('✅ logic.js reloaded');
    }
    lastLogicHash = hash;
  } catch {}
}
setInterval(checkLogicUpdate, 300000); // ทุก 5 นาที
checkLogicUpdate(); // check ตอน start

// ── Fetch ─────────────────────────────────
async function fetchKlines(sym, iv, lim) { const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${lim}`); return r.json(); }
async function fetchPrice() { const r = await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=ETHUSDT`); const d = await r.json(); return parseFloat(d.price); }
async function fetchFunding() { try { const r = await fetch(`${BINANCE}/fapi/v1/premiumIndex?symbol=ETHUSDT`); const d = await r.json(); return parseFloat(d.lastFundingRate)*100; } catch { return 0; } }
async function fetchFG() {
  if (Date.now() - fgCache.ts < 6*3600*1000) return fgCache.val;
  try { const r = await fetch(FG_API); const d = await r.json(); const val = parseInt(d.data[0].value); fgCache = {val,ts:Date.now()}; return val; } catch { return fgCache.val; }
}


// ── Auto Paper Trade ──────────────────────
// ══════════════════════════════════════════════
// BINANCE API LAYER — เตรียมพร้อม (active เมื่อ TRADE_MODE='live')
// ══════════════════════════════════════════════
const crypto = require('crypto');

// สร้าง signature สำหรับ Binance API
function signRequest(queryString) {
  return crypto.createHmac('sha256', BINANCE_CONFIG.apiSecret)
    .update(queryString).digest('hex');
}

// สร้าง order object — map กับ Binance Futures API
function buildOrder(params) {
  const { side, type, quantity, price, stopPrice, callbackRate, reduceOnly } = params;
  const order = {
    symbol: BINANCE_CONFIG.symbol,
    side,                          // 'BUY' | 'SELL'
    type,                          // 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET'
    quantity: quantity.toFixed(3)
  };
  if (price)        order.price = price.toFixed(2);
  if (stopPrice)    order.stopPrice = stopPrice.toFixed(2);
  if (callbackRate) order.callbackRate = callbackRate.toFixed(1);  // Trailing Stop %
  if (reduceOnly)   order.reduceOnly = 'true';
  return order;
}

// แปลง ATR → Trailing callback rate %
function atrToCallbackRate(atr, entry) {
  // callback rate = (ATR × 0.75 / entry) × 100, จำกัด 0.1-5%
  const rate = (atr * ATR_MULT_SL / entry) * 100;
  return Math.max(0.1, Math.min(5.0, rate));
}

// ส่ง order ไป Binance (active เมื่อ live เท่านั้น)
async function placeBinanceOrder(order) {
  if (!IS_REAL_ORDER) {
    console.log('[PAPER] buildOrder:', JSON.stringify(order));
    return { paper: true, order };
  }
  // --- TESTNET / LIVE MODE ---
  const ts = Date.now();
  const qs = Object.entries({...order, timestamp: ts})
    .map(([k,v]) => `${k}=${v}`).join('&');
  const sig = signRequest(qs);
  const r = await fetch(`${BINANCE_CONFIG.baseURL}/fapi/v1/order?${qs}&signature=${sig}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': BINANCE_CONFIG.apiKey }
  });
  return await r.json();
}

// ดึง balance (live เท่านั้น)
async function getBinanceBalance() {
  if (!IS_REAL_ORDER) return { paper: true, balance: AUTO_SIZE };
  const ts = Date.now();
  const qs = `timestamp=${ts}`;
  const sig = signRequest(qs);
  const r = await fetch(`${BINANCE_CONFIG.baseURL}/fapi/v2/balance?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': BINANCE_CONFIG.apiKey }
  });
  return await r.json();
}


// ตั้ง leverage บน Binance (testnet/live)
async function setBinanceLeverage(lev) {
  if (!IS_REAL_ORDER) return { paper: true, leverage: lev };
  const ts = Date.now();
  const qs = `symbol=${BINANCE_CONFIG.symbol}&leverage=${lev}&timestamp=${ts}`;
  const sig = signRequest(qs);
  const r = await fetch(`${BINANCE_CONFIG.baseURL}/fapi/v1/leverage?${qs}&signature=${sig}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': BINANCE_CONFIG.apiKey }
  });
  return await r.json();
}

// ดึง position ปัจจุบันจาก Binance
async function getBinancePosition() {
  if (!IS_REAL_ORDER) return { paper: true, positions: [] };
  const ts = Date.now();
  const qs = `timestamp=${ts}`;
  const sig = signRequest(qs);
  const r = await fetch(`${BINANCE_CONFIG.baseURL}/fapi/v2/positionRisk?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': BINANCE_CONFIG.apiKey }
  });
  const data = await r.json();
  // กรองเฉพาะ ETHUSDT ที่มี position จริง
  if (Array.isArray(data)) {
    return data.filter(p => p.symbol === BINANCE_CONFIG.symbol && parseFloat(p.positionAmt) !== 0);
  }
  return data;
}

// ปิด position ทั้งหมด (emergency)
async function closeBinanceAll() {
  if (!IS_REAL_ORDER) return { paper: true, msg: 'paper mode — nothing to close' };
  try {
    const positions = await getBinancePosition();
    if (!Array.isArray(positions) || positions.length === 0) {
      return { ok: true, msg: 'no open positions' };
    }
    const results = [];
    for (const pos of positions) {
      const amt = parseFloat(pos.positionAmt);
      const side = amt > 0 ? 'SELL' : 'BUY';  // ปิดด้วยฝั่งตรงข้าม
      const order = buildOrder({ side, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: true });
      const res = await placeBinanceOrder(order);
      results.push(res);
    }
    return { ok: true, closed: results.length, results };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function startBurstTrade(price, dir, atr, strength, detail) {
  burstActive = true;
  const entry = price;
  const qty = (BURST_SIZE * LEVERAGE) / entry;
  const endTime = Date.now() + BURST_DURATION_MS;
  const tradeNum = burstTrades.length + 1;

  let tp, sl;
  if (dir === 'long') {
    tp = entry + atr * BURST_TP_MULT;
    sl = entry - atr * BURST_SL_MULT;
  } else {
    tp = entry - atr * BURST_TP_MULT;
    sl = entry + atr * BURST_SL_MULT;
  }

  const f = (x) => x.toFixed(2);
  await tg(`🔥 <b>BURST #${tradeNum} ENTRY</b>\n\n${dir==='long'?'🟢':'🔴'} ${dir.toUpperCase()}\n💰 Entry: $${f(entry)}\n🎯 TP: $${f(tp)}\n🛑 SL: $${f(sl)}\n⚡ Strength: ${strength}\n📊 ATR sq: ${detail.atrRatio} | range: ${detail.rangePct}%\n⏱ 45min`, true);

  let maxP = 0, maxL = 0;
  const monitor = setInterval(async () => {
    try {
      const p = await fetchPrice();
      const pnl = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
      if (pnl > maxP) maxP = pnl;
      if (pnl < maxL) maxL = pnl;

      let done = false, result = '';
      if (dir === 'long') {
        if (p >= tp) { result='TP'; done=true; }
        else if (p <= sl) { result='SL'; done=true; }
      } else {
        if (p <= tp) { result='TP'; done=true; }
        else if (p >= sl) { result='SL'; done=true; }
      }
      if (Date.now() > endTime && !done) { result='TIMEOUT'; done=true; }

      if (done) {
        clearInterval(monitor);
        const grossPnl = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
        const fee = calcFees(entry, p, qty);
        const finalPnl = grossPnl - fee;
        const rec = { ts: Date.now(), num: tradeNum, dir, entry, exit: p, tp, sl, pnl: finalPnl, grossPnl, fee, maxP, maxL, strength, result, engine: 'B' };
        burstTrades.push(rec);
        saveBurstTrades();
        burstActive = false;
        burstLastEndTime = Date.now();
        const icon = result==='TP'?'🏆':result==='SL'?'🛑':'⏰';
        await tg(`${icon} <b>BURST #${tradeNum} ${result}</b>\n\n${dir.toUpperCase()} $${f(entry)} → $${f(p)}\nPnL: ${finalPnl>=0?'+':''}$${finalPnl.toFixed(2)}\nMaxP: +$${maxP.toFixed(2)}`, true);
      }
    } catch(e) { console.log('burst monitor err', e.message); }
  }, 5000);
}

async function startAutoPaperTrade(sig, price, dir, atr, conf, trigs, features = {}) {
  // autoTradeActive ถูก set ก่อน call แล้ว ไม่ต้อง check ซ้ำ
  autoTradeActive = true;

  const entry = price;
  const qty   = (AUTO_SIZE * LEVERAGE) / entry;
  const endTime = Date.now() + AUTO_DURATION_MS;

  let tp1, tp2, sl;
  if (dir === 'long') {
    tp1 = entry + atr * ATR_MULT_TP1;
    tp2 = entry + atr * ATR_MULT_TP2;
    sl  = entry - atr * ATR_MULT_SL;
  } else {
    tp1 = entry - atr * ATR_MULT_TP1;
    tp2 = entry - atr * ATR_MULT_TP2;
    sl  = entry + atr * ATR_MULT_SL;
  }

  const tradeNum = autoTrades.length + 1;
  const f = v => v.toFixed(2);
  const _mlFeatures = features;  // เก็บไว้ log ตอน trade ปิด

  try {
    await tg(
`🤖 <b>Auto Paper Trade #${tradeNum}/${AUTO_TRADE_TARGET_DYNAMIC}</b>

🎯 Direction: <b>${dir.toUpperCase()}</b>
📊 Signal: ${sig}
📊 Conf: ${conf}% | Trig: ${trigs}/5
💰 Entry: $${f(entry)}
🎯 TP1: $${f(tp1)} | TP2: $${f(tp2)}
🛑 SL: $${f(sl)}
⏱ Duration: ${AUTO_DURATION_MS/3600000}H`, true);
  } catch(e) { console.log('TG ERROR:', e.message); }

  // Monitor loop
  let tp1Hit = false;
  let maxP = 0, maxL = 0;
  let partialClosed = false;
  let realizedPnl = 0;  // กำไรที่ปิดไปแล้วบางส่วน

  const monitor = setInterval(async () => {
    const now = Date.now();
    let curPrice;
    try { curPrice = await fetchPrice(); } catch { return; }
    const p = parseFloat(curPrice);

    // track max profit/loss
    const pnlNow = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
    if (pnlNow > maxP) maxP = pnlNow;
    if (pnlNow < maxL) maxL = pnlNow;

    // ── Trailing SL ───────────────────────
    const tp1dist = Math.abs(tp1 - entry);
    const tp1pnl  = tp1dist * qty;
    if (maxP >= tp1pnl * TRAIL_BREAKEVEN) {
      if (dir === 'long'  && sl < entry) { sl = entry; }
      if (dir === 'short' && sl > entry) { sl = entry; }
    }
    if (maxP >= tp1pnl * TRAIL_LOCK) {
      const lockPrice = dir === 'long' ? entry + tp1dist * 0.4 : entry - tp1dist * 0.4;
      if (dir === 'long'  && sl < lockPrice) { sl = lockPrice; }
      if (dir === 'short' && sl > lockPrice) { sl = lockPrice; }
    }
    // ── v3.32 Progressive Profit Lock ──
    // เมื่อ maxP > $1 → ล็อก SL ที่ 50% ของกำไรสูงสุด (กันกำไรหลุดแบบ #4 R16)
    if (maxP >= TRAIL_PROFIT_MIN) {
      const lockPnl = maxP * TRAIL_PROFIT_LOCK;       // ล็อกครึ่งของ maxP
      const lockDist = lockPnl / qty;                  // แปลงกลับเป็นระยะราคา
      const profitLockPrice = dir === 'long' ? entry + lockDist : entry - lockDist;
      if (dir === 'long'  && sl < profitLockPrice) { sl = profitLockPrice; }
      if (dir === 'short' && sl > profitLockPrice) { sl = profitLockPrice; }
    }

    // Check timeout
    if (now >= endTime) {
      clearInterval(monitor);
      autoTradeActive = false;
      lastTradeEndTime = Date.now(); // เริ่ม cooldown 30 นาที
      lastConfAlert = false;
      const remainRatio = partialClosed ? (1 - PARTIAL_TP_RATIO) : 1;
      const livePnl = dir === 'long' ? (p - entry) * qty : (entry - p) * qty;
      const grossPnl = realizedPnl + livePnl * remainRatio;
      const fee = calcFees(entry, p, qty);
      const pnl = grossPnl - fee;
      const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, grossPnl, fee, result: partialClosed?'TP1':'TIMEOUT', maxP, maxL, conf, partialClosed };
      autoTrades.push(result); logMLData(result, _mlFeatures);
      saveAutoTrades();
      await tg(`⏰ <b>Auto Trade #${tradeNum} TIMEOUT</b>\n\n${dir.toUpperCase()} Entry: $${f(entry)} → $${f(p)}\nPnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nMax Profit: +$${maxP.toFixed(2)} | Max Loss: $${maxL.toFixed(2)}`, true);
      if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      return;
    }

    if (dir === 'long') {
      if (!tp1Hit && p >= tp1) {
        tp1Hit = true;
        // Partial TP — ปิด 50% ล็อกกำไร
        const partialPnl = (p - entry) * qty * PARTIAL_TP_RATIO;
        realizedPnl += partialPnl;
        partialClosed = true;
        await tg(`🎯 <b>Auto #${tradeNum} TP1 HIT</b> $${f(p)}\n💰 ปิด 50% → +$${partialPnl.toFixed(2)}\nที่เหลือ 50% รอ TP2`, true);
      }
      if (p >= tp2) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const remainRatio = partialClosed ? (1 - PARTIAL_TP_RATIO) : 1;
        const grossPnl = realizedPnl + (p - entry) * qty * remainRatio;
        const fee = calcFees(entry, p, qty);
        const pnl = grossPnl - fee;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, grossPnl, fee, result: 'TP2', maxP, maxL, conf, partialClosed };
        autoTrades.push(result); logMLData(result, _mlFeatures); saveAutoTrades();
        await tg(`🏆 <b>Auto Trade #${tradeNum} TP2 WIN!</b>\n\nLONG $${f(entry)} → $${f(p)}\n+$${pnl.toFixed(2)} (fee -$${fee.toFixed(2)})`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      } else if (p <= sl) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const remainRatio = partialClosed ? (1 - PARTIAL_TP_RATIO) : 1;
        const grossPnl = realizedPnl + (p - entry) * qty * remainRatio;
        const fee = calcFees(entry, p, qty);
        const pnl = grossPnl - fee;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, grossPnl, fee, result: partialClosed?'TP1':'SL', maxP, maxL, conf, partialClosed };
        autoTrades.push(result); logMLData(result, _mlFeatures); saveAutoTrades();
        await tg(`🛑 <b>Auto Trade #${tradeNum} SL HIT</b>\n\nLONG $${f(entry)} → $${f(p)}\n$${pnl.toFixed(2)} (fee -$${fee.toFixed(2)})`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      }
    } else {
      if (!tp1Hit && p <= tp1) {
        tp1Hit = true;
        const partialPnl = (entry - p) * qty * PARTIAL_TP_RATIO;
        realizedPnl += partialPnl;
        partialClosed = true;
        await tg(`🎯 <b>Auto #${tradeNum} TP1 HIT</b> $${f(p)}\n💰 ปิด 50% → +$${partialPnl.toFixed(2)}\nที่เหลือ 50% รอ TP2`, true);
      }
      if (p <= tp2) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const remainRatio = partialClosed ? (1 - PARTIAL_TP_RATIO) : 1;
        const grossPnl = realizedPnl + (entry - p) * qty * remainRatio;
        const fee = calcFees(entry, p, qty);
        const pnl = grossPnl - fee;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, grossPnl, fee, result: 'TP2', maxP, maxL, conf, partialClosed };
        autoTrades.push(result); logMLData(result, _mlFeatures); saveAutoTrades();
        await tg(`🏆 <b>Auto Trade #${tradeNum} TP2 WIN!</b>\n\nSHORT $${f(entry)} → $${f(p)}\n+$${pnl.toFixed(2)} (fee -$${fee.toFixed(2)})`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      } else if (p >= sl) {
        clearInterval(monitor); autoTradeActive = false; lastTradeEndTime = Date.now(); lastConfAlert = false;
        const remainRatio = partialClosed ? (1 - PARTIAL_TP_RATIO) : 1;
        const grossPnl = realizedPnl + (entry - p) * qty * remainRatio;
        const fee = calcFees(entry, p, qty);
        const pnl = grossPnl - fee;
        const result = { num: tradeNum, sig, dir, entry, exit: p, tp1, tp2, sl, pnl, grossPnl, fee, result: partialClosed?'TP1':'SL', maxP, maxL, conf, partialClosed };
        autoTrades.push(result); logMLData(result, _mlFeatures); saveAutoTrades();
        await tg(`🛑 <b>Auto Trade #${tradeNum} SL HIT</b>\n\nSHORT $${f(entry)} → $${f(p)}\n$${pnl.toFixed(2)} (fee -$${fee.toFixed(2)})`, true);
        if (autoTrades.length >= AUTO_TRADE_TARGET_DYNAMIC) await sendSummary();
      }
    }
  }, 10000);
}

function saveAutoTrades() {
  try { fs.writeFileSync('/home/ubuntu/eth-bot/auto_trades.json', JSON.stringify(autoTrades, null, 2)); } catch {}
  // บันทึก archive ทุกครั้ง
  saveArchive();
}

// ── ML Data Pipeline — เก็บ features ทุก trade ──
function logMLData(trade, features) {
  try {
    const row = {
      ts: Date.now(),
      // Features ตอน entry
      dir: trade.dir,
      entry: trade.entry,
      rsi: features.rsi,
      macdHist: features.macdHist,
      atr: trade.atr || features.atr,
      obvSlope: features.obvSlope,
      ema50Dist: features.ema50Dist,
      conf: trade.conf,
      trigScore: features.trigScore,
      fg: features.fg,
      btcBull: features.btcBull,
      // Outcome
      result: trade.result,
      pnl: trade.pnl,
      maxP: trade.maxP,
      maxL: trade.maxL,
      partialClosed: trade.partialClosed || false
    };
    fs.appendFileSync('/home/ubuntu/eth-bot/ml_dataset.jsonl', JSON.stringify(row) + '\n');
  } catch(e) { console.log('ML log error:', e.message); }
}

function saveArchive() {
  try {
    const archivePath = '/home/ubuntu/eth-bot/auto_trades_archive.json';
    let archive = [];
    try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch {}
    // เพิ่มหรืออัปเดต trade ล่าสุด
    autoTrades.forEach(t => {
      const idx = archive.findIndex(a => a.ts === t.ts || (a.num === t.num && a.entry === t.entry));
      if (idx === -1) archive.push({...t, ts: Date.now()});
      else archive[idx] = {...t, ts: archive[idx].ts};
    });
    fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
  } catch {}
}

async function sendSummary() {
  const wins = autoTrades.filter(t => 
    t.result === 'TP1' || t.result === 'TP2' || 
    (t.result === 'TIMEOUT' && t.pnl > 0)
  ).length;
  const losses = autoTrades.filter(t => 
    t.result === 'SL' || 
    (t.result === 'TIMEOUT' && t.pnl <= 0)
  ).length;
  const timeouts = autoTrades.filter(t => t.result === 'TIMEOUT').length;
  const totalPnL = autoTrades.reduce((a, t) => a + t.pnl, 0);
  const winRate = Math.round(wins / autoTrades.length * 100);

  let detail = '';
  autoTrades.forEach(t => {
    const icon = t.result === 'TP2' ? '🏆' : t.result === 'TP1' ? '🎯' : t.result === 'SL' ? '🛑' : '⏰';
    detail += `${icon} #${t.num} ${t.dir.toUpperCase()} ${t.result} ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}\n`;
  });

  await tg(
`📊 <b>Auto Paper Trade สรุป 10 รอบ</b>

✅ WIN: ${wins} | 🛑 LOSS: ${losses} | ⏰ TIMEOUT: ${timeouts}
📈 Win Rate: <b>${winRate}%</b>
💰 Total PnL: ${totalPnL>=0?'+':''}$${totalPnL.toFixed(2)}

${detail}
🔬 วิเคราะห์ผลกับ Claude ต่อได้เลย!`);
}

// ── Main Analysis ─────────────────────────
async function analyze() {
  try {
    if (tradeState) return;

    const [ethK,ethK4h,ethK15m,btcK,price,funding,fg] = await Promise.all([fetchKlines('ETHUSDT','1h',80),fetchKlines('ETHUSDT','4h',60),fetchKlines('ETHUSDT','15m',60),fetchKlines('BTCUSDT','1h',60),fetchPrice(),fetchFunding(),fetchFG()]);
    const ec=ethK.map(k=>parseFloat(k[4])),bc=btcK.map(k=>parseFloat(k[4]));
    // คำนวณ trap ก่อน แล้วส่งเข้า calcBestDirection
    const atrTemp = calcATR(ethK, 14);
    const trapTemp = calcTrap(ethK, atrTemp);
    // ── เปรียบเทียบทั้งสองฝั่ง เลือก Conf สูงกว่า ──
    const best    = calcBestDirection(ethK, btcK, funding, trapTemp, fg, ethK4h, ethK15m);
    const macd1h  = best.macd;
    const btcMacd = best.btcMacd;
    const rsi     = best.rsi;
    const obv     = best.obv;
    const atr     = best.atr;
    const trap2   = best.trap;
    const btcBull = btcMacd.positive;
    const conf    = best.confLong >= best.confShort ? best.confLong : best.confShort;
    const trigs   = calcTriggers(macd1h, obv, btcBull, trap2, fg);
    const sig     = best.best ? best.best.sig : best.sigLong.sig;
    const entryReady = best.best ? best.best.entryReady : false;
    const entryDir   = best.best ? best.best.entryDir : 'long';
    const emaDir  = best.aboveEMA50 ? '↑EMA' : '↓EMA';

    const now=Date.now(),p=price.toFixed(2);
    const fgL=fg<=25?'😱 XFear':fg<=45?'😨 Fear':fg<=55?'😐 Neutral':fg<=75?'😊 Greed':'🤑 XGreed';
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] $${p} Conf:${conf}% RSI:${rsi.toFixed(0)} ${emaDir} ATR:${best.atrOK?'✓':'✗'} | ${sig} ${autoTradeActive?'[AUTO TRADING]':''}`);

    // ── Micro-Momentum: บันทึก tick ──────────
    tickHistory.push({ price, ts: now });
    if (tickHistory.length > 12) tickHistory.shift();

    // ── Entry Timing Refinement (v3.29) ──
    // เมื่อ signal ready → รอราคา pullback เล็กน้อยก่อนเข้า (entry ดีกว่า)
    if (PULLBACK_ENABLED && best.best && best.best.entryReady && !pullbackPending && !autoTradeActive) {
      const cooldownCheck = Date.now() > lastTradeEndTime + TRADE_COOLDOWN_MS;
      if (cooldownCheck && autoTradeEnabled && autoTrades.length < AUTO_TRADE_TARGET_DYNAMIC) {
        pullbackPending = true;
        pullbackDir = best.best.entryDir;
        pullbackStartPrice = price;
        pullbackStartTime = Date.now();
        console.log(`[PULLBACK] รอราคาย่อกลับก่อนเข้า ${pullbackDir} (signal $${price.toFixed(2)})`);
      }
    }

    // เช็ค pullback: SHORT รอราคาเด้งขึ้น, LONG รอราคาย่อลง
    if (pullbackPending) {
      const waited = Date.now() - pullbackStartTime;
      const moveFromSignal = (price - pullbackStartPrice) / pullbackStartPrice;
      let pullbackHit = false;
      if (pullbackDir === 'short' && moveFromSignal >= PULLBACK_TARGET) pullbackHit = true;  // ราคาเด้งขึ้น → SHORT entry ดีกว่า
      if (pullbackDir === 'long'  && moveFromSignal <= -PULLBACK_TARGET) pullbackHit = true; // ราคาย่อลง → LONG entry ดีกว่า
      if (pullbackHit) {
        console.log(`[PULLBACK] ✅ ได้ราคาดีขึ้น เข้า ${pullbackDir} ที่ $${price.toFixed(2)}`);
        pullbackPending = false;
      } else if (waited > PULLBACK_MAX_WAIT) {
        console.log(`[PULLBACK] หมดเวลา 90s — เข้าที่ราคาตลาด`);
        pullbackPending = false; // หมดเวลา → เข้าปกติ
      } else {
        // ยังรอ pullback อยู่ — ไม่เข้า trade
        lastSig = sig;
        return;
      }
    }

    // เช็คว่าราคาวิ่งสวนทิศใน 60 วินาทีล่าสุดมั้ย
    let microOK = true;
    if (tickHistory.length >= MICRO_LOOKBACK) {
      const old = tickHistory[tickHistory.length - MICRO_LOOKBACK].price;
      const change = (price - old) / old;  // +ขึ้น -ลง
      if (entryDir === 'short' && change > MICRO_THRESHOLD) microOK = false;  // ราคาพุ่งขึ้น → ไม่เข้า SHORT
      if (entryDir === 'long'  && change < -MICRO_THRESHOLD) microOK = false; // ราคาดิ่งลง → ไม่เข้า LONG
    }

    // ── Auto Paper Trade trigger ───────────
    const cooldownOK = Date.now() > lastTradeEndTime + TRADE_COOLDOWN_MS;

    if(entryReady && !autoTradeActive && autoTradeEnabled && autoTrades.length < AUTO_TRADE_TARGET_DYNAMIC && cooldownOK && !microOK) {
      console.log(`[MICRO-MOMENTUM] รอจังหวะ — ราคากำลังสวน ${entryDir}`);
    } else if(entryReady && !autoTradeActive && autoTradeEnabled && autoTrades.length < AUTO_TRADE_TARGET_DYNAMIC && cooldownOK && microOK) {
      autoTradeActive = true;
      lastConfAlert = true;
      await startAutoPaperTrade(sig, price, entryDir, atr, conf, trigs.score, {
        rsi, macdHist: macd1h.hist || 0, atr,
        obvSlope: obv.slope || 0,
        ema50Dist: ((price - best.ema50) / best.ema50 * 100),
        trigScore: trigs.score, fg, btcBull
      });
    } else if(!cooldownOK) {
      const remain = Math.round((lastTradeEndTime + TRADE_COOLDOWN_MS - Date.now())/60000);
      if(remain > 0) console.log(`[COOLDOWN] รอ ${remain} นาที`);
    }

    // ── Manual Notifications ───────────────
    if((sig==='GO'||sig==='SOFT GO — Entry Ready')&&sig!==lastSig&&now>goCooldown){
      goCooldown=now+7200000;lastConfAlert=true;
      await tg(`${sig==='GO'?'✅':'⚡'} <b>ETH ${sig}</b>\n\n🎯 ${entryDir.toUpperCase()}\n📊 Conf: ${conf}% | Trig: ${trigs.score}/5\n💰 Price: $${p}\n📈 MACD: ${macd1h.cross?'Cross ✅':'Positive'} | OBV: ✅ | BTC: ✅\n📉 RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\n🤖 Auto Paper Trade #${autoTrades.length+1}/${AUTO_TRADE_TARGET_DYNAMIC} เริ่มแล้ว`,true);
    } else if(sig==='NO GO — TRAP DETECTED'&&sig!==lastSig){
      await tg(`⛔ <b>ETH TRAP</b>\n💰 $${p} | Trap: ${(trap.prob*100).toFixed(0)}%\n❌ งดเทรด`,true);
    }

    if(conf>=80&&!lastConfAlert&&!tradeState){
      lastConfAlert=true;
      await tg(`📊 <b>Confidence ≥ 80%!</b>\n\n🎯 ${macd1h.positive?'🟢 LONG':'🔴 SHORT'}\n📊 Conf: ${conf}% | Trig: ${trigs.score}/5\n💰 $${p} | RSI: ${rsi.toFixed(1)}\n😨 F&G: ${fg} ${fgL}\n\nระบบเริ่มตรวจ Trigger`,true);
    }

    // ═══════════ ENGINE B — BURST HUNTER ═══════════
    if (BURST_ENABLED && detectPreBurst && !burstActive) {
      const burstCooldownOK = Date.now() > burstLastEndTime + BURST_COOLDOWN_MS;
      if (burstCooldownOK) {
        const burst = detectPreBurst(ethK, ethK15m);
        if (burst.preBurst && burst.strength >= BURST_STRENGTH_MIN) {
          console.log(`[BURST] ${burst.reason} (strength ${burst.strength})`);
          await startBurstTrade(price, burst.direction, atr, burst.strength, burst.details);
        }
      }
    }

    lastSig=sig;
  } catch(e){console.error('Analyze error:',e.message);}
}

// ── Trade State File ──────────────────────
const TRADE_FILE='/home/ubuntu/eth-bot/.trade_state.json';
function saveTradeFile(s){try{fs.writeFileSync(TRADE_FILE,JSON.stringify(s));}catch{}}
function loadTradeFile(){try{if(!fs.existsSync(TRADE_FILE))return null;const s=JSON.parse(fs.readFileSync(TRADE_FILE,'utf8'));if(!s||!s.active||Date.now()>=s.endTime){fs.unlinkSync(TRADE_FILE);return null;}return s;}catch{return null;}}
function clearTradeFile(){try{if(fs.existsSync(TRADE_FILE))fs.unlinkSync(TRADE_FILE);}catch{}}

// ── Manual Trade Monitor ──────────────────
function stopTradeMonitor(){
  if(tradeInterval){clearInterval(tradeInterval);tradeInterval=null;}
  clearTradeFile();
  lastConfAlert=false;
}

function startTradeMonitor(state){
  stopTradeMonitor();
  tradeState=state;
  saveTradeFile({...state,active:true});
  goCooldown=Date.now()+120000;
  softGoCooldown=Date.now()+120000;
  lastConfAlert=true;
  console.log('📊 Manual Trade Monitor started');
  tg(`📊 <b>Trade Monitor เริ่มแล้ว!</b>\n\n🎯 ${state.dir.toUpperCase()}\n💰 Entry: $${parseFloat(state.entry).toFixed(2)}\n🎯 TP1: $${parseFloat(state.tp1).toFixed(2)} | TP2: $${parseFloat(state.tp2).toFixed(2)}\n🛑 SL: $${parseFloat(state.sl).toFixed(2)}\n⏱ ${state.dur}`,true);
  tradeInterval=setInterval(async()=>{
    if(!tradeState){stopTradeMonitor();return;}
    const now=Date.now();
    if(tradeState.endTime&&now>=tradeState.endTime){
      const price=await fetchPrice().catch(()=>tradeState.entry);
      const pnl=tradeState.dir==='long'?(price-tradeState.entry)*tradeState.qty:(tradeState.entry-price)*tradeState.qty;
      const tmp=tradeState;stopTradeMonitor();tradeState=null;
      await tg(`⏰ <b>TIMEOUT</b>\n🎯 ${tmp.dir.toUpperCase()} Entry: $${parseFloat(tmp.entry).toFixed(2)}\n💰 Exit: $${parseFloat(price).toFixed(2)}\nPnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`,true);
      return;
    }
    let price;try{price=await fetchPrice();}catch{return;}
    const p=parseFloat(price),entry=parseFloat(tradeState.entry),tp1=parseFloat(tradeState.tp1),tp2=parseFloat(tradeState.tp2),sl=parseFloat(tradeState.sl),qty=parseFloat(tradeState.qty||0.04),f=v=>v.toFixed(2);
    if(tradeState.dir==='long'){
      if(!tradeState.tp1Hit&&p>=tp1){tradeState.tp1Hit=true;await tg(`🎯 <b>LONG TP1 HIT!</b>\n$${f(p)} | เหลือ ${Math.round((tradeState.endTime-now)/60000)} นาที`,true);}
      if(p>=tp2){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🏆 <b>LONG TP2 WIN!</b>\n$${f(p)} | +$${f((p-entry)*qty)}`,true);}
      else if(p<=sl){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🛑 <b>LONG SL HIT</b>\n$${f(p)} | -$${f((entry-p)*qty)}`,true);}
    }else{
      if(!tradeState.tp1Hit&&p<=tp1){tradeState.tp1Hit=true;await tg(`🎯 <b>SHORT TP1 HIT!</b>\n$${f(p)} | เหลือ ${Math.round((tradeState.endTime-now)/60000)} นาที`,true);}
      if(p<=tp2){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🏆 <b>SHORT TP2 WIN!</b>\n$${f(p)} | +$${f((entry-p)*qty)}`,true);}
      else if(p>=sl){const t=tradeState;stopTradeMonitor();tradeState=null;await tg(`🛑 <b>SHORT SL HIT</b>\n$${f(p)} | -$${f((p-entry)*qty)}`,true);}
    }
  },10000);
}

// ── HTTP Server ───────────────────────────
const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,ngrok-skip-browser-warning,User-Agent');
  res.setHeader('ngrok-skip-browser-warning','true');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  if(req.method==='POST'&&req.url==='/trade'){
    let body='';req.on('data',d=>body+=d);
    req.on('end',()=>{
      try{
        const state=JSON.parse(body);
        if(state.action==='start'){startTradeMonitor(state);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}
        else if(state.action==='stop'){
          stopTradeMonitor();tradeState=null;
          autoTradeActive=false;
          lastConfAlert=false;
          res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));
        }
        else{res.writeHead(400);res.end('Unknown action');}
      }catch(e){res.writeHead(400);res.end('Invalid JSON');}
    });
  }else if(req.method==='GET'&&req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,tradeMode:TRADE_MODE,isTestnet:IS_TESTNET,isRealOrder:IS_REAL_ORDER,trade:!!tradeState,autoTrade:autoTradeActive,autoCount:autoTrades.length,autoTarget:AUTO_TRADE_TARGET_DYNAMIC,autoEnabled:autoTradeEnabled,sig:lastSig}));
  }else if(req.method==='GET'&&req.url==='/auto-archive'){
    try{const d=fs.readFileSync('/home/ubuntu/eth-bot/auto_trades_archive.json','utf8');res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(d);}catch{res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end('[]');}
  }else if(req.method==='GET'&&req.url==='/auto-trades'){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ok:true,trades:autoTrades,count:autoTrades.length}));
  }else if(req.method==='GET'&&req.url==='/burst-trades'){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    const bwins = burstTrades.filter(t=>t.pnl>0).length;
    const btotal = burstTrades.reduce((a,t)=>a+t.pnl,0);
    res.end(JSON.stringify({ok:true,trades:burstTrades,count:burstTrades.length,active:burstActive,wins:bwins,totalPnl:btotal}));
  }else if(req.method==='GET'&&req.url==='/live-position'){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    getBinancePosition().then(pos=>{
      res.end(JSON.stringify({ok:true,mode:TRADE_MODE,testnet:IS_TESTNET,positions:pos}));
    }).catch(e=>res.end(JSON.stringify({ok:false,error:e.message})));
  }else if(req.method==='POST'&&req.url==='/live-close-all'){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    closeBinanceAll().then(r=>{
      res.end(JSON.stringify(r));
    }).catch(e=>res.end(JSON.stringify({ok:false,error:e.message})));
  }else if(req.method==='GET'&&req.url==='/live-balance'){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    getBinanceBalance().then(b=>{
      res.end(JSON.stringify({ok:true,mode:TRADE_MODE,balance:b}));
    }).catch(e=>res.end(JSON.stringify({ok:false,error:e.message})));
  }else if(req.method==='POST'&&req.url==='/global-sl'){
    let body='';req.on('data',d=>body+=d);req.on('end',()=>{
      try{
        const c=JSON.parse(body);
        if(typeof c.amount==='number'){
          GLOBAL_SL_AMOUNT=c.amount;globalSLActive=false;dailyPnL=0;
          res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ok:true,msg:'Global SL: $'+c.amount}));
        }else if(c.reset){
          globalSLActive=false;dailyPnL=0;
          res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ok:true,msg:'Reset แล้ว'}));
        }else{res.writeHead(400);res.end('err');}
      }catch(e){res.writeHead(400);res.end('err');}
    });
  }else if(req.method==='POST'&&req.url==='/auto-control'){
  let body='';req.on('data',d=>body+=d);req.on('end',()=>{
    try{
      const c=JSON.parse(body);
      if(c.action==='stop'){autoTradeActive=false;lastConfAlert=false;}
      else if(c.action==='reset'){autoTrades=[];autoTradeActive=false;lastConfAlert=false;lastTradeEndTime=0;try{require('fs').unlinkSync('/home/ubuntu/eth-bot/auto_trades.json');}catch{}}
      else if(c.action==='start'){if(c.reset){autoTrades=[];try{require('fs').unlinkSync('/home/ubuntu/eth-bot/auto_trades.json');}catch{}}if(c.target)AUTO_TRADE_TARGET_DYNAMIC=parseInt(c.target);autoTradeEnabled=true;autoTradeActive=false;lastConfAlert=false;lastTradeEndTime=0;try{fs.writeFileSync("/home/ubuntu/eth-bot/.bot_state.json",JSON.stringify({enabled:true,target:AUTO_TRADE_TARGET_DYNAMIC}));}catch{}}
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true,msg:'done'}));
    }catch(e){res.writeHead(400);res.end(JSON.stringify({ok:false}));}
  });
}else{res.writeHead(404);res.end('Not found');}
});
server.listen(3000,()=>console.log('🌐 HTTP Server listening on port 3000'));

// ── Start ─────────────────────────────────
console.log(`🚀 ETH Cone Bot ${BOT_VERSION} Started — Auto Paper Trade Mode`);
console.log('📡 Monitoring every 10s | Singapore 🇸🇬');

(async () => {
  // โหลด logic.js จาก GitHub ก่อน start
  await loadLogic();

  // Load existing auto trades
  try{const d=fs.readFileSync('/home/ubuntu/eth-bot/auto_trades.json','utf8');autoTrades=JSON.parse(d);console.log(`♻️ Loaded ${autoTrades.length} auto trades`);}catch{}
try{const s=JSON.parse(fs.readFileSync('/home/ubuntu/eth-bot/.bot_state.json','utf8'));if(s.enabled){autoTradeEnabled=true;AUTO_TRADE_TARGET_DYNAMIC=s.target||10;console.log('♻️ Auto trade restored: target='+AUTO_TRADE_TARGET_DYNAMIC);};}catch{}

  const savedTrade=loadTradeFile();
  if(savedTrade){tradeState=savedTrade;startTradeMonitor(savedTrade);}

  const flagFile='/home/ubuntu/eth-bot/.started';
  if(!fs.existsSync(flagFile)){
    fs.writeFileSync(flagFile,Date.now().toString());
    tg(`🚀 <b>ETH Cone Bot ${BOT_VERSION} Online</b>\n\n🤖 Auto Paper Trade: ${autoTrades.length}/${AUTO_TRADE_TARGET} รอบ\n📡 Oracle Cloud 🇸🇬`);
  }

  let analyzing = false;
  analyze();
  setInterval(async () => {
    if (analyzing) return;
    analyzing = true;
    await analyze();
    analyzing = false;
  }, 10000);
})();
