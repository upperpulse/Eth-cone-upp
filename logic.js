// ============================================================
// ETH Cone Logic — Shared v1.0
// ใช้ร่วมกันระหว่าง Dashboard (browser) และ Bot (Node.js)
// แก้ที่นี่ที่เดียว — sync ทั้งคู่อัตโนมัติ
// ============================================================

const ETH_LOGIC_VERSION = '3.12';
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
    if (obv.slope > 0)    score += 8;   // เพิ่มจาก 2 → 8 (ML: OBV ทำนายดีสุด)
    if (obv.slope < 0)    score -= 10;  // LONG แต่ OBV ลง = ไม่มีแรงซื้อ → penalty
    // v3.12: OBV strength penalty — แรงซื้ออ่อน = ปลาย uptrend (เด้งหมดแรง)
    if (obv.slope > 0 && obv.slope < 30000) score -= 7;  // บวกแต่อ่อน → ใกล้ยอด
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
    if (obv.slope < 0)     score += 8;  // เพิ่มจาก 2 → 8 (ML: OBV ทำนายดีสุด)
    if (obv.slope > 0)     score -= 10; // SHORT แต่ OBV ขึ้น = ไม่มีแรงขาย → penalty
    // v3.12: OBV strength penalty — แรงขายอ่อน = ปลาย downtrend (ก้นเด้ง)
    // ML: WIN OBV -79k (แรง) vs LOSS -22k (อ่อน) → ลบอ่อน = เด้งเสี่ยง
    if (obv.slope < 0 && obv.slope > -30000) score -= 7;  // ลบแต่อ่อน → ใกล้ก้น
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
  const threshold = options.threshold !== undefined ? options.threshold : 80;
  const confOK    = conf >= threshold;
  const regimeTrending = options.regimeTrending || false;  // v3.1: ตลาด trend ชัด
  const shortExhausted = options.shortExhausted || false;  // v3.6
  const longExhausted = options.longExhausted || false;
  const sigDir = options.sigDir || 'long';                 // v3.1: ทิศที่เช็ค
  // v3.2: RSI Adaptive ตาม regime
  // TRENDING → ผ่อน (ตามเทรนด์) | RANGING → เข้ม (กันเด้ง) | VOLATILE → เข้มสุด
  let rsiShortMin = 35, rsiLongMax = 62;  // default (RANGING-like)
  const earlyBull = options.earlyBull || false;  // v3.10
  if (regimeTrending) {
    rsiShortMin = 25;   // downtrend แรง RSI ต่ำ = ปกติ → SHORT ได้
    rsiLongMax = 75;    // uptrend แรง RSI สูง = ปกติ → LONG ได้
  }
  // v3.10: early-bull = uptrend เพิ่งเริ่ม (ยังไม่ confirm) → RSI ceiling เข้มขึ้น
  // แก้ #6,#8 R20: LONG เข้า RSI 67,58 (ยอด) → ย่อ
  if (earlyBull) rsiLongMax = 62;  // ไม่ LONG ตอน RSI > 62 (ใกล้ยอด)
  const rsiOB     = rsi > rsiLongMax;
  const goOnly    = options.goOnly || false;     // true = GO cross เท่านั้น
  const aboveEMA  = options.aboveEMA50 !== undefined ? options.aboveEMA50 : true;
  const belowEMA  = options.belowEMA50 !== undefined ? options.belowEMA50 : true;
  const atrOK     = options.atrOK !== undefined ? options.atrOK : true;
  const momentumOK = options.momentumOK !== undefined ? options.momentumOK : true; // micro-momentum confirm
  let sig = 'HOLD';
  let entryReady = false;
  let entryDir = 'long';

  // Block extreme RSI trap เมื่อ Conf สูงมาก
  // v3.1: ผ่อนเมื่อ TRENDING + ทิศตรงกับ trend (RSI ต่ำใน downtrend = ปกติ ไม่ใช่ trap)
  // SHORT ตอน RSI ต่ำ + downtrend = OK | LONG ตอน RSI สูง + uptrend = OK
  let extremeRSI = conf >= 90 && (rsi < 35 || rsi > 65);
  if (regimeTrending) {
    // ตลาด trend: SHORT+RSI ต่ำ หรือ LONG+RSI สูง = ตามเทรนด์ ไม่ block
    if (sigDir === 'short' && rsi < 35 && rsi > 25) extremeRSI = false; // downtrend RSI ต่ำ OK (แต่ < 25 ยัง block)
    if (sigDir === 'long'  && rsi > 65 && rsi < 75 && !earlyBull) extremeRSI = false; // uptrend RSI สูง OK (early-bull ยังเข้ม)
  }
  if (sigDir === 'short' && shortExhausted) {
    sig = 'HOLD — Over-extended (ดิ่งเร็ว+RSI ต่ำ — เสี่ยงเด้ง)';
  } else if (sigDir === 'long' && longExhausted) {
    sig = 'HOLD — Over-extended (พุ่งเร็ว+RSI สูง — เสี่ยงย่อ)';
  } else if (!confOK) {
    sig = `HOLD — Conf ต่ำ (${conf}% / ต้อง ${threshold}%)`;
  } else if (extremeRSI) {
    sig = `HOLD — RSI Extreme (${rsi.toFixed(0)}) Trap Risk`;
  } else if (trap.alert) {
    sig = 'NO GO — TRAP DETECTED';
  } else if (!atrOK) {
    sig = 'HOLD — ตลาด Sideways (ATR < 0.7%)';
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
  } else if (!macd1h.positive && (!obv.positive || obv.slope < 0) && !rsiOB && rsi > rsiShortMin && belowEMA) {
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
  } else if (!macd1h.positive && (!obv.positive || obv.slope < 0) && rsi <= rsiShortMin) {
    sig = `HOLD — RSI Oversold ${rsi.toFixed(0)} < ${rsiShortMin} (SHORT Risk)`;
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

// ════════════════════════════════════════════════════════════
// PHASE A — MARKET REGIME DETECTOR
// ════════════════════════════════════════════════════════════
// คำนวณสภาพตลาดจริงจาก price action 
// Output: { regime, score, details } 
//
// regime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'TRANSITION'

function detectMarketRegime(klines4h, klines1h) {
  // ใช้ 4H เป็นหลัก (ภาพรวม), 1H เป็น confirmation
  const cls4h = klines4h.map(k => parseFloat(k[4]));
  const cls1h = klines1h.map(k => parseFloat(k[4]));
  const recent4h = cls4h.slice(-50);
  const recent1h = cls1h.slice(-50);

  const price = cls4h[cls4h.length - 1];

  // 1. ATR analysis (volatility)
  const atr4h = calcATR(klines4h, 14);
  const avgATR = calcATR(klines4h, 50);
  const atrRatio = atr4h / avgATR;
  const atrPct = (atr4h / price) * 100;  // ATR เป็น % ของราคา

  // 2. Range analysis
  const high4h = Math.max(...recent4h);
  const low4h = Math.min(...recent4h);
  const rangePct = ((high4h - low4h) / price) * 100;

  // 3. EMA trend strength
  const ema20_4h = calcEMA(cls4h, 20);
  const ema50_4h = calcEMA(cls4h, 50);
  const emaGapPct = Math.abs((ema20_4h - ema50_4h) / price) * 100;
  const emaDirection = ema20_4h > ema50_4h ? 'bull' : 'bear';

  // 4. EMA crossover detection (transition)
  const ema20_prev = calcEMA(cls4h.slice(0, -3), 20);
  const ema50_prev = calcEMA(cls4h.slice(0, -3), 50);
  const wasAbove = ema20_prev > ema50_prev;
  const isAbove = ema20_4h > ema50_4h;
  const justCrossed = wasAbove !== isAbove;

  // 5. Trend consistency (1H confirms 4H)
  const ema20_1h = calcEMA(cls1h, 20);
  const ema50_1h = calcEMA(cls1h, 50);
  const dir1h = ema20_1h > ema50_1h ? 'bull' : 'bear';
  const tfAlign = dir1h === emaDirection;

  // ── Decision Logic ──
  let regime = 'TRANSITION';
  let score = 0;
  let reason = '';

  // VOLATILE — ATR สูงเกิน
  if (atrRatio > 2.0) {
    regime = 'VOLATILE';
    score = -10;
    reason = `ATR ${atrRatio.toFixed(2)}× avg — อันตราย`;
  }
  // TRANSITION — EMA เพิ่ง cross
  else if (justCrossed) {
    regime = 'TRANSITION';
    score = -5;
    reason = 'EMA20/50 เพิ่ง cross — รอ stable';
  }
  // RANGING — range แคบ + ATR ต่ำ
  else if (rangePct < 2.5 && atrPct < 0.8) {
    regime = 'RANGING';
    score = -8;
    reason = `Range ${rangePct.toFixed(1)}% — sideways`;
  }
  // TRENDING — EMA ห่าง + tfAlign
  else if (emaGapPct > 1.0 && tfAlign) {
    regime = 'TRENDING';
    score = +10;
    reason = `${emaDirection.toUpperCase()} trend — EMA gap ${emaGapPct.toFixed(2)}%`;
  }
  // WEAK TRENDING — EMA ห่างพอแต่ TF ไม่ตรง
  else if (emaGapPct > 0.5) {
    regime = 'TRENDING';
    score = +3;
    reason = `Weak ${emaDirection.toUpperCase()} — TF mixed`;
  }
  // Default — neutral
  else {
    regime = 'RANGING';
    score = -3;
    reason = 'Neutral — ไม่ชัด';
  }

  return {
    regime,
    score,
    reason,
    direction: emaDirection,  // bull/bear (ทิศ trend ใหญ่)
    details: {
      atrRatio: +atrRatio.toFixed(2),
      atrPct: +atrPct.toFixed(2),
      rangePct: +rangePct.toFixed(2),
      emaGapPct: +emaGapPct.toFixed(2),
      justCrossed,
      tfAlign
    }
  };
}


// ════════════════════════════════════════════════════════════
// PHASE B — MULTI-TF CONFIRMATION
// ════════════════════════════════════════════════════════════
function analyzeMultiTF(klines15m, klines1h, klines4h) {
  function getTrend(klines) {
    if (!klines || klines.length < 50) return { dir: 'neutral', strength: 0 };
    const cls = klines.map(k => parseFloat(k[4]));
    const ema20 = calcEMA(cls, 20);
    const ema50 = calcEMA(cls, 50);
    const price = cls[cls.length - 1];
    const gap = Math.abs(ema20 - ema50) / price * 100;
    if (price > ema50 && ema20 > ema50) return { dir: 'bull', strength: Math.min(3, Math.floor(gap * 2)) };
    if (price < ema50 && ema20 < ema50) return { dir: 'bear', strength: Math.min(3, Math.floor(gap * 2)) };
    return { dir: 'neutral', strength: 0 };
  }
  const tf15m = getTrend(klines15m);
  const tf1h  = getTrend(klines1h);
  const tf4h  = getTrend(klines4h);
  const dirs = [tf15m.dir, tf1h.dir, tf4h.dir];
  const bullCount = dirs.filter(d => d === 'bull').length;
  const bearCount = dirs.filter(d => d === 'bear').length;
  let alignment, direction, score, reason;
  if (bullCount === 3) { alignment='strong'; direction='bull'; score=10; reason='all BULL'; }
  else if (bearCount === 3) { alignment='strong'; direction='bear'; score=10; reason='all BEAR'; }
  else if (bullCount === 2 && bearCount === 0) { alignment='medium'; direction='bull'; score=5; reason='2 bull + neutral'; }
  else if (bearCount === 2 && bullCount === 0) { alignment='medium'; direction='bear'; score=5; reason='2 bear + neutral'; }
  else if (bullCount === 2 && bearCount === 1) { alignment='conflicted'; direction='bull'; score=-5; reason='mixed bull/bear'; }
  else if (bearCount === 2 && bullCount === 1) { alignment='conflicted'; direction='bear'; score=-5; reason='mixed bear/bull'; }
  else { alignment='weak'; direction='neutral'; score=-3; reason='No alignment'; }
  return { alignment, direction, score, reason, details: { tf15m: tf15m.dir, tf1h: tf1h.dir, tf4h: tf4h.dir, bullCount, bearCount } };
}


// ════════════════════════════════════════════════════════════
// ENGINE B — PRE-BURST DETECTOR (v3.0)
// ════════════════════════════════════════════════════════════
// จับจังหวะ "ก่อน" ตลาด breakout — เข้า early ทำกำไรสูงช่วงสั้น
// แยกอิสระจาก Engine A (trend trading)
//
// Output: { preBurst, direction, strength, reason, details }

function detectPreBurst(klines1h, klines15m) {
  const c1h = klines1h.map(k => parseFloat(k[4]));
  const v1h = klines1h.map(k => parseFloat(k[5]));
  const price = c1h[c1h.length - 1];

  // ── 1. ATR Squeeze ──
  const atrNow = calcATR(klines1h, 14);
  const atrAvg = calcATR(klines1h, 50);
  const atrRatio = atrNow / atrAvg;
  const squeeze = atrRatio < 0.7;  // ATR หดตัว 30%+

  // ── 2. Range Compression ──
  const recent10 = c1h.slice(-10);
  const high10 = Math.max(...recent10);
  const low10 = Math.min(...recent10);
  const rangePct = ((high10 - low10) / price) * 100;
  const compressed = rangePct < 2.0;  // range แคบ < 2%

  // ── 3. Volume Building ──
  const volRecent = v1h.slice(-5).reduce((a,b)=>a+b,0) / 5;
  const volAvg = v1h.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const volRatio = volRecent / volAvg;
  const volBuilding = volRatio > 1.15;  // volume เพิ่ม 15%+

  // ── 4. ทิศที่จะ breakout ──
  // v3.3: หาทิศแบบใช้ได้ตอน squeeze (ไม่พึ่ง EMA9/21 spread ที่หายตอนนิ่ง)
  const ema50 = calcEMA(c1h, 50);
  const obv = calcOBV(klines1h);

  // ทิศหลัก = EMA50 trend (ใหญ่ ไม่หายตอน squeeze) + position ในกรอบ
  // ราคาอยู่ส่วนไหนของกรอบ 10 candle (0=ก้น, 1=ยอด)
  const posInRange = (price - low10) / (high10 - low10 + 0.0001);

  // breakout ทิศไหน: ดู EMA50 + OBV + position
  // - ราคาเหนือ EMA50 + OBV บวก → จะ breakout ขึ้น (long)
  // - ราคาใต้ EMA50 + OBV ลบ → จะ breakout ลง (short)
  let direction = 'neutral';
  const aboveEMA50 = price > ema50;
  if (aboveEMA50 && obv.slope >= 0 && posInRange > 0.4) direction = 'long';
  else if (!aboveEMA50 && obv.slope <= 0 && posInRange < 0.6) direction = 'short';

  // ── 5. 15m EMA50 trend confirm (ไม่ใช่ EMA9/21 spread) ──
  let momentum15m = 'neutral';
  if (klines15m && klines15m.length >= 50) {
    const c15 = klines15m.map(k => parseFloat(k[4]));
    const ema50_15 = calcEMA(c15, 50);
    const price15 = c15[c15.length - 1];
    momentum15m = price15 > ema50_15 ? 'long' : 'short';
  } else {
    momentum15m = direction; // ถ้า data ไม่พอ ใช้ทิศหลัก
  }

  // ── Decision: Squeeze Burst ──
  const dirConfirm = direction !== 'neutral' && direction === momentum15m;
  const squeezeBurst = squeeze && compressed && dirConfirm;

  // ── v3.4: REVERSAL BURST — จับก้นเด้ง (capitulation reversal) ──
  // ราคาดิ่งแรงเกิน → oversold สุด → เด้งกลับ (จับ #6,7,8 pattern)
  const rsi14 = calcRSI(c1h, 14);
  // ดิ่ง/พุ่งกี่ % ใน 5 candle ล่าสุด (วัดจาก peak→trough — จับ capitulation)
  const recent5 = c1h.slice(-5);
  const peak5 = Math.max(...recent5);
  const trough5 = Math.min(...recent5);
  const drop5 = (peak5 - trough5) / peak5;       // ช่วงดิ่งสูงสุด
  const pump5 = (peak5 - trough5) / trough5;      // ช่วงพุ่งสูงสุด
  // ราคาเด้งจากก้นแล้วหรือยัง (price > trough = เริ่มเด้ง)
  const bouncedFromLow = (price - trough5) / trough5 > 0.003;  // เด้ง > 0.3% จากก้น
  const droppedFromHigh = (peak5 - price) / peak5 > 0.003;     // ลง > 0.3% จากยอด

  // v3.7 CONFIRMATION: เด้ง 2 candle ติด (ไม่ใช่เด้งแรกหลอก) — แก้ #7 R19
  // #7: เข้า $1583 (เด้งแรก) → ลงต่อ $1557 (ก้นจริง) → แพ้
  const c2 = c1h[c1h.length-2], c3 = c1h[c1h.length-3];
  const confirmUp = price > c2 && c2 >= c3;    // 2 candle เขียวติด (เด้งยืน)
  const confirmDown = price < c2 && c2 <= c3;  // 2 candle แดงติด (ร่วงยืน)

  // Reversal LONG: ดิ่งแรง + RSI<35 + เด้งจากก้น + confirm 2 candle ขึ้น
  const revLong = drop5 > 0.020 && rsi14 < 35 && bouncedFromLow && confirmUp;
  // Reversal SHORT: พุ่งแรง + RSI>65 + ลงจากยอด + confirm 2 candle ลง
  const revShort = pump5 > 0.020 && rsi14 > 65 && droppedFromHigh && confirmDown;
  const drop3 = drop5, pump3 = pump5;  // alias สำหรับ strength/reason
  const reversalBurst = revLong || revShort;
  const revDir = revLong ? 'long' : (revShort ? 'short' : 'neutral');

  // ── v3.5: LIQUIDITY SWEEP — ทะลุ low/high (กิน stop) แล้วกลับทันที ──
  // ราคาทะลุ low 20 candle แล้วเด้งกลับเหนือ = sweep liquidity → LONG
  // ราคาทะลุ high 20 candle แล้วร่วงกลับใต้ = sweep → SHORT
  const recent20 = c1h.slice(-21, -1);  // 20 candle ก่อนหน้า (ไม่รวมปัจจุบัน)
  const prevLow20 = Math.min(...recent20);
  const prevHigh20 = Math.max(...recent20);
  const candleLow = parseFloat(klines1h[klines1h.length-1][3]);   // low ของ candle ปัจจุบัน
  const candleHigh = parseFloat(klines1h[klines1h.length-1][2]);  // high ของ candle ปัจจุบัน

  // Sweep LONG: ไส้เทียนทะลุ low เดิม (กิน stop) แต่ราคาปิดกลับเหนือ low เดิม
  const sweptLow = candleLow < prevLow20 && price > prevLow20;
  // Sweep SHORT: ไส้เทียนทะลุ high เดิม แต่ราคาปิดกลับใต้ high เดิม
  const sweptHigh = candleHigh > prevHigh20 && price < prevHigh20;
  const sweepLong = sweptLow && obv.slope > 0 && price > c2;    // v3.7: + ปิดเหนือ candle ก่อน (ยืน)
  const sweepShort = sweptHigh && obv.slope < 0 && price < c2;   // v3.7: + ปิดใต้ candle ก่อน (ยืน)
  const liquiditySweep = sweepLong || sweepShort;
  const sweepDir = sweepLong ? 'long' : (sweepShort ? 'short' : 'neutral');

  // รวม 3 โหมด
  const preBurst = squeezeBurst || reversalBurst || liquiditySweep;
  // priority: sweep > reversal > squeeze (sweep เฉพาะเจาะจงสุด)
  if (liquiditySweep) direction = sweepDir;
  else if (reversalBurst) direction = revDir;

  // strength score
  let strength = 0;
  let burstType = 'none';
  if (squeezeBurst) {
    if (squeeze) strength += 30;
    if (compressed) strength += 25;
    if (volBuilding) strength += 25;
    if (dirConfirm) strength += 20;
    burstType = 'squeeze';
  } else if (liquiditySweep) {
    strength += 55;                          // sweep = เฉพาะเจาะจง base สูง
    if (volRatio > 1.3) strength += 25;      // volume spike ตอน sweep = ยืนยัน
    if (rsi14 < 35 || rsi14 > 65) strength += 20;  // RSI สุดขั้ว = มั่นใจกลับ
    burstType = 'sweep';
  } else if (reversalBurst) {
    strength += 50;
    if (Math.abs(drop3 || pump3) > 0.035) strength += 20;
    if (volRatio > 1.3) strength += 20;
    burstType = 'reversal';
  }

  let reason = '';
  if (squeezeBurst) {
    reason = `${direction.toUpperCase()} squeeze burst — ATR ${atrRatio.toFixed(2)}, range ${rangePct.toFixed(1)}%`;
  } else if (liquiditySweep) {
    reason = `${direction.toUpperCase()} liquidity sweep — ${sweepLong?'กิน low เด้งกลับ':'กิน high ร่วงกลับ'} RSI ${rsi14.toFixed(0)}`;
  } else if (reversalBurst) {
    reason = `${direction.toUpperCase()} reversal burst — ${revLong?'ดิ่ง':'พุ่ง'} ${((revLong?drop3:pump3)*100).toFixed(1)}% RSI ${rsi14.toFixed(0)}`;
  } else if (squeeze && compressed) {
    reason = 'Squeeze แต่ทิศไม่ชัด — รอ';
  } else {
    reason = 'ไม่มี setup';
  }

  return {
    preBurst,
    direction,
    strength,
    reason,
    details: {
      atrRatio: +atrRatio.toFixed(2),
      rangePct: +rangePct.toFixed(2),
      volRatio: +volRatio.toFixed(2),
      squeeze, compressed, volBuilding, dirConfirm,
      momentum15m, burstType, rsi14: +rsi14.toFixed(0),
      drop3: +(drop3*100).toFixed(1), pump3: +(pump3*100).toFixed(1)
    }
  };
}

function calcBestDirection(ethKlines, btcKlines, funding, trap, fg, ethKlines4h = null, ethKlines15m = null) {
  const ec = ethKlines.map(k => parseFloat(k[4]));
  const bc = btcKlines.map(k => parseFloat(k[4]));

  // ── 4H Trend Filter (v2.4 + v3.8 early-trend) ──
  let trend4hBull = null, trend4hBear = null;
  let trend4hEarlyBull = false;  // v3.8: uptrend เริ่ม (ไม่ต้องรอ EMA50)
  if (ethKlines4h && ethKlines4h.length >= 50) {
    const ec4h = ethKlines4h.map(k => parseFloat(k[4]));
    const ema20_4h = calcEMA(ec4h, 20);
    const ema50_4h = calcEMA(ec4h, 50);
    const price4h  = ec4h[ec4h.length - 1];
    trend4hBull = price4h > ema50_4h && ema20_4h > ema50_4h;
    trend4hBear = price4h < ema50_4h && ema20_4h < ema50_4h;

    // v3.8 EARLY BULL: uptrend กำลังเริ่ม (EMA50 ช้า → ใช้ EMA20 + slope)
    // เงื่อนไข: ราคาเหนือ EMA20 + EMA20 ชันขึ้น (3 แท่งก่อน EMA20 ต่ำกว่า)
    const ema20_prev = calcEMA(ec4h.slice(0, -3), 20);
    const ema20Rising = ema20_4h > ema20_prev;            // EMA20 ชันขึ้น
    const aboveEMA20_4h = price4h > ema20_4h;             // ราคาเหนือ EMA20
    trend4hEarlyBull = aboveEMA20_4h && ema20Rising && trend4hBear;  // bear กำลังกลับ
  }

  // ── Market Regime Detector (v2.5 — Phase A) ──
  let regime = null;
  if (ethKlines4h && ethKlines4h.length >= 50) {
    regime = detectMarketRegime(ethKlines4h, ethKlines);
  }

  // ── Multi-TF Confirmation (v2.6 — Phase B) ──
  let multitf = null;
  if (ethKlines15m && ethKlines4h) {
    multitf = analyzeMultiTF(ethKlines15m, ethKlines, ethKlines4h);
  }

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
  const atrPct   = (atr / price) * 100;
  // ATR ต้อง > 0.7% ของราคา ถึงจะเทรด (block sideways ทันที)
  const atrOK    = atr > avgATR * 0.8 && atr < avgATR * 1.8 && atrPct > 0.7;

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
  let confLong   = calcConfidence(macd, rsi, obv, btcMacd, funding, trap, confExtras);
  if (regime) confLong = Math.max(50, Math.min(95, confLong + regime.score));
  if (multitf && multitf.direction === 'bull') confLong = Math.max(50, Math.min(95, confLong + multitf.score));
  if (multitf && multitf.direction === 'bear') confLong = Math.max(50, Math.min(95, confLong - Math.abs(multitf.score)));

  // จำลอง SHORT — flip MACD และ OBV
  const macdShort = { ...macd, positive: false, bullCross: false, bearCross: !macd.positive };
  const obvShort  = { ...obv,  positive: false, slope: -Math.abs(obv.slope) };
  let confShort = calcConfidence(macdShort, rsi, obvShort, btcMacd, funding, trap, confExtras);
  if (regime) confShort = Math.max(50, Math.min(95, confShort + regime.score));
  if (multitf && multitf.direction === 'bear') confShort = Math.max(50, Math.min(95, confShort + multitf.score));
  if (multitf && multitf.direction === 'bull') confShort = Math.max(50, Math.min(95, confShort - Math.abs(multitf.score)));

  // Signal ทั้งสองฝั่ง พร้อม EMA, ATR และ Momentum filter
  // 4H filter + Regime + Multi-TF
  const longOK4h  = trend4hBull !== false || trend4hEarlyBull;  // v3.8: early bull ผ่าน
  const shortOK4h = trend4hBear !== false;
  const regimeOK  = !regime || (regime.regime !== 'VOLATILE' && regime.regime !== 'RANGING'); // block both VOLATILE และ RANGING
  const longOKtf  = !multitf || multitf.direction === 'bull' || multitf.direction === 'neutral';
  const shortOKtf = !multitf || multitf.direction === 'bear' || multitf.direction === 'neutral';

  // ── Adaptive Threshold (v2.7) ──
  // ปรับ threshold ตามสภาพตลาด
  let threshold = 80;
  if (regime) {
    if (regime.regime === 'TRENDING') threshold = 75;     // ตลาด trend ชัด → ผ่อน
    else if (regime.regime === 'RANGING') threshold = 85; // sideways → เข้มขึ้น
    else if (regime.regime === 'VOLATILE') threshold = 90;// อันตราย → เข้มมาก
    else if (regime.regime === 'TRANSITION') threshold = 82; // เปลี่ยน → กลาง
  }
  if (multitf && multitf.alignment === 'strong') threshold -= 3; // TF align ดี → ผ่อน
  if (multitf && multitf.alignment === 'conflicted') threshold += 5; // TF mixed → เข้มขึ้น
  threshold = Math.max(70, Math.min(92, threshold));

  // ── v3.6: EXHAUSTION BRAKE + v3.7 COOLDOWN ──
  // หยุดเข้าตอนตลาด over-extended (ดิ่ง/พุ่งเร็วเกิน + RSI สุดขั้ว = เสี่ยงกลับตัว)
  const recent3 = ec.slice(-4, -1);
  const peak3 = Math.max(...recent3, price);
  const trough3 = Math.min(...recent3, price);
  const dropFast = (peak3 - price) / peak3;
  const pumpFast = (price - trough3) / trough3;

  // v3.7 COOLDOWN: ดู recovery zone — เพิ่งมีก้นลึกใน 10 candle ล่าสุดมั้ย
  // แก้ #6,#9 R19: ก้น RSI<30 → เด้ง RSI 36 → SHORT → เด้งต่อ แพ้
  const recent10 = ec.slice(-11, -1);
  const low10 = Math.min(...recent10, price);
  const recoveryFromLow = (price - low10) / low10;  // เด้งจากก้น 10 candle กี่ %
  // ยังอยู่ recovery zone: เด้งจากก้น 0.3-3% = "เพิ่งเด้ง" (เด้งหลอกเสี่ยง)
  const inRecoveryZone = recoveryFromLow > 0.003 && recoveryFromLow < 0.03;

  // SHORT exhaustion (v3.11 ขยาย zone):
  // (1) ดิ่งเร็ว+RSI<30  (2) เพิ่งเด้งจากก้น+RSI<42  (3) RSI<38 ใกล้ก้น (choppy)
  // แก้ #2,#3,#8,#10 R21: SHORT RSI 31-43 → เด้งสวน (ตลาด choppy)
  const nearLow = recoveryFromLow < 0.015;  // ราคาใกล้ low 10 candle (< 1.5%)
  const shortExhausted = (dropFast > 0.025 && rsi < 30)
    || (inRecoveryZone && rsi < 42)
    || (rsi < 38 && nearLow);  // v3.11: RSI ต่ำ + ใกล้ก้น = เด้งเสี่ยง
  // LONG exhaustion: (พุ่งเร็ว+RSI>70) หรือ (เพิ่งย่อจากยอด+RSI ยังสูง>58)
  const recent10H = Math.max(...recent10, price);
  const pullbackFromHigh = (recent10H - price) / recent10H;
  const inPullbackZone = pullbackFromHigh > 0.003 && pullbackFromHigh < 0.03;
  // v3.9: แยก 2 เงื่อนไข (สมมาตรกับ SHORT cooldown)
  const longPumpExhausted = pumpFast > 0.025 && rsi > 70;       // พุ่งเร็ว+RSI สูง
  const longPullbackZone = inPullbackZone && rsi > 58;           // เพิ่งย่อจากยอด (cooldown)
  let longExhausted = longPumpExhausted || longPullbackZone;
  // early-bull ผ่อนเฉพาะ "พุ่งเร็ว" (uptrend เริ่มต้องพุ่ง) — แต่ยัง block "เพิ่งย่อจากยอด"
  // แก้ #1,#3,#6 R20: LONG เข้ายอด → ย่อ (เหมือน SHORT เข้าก้น → เด้ง)
  if (trend4hEarlyBull && rsi < 72 && !longPullbackZone) longExhausted = false;

  const opts = { 
    aboveEMA50: trendAlignLong && longOK4h && regimeOK && longOKtf && !longExhausted, 
    belowEMA50: trendAlignShort && shortOK4h && regimeOK && shortOKtf && !shortExhausted, 
    atrOK,
    threshold,
    shortExhausted, longExhausted, earlyBull: trend4hEarlyBull  // v3.10
  };
  const regimeTrending = regime && regime.regime === 'TRENDING';
  const sigLong  = calcSignal(macd, obv, rsi, trap, confLong,  {...opts, momentumOK: momentumLong, regimeTrending, sigDir: 'long'});
  const sigShort = calcSignal(macdShort, obvShort, rsi, trap, confShort, {...opts, momentumOK: momentumShort, regimeTrending, sigDir: 'short'});

  // เลือก direction ที่ดีกว่า
  let best = null;
  if (sigLong.entryReady && sigShort.entryReady) {
    best = confLong >= confShort ? sigLong : sigShort;
  } else if (sigLong.entryReady) {
    best = sigLong;
  } else if (sigShort.entryReady) {
    best = sigShort;
  }

  // v3.1: displaySig — sig ที่ควรแสดง (ทิศ conf สูงกว่า) — decision อยู่ logic
  const displaySig = confShort > confLong ? sigShort.sig : sigLong.sig;
  const displayDir = confShort > confLong ? 'short' : 'long';
  // v3.6: exhaustion info
  const exhaustion = { shortExhausted, longExhausted, dropFast: +(dropFast*100).toFixed(1), pumpFast: +(pumpFast*100).toFixed(1) };

  return {
    macd, obv, rsi, atr, trap, btcMacd,
    ema50, ema20, price, aboveEMA50, belowEMA50, atrOK,
    rsiSlope, momentumLong, momentumShort,
    aboveEMA20, belowEMA20, trendAlignLong, trendAlignShort,
    volRatio, atrRatio, atrPct, candleBull,
    trend4hBull, trend4hBear, trend4hEarlyBull,
    regime, multitf, threshold,
    bouncedUp, droppedDown, recentLow, recentHigh,
    confLong, confShort,
    sigLong, sigShort,
    best, displaySig, displayDir, exhaustion,
    fg
  };
}

// ── Export — รองรับทั้ง Node.js และ Browser ────────────────
const ETH_LOGIC = {
  version: ETH_LOGIC_VERSION,
  CONF_THRESHOLD,
  detectMarketRegime,
  analyzeMultiTF,
  detectPreBurst,
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
