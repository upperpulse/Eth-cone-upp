// ============================================================
// ETH Cone Logic — Shared v1.0
// ใช้ร่วมกันระหว่าง Dashboard (browser) และ Bot (Node.js)
// แก้ที่นี่ที่เดียว — sync ทั้งคู่อัตโนมัติ
// ============================================================

const ETH_LOGIC_VERSION = '2.3';
const CONF_THRESHOLD = 80; // sync กับ confOK threshold

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

function calcConfidence(macd, rsi, obv, btcMacd, funding, trap, extra = {}) {
  let score = 60;
  if (macd.positive) {
    // LONG mode
    if (macd.bullCross)   score += 5;
    score += 8; // MACD positive
    if (obv.positive)     score += 5;
    if (obv.slope > 0)    score += 2;
    if (btcMacd.positive) score += 8;
    if (rsi > 32 && rsi < 55) score += 4; // sweet spot LONG
    if (rsi < 30)         score -= 12;
    if (rsi < 35)         score -= 6;
    if (rsi > 65)         score -= 6;
    if (rsi > 60)         score -= 3;
  } else {
    // SHORT mode
    if (macd.bearCross)    score += 5;
    score += 8;
    if (!obv.positive)     score += 5;
    if (obv.slope < 0)     score += 2;
    if (!btcMacd.positive) score += 8;
    if (rsi > 45 && rsi < 70) score += 4;
    if (rsi < 35)          score -= 8;
    if (rsi < 40)          score -= 4;
    if (rsi > 72)          score -= 3;
  }
  if (!obv.divergence)      score += 2;
  if (rsi > 40 && rsi < 60) score += 2;
  if (funding < -0.01)      score += 2;
  if (funding > 0.01)       score -= 2;
  if (trap.alert)           score -= 22;
  else if (trap.prob > 0.3) score -= 5;

  // ══════════════════════════════════════════
  // NEW v2.3 — 3 confirmation factors
  // ══════════════════════════════════════════
  
  // 1. Volume Confirmation
  const volRatio = extra.volRatio;
  if (volRatio !== undefined) {
    if (volRatio > 1.5)      score += 5;  // institutional
    else if (volRatio > 1.2) score += 2;
    else if (volRatio < 0.7) score -= 8;  // low conviction (stronger)
  }
  
  // 2. ATR-adjusted (penalty volatility สูง/ต่ำ)
  const atrRatio = extra.atrRatio;
  if (atrRatio !== undefined) {
    if (atrRatio > 1.6)      score -= 7;  // too volatile (stronger)
    else if (atrRatio < 0.9) score -= 3;  // sideways
  }
  
  // 3. Candle Confirmation — ราคาต้องสอดคล้องทิศ
  const candleBull = extra.candleBull;
  if (candleBull !== undefined) {
    if (macd.positive && !candleBull)       score -= 7; // LONG แต่ candle แดง (stronger)
    else if (!macd.positive && candleBull)  score -= 7; // SHORT แต่ candle เขียว (stronger)
    else if (macd.positive && candleBull)   score += 2; // LONG + candle เขียว
    else if (!macd.positive && !candleBull) score += 2; // SHORT + candle แดง
  }

  return Math.min(95, Math.max(50, Math.round(score)));
}

