// ETH Cone Bot v3.0 — Oracle VM
// Token อยู่ใน Environment Variables — ไม่เก็บใน code

const BOT_TOKEN = process.env.TG_TOKEN || '';
const CHAT_ID   = process.env.TG_CHAT  || '';
const BINANCE   = 'https://fapi.binance.com';
const FG_API    = 'https://api.alternative.me/fng/?limit=1';

if(!BOT_TOKEN||!CHAT_ID){
  console.error('❌ ต้องตั้ง TG_TOKEN และ TG_CHAT ใน environment');
  process.exit(1);
}

// ── State ──────────────────────────────
let lastSig = '';
let lastConfAlert = false;
let goCooldown = 0;
let softGoCooldown = 0;
let fgCache = { val: 50, ts: 0 };

// ── Telegram with inline button ────────
async function tg(msg, withButton = false) {
  try {
    const body = {
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: 'HTML'
    };
    // เพิ่มปุ่ม "เปิด Dashboard" ถ้า withButton = true
    if (withButton) {
      body.reply_markup = {
        inline_keyboard: [[
          {
            text: '📊 เปิด Dashboard',
            url: 'https://upperpulse.github.io/Eth-cone-upp/'
          }
        ]]
      };
    }
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) console.log('📲 TG sent:', msg.slice(0, 50));
    else console.error('TG Error:', d.description);
  } catch (e) { console.error('TG:', e.message); }
}

// ── Fetch ───────────────────────────────
async function fetchKlines(sym, iv, lim) {
  const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${lim}`);
  return r.json();
}
async function fetchPrice() {
  const r = await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=ETHUSDT`);
  const d = await r.json();
  return parseFloat(d.price);
}
async function fetchFunding() {
  try {
    const r = await fetch(`${BINANCE}/fapi/v1/premiumIndex?symbol=ETHUSDT`);
    const d = await r.json();
    return parseFloat(d.lastFundingRate) * 100;
  } catch { return 0; }
}
async function fetchFG() {
  // cache 6H เหมือน Dashboard
  if (Date.now() - fgCache.ts < 6 * 3600 * 1000) return fgCache.val;
  try {
    const r = await fetch(FG_API);
    const d = await r.json();
    const val = parseInt(d.data[0].value);
    fgCache = { val, ts: Date.now() };
    return val;
  } catch { return fgCache.val; }
}

// ── Indicators — เหมือน Dashboard ──────
function calcEMA(closes, n) {
  const k = 2 / (n + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function calcMACD(closes) {
  const hist     = calcEMA(closes, 12) - calcEMA(closes, 26);
  const prevHist = calcEMA(closes.slice(0, -1), 12) - calcEMA(closes.slice(0, -1), 26);
  return {
    positive: hist > 0,
    cross: hist > 0 && prevHist <= 0,
    hist
  };
}

function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l -= d;
  }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcOBV(klines) {
  let obv = 0;
  const arr = [0];
  for (let i = 1; i < klines.length; i++) {
    const c = parseFloat(klines[i][4]);
    const pc = parseFloat(klines[i - 1][4]);
    const v = parseFloat(klines[i][5]);
    obv += c > pc ? v : c < pc ? -v : 0;
    arr.push(obv);
  }
  const recent = arr.slice(-10);
  const slope = (recent[recent.length - 1] - recent[0]) / 10;
  const divergence = recent.slice(-3).every((v, i, a) => i === 0 || v < a[i - 1]);
  return { positive: obv > 0, slope, trend: obv > 0 ? 'UP' : 'DOWN', divergence };
}

function calcATR(klines, p = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]);
    const l = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i - 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

