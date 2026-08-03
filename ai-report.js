// ═══════════════════════════════════════════════════════════
//  ai-report.js — วิเคราะห์ log ด้วย Claude API แล้วส่ง Telegram
//  ปิดเองอัตโนมัติถ้าไม่มี ANTHROPIC_API_KEY (ไม่กระทบบอท)
// ═══════════════════════════════════════════════════════════
const fs = require('fs');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = process.env.AI_MODEL || 'claude-sonnet-4-6';
const enabled = !!API_KEY;

function isEnabled() { return enabled; }

// ── อ่าน trades จากไฟล์ (ทั้งหมด + เฉพาะวันนี้) ──
function loadTrades(dir) {
  try {
    const all = JSON.parse(fs.readFileSync(dir + '/donchian_trades.json', 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch { return []; }
}

function loadErrors(dir, hours = 24) {
  try {
    const lines = fs.readFileSync(dir + '/bot_errors.jsonl', 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - hours * 3600000;
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
                .filter(e => e && new Date(e.ts).getTime() >= cutoff);
  } catch { return []; }
}

// ── สรุปตัวเลขก่อนส่งให้ AI (ประหยัด token + ให้ AI โฟกัสที่การตีความ) ──
function summarize(trades, days) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(l.reduce((a, t) => a + t.pnl, 0));
  const aw = w.length ? gw / w.length : 0, al = l.length ? gl / l.length : 0;
  const W = w.length / trades.length;
  const payoff = al ? aw / al : 0;
  const num = arr => arr.filter(v => v != null && isFinite(v));
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const slipIn = num(trades.map(t => t.slipEntryBps));
  const slipOut = num(trades.map(t => t.slipExitBps));
  const ers = num(trades.map(t => t.efficiencyRatio));
  const feeLive = num(trades.map(t => t.feeLive));
  const feeEst = num(trades.map(t => t.feeEstimate));
  const mfeTotal = trades.reduce((a, t) => a + (t.mfe || 0), 0);

  const bySym = {};
  trades.forEach(t => {
    const s = t.symbol || 'UNKNOWN';
    if (!bySym[s]) bySym[s] = { n: 0, pnl: 0, win: 0 };
    bySym[s].n++; bySym[s].pnl += t.pnl; if (t.pnl > 0) bySym[s].win++;
  });
  const byReason = {};
  trades.forEach(t => {
    const r = t.reason || '?';
    if (!byReason[r]) byReason[r] = { n: 0, pnl: 0 };
    byReason[r].n++; byReason[r].pnl += t.pnl;
  });

  return {
    period_days: days,
    trades: trades.length,
    win_rate_pct: +(W * 100).toFixed(1),
    net_pnl: +trades.reduce((a, t) => a + t.pnl, 0).toFixed(2),
    profit_factor: gl > 0 ? +(gw / gl).toFixed(2) : null,
    payoff_ratio: +payoff.toFixed(2),
    kelly_pct: payoff ? +((W - (1 - W) / payoff) * 100).toFixed(1) : null,
    avg_win: +aw.toFixed(2), avg_loss: +al.toFixed(2),
    avg_r: +avg(trades.map(t => t.rMultiple || 0)).toFixed(3),
    best_r: +Math.max(...trades.map(t => t.rMultiple || 0)).toFixed(2),
    worst_r: +Math.min(...trades.map(t => t.rMultiple || 0)).toFixed(2),
    avg_hold_hours: Math.round(avg(trades.map(t => t.bars || 0))),
    mfe_capture_pct: mfeTotal > 0 ? +(trades.reduce((a, t) => a + t.pnl, 0) / mfeTotal * 100).toFixed(1) : null,
    trades_reversed_to_loss: trades.filter(t => t.pnl <= 0 && (t.mfe || 0) > 0).length,
    // ข้อมูลจริงที่ backtest ไม่มี
    slippage_entry_bps_avg: slipIn.length ? +avg(slipIn).toFixed(2) : null,
    slippage_exit_bps_avg: slipOut.length ? +avg(slipOut).toFixed(2) : null,
    slippage_samples: slipIn.length,
    fee_live_total: feeLive.length ? +feeLive.reduce((a, b) => a + b, 0).toFixed(4) : null,
    fee_estimated_total: feeEst.length ? +feeEst.reduce((a, b) => a + b, 0).toFixed(4) : null,
    efficiency_ratio_avg: ers.length ? +avg(ers).toFixed(4) : null,
    by_symbol: bySym,
    by_exit_reason: byReason
  };
}

// ── เรียก Claude API ──
async function askClaude(prompt, maxTokens = 1400) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error.type}: ${data.error.message}`);
  if (!Array.isArray(data.content)) throw new Error('รูปแบบคำตอบผิดปกติ');
  return data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

/**
 * สร้างรายงานประจำวัน
 * ctx: { dir, equity, startEquity, peakEquity, halted, positions, markets, config, healthCounters, exchangeBalance }
 */
async function buildDailyReport(ctx) {
  if (!enabled) return null;
  const all = loadTrades(ctx.dir);
  const dayMs = 24 * 3600000;
  const today = all.filter(t => t.exitTs && Date.now() - t.exitTs < dayMs);
  const week = all.filter(t => t.exitTs && Date.now() - t.exitTs < 7 * dayMs);
  const errors = loadErrors(ctx.dir, 24);

  const errSummary = {};
  errors.forEach(e => {
    const k = `${e.severity}:${e.kind}`;
    errSummary[k] = (errSummary[k] || 0) + 1;
  });

  const openNow = Object.entries(ctx.positions || {})
    .filter(([, p]) => p)
    .map(([sym, p]) => ({
      symbol: sym, dir: p.dir, entry: p.entry, sl: p.sl,
      held_hours: Math.round((Date.now() - p.entryTs) / 3600000),
      be_done: !!p.beDone, sl_on_exchange: p.slPlaced !== false
    }));

  const payload = {
    วันที่: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10),
    equity_ปัจจุบัน: ctx.equity,
    equity_เริ่มต้น: ctx.startEquity,
    peak_equity: ctx.peakEquity,
    drawdown_pct: +(((ctx.peakEquity - ctx.equity) / ctx.peakEquity) * 100).toFixed(2),
    balance_บน_exchange: ctx.exchangeBalance ?? null,
    halted: ctx.halted,
    position_ที่ถืออยู่: openNow,
    วันนี้: summarize(today, 1),
    สัปดาห์นี้: summarize(week, 7),
    ตั้งแต่เริ่ม: summarize(all, null),
    error_24ชม: errSummary,
    error_ร้ายแรงล่าสุด: errors.filter(e => e.severity === 'critical').slice(-3)
      .map(e => ({ kind: e.kind, symbol: e.symbol, msg: e.message.slice(0, 120) })),
    ตัวนับปัญหาสะสม: ctx.healthCounters,
    config: ctx.config,
    backtest_อ้างอิง: {
      หมายเหตุ: 'ผลจาก backtest 5.14 ปี ใช้เทียบว่าของจริงเบี่ยงไปมั้ย',
      win_rate_pct: 35.7, payoff_ratio: 1.47, avg_r: 0.08,
      slippage_สมมติ_bps: 2, max_dd_pct: 25.1, expect_hold_hours: 35
    }
  };

  const prompt = `คุณเป็นผู้เชี่ยวชาญวิเคราะห์ระบบเทรดอัตโนมัติ ช่วยวิเคราะห์ข้อมูลบอทเทรด crypto ตัวนี้

ระบบ: Donchian Turtle trend-following (D40 breakout / D30 exit / trail ATR×3.5 / breakeven +1R / risk 0.90%)
กำลังทดสอบบน Binance Futures Testnet (เงินปลอม) ก่อนใช้เงินจริง

ข้อมูล:
${JSON.stringify(payload, null, 1)}

เขียนรายงานภาษาไทย ส่งทาง Telegram (รองรับ <b>ตัวหนา</b> เท่านั้น ห้ามใช้ markdown) ความยาวไม่เกิน 380 คำ แบ่งเป็น:

<b>📊 สรุปวันนี้</b>
ตัวเลขสำคัญ 2-3 บรรทัด

<b>🔍 สิ่งที่น่าสนใจ</b>
2-3 ข้อที่ตัวเลขบอกแต่คนอาจมองข้าม — เทียบกับ backtest ด้วยว่าเบี่ยงตรงไหน โดยเฉพาะ slippage จริง vs 2 bps ที่สมมติไว้ และ fee จริง vs ที่ประมาณ

<b>⚠️ ต้องระวัง</b>
ปัญหาจาก error log หรือความผิดปกติ (ถ้าไม่มีให้บอกว่าปกติดี)

<b>💡 ข้อเสนอ</b>
1-2 ข้อที่ทำได้จริง

กติกาสำคัญ:
- ห้ามเสนอให้เปลี่ยน parameter ถ้ามี trade น้อยกว่า 30 ไม้ ให้บอกตรงๆ ว่า sample เล็กเกินสรุป
- แยกให้ชัดระหว่าง "ข้อสรุปที่เชื่อได้" กับ "แค่สังเกต"
- ถ้าข้อมูลบางอย่างว่าง (null) ให้บอกว่ายังไม่มีข้อมูล อย่าเดา
- ตรงไปตรงมา ถ้าผลแย่ให้บอกว่าแย่`;

  const text = await askClaude(prompt);
  return text;
}

module.exports = { isEnabled, buildDailyReport, summarize, loadTrades, loadErrors, askClaude };