function calcSignal(macd1h, obv, rsi, trap, conf, options = {}) {
  const confOK    = conf >= 80;
  const rsiOB     = rsi > 62;
  const goOnly    = options.goOnly || false;     // true = GO cross เท่านั้น
  const aboveEMA  = options.aboveEMA50 !== undefined ? options.aboveEMA50 : true;
  const belowEMA  = options.belowEMA50 !== undefined ? options.belowEMA50 : true;
  const atrOK     = options.atrOK !== undefined ? options.atrOK : true;
  const momentumOK = options.momentumOK !== undefined ? options.momentumOK : true; // micro-momentum confirm

  let sig = 'HOLD';
  let entryReady = false;
  let entryDir = 'long';

  // Block extreme RSI trap เมื่อ Conf สูงมาก
  const extremeRSI = conf >= 90 && (rsi < 35 || rsi > 65);
  if (!confOK) {
    sig = `HOLD — Conf ต่ำ (${conf}%)`;
  } else if (extremeRSI) {
    sig = `HOLD — RSI Extreme (${rsi.toFixed(0)}) Trap Risk`;
  } else if (trap.alert) {
    sig = 'NO GO — TRAP DETECTED';
  } else if (!atrOK) {
    sig = 'HOLD — ATR ต่ำเกิน (Sideways)';
  } else if (!momentumOK) {
    sig = 'HOLD — รอจังหวะ (Counter-Momentum)';

  // ── LONG conditions ──────────────────────
  } else if (macd1h.positive && (obv.positive || obv.slope > 0) && !rsiOB && rsi > 28 && aboveEMA) {
    // LONG: OBV positive หรือ slope ขึ้น (กำลังดีขึ้น) ก็พอ
    if (macd1h.bullCross) {
      sig = 'GO LONG';
      entryDir = 'long';
      entryReady = true;
    } else if (!goOnly && macd1h.hist > 0.0001) {
      // SOFT GO เฉพาะ MACD hist แข็งแรงพอ
      sig = 'SOFT GO — LONG Ready';
      entryDir = 'long';
      entryReady = true;
    } else {
      sig = 'HOLD — รอ MACD แข็งแรงขึ้น (LONG)';
    }
  } else if (macd1h.positive && (obv.positive || obv.slope > 0) && rsi <= 28) {
    sig = 'HOLD — RSI Extreme Oversold';
  } else if (macd1h.positive && !aboveEMA) {
    sig = 'HOLD — ราคาต่ำกว่า EMA50 (LONG Risk)';
  } else if (macd1h.positive && !obv.positive && obv.slope <= 0) {
    sig = 'HOLD — รอ OBV+ หรือ Slope+';

  // ── SHORT conditions ─────────────────────
  } else if (!macd1h.positive && (!obv.positive || obv.slope < 0) && !rsiOB && rsi > 35 && belowEMA) {
    // SHORT: OBV negative หรือ slope ลง ก็พอ
    if (macd1h.bearCross) {
      sig = 'GO SHORT';
      entryDir = 'short';
      entryReady = true;
    } else if (!goOnly && macd1h.hist < -0.0001) {
      // SOFT GO เฉพาะ MACD hist แข็งแรงพอ
      sig = 'SOFT GO — SHORT Ready';
      entryDir = 'short';
      entryReady = true;
    } else {
      sig = 'HOLD — รอ MACD แข็งแรงขึ้น (SHORT)';
    }
  } else if (!macd1h.positive && (!obv.positive || obv.slope < 0) && rsi <= 35) {
    sig = 'HOLD — RSI Oversold (SHORT Risk)';
  } else if (!macd1h.positive && belowEMA === false) {
    sig = 'HOLD — ราคาสูงกว่า EMA50 (SHORT Risk)';
  } else if (!macd1h.positive && obv.positive && obv.slope >= 0) {
    sig = 'HOLD — OBV ยังขึ้น (SHORT Risk)';

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


// ── Best Direction Selector ──────────────────────────────────────
// เปรียบเทียบ LONG vs SHORT แล้วเลือก Conf สูงกว่า
function calcBestDirection(ethKlines, btcKlines, funding, trap, fg) {
  const ec = ethKlines.map(k => parseFloat(k[4]));
  const bc = btcKlines.map(k => parseFloat(k[4]));

  const macd     = calcMACD(ec);
  const btcMacd  = calcMACD(bc);
  const rsi      = calcRSI(ec, 14);
  const obv      = calcOBV(ethKlines);
  const atr      = calcATR(ethKlines, 14);
  const ema50    = calcEMA(ec, 50);
  const ema20    = calcEMA(ec, 20);
  const price    = ec[ec.length - 1];
  const aboveEMA50 = price > ema50;  // uptrend (long-term)
  const belowEMA50 = price < ema50;  // downtrend (long-term)
  // EMA20 — short-term trend
  const aboveEMA20 = price > ema20;
  const belowEMA20 = price < ema20;
  // ทั้ง 50+20 ต้องสอดคล้อง — ถ้าไม่ = ตลาดกำลังเปลี่ยนทิศ
  const trendAlignLong  = aboveEMA50 && aboveEMA20;
  const trendAlignShort = belowEMA50 && belowEMA20;
  // Bounce detection — ราคาเด้งจาก low/high ใน 20 candles ล่าสุด
  const recent20  = ec.slice(-20);
  const recentLow = Math.min(...recent20);
  const recentHigh = Math.max(...recent20);
  const bouncedUp   = (price - recentLow)  / recentLow  > 0.012; // เด้งขึ้น >1.2%
  const droppedDown = (recentHigh - price) / recentHigh > 0.012; // ดิ่งลง >1.2%
  // Minimum ATR filter — ไม่เทรดตอน sideways
  const avgATR   = calcATR(ethKlines, 20);
  const atrOK    = atr > avgATR * 0.8 && atr < avgATR * 1.8; // ATR ต้องอยู่ใน active range ไม่ volatile เกิน

  // ── Momentum Confirmation — ไม่เข้าสวน micro-momentum ──
  // ดู 3 candle ล่าสุด + RSI slope
  const c1 = ec[ec.length-1], c2 = ec[ec.length-2], c3 = ec[ec.length-3];
  const rsiPrev  = calcRSI(ec.slice(0, -1), 14);
  const rsiSlope = rsi - rsiPrev; // RSI กำลังขึ้นหรือลง
  // candle เขียว = ขึ้น, แดง = ลง
  const greenCount = [c1>c2, c2>c3].filter(Boolean).length;
  const redCount   = [c1<c2, c2<c3].filter(Boolean).length;
  // Block เฉพาะตอนสวน momentum แรงจริงๆ:
  // SHORT จะ block ก็ต่อเมื่อ ราคาขึ้น 2 candle ติด AND RSI พุ่ง > 4
  const strongUp   = greenCount === 2 && rsiSlope > 4;
  const strongDown = redCount === 2 && rsiSlope < -4;
  const momentumLong  = !strongDown && !droppedDown; // LONG: ไม่เข้าตอนเพิ่งดิ่ง
  const momentumShort = !strongUp && !bouncedUp;     // SHORT: ไม่เข้าตอนเพิ่งเด้ง

  // ── Extra factors สำหรับ v2.3 Conf ──
  const vols     = ethKlines.map(c => parseFloat(c[5]));
  const avgVol   = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
  const volRatio = vols[vols.length-1] / avgVol;
  const atrRatio = atr / avgATR;
  const lastK    = ethKlines[ethKlines.length-1];
  const candleBull = parseFloat(lastK[4]) > parseFloat(lastK[1]); // close > open

  // คำนวณ Conf ทั้งสองฝั่ง (พร้อม extras)
  const confExtras = { volRatio, atrRatio, candleBull };
  const confLong   = calcConfidence(macd, rsi, obv, btcMacd, funding, trap, confExtras);

  // จำลอง SHORT — flip MACD และ OBV
  const macdShort = { ...macd, positive: false, bullCross: false, bearCross: !macd.positive };
  const obvShort  = { ...obv,  positive: false, slope: -Math.abs(obv.slope) };
  const confShort = calcConfidence(macdShort, rsi, obvShort, btcMacd, funding, trap, confExtras);

  // Signal ทั้งสองฝั่ง พร้อม EMA, ATR และ Momentum filter
  const opts = { aboveEMA50: trendAlignLong, belowEMA50: trendAlignShort, atrOK };
  const sigLong  = calcSignal(macd, obv, rsi, trap, confLong,  {...opts, momentumOK: momentumLong});
  const sigShort = calcSignal(macdShort, obvShort, rsi, trap, confShort, {...opts, momentumOK: momentumShort});

  // เลือก direction ที่ดีกว่า
  let best = null;
  if (sigLong.entryReady && sigShort.entryReady) {
    // ทั้งคู่พร้อม → เลือก Conf สูงกว่า
    best = confLong >= confShort ? sigLong : sigShort;
  } else if (sigLong.entryReady) {
    best = sigLong;
  } else if (sigShort.entryReady) {
    best = sigShort;
  }

  return {
    macd, obv, rsi, atr, trap, btcMacd,
    ema50, ema20, price, aboveEMA50, belowEMA50, atrOK,
    rsiSlope, momentumLong, momentumShort,
    aboveEMA20, belowEMA20, trendAlignLong, trendAlignShort,
    volRatio, atrRatio, candleBull,
    bouncedUp, droppedDown, recentLow, recentHigh,
    confLong, confShort,
    sigLong, sigShort,
    best,
    fg
  };
}

// ── Export — รองรับทั้ง Node.js และ Browser ────────────────
const ETH_LOGIC = {
  version: ETH_LOGIC_VERSION,
  CONF_THRESHOLD,
  calcEMA,
  calcMACD,
  calcRSI,
  calcOBV,
  calcATR,
  calcTrap,
  calcConfidence,
  calcSignal,
  calcTriggers,
  calcBestDirection
};

// Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ETH_LOGIC;
}
// Browser
if (typeof window !== 'undefined') {
  window.ETH_LOGIC = ETH_LOGIC;
}
