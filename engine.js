/* Motor de indicadores e decisão — sem dependências. Funciona no browser e em Node (testes). */
(function (root) {
  'use strict';

  // ---------- Indicadores ----------
  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    if (values.length < n) return out;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    let prev = sum / n;
    out[n - 1] = prev;
    const k = 2 / (n + 1);
    for (let i = n; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function bollinger(values, n = 20, mult = 2) {
    const mid = sma(values, n);
    const upper = new Array(values.length).fill(null);
    const lower = new Array(values.length).fill(null);
    for (let i = n - 1; i < values.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  }

  // RSI de Wilder
  function rsi(values, n = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let ag = gain / n, al = loss / n;
    out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      ag = (ag * (n - 1) + Math.max(d, 0)) / n;
      al = (al * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function macd(values, f = 12, s = 26, sig = 9) {
    const ef = ema(values, f), es = ema(values, s);
    const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const start = line.findIndex(v => v != null);
    const signal = new Array(values.length).fill(null);
    if (start >= 0) {
      const sub = ema(line.slice(start), sig);
      sub.forEach((v, i) => (signal[start + i] = v));
    }
    const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
    return { line, signal, hist };
  }

  // ATR de Wilder
  function atr(bars, n = 14) {
    const out = new Array(bars.length).fill(null);
    if (bars.length <= n) return out;
    const tr = bars.map((b, i) => i === 0 ? b.high - b.low :
      Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
    let a = 0;
    for (let i = 1; i <= n; i++) a += tr[i];
    a /= n;
    out[n] = a;
    for (let i = n + 1; i < bars.length; i++) {
      a = (a * (n - 1) + tr[i]) / n;
      out[i] = a;
    }
    return out;
  }

  function computeIndicators(bars) {
    const c = bars.map(b => b.close);
    const L = c.length - 1;
    const e13 = ema(c, 13), e50 = ema(c, 50), e100 = ema(c, 100), e200 = ema(c, 200);
    const bb = bollinger(c, 20, 2);
    const r = rsi(c, 14);
    const m = macd(c);
    const a = atr(bars, 14);
    const volAvg = sma(bars.map(b => b.volume || 0), 20);
    const last252 = bars.slice(-252);
    const hi52 = Math.max(...last252.map(b => b.high));
    const lo52 = Math.min(...last252.map(b => b.low));
    const pctB = bb.upper[L] != null ? (c[L] - bb.lower[L]) / (bb.upper[L] - bb.lower[L]) : null;
    const bw = bb.upper[L] != null ? (bb.upper[L] - bb.lower[L]) / bb.mid[L] : null;
    // largura mínima de banda nos últimos 120 dias -> squeeze
    let minBw = Infinity;
    for (let i = Math.max(19, L - 120); i <= L; i++) {
      if (bb.upper[i] != null) minBw = Math.min(minBw, (bb.upper[i] - bb.lower[i]) / bb.mid[i]);
    }
    return {
      date: bars[L].datetime, close: c[L], prevClose: c[L - 1],
      changePct: (c[L] / c[L - 1] - 1) * 100,
      ema13: e13[L], ema50: e50[L], ema100: e100[L], ema200: e200[L],
      ema13Prev: e13[L - 1], ema50Prev: e50[L - 1], ema200Prev: e200[L - 1],
      ema50_5ago: e50[L - 5],
      bbUpper: bb.upper[L], bbMid: bb.mid[L], bbLower: bb.lower[L], pctB, bandwidth: bw,
      squeeze: bw != null && bw <= minBw * 1.1,
      rsi: r[L], rsiPrev: r[L - 1],
      macd: m.line[L], macdSignal: m.signal[L], macdHist: m.hist[L], macdHistPrev: m.hist[L - 1],
      atr: a[L], volume: bars[L].volume || 0, volAvg20: volAvg[L],
      hi52, lo52, bars: bars.length,
      series: { close: c, e13, e50, e100, e200, bbU: bb.upper, bbL: bb.lower, dates: bars.map(b => b.datetime) }
    };
  }

  // ---------- Sentimento de notícias (léxico simples EN/PT) ----------
  const POS = ['beat', 'beats', 'upgrade', 'upgraded', 'outperform', 'overweight', 'raises', 'raised', 'record', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'rally', 'strong', 'growth', 'buy', 'bullish', 'wins', 'contract', 'partnership', 'expands', 'approval', 'approved', 'guidance raise', 'tops', 'accelerat',
    'sobe', 'subida', 'lucro', 'recorde', 'dispara', 'melhora', 'reforça', 'compra', 'contrato', 'crescimento'];
  const NEG = ['miss', 'misses', 'downgrade', 'downgraded', 'underperform', 'underweight', 'cuts', 'cut', 'lowers', 'plunge', 'plunges', 'slump', 'falls', 'drop', 'drops', 'sinks', 'weak', 'lawsuit', 'probe', 'investigation', 'sell', 'bearish', 'delay', 'recall', 'fraud', 'warning', 'force majeure', 'layoffs', 'dilution', 'offering',
    'cai', 'queda', 'prejuízo', 'afunda', 'corta', 'venda', 'processo', 'investigação', 'alerta'];
  function newsSentiment(headlines) {
    if (!headlines || !headlines.length) return { score: 0, n: 0 };
    let s = 0;
    for (const h of headlines) {
      const t = (h.headline || '').toLowerCase();
      let hs = 0;
      for (const w of POS) if (t.includes(w)) hs += 1;
      for (const w of NEG) if (t.includes(w)) hs -= 1;
      s += Math.max(-2, Math.min(2, hs));
    }
    // normaliza para [-10, 10]
    const score = Math.round(Math.max(-10, Math.min(10, (s / Math.max(3, headlines.length)) * 10)));
    return { score, n: headlines.length };
  }

  // ---------- Pontuação técnica ----------
  function scoreIndicators(ind, newsScore) {
    const comp = [];
    const add = (pts, txt) => comp.push({ pts, txt });
    const c = ind.close;
    if (ind.ema200 != null) {
      c > ind.ema200 ? add(15, 'Preço acima da EMA200 (tendência longa positiva)') : add(-15, 'Preço abaixo da EMA200 (tendência longa negativa)');
      if (ind.ema50 != null) {
        ind.ema50 > ind.ema200 ? add(10, 'EMA50 > EMA200 (golden cross ativo)') : add(-10, 'EMA50 < EMA200 (death cross ativo)');
        if (ind.ema50Prev != null && ind.ema200Prev != null) {
          if (ind.ema50Prev <= ind.ema200Prev && ind.ema50 > ind.ema200) add(8, 'Golden cross HOJE');
          if (ind.ema50Prev >= ind.ema200Prev && ind.ema50 < ind.ema200) add(-8, 'Death cross HOJE');
        }
      }
    }
    if (ind.ema100 != null) c > ind.ema100 ? add(5, 'Acima da EMA100') : add(-5, 'Abaixo da EMA100');
    if (ind.ema50 != null) {
      c > ind.ema50 ? add(10, 'Acima da EMA50 (tendência média positiva)') : add(-10, 'Abaixo da EMA50 (tendência média negativa)');
      if (ind.ema50_5ago != null) ind.ema50 > ind.ema50_5ago ? add(5, 'EMA50 a subir') : add(-5, 'EMA50 a descer');
    }
    if (ind.ema13 != null && ind.ema50 != null) {
      ind.ema13 > ind.ema50 ? add(10, 'EMA13 > EMA50 (momentum de curto prazo)') : add(-10, 'EMA13 < EMA50 (momentum curto negativo)');
      if (ind.ema13Prev != null && ind.ema50Prev != null) {
        if (ind.ema13Prev <= ind.ema50Prev && ind.ema13 > ind.ema50) add(5, 'Cruzamento EMA13/50 em alta HOJE');
        if (ind.ema13Prev >= ind.ema50Prev && ind.ema13 < ind.ema50) add(-5, 'Cruzamento EMA13/50 em baixa HOJE');
      }
    }
    const upTrend = ind.ema200 != null && c > ind.ema200;
    if (ind.rsi != null) {
      if (ind.rsi < 30) add(upTrend ? 12 : 4, `RSI ${ind.rsi.toFixed(0)} sobrevendido${upTrend ? ' em tendência de alta (oportunidade)' : ''}`);
      else if (ind.rsi > 75) add(-12, `RSI ${ind.rsi.toFixed(0)} muito sobrecomprado`);
      else if (ind.rsi > 70) add(-6, `RSI ${ind.rsi.toFixed(0)} sobrecomprado`);
      else if (ind.rsi >= 50) add(4, `RSI ${ind.rsi.toFixed(0)} com momentum saudável`);
      else add(-4, `RSI ${ind.rsi.toFixed(0)} abaixo de 50`);
    }
    if (ind.macdHist != null && ind.macdHistPrev != null) {
      if (ind.macdHist > 0 && ind.macdHist >= ind.macdHistPrev) add(8, 'MACD positivo e a acelerar');
      else if (ind.macdHist > 0) add(3, 'MACD positivo mas a abrandar');
      else if (ind.macdHist < 0 && ind.macdHist <= ind.macdHistPrev) add(-8, 'MACD negativo e a piorar');
      else add(-3, 'MACD negativo mas a melhorar');
      if (ind.macdHistPrev <= 0 && ind.macdHist > 0) add(5, 'MACD cruzou sinal em alta HOJE');
      if (ind.macdHistPrev >= 0 && ind.macdHist < 0) add(-5, 'MACD cruzou sinal em baixa HOJE');
    }
    if (ind.pctB != null) {
      if (ind.pctB < 0.05) add(upTrend ? 10 : 0, 'Preço na banda inferior de Bollinger' + (upTrend ? ' (pullback em tendência de alta)' : ' (fraqueza; sem confirmação)'));
      else if (ind.pctB > 1) add(-6, 'Preço acima da banda superior de Bollinger (esticado)');
      if (ind.squeeze) add(0, 'Bollinger squeeze: volatilidade comprimida, movimento forte provável');
    }
    if (ind.volAvg20 && ind.volume > 1.5 * ind.volAvg20) {
      ind.changePct > 0 ? add(5, 'Volume > 1,5× média numa subida') : add(-5, 'Volume > 1,5× média numa descida');
    }
    if (newsScore) add(newsScore, `Sentimento de notícias ${newsScore > 0 ? '+' : ''}${newsScore}`);
    const score = Math.max(-100, Math.min(100, comp.reduce((a, b) => a + b.pts, 0)));
    return { score, components: comp };
  }

  // ---------- Decisão e quantidades ----------
  /*
   pos: { qty, avgPrice }  (preço médio na moeda do ativo)
   ctx: { portfolioValue, cash, fx }  (em moeda base; fx = moeda base por 1 unidade da moeda do ativo)
   s:   { buyThreshold, sellThreshold, riskPct, maxPosPct, maxLossPct, takeProfitPct }
  */
  /* Plano de entrada: suporte dinâmico mais próximo abaixo do preço (EMA13, média das Bollinger, EMA50).
     Se o preço está a ≤ 1 ATR desse suporte → entrada já, entre o suporte e o preço atual.
     Se está mais longe (esticado) → aguardar recuo para a zona suporte … suporte + 0,5 ATR.
     Stop a 2×ATR abaixo do topo da zona (a mesma distância usada no dimensionamento). */
  function entryPlan(ind, target) {
    const p = ind.close, a = ind.atr;
    if (!a) return null;
    const cands = [['EMA13', ind.ema13], ['média Bollinger', ind.bbMid], ['EMA50', ind.ema50]]
      .filter(([, v]) => v != null && v < p).sort((x, y) => y[1] - x[1]);
    let low, high, now, ref;
    if (!cands.length) { // preço abaixo de todos os suportes: só entrar se recuperar a EMA13
      ref = 'EMA13'; low = ind.ema13 != null ? Math.max(p, ind.ema13) : p; high = low + 0.5 * a; now = false;
      return { low, high, now, ref, stop: high - 2 * a, rr: target ? (target - high) / (2 * a) : null, breakout: true };
    }
    const [name, sup] = cands[0];
    ref = name;
    if (p - sup <= a) { low = sup; high = p; now = true; }
    else { low = sup; high = sup + 0.5 * a; now = false; }
    const stop = high - 2 * a;
    return { low, high, now, ref, stop, rr: target ? (target - high) / (high - stop) : null };
  }

  function decide(ind, sc, pos, ctx, s) {
    const d = decideCore(ind, sc, pos, ctx, s);
    d.entry = entryPlan(ind, d.target);
    return d;
  }

  function decideCore(ind, sc, pos, ctx, s) {
    const price = ind.close;
    const qty = pos ? (pos.qty || 0) : 0;
    const avg = pos ? (pos.avgPrice || 0) : 0;
    const fx = ctx.fx || 1;
    const reasons = [];
    const stop = ind.atr ? price - 2 * ind.atr : null;
    const plPct = qty > 0 && avg > 0 ? (price / avg - 1) * 100 : null;
    // Alvo técnico: máximo de 52 semanas, limitado a 5×ATR (evita alvos irrealistas em ações que caíram muito)
    let target = ind.atr ? (ind.hi52 > price * 1.03 ? Math.min(ind.hi52, price + 5 * ind.atr) : price + 3 * ind.atr) : null;
    const upsidePct = target ? (target / price - 1) * 100 : null;

    // 1) Stop-loss: perda acima do limite E tendência longa quebrada
    if (qty > 0 && plPct != null && plPct <= -s.maxLossPct && ind.ema200 != null && price < ind.ema200) {
      reasons.push(`Perda de ${plPct.toFixed(1)}% (limite ${s.maxLossPct}%) e preço abaixo da EMA200: tese técnica quebrada.`);
      return { action: 'VENDER', qty: qty, stop, target, upsidePct, plPct, reasons };
    }
    // 2) Sinal forte de venda
    if (qty > 0 && sc.score <= s.sellThreshold * 1.7) {
      reasons.push(`Pontuação ${sc.score} muito negativa: sair da posição.`);
      return { action: 'VENDER', qty: qty, stop, target, upsidePct, plPct, reasons };
    }
    if (qty > 0 && sc.score <= s.sellThreshold) {
      const q = Math.max(1, Math.ceil(qty / 3));
      reasons.push(`Pontuação ${sc.score} ≤ ${s.sellThreshold}: reduzir 1/3 da posição e reavaliar.`);
      return { action: 'VENDER', qty: q, stop, target, upsidePct, plPct, reasons };
    }
    // 3) Realização parcial de lucros quando esticado
    if (qty > 0 && plPct != null && plPct >= s.takeProfitPct && ind.rsi > 75 && ind.pctB > 1) {
      const q = Math.max(1, Math.floor(qty * 0.25));
      reasons.push(`Ganho de ${plPct.toFixed(1)}%, RSI ${ind.rsi.toFixed(0)} e acima da banda superior: realizar 25%.`);
      return { action: 'VENDER', qty: q, stop, target, upsidePct, plPct, reasons, partial: true };
    }
    // 4) Compra
    if (sc.score >= s.buyThreshold) {
      const pv = ctx.portfolioValue;
      const priceBase = price * fx;
      const stopDistBase = ind.atr ? 2 * ind.atr * fx : priceBase * 0.08;
      const qRisk = Math.floor((s.riskPct / 100 * pv) / stopDistBase);
      const room = Math.max(0, s.maxPosPct / 100 * pv - qty * priceBase);
      const qRoom = Math.floor(room / priceBase);
      const qCash = Math.floor((ctx.cash || 0) / priceBase);
      let q = Math.min(qRisk, qRoom, qCash);
      const conviction = sc.score >= s.buyThreshold + 25 ? 1 : 0.5;
      if (conviction < 1 && q >= 1) q = Math.max(1, Math.floor(q * 0.5));
      if (q >= 1) {
        reasons.push(`Pontuação ${sc.score} ≥ ${s.buyThreshold}${conviction < 1 ? ' (convicção moderada: meia posição)' : ' (convicção alta)'}.`);
        reasons.push(`Tamanho limitado por: risco ${s.riskPct}% da carteira com stop a 2×ATR (${qRisk}), peso máx. ${s.maxPosPct}% (${qRoom}), liquidez (${qCash}).`);
        return { action: 'COMPRAR', qty: q, stop, target, upsidePct, plPct, reasons };
      }
      const lim = qRoom < 1 ? `posição já no peso máximo de ${s.maxPosPct}%`
        : qCash < 1 ? (!(ctx.cash > 0) ? 'a liquidez está a 0 — define-a em Definições para a app calcular a quantidade' : 'a liquidez disponível não chega para 1 ação')
        : 'o risco por operação não permite 1 unidade';
      reasons.push(`Sinal de compra (pontuação ${sc.score}) mas ${lim}.`);
      return { action: qty > 0 ? 'MANTER' : 'SINAL COMPRA', qty: 0, stop, target, upsidePct, plPct, reasons, blockedBuy: true };
    }
    if (qty > 0) {
      reasons.push(`Pontuação ${sc.score} entre ${s.sellThreshold} e ${s.buyThreshold}: sem sinal claro. Manter; stop técnico sugerido ${stop ? stop.toFixed(2) : '—'}.`);
      return { action: 'MANTER', qty: 0, stop, target, upsidePct, plPct, reasons };
    }
    reasons.push(`Pontuação ${sc.score}: sem sinal de entrada.`);
    return { action: sc.score <= s.sellThreshold ? 'EVITAR' : 'AGUARDAR', qty: 0, stop, target, upsidePct, plPct, reasons };
  }

  const api = { ema, sma, bollinger, rsi, macd, atr, computeIndicators, newsSentiment, scoreIndicators, decide, entryPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
