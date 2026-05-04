// ETH Cone Bot v2.0 — Oracle VM
// Logic เหมือน Dashboard v5.13 ทุกอย่าง
// Conf gate → Trigger 5 ตัว → GO/SOFT GO/TRAP

const BOT_TOKEN = '8397156356:AAHpIeQYWikPCH2wthqYBWMCMp0sXmFLcMM';
const CHAT_ID   = '7970078364';
const BINANCE   = 'https://fapi.binance.com';
const FG_API    = 'https://api.alternative.me/fng/?limit=1';

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
      await tg(
`⚡ <b>ETH SOFT GO</b>

📊 Confidence: ${conf}% | Trigger: ${trigs.score}/5
💰 Price: $${p}
📈 MACD: Positive (รอ Cross)
📊 OBV: ${obv.positive && obv.slope > 0 ? 'Slope+ ✅' : '❌'}
🟡 BTC: ${btcBull ? 'Bull ✅' : 'Bear ❌'}
📉 RSI: ${rsi.toFixed(1)}

⏳ รอ MACD Cross ก่อน Entry`, true);

    } else if (sig === 'NO GO — TRAP DETECTED' && sig !== lastSig) {
      await tg(
`⛔ <b>ETH TRAP DETECTED</b>

💰 Price: $${p}
🪤 Trap Prob: ${(trap.prob * 100).toFixed(0)}%
📊 Confidence: ${conf}%

❌ งดเทรด รอ Signal ใหม่`, true);
    }

    // Conf ≥ 75% alert ครั้งแรก
    if (confOK && !lastConfAlert) {
      lastConfAlert = true;
      await tg(
`📊 <b>Confidence ≥ 75%!</b>

Conf: ${conf}% | Trigger: ${trigs.score}/5
Price: $${p}
ระบบเริ่มตรวจ Trigger แล้ว`, true);
    } else if (!confOK) {
      lastConfAlert = false;
    }

    lastSig = sig;

  } catch (e) {
    console.error('Analyze error:', e.message);
  }
}

// ── Start ───────────────────────────────
console.log('🚀 ETH Cone Bot v2.0 Started — Logic = Dashboard v5.13');
console.log('📡 Monitoring every 10s | Singapore 🇸🇬');
tg(`🚀 <b>ETH Cone Bot v2.0 เริ่มทำงาน!</b>

🧠 Logic = Dashboard v5.13
📡 Monitor ทุก 10s | Oracle Cloud 🇸🇬
⚡ Gate: Conf ≥75% → Trigger 5 ตัว → GO

แจ้งเตือน: GO / SOFT GO / TRAP / Conf Alert`);

analyze();
setInterval(analyze, 10000);