// ── Trap Detection — เหมือน Dashboard ──
function calcTrap(klines, atr) {
  const closes = klines.map(k => parseFloat(k[4]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const vols   = klines.map(k => parseFloat(k[5]));

  // Wick ratio
  const last = klines[klines.length - 1];
  const body = Math.abs(parseFloat(last[4]) - parseFloat(last[1]));
  const range = parseFloat(last[2]) - parseFloat(last[3]);
  const wickR = range > 0 ? (range - body) / range : 0;

  // Vol Z-score
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const stdVol = Math.sqrt(vols.slice(-20).reduce((a, b) => a + Math.pow(b - avgVol, 2), 0) / 20);
  const volZ   = stdVol > 0 ? (vols[vols.length - 1] - avgVol) / stdVol : 0;

  // Price squeeze
  const recentHigh = Math.max(...highs.slice(-5));
  const recentLow  = Math.min(...lows.slice(-5));
  const squeeze = (recentHigh - recentLow) < atr * 0.5;

  // Trap probability
  let prob = 0;
  if (wickR > 0.6) prob += 0.3;
  if (volZ > 2) prob += 0.25;
  if (squeeze) prob += 0.3;
  if (volZ < -1) prob += 0.15;

  return { prob: Math.min(1, prob), alert: prob > 0.6, wickR, volZ };
}

// ── Confidence — เหมือน Dashboard ──────
function calcConfidence(macd, rsi, obv, btcMacd, funding, trap) {
  let score = 60;
  if (macd.positive) score += 8;
  if (macd.cross)    score += 5;
  if (obv.positive)  score += 7;
  if (obv.slope > 0) score += 3;
  if (!obv.divergence) score += 2;
  if (btcMacd.positive) score += 8;
  if (rsi > 40 && rsi < 60) score += 3;
  if (rsi < 38) score += 4;
  if (rsi > 65) score -= 4;
  if (rsi > 62) score -= 2;
  if (funding < -0.01) score += 2;
  if (funding > 0.01)  score -= 2;
  if (trap.alert) score -= 15;
  else if (trap.prob > 0.3) score -= 5;
  return Math.min(95, Math.max(50, Math.round(score)));
}

// ── 5 Core Triggers — เหมือน Dashboard ─
function checkTriggers(macd, obv, btcBull, trap, fg) {
  const t1 = macd.cross || macd.positive;  // MACD
  const t2 = obv.positive && obv.slope > 0; // OBV
  const t3 = btcBull;                       // BTC Bias
  const t4 = !trap.alert;                   // Trap Clear
  const t5 = fg > 20 && fg < 80;           // Fear & Greed
  const score = [t1, t2, t3, t4, t5].filter(Boolean).length;
  return { t1, t2, t3, t4, t5, score };
}

// ── Main Analysis — Logic เหมือน Dashboard v5.13 ──
async function analyze() {
  try {
    const [ethK, btcK, price, funding, fg] = await Promise.all([
      fetchKlines('ETHUSDT', '1h', 80),
      fetchKlines('BTCUSDT', '1h', 60),
      fetchPrice(),
      fetchFunding(),
      fetchFG()
    ]);

    const ec = ethK.map(k => parseFloat(k[4]));
    const bc = btcK.map(k => parseFloat(k[4]));

    const macd1h  = calcMACD(ec);
    const btcMacd = calcMACD(bc);
    const rsi     = calcRSI(ec, 14);
    const obv     = calcOBV(ethK);
    const atr     = calcATR(ethK, 14);
    const trap    = calcTrap(ethK, atr);
    const btcBull = btcMacd.positive;

    const conf   = calcConfidence(macd1h, rsi, obv, btcMacd, funding, trap);
    const trigs  = checkTriggers(macd1h, obv, btcBull, trap, fg);
    const confOK = conf >= 75;

    // RSI conditions
    const rsiOversold  = rsi < 38;
    const rsiOverbought = rsi > 62;
    const rsiOK = !rsiOverbought && !rsiOversold ||
                  (rsiOversold && macd1h.positive) ||
                  (rsiOverbought && !macd1h.positive);

    // ── Entry Signal — เหมือน Dashboard v5.13 ──
    let sig = 'HOLD';
    if (!confOK) {
      sig = `HOLD — Conf ต่ำ (${conf}% / ต้อง 75%)`;
    } else if (trap.alert) {
      sig = 'NO GO — TRAP DETECTED';
    } else if (macd1h.cross && obv.positive && obv.slope > 0 && btcBull && rsiOK) {
      sig = 'GO';
    } else if (macd1h.positive && obv.positive && obv.slope > 0 && btcBull) {
      sig = 'SOFT GO — รอ MACD Cross';
    } else if (macd1h.positive && obv.positive && !btcBull) {
      sig = 'HOLD — BTC ไม่ Align';
    } else if (macd1h.positive && (!obv.positive || obv.slope <= 0)) {
      sig = 'HOLD — รอ OBV Slope+';
    } else if (!macd1h.positive && macd1h.cross) {
      sig = 'WATCH — MACD Cross เพิ่งเกิด';
    } else {
      sig = 'HOLD — MACD ยังไม่ Cross';
    }

    const dir  = macd1h.positive ? 'LONG 🟢' : 'SHORT 🔴';
    const now  = Date.now();
    const p    = price.toFixed(2);
    const fgLabel = fg <= 25 ? '😱 Extreme Fear' : fg <= 45 ? '😨 Fear' : fg <= 55 ? '😐 Neutral' : fg <= 75 ? '😊 Greed' : '🤑 Extreme Greed';

    console.log(`[${new Date().toLocaleTimeString('th-TH')}] $${p} Conf:${conf}% RSI:${rsi.toFixed(0)} Trig:${trigs.score}/5 | ${sig}`);

    // ── Notifications ──────────────────────
    // ── ไม่แจ้ง Signal ขณะ Trade Monitor รัน ──
    if(tradeState){
      lastSig=sig; // update state แต่ไม่แจ้ง
      return;
    }

    if (sig === 'GO' && sig !== lastSig && now > goCooldown) {
      goCooldown = now + 180000;
      await tg(
`✅ <b>ETH GO SIGNAL!</b>

🎯 Direction: <b>${dir}</b>
📊 Confidence: <b>${conf}%</b>
⚡ Trigger: <b>${trigs.score}/5</b>
💰 Price: <b>$${p}</b>

📈 MACD Cross: ✅
📊 OBV Slope+: ✅
🟡 BTC Bull: ✅
📉 RSI: ${rsi.toFixed(1)} ${rsiOversold?'📉OS':rsiOverbought?'📈OB':'✅'}
😨 F&G: ${fg} ${fgLabel}
💸 Funding: ${funding.toFixed(4)}%`, true);

    } else if (sig === 'SOFT GO — รอ MACD Cross' && sig !== lastSig && now > softGoCooldown) {
      softGoCooldown = now + 120000;
      lastConfAlert = true; // รวม conf alert ไปด้วย
      await tg(
`⚡ <b>ETH SOFT GO</b>

🎯 Direction: <b>${macd1h.positive?'🟢 LONG':'🔴 SHORT'}</b>
📊 Confidence: <b>${conf}%</b> | Trigger: <b>${trigs.score}/5</b>
💰 Price: $${p}
📈 MACD: Positive (รอ Cross)
📊 OBV: ${obv.positive && obv.slope > 0 ? 'Slope+ ✅' : '❌'}
🟡 BTC: ${btcBull ? 'Bull ✅' : 'Bear ❌'}
📉 RSI: ${rsi.toFixed(1)}
😨 F&G: ${fg} ${fgLabel}

⏳ รอ MACD Cross ก่อน Entry`, true);

    } else if (sig === 'GO' && sig !== lastSig && now > goCooldown) {
      // GO รวม conf ด้วย
    } else if (sig === 'NO GO — TRAP DETECTED' && sig !== lastSig) {
      await tg(
`⛔ <b>ETH TRAP DETECTED</b>

💰 Price: $${p}
🪤 Trap Prob: ${(trap.prob * 100).toFixed(0)}%
📊 Confidence: ${conf}%

❌ งดเทรด รอ Signal ใหม่`, true);
    }

    // Conf ≥ 75% alert — ส่งเฉพาะถ้าไม่ได้รวมไปกับ Signal แล้ว
    if(confOK && !lastConfAlert) {
      lastConfAlert = true;
      await tg(
`📊 <b>Confidence ≥ 75%!</b>

🎯 Direction: <b>${macd1h.positive ? '🟢 LONG' : '🔴 SHORT'}</b>
📊 Conf: ${conf}% | Trigger: ${trigs.score}/5
💰 Price: $${p}
📉 RSI: ${rsi.toFixed(1)}
😨 F&G: ${fg} ${fgLabel}

ระบบเริ่มตรวจ Trigger แล้ว`, true);
    } else if (!confOK) {
      lastConfAlert = false;
    }

    lastSig = sig;

  } catch (e) {
    console.error('Analyze error:', e.message);
  }
}

// ── Trade Monitor — รับข้อมูลจาก Dashboard ──
const http = require('http');
let tradeState = null;
let tradeInterval = null;

function startTradeMonitor(state) {
  stopTradeMonitor();
  tradeState = state;
  console.log('📊 Trade Monitor started:', JSON.stringify(state));
  tg(`📊 <b>Trade Monitor เริ่มแล้ว!</b>

🎯 Direction: ${state.dir.toUpperCase()}
💰 Entry: $${parseFloat(state.entry).toFixed(2)}
🎯 TP1: $${parseFloat(state.tp1).toFixed(2)}
🏆 TP2: $${parseFloat(state.tp2).toFixed(2)}
🛑 SL: $${parseFloat(state.sl).toFixed(2)}
⏱ Duration: ${state.dur}

Bot จะแจ้งเมื่อ TP/SL/Timeout`, true);

  tradeInterval = setInterval(async () => {
    if (!tradeState) { stopTradeMonitor(); return; }
    const now = Date.now();

    // Timeout check
    if (tradeState.endTime && now >= tradeState.endTime) {
      stopTradeMonitor();
      const price = await fetchPrice().catch(() => tradeState.entry);
      const pnl = tradeState.dir === 'long'
        ? (price - tradeState.entry) * tradeState.qty
        : (tradeState.entry - price) * tradeState.qty;
      await tg(`⏰ <b>Trade TIMEOUT</b>

🎯 ${tradeState.dir.toUpperCase()} | Entry: $${parseFloat(tradeState.entry).toFixed(2)}
💰 Exit Price: $${parseFloat(price).toFixed(2)}
📊 PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, true);
      tradeState = null;
      return;
    }

    // Fetch price และตรวจ TP/SL
    let price;
    try { price = await fetchPrice(); } catch { return; }
    const p = parseFloat(price);
    const entry = parseFloat(tradeState.entry);
    const tp1 = parseFloat(tradeState.tp1);
    const tp2 = parseFloat(tradeState.tp2);
    const sl = parseFloat(tradeState.sl);
    const qty = parseFloat(tradeState.qty || 0.04);
    const fmt = v => v.toFixed(2);

    if (tradeState.dir === 'long') {
      if (!tradeState.tp1Hit && p >= tp1) {
        tradeState.tp1Hit = true;
        const rem = tradeState.endTime ? Math.round((tradeState.endTime - now) / 60000) : '?';
        await tg(`🎯 <b>LONG TP1 HIT!</b>\n\n$${fmt(p)} ≥ TP1 $${fmt(tp1)}\nเหลือ ${rem} นาที`, true);
      }
      if (p >= tp2) {
        stopTradeMonitor();
        await tg(`🏆 <b>LONG TP2 WIN!</b>\n\n$${fmt(p)} | Entry $${fmt(entry)}\n+$${fmt((p - entry) * qty)}`, true);
        tradeState = null;
      } else if (p <= sl) {
        stopTradeMonitor();
        await tg(`🛑 <b>LONG SL HIT</b>\n\n$${fmt(p)} | Entry $${fmt(entry)}\n-$${fmt((entry - p) * qty)}`, true);
        tradeState = null;
      }
    } else {
      if (!tradeState.tp1Hit && p <= tp1) {
        tradeState.tp1Hit = true;
        const rem = tradeState.endTime ? Math.round((tradeState.endTime - now) / 60000) : '?';
        await tg(`🎯 <b>SHORT TP1 HIT!</b>\n\n$${fmt(p)} ≤ TP1 $${fmt(tp1)}\nเหลือ ${rem} นาที`, true);
      }
      if (p <= tp2) {
        stopTradeMonitor();
        await tg(`🏆 <b>SHORT TP2 WIN!</b>\n\n$${fmt(p)} | Entry $${fmt(entry)}\n+$${fmt((entry - p) * qty)}`, true);
        tradeState = null;
      } else if (p >= sl) {
        stopTradeMonitor();
        await tg(`🛑 <b>SHORT SL HIT</b>\n\n$${fmt(p)} | Entry $${fmt(entry)}\n-$${fmt((p - entry) * qty)}`, true);
        tradeState = null;
      }
    }
  }, 10000);
}

function stopTradeMonitor() {
  if (tradeInterval) { clearInterval(tradeInterval); tradeInterval = null; }
}

// ── HTTP Server — รับ POST จาก Dashboard ──
const server = http.createServer((req, res) => {
  // CORS headers — ให้ Dashboard เรียกได้
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/trade') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        if (state.action === 'start') {
          startTradeMonitor(state);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Trade monitor started' }));
        } else if (state.action === 'stop') {
          stopTradeMonitor();
          tradeState = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Trade monitor stopped' }));
        } else {
          res.writeHead(400); res.end('Unknown action');
        }
      } catch (e) {
        res.writeHead(400); res.end('Invalid JSON');
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, trade: !!tradeState, sig: lastSig }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(3000, () => {
  console.log('🌐 HTTP Server listening on port 3000');
});

// ── Start ───────────────────────────────
console.log('🚀 ETH Cone Bot v3.0 Started');
console.log('📡 Monitoring every 10s | Singapore 🇸🇬');

// แสดงครั้งเดียวตอน start — ใช้ flag file
const fs = require('fs');
const flagFile = '/home/ubuntu/eth-bot/.started';
if (!fs.existsSync(flagFile)) {
  fs.writeFileSync(flagFile, Date.now().toString());
  tg('🚀 <b>ETH Cone Bot v3.0 Online</b> | Oracle 🇸🇬');
}

analyze();
setInterval(analyze, 10000);

