// ═══════════════════════════════════════════════════════════
//  analyzer.js — วิเคราะห์ผลเทรดจากข้อมูลจริง + ให้คำแนะนำ
//  ไม่ต้องใช้ API ภายนอก คำนวณเองทั้งหมด
//  ทุกข้อสรุประบุระดับความเชื่อมั่นตามขนาด sample
// ═══════════════════════════════════════════════════════════
const fs = require('fs');

// ค่าอ้างอิงจาก backtest 5.14 ปี (ETH+SOL, D40/x30/ATR3.5/BE1R/risk0.9%)
const BASELINE = {
  winRate: 35.7, payoff: 1.47, avgR: 0.08, maxDD: 25.1,
  slippageBps: 2,            // ที่ backtest สมมติ (FEE 0.04% + SLIP 0.02%)
  feeRate: 0.0004,
  fundingPer8h: 0.0001,      // 0.01% ต่อ 8 ชม.
  avgHoldHours: 35,
  mfeCapture: 44             // % ของ MFE ที่เก็บได้ (จาก paper 32 ไม้)
};

const n = v => (v == null || !isFinite(v)) ? null : v;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
const f2 = v => v == null ? '—' : (+v).toFixed(2);

// ระดับความเชื่อมั่นตามจำนวน sample
function confidence(count) {
  if (count >= 100) return { level: 'สูง', tag: '✅', note: '' };
  if (count >= 50)  return { level: 'กลาง', tag: '🟡', note: 'พอเห็นแนวโน้ม' };
  if (count >= 30)  return { level: 'ต่ำ', tag: '🟠', note: 'ยังไม่พอตัดสินใจ' };
  return { level: 'ต่ำมาก', tag: '🔴', note: 'sample เล็กเกินสรุป' };
}

