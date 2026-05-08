// ============================================================
// ETH Cone Logic — Shared v1.0
// ใช้ร่วมกันระหว่าง Dashboard (browser) และ Bot (Node.js)
// แก้ที่นี่ที่เดียว — sync ทั้งคู่อัตโนมัติ
// ============================================================

const ETH_LOGIC_VERSION = '1.2';

// ── Indicators ──────────────────────────────────────────────
function calcEMA(c, n) {
  const k = 2 / (n + 1);
  let e = c[0];
  for (let i = 1; i < c.length; i++) e = c[i] * k + e * (1 - k);
  return e;
}

function calcMACD(closes) {
  const hist = calcEMA(closes, 12) - calcEMA(closes, 26);
  const prevHist = calcEMA(closes.slice(0, -1), 12) - calcEMA(closes.slice(0, -1), 26);
  const bullCross = hist > 0 && prevHist <= 0; // ขึ้น
  const bearCross = hist < 0 && prevHist >= 0; // ลง
  return {
    positive: hist > 0,
    cross: bullCross || bearCross, // cross ทั้งสองทิศ
    bullCross,
    bearCross,
    hist
  };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
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
  const recent = arr.slice(-5);
  const slope = (recent[recent.length - 1] - recent[0]) / 5;
  const divergence = recent.slice(-3).every((v, i, a) => i === 0 || v < a[i - 1]);
  return { positive: obv > 0, slope, divergence };
}

function calcATR(klines, period = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]);
    const l = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i - 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcTrap(klines, atr) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const vols  = klines.map(k => parseFloat(k[5]));
  const last  = klines[klines.length - 1];
  const body  = Math.abs(parseFloat(last[4]) - parseFloat(last[1]));
  const range = parseFloat(last[2]) - parseFloat(last[3]);
  const wickR = range > 0 ? (range - body) / range : 0;
  const avg   = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const std   = Math.sqrt(vols.slice(-20).reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 20);
  const volZ  = std > 0 ? (vols[vols.length - 1] - avg) / std : 0;
  const sq    = (Math.max(...highs.slice(-5)) - Math.min(...lows.slice(-5))) < atr * 0.5;
  let prob = 0;
  if (wickR > 0.6) prob += 0.3;
  if (volZ > 2)    prob += 0.25;
  if (sq)          prob += 0.3;
  if (volZ < -1)   prob += 0.15;
  return { prob: Math.min(1, prob), alert: prob > 0.6 };
}

function calcConfidence(macd, rsi, obv, btcMacd, funding, trap) {
  let score = 60;
  if (macd.positive) {
    // LONG mode
    if (macd.positive)    score += 8;
    if (macd.bullCross)   score += 5;
    if (obv.positive)     score += 5;
    if (obv.slope > 0)    score += 2;
    if (btcMacd.positive) score += 8;
    if (rsi < 38)         score += 4;
    if (rsi > 65)         score -= 4;
    if (rsi > 62)         score -= 2;
  } else {
    // SHORT mode
    if (!macd.positive)    score += 8;
    if (macd.bearCross)    score += 5;
    if (!obv.positive)     score += 5;
    if (obv.slope < 0)     score += 2;
    if (!btcMacd.positive) score += 8;
    if (rsi > 65)          score += 4;
    if (rsi < 38)          score -= 4;
  }
  if (!obv.divergence)      score += 2;
  if (rsi > 40 && rsi < 60) score += 3;
  if (funding < -0.01)      score += 2;
  if (funding > 0.01)       score -= 2;
  if (trap.alert)           score -= 15;
  else if (trap.prob > 0.3) score -= 5;
  return Math.min(95, Math.max(50, Math.round(score)));
}

function calcSignal(macd1h, obv, rsi, trap, conf) {
  const confOK = conf >= 75;
  const rsiOS  = rsi < 38;
  const rsiOB  = rsi > 62;
  let sig = 'HOLD';
  let entryReady = false;
  let entryDir = 'long';
  if (!confOK) {
    sig = `HOLD — Conf ต่ำ (${conf}%)`;
  } else if (trap.alert) {
    sig = 'NO GO — TRAP DETECTED';
  } else if (macd1h.positive && obv.positive && !rsiOB) {
    sig = macd1h.bullCross ? 'GO LONG' : 'SOFT GO — LONG Ready';
    entryDir = 'long';
    entryReady = true;
  } else if (!macd1h.positive && !obv.positive && !rsiOB) {
    sig = macd1h.bearCross ? 'GO SHORT' : 'SOFT GO — SHORT Ready';
    entryDir = 'short';
    entryReady = true;
  } else if (macd1h.positive && !obv.positive) {
    sig = 'HOLD — รอ OBV+';
  } else if (!macd1h.positive && obv.positive) {
    sig = 'HOLD — รอ OBV-';
  } else {
    sig = 'HOLD — รอ Signal';
  }
  return { sig, entryReady, entryDir, confOK };
}

function calcTriggers(macd, obv, btcBull, trap, fg) {
  const t1 = macd.bullCross || macd.positive || macd.bearCross || !macd.positive;
  const t2 = obv.positive || !obv.positive; // OBV มีทิศทาง
  const t3 = btcBull;
  const t4 = !trap.alert;
  const t5 = fg > 20 && fg < 80;
  // นับ trigger ตาม direction
  const longScore  = [macd.positive, obv.positive, btcBull, t4, t5].filter(Boolean).length;
  const shortScore = [!macd.positive, !obv.positive, !btcBull, t4, t5].filter(Boolean).length;
  return { t1, t2, t3, t4, t5, score: Math.max(longScore, shortScore), longScore, shortScore };
}

// ── Export — รองรับทั้ง Node.js และ Browser ────────────────
const ETH_LOGIC = {
  version: ETH_LOGIC_VERSION,
  calcEMA,
  calcMACD,
  calcRSI,
  calcOBV,
  calcATR,
  calcTrap,
  calcConfidence,
  calcSignal,
  calcTriggers
};

// Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ETH_LOGIC;
}
// Browser
if (typeof window !== 'undefined') {
  window.ETH_LOGIC = ETH_LOGIC;
}