function analyze(dir) {
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync(dir + '/donchian_trades.json', 'utf8')); } catch {}
  if (!Array.isArray(trades)) trades = [];

  let errors = [];
  try {
    errors = fs.readFileSync(dir + '/bot_errors.jsonl', 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}

  let state = {};
  try { state = JSON.parse(fs.readFileSync(dir + '/donchian_state.json', 'utf8')); } catch {}

  const N = trades.length;
  const conf = confidence(N);
  const L = [];   // บรรทัดรายงาน
  const rec = []; // ข้อแนะนำ

  L.push(`<b>📊 รายงานวิเคราะห์ระบบ</b>`);
  L.push(`${conf.tag} ข้อมูล ${N} trades — ความเชื่อมั่น${conf.level}${conf.note ? ' (' + conf.note + ')' : ''}`);
  L.push('');

  // ───────── สถิติพื้นฐาน ─────────
  if (N === 0) {
    L.push('ยังไม่มี trade — รอ signal แรก');
    const eq = state.accountEquity, st = state.startEquity ?? eq;
    if (eq) L.push(`Equity $${f2(eq)} (เริ่ม $${f2(st)})`);
    return { text: L.join('\n'), trades: 0 };
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const W = wins.length / N;
  const aw = wins.length ? gw / wins.length : 0, al = losses.length ? gl / losses.length : 0;
  const payoff = al ? aw / al : 0;
  const kelly = payoff ? (W - (1 - W) / payoff) * 100 : null;
  const avgR = avg(trades.map(t => t.rMultiple || 0));

  // drawdown จาก equity curve
  let pk = state.startEquity ?? trades[0]?.equity ?? 0, mdd = 0;
  trades.forEach(t => { if (t.equity > pk) pk = t.equity; const d = (pk - t.equity) / pk * 100; if (d > mdd) mdd = d; });

  const eqNow = state.accountEquity ?? trades[N-1]?.equity;
  const eqStart = state.startEquity ?? eqNow;
  const retPct = eqStart ? (eqNow / eqStart - 1) * 100 : 0;

  L.push(`<b>ผลตอบแทน</b>`);
  L.push(`Equity $${f2(eqNow)} (${retPct >= 0 ? '+' : ''}${f2(retPct)}%) | PnL $${f2(netPnl)}`);
  L.push(`WR ${(W*100).toFixed(1)}% | payoff ${f2(payoff)} | avgR ${avgR?.toFixed(3)}`);
  L.push(`PF ${gl > 0 ? f2(gw/gl) : '—'} | Kelly ${kelly != null ? f2(kelly) + '%' : '—'} | DD ${f2(mdd)}%`);
  L.push('');

  // เทียบ baseline
  const cmp = [];
  if (Math.abs(W*100 - BASELINE.winRate) > 8) cmp.push(`WR ${(W*100).toFixed(0)}% vs backtest ${BASELINE.winRate}%`);
  if (payoff && Math.abs(payoff - BASELINE.payoff) > 0.4) cmp.push(`payoff ${f2(payoff)} vs ${BASELINE.payoff}`);
  if (cmp.length) { L.push(`<b>เทียบ backtest</b>`); cmp.forEach(c => L.push(`• ${c}`)); L.push(''); }

  // ───────── ต้นทุนจริง vs ที่ backtest สมมติ ─────────
  const slipIn = trades.map(t => n(t.slipEntryBps)).filter(v => v != null);
  const slipOut = trades.map(t => n(t.slipExitBps)).filter(v => v != null);
  const fundLive = trades.map(t => n(t.fundingLive)).filter(v => v != null);
  const fundEst = trades.map(t => n(t.fundingEstimate)).filter(v => v != null);
  const feeLive = trades.map(t => n(t.feeLive)).filter(v => v != null);
  const feeEst = trades.map(t => n(t.feeEstimate)).filter(v => v != null);
  const pnlLive = trades.filter(t => n(t.pnlLive) != null && n(t.pnlEstimate) != null);

  const costLines = [];
  if (slipIn.length) {
    const a = avg(slipIn);
    costLines.push(`slippage เข้า ${f2(a)} bps (สมมติ ${BASELINE.slippageBps}) — ${a > BASELINE.slippageBps ? '🔴 แย่กว่า' : '✅ ดีกว่า'}`);
  }
  if (slipOut.length) costLines.push(`slippage ออก ${f2(avg(slipOut))} bps`);
  if (fundLive.length) {
    const totalLive = Math.abs(fundLive.reduce((a, b) => a + b, 0));
    const totalEst = fundEst.length ? fundEst.reduce((a, b) => a + b, 0) : 0;
    const ratio = totalEst > 0 ? totalLive / totalEst : null;
    costLines.push(`funding จ่ายจริง $${f2(totalLive)} vs ประมาณ $${f2(totalEst)}${ratio ? ` (${f2(ratio)}× )` : ''}`);
    if (ratio && ratio > 2) rec.push(`🔴 funding จริงสูงกว่าที่ backtest คิด ${f2(ratio)} เท่า — ผลจริงจะต่ำกว่า backtest`);
  }
  if (feeLive.length && feeEst.length) {
    const dl = feeLive.reduce((a,b)=>a+b,0), de = feeEst.reduce((a,b)=>a+b,0);
    costLines.push(`fee จริง $${f2(dl)} vs ประมาณ $${f2(de)}`);
  }
  if (pnlLive.length) {
    const diff = pnlLive.reduce((a, t) => a + (t.pnlLive - t.pnlEstimate), 0);
    const pct = pnlLive.reduce((a,t)=>a+Math.abs(t.pnlEstimate),0);
    costLines.push(`PnL จริงต่างจากคำนวณ $${f2(diff)}${pct ? ` (${f2(diff/pct*100)}%)` : ''}`);
    if (pct && Math.abs(diff/pct*100) > 10)
      rec.push(`⚠️ PnL จริงต่างจากที่คำนวณ ${f2(diff/pct*100)}% — backtest ${diff < 0 ? 'มองโลกสวยไป' : 'ประเมินต่ำไป'}`);
  }
  if (costLines.length) { L.push(`<b>💰 ต้นทุนจริง</b>`); costLines.forEach(c => L.push(`• ${c}`)); L.push(''); }
  else { L.push(`<b>💰 ต้นทุนจริง</b>`); L.push('• ยังไม่มีข้อมูล (ไม้ที่ปิดยังไม่มี fill จริง)'); L.push(''); }

  // ───────── พฤติกรรม trail / exit ─────────
  const mfeTotal = trades.reduce((a, t) => a + (t.mfe || 0), 0);
  const capture = mfeTotal > 0 ? netPnl / mfeTotal * 100 : null;
  const peakBars = trades.map(t => n(t.peakBar)).filter(v => v != null);
  const holds = trades.map(t => t.bars || 0);
  const trailMoves = trades.map(t => n(t.trailMoves)).filter(v => v != null);
  const reversed = trades.filter(t => t.pnl <= 0 && (t.mfe || 0) > 0);

  L.push(`<b>📈 พฤติกรรมการออก</b>`);
  if (capture != null) {
    L.push(`เก็บได้ ${f2(capture)}% ของ MFE (backtest ${BASELINE.mfeCapture}%)`);
    if (capture < BASELINE.mfeCapture - 15 && N >= 30)
      rec.push(`คืนกำไรมากกว่า backtest — แต่ trail ที่แคบลงเคยทดสอบแล้วแพ้ทุกครั้ง อย่าเพิ่งแก้`);
  }
  if (peakBars.length && holds.length) {
    const pb = avg(peakBars), hh = avg(holds);
    L.push(`MFE เกิด ชม.ที่ ${pb.toFixed(1)} จากถือ ${hh.toFixed(1)} ชม. → ปล่อยต่อ ${(hh-pb).toFixed(1)} ชม.`);
  }
  if (trailMoves.length) L.push(`trail ขยับเฉลี่ย ${f2(avg(trailMoves))} ครั้ง/ไม้`);
  L.push(`เคยกำไรแล้วพลิกขาดทุน ${reversed.length}/${N} ไม้ (${(reversed.length/N*100).toFixed(0)}%)`);
  if (reversed.length) {
    const maxR = Math.max(...reversed.map(t => n(t.mfeR) ?? 0));
    L.push(`  MFE สูงสุดในกลุ่มนี้ ${f2(maxR)}R ${maxR < 1 ? '(ต่ำกว่า BE +1R จึงไม่ทำงาน)' : ''}`);
  }
  L.push('');

  // ───────── entry quality ─────────
  const troughBars = trades.map(t => n(t.troughBar)).filter(v => v != null);
  const maeRs = trades.map(t => n(t.maeR)).filter(v => v != null);
  if (troughBars.length || maeRs.length) {
    L.push(`<b>🎯 คุณภาพจุดเข้า</b>`);
    if (maeRs.length) L.push(`MAE เฉลี่ย ${f2(avg(maeRs))}R (แย่สุด ${f2(Math.min(...maeRs))}R)`);
    if (troughBars.length) {
      const tb = avg(troughBars);
      L.push(`MAE เกิด ชม.ที่ ${tb.toFixed(1)}`);
      if (tb < 2 && N >= 30) rec.push(`MAE มาช่วงแรกเสมอ — สัญญาณว่าเข้าเร็วไป (ต้อง backtest ก่อนแก้)`);
    }
    L.push('');
  }

  // ───────── regime ─────────
  const withER = trades.filter(t => n(t.efficiencyRatio) != null);
  if (withER.length >= 4) {
    const sorted = [...withER].sort((a, b) => a.efficiencyRatio - b.efficiencyRatio);
    const half = Math.floor(sorted.length / 2);
    const choppy = sorted.slice(0, half), trend = sorted.slice(-half);
    const cp = choppy.reduce((a, t) => a + t.pnl, 0), tp = trend.reduce((a, t) => a + t.pnl, 0);
    L.push(`<b>🌊 สภาพตลาด</b>`);
    L.push(`sideways ${choppy.length} ไม้: $${f2(cp)} | trend ${trend.length} ไม้: $${f2(tp)}`);
    L.push('');
  }

  // ───────── execution ─────────
  const lat = trades.map(t => n(t.fillLatencyMs)).filter(v => v != null);
  const fills = trades.map(t => n(t.entryFills)).filter(v => v != null);
  if (lat.length || fills.length) {
    L.push(`<b>⚡ การส่งคำสั่ง</b>`);
    if (lat.length) L.push(`latency เฉลี่ย ${Math.round(avg(lat))} ms (สูงสุด ${Math.max(...lat)})`);
    if (fills.length) {
      const af = avg(fills);
      L.push(`แตกเป็น ${f2(af)} ไม้/order`);
      if (af > 2.5) rec.push(`order แตกหลายไม้ — liquidity บาง อาจต้องลด size หรือใช้ limit order`);
    }
    L.push('');
  }

  // ───────── รายเหรียญ ─────────
  const bySym = {};
  trades.forEach(t => {
    const s = t.symbol || '?';
    if (!bySym[s]) bySym[s] = { n: 0, pnl: 0, w: 0 };
    bySym[s].n++; bySym[s].pnl += t.pnl; if (t.pnl > 0) bySym[s].w++;
  });
  if (Object.keys(bySym).length > 1) {
    L.push(`<b>เทียบรายเหรียญ</b>`);
    Object.entries(bySym).forEach(([s, v]) =>
      L.push(`${s.replace('USDT','')}: ${v.n} ไม้ | WR ${(v.w/v.n*100).toFixed(0)}% | $${f2(v.pnl)}`));
    L.push('');
  }

  // ───────── ปัญหาระบบ ─────────
  const last24 = errors.filter(e => Date.now() - new Date(e.ts).getTime() < 86400000);
  const crit = last24.filter(e => e.severity === 'critical');
  const kinds = {};
  last24.forEach(e => kinds[e.kind] = (kinds[e.kind] || 0) + 1);
  L.push(`<b>⚠️ ระบบ 24 ชม.</b>`);
  if (!last24.length) L.push('ไม่มีปัญหา ✅');
  else {
    Object.entries(kinds).sort((a,b) => b[1]-a[1]).slice(0, 5)
      .forEach(([k, c]) => L.push(`• ${k} ×${c}`));
    if (crit.length) rec.push(`🔴 มี critical ${crit.length} ครั้งใน 24 ชม. — ตรวจ /errors`);
  }
  const slFail = trades.filter(t => t.slPlaced === false).length;
  if (slFail) rec.push(`🔴 ${slFail} ไม้ไม่มี SL บน exchange — เสี่ยงถ้าบอทดับ`);
  L.push('');

  // ───────── คำแนะนำ ─────────
  L.push(`<b>💡 คำแนะนำ</b>`);
  if (N < 30) {
    rec.unshift(`ยังไม่ควรแก้ parameter ใดๆ — ต้องมี 30+ ไม้ (มี ${N})`);
    rec.push(`ที่ผ่านมาแก้จาก sample เล็ก 3 ครั้ง backtest ปฏิเสธทั้งหมด`);
  } else if (N < 100) {
    rec.unshift(`sample ${N} ไม้ — เห็นแนวโน้มได้ แต่ควรยืนยันด้วย backtest ก่อนแก้อะไร`);
  }
  if (mdd > 20) rec.push(`DD ${f2(mdd)}% — ใกล้ halt 30% เฝ้าดูใกล้ชิด`);
  if (!rec.length) rec.push('ระบบทำงานปกติ ไม่มีอะไรต้องแก้');
  rec.slice(0, 6).forEach(r => L.push(`• ${r}`));

  return { text: L.join('\n'), trades: N, netPnl, winRate: W * 100, mdd };
}

module.exports = { analyze, BASELINE, confidence };

// รันตรงจาก command line: node analyzer.js
if (require.main === module) {
  const dir = process.argv[2] || '/root/eth-bot';
  const r = analyze(dir);
  console.log(r.text.replace(/<\/?b>/g, ''));
}
