/* Modelo histórico: backtest das regras, regressão ridge com validação fora da amostra e calibração de limiares.
   Sem dependências. Browser (window.Model) e Node (require). */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.Engine;

  const H = 20;               // horizonte de previsão (sessões)
  const TEST_DAYS = 252;      // último ~1 ano = validação fora da amostra
  const EMBARGO = H;          // intervalo entre treino e teste (evita sobreposição de janelas)
  const WARMUP = 252;         // precisa de EMA200 e máximo de 52 semanas estáveis

  const FEATURES = [
    'Preço vs EMA200', 'EMA50 vs EMA200', 'Preço vs EMA50', 'EMA13 vs EMA50', 'Inclinação EMA50 (10d)',
    'RSI14', 'MACD hist / preço', 'Bollinger %B', 'Largura Bollinger', 'Volume relativo × direção',
    'Retorno 20d', 'Retorno 60d', 'Volatilidade (ATR %)', 'Distância ao máx. 52s'
  ];

  function feat(S, i) {
    const c = S.c[i];
    const v = [
      c / S.e200[i] - 1, S.e50[i] / S.e200[i] - 1, c / S.e50[i] - 1, S.e13[i] / S.e50[i] - 1,
      S.e50[i] / S.e50[i - 10] - 1,
      (S.rsi[i] - 50) / 50, S.macdHist[i] / c,
      S.bbU[i] != null ? (c - S.bbL[i]) / (S.bbU[i] - S.bbL[i]) - 0.5 : null, S.bw[i],
      S.volAvg[i] > 0 && S.vol[i] > 0 ? Math.log(S.vol[i] / S.volAvg[i]) * Math.sign(c - S.c[i - 1]) : 0,
      c / S.c[i - 20] - 1, c / S.c[i - 60] - 1, S.atr[i] / c, c / S.hi[i] - 1
    ];
    return v.every(x => x != null && isFinite(x)) ? v : null;
  }

  // ---------- utilitários ----------
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1e-9; };
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    for (let k = 0; k < idx.length;) {
      let j = k; while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++;
      const avg = (k + j) / 2; for (let t = k; t <= j; t++) r[idx[t][1]] = avg; k = j + 1;
    }
    return r;
  }
  function corr(a, b) {
    const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? n / Math.sqrt(da * db) : 0;
  }
  const spearman = (a, b) => corr(ranks(a), ranks(b));
  function solve(A, b) { // eliminação de Gauss com pivot parcial
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let k = 0; k < n; k++) {
      let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
      [M[k], M[p]] = [M[p], M[k]];
      for (let i = k + 1; i < n; i++) { const f = M[i][k] / M[k][k]; for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }
  function ridgeFit(X, y, lambda) {
    const F = X[0].length, XtX = Array.from({ length: F }, () => new Array(F).fill(0)), Xty = new Array(F).fill(0);
    const ym = mean(y);
    for (let r = 0; r < X.length; r++) {
      const x = X[r], yy = y[r] - ym;
      for (let i = 0; i < F; i++) { Xty[i] += x[i] * yy; for (let j = i; j < F; j++) XtX[i][j] += x[i] * x[j]; }
    }
    for (let i = 0; i < F; i++) { for (let j = 0; j < i; j++) XtX[i][j] = XtX[j][i]; XtX[i][i] += lambda * X.length; }
    return { w: solve(XtX, Xty), b: ym };
  }
  const predict = (m, x) => m.b + x.reduce((s, v, i) => s + v * m.w[i], 0);
  function standardizer(X) {
    const F = X[0].length, mu = [], sg = [];
    for (let j = 0; j < F; j++) { const col = X.map(r => r[j]); mu.push(mean(col)); sg.push(sd(col)); }
    return { mu, sg, apply: x => x.map((v, j) => Math.max(-3, Math.min(3, (v - mu[j]) / sg[j]))) };
  }

  // IC médio por data (correlação de Spearman entre previsão e retorno relativo, entre ações, em cada dia)
  function dailyIC(rows, key) {
    const byDate = new Map();
    for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    const ics = [];
    for (const g of byDate.values()) if (g.length >= 5) ics.push(spearman(g.map(r => r[key]), g.map(r => r.ex)));
    const m = mean(ics), s = sd(ics);
    // janelas de 20 dias sobrepõem-se: nº efetivo de observações independentes ≈ dias / H
    const t = ics.length ? m / s * Math.sqrt(ics.length / H) : 0;
    return { ic: m, t, days: ics.length };
  }
  function quintileSpread(rows, key) {
    const byDate = new Map();
    for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    const top = [], bot = [], hit = [];
    for (const g of byDate.values()) {
      if (g.length < 5) continue;
      const s = [...g].sort((a, b) => b[key] - a[key]), q = Math.max(1, Math.floor(s.length / 5));
      top.push(mean(s.slice(0, q).map(r => r.r))); bot.push(mean(s.slice(-q).map(r => r.r)));
      for (const r of s.slice(0, q)) hit.push(r.ex > 0 ? 1 : 0);
    }
    return { top: mean(top), bottom: mean(bot), spread: mean(top) - mean(bot), topHit: mean(hit) };
  }

  // ---------- backtest das regras com limiares B/S ----------
  function simulate(S, scores, from, to, B, Sl, cost = 0.001) {
    let inPos = false, entry = 0, stop = 0, logR = 0, trades = 0, wins = 0, peak = 0, mdd = 0, daily = [], eq = 0;
    for (let i = from; i < to; i++) {
      const r = Math.log(S.c[i + 1] / S.c[i]);
      if (!inPos && scores[i] >= B) { inPos = true; entry = S.c[i]; stop = S.c[i] - 2 * S.atr[i]; logR -= cost; trades++; }
      else if (inPos && (scores[i] <= Sl || S.c[i] < stop)) { inPos = false; logR -= cost; if (S.c[i] > entry) wins++; }
      const dr = inPos ? r : 0; logR += dr; daily.push(dr);
      eq = logR; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak);
    }
    if (inPos && S.c[to] > entry) wins++;
    const m = mean(daily), s = sd(daily);
    return { ret: Math.exp(logR) - 1, sharpe: s > 1e-8 ? m / s * Math.sqrt(252) : 0, trades, winRate: trades ? wins / trades : 0, mdd: Math.exp(mdd) - 1 };
  }
  function buyHold(S, from, to) { return S.c[to] / S.c[from] - 1; }

  const BUCKETS = [[-100, -60], [-60, -35], [-35, -10], [-10, 10], [10, 35], [35, 60], [60, 101]];
  const bucketOf = s => BUCKETS.findIndex(([a, b]) => s >= a && s < b);

  /*
   data: { SYM: bars[] }  (barras diárias ascendentes, idealmente ~1000)
   Devolve o modelo (serializável) + relatório.
  */
  function train(data, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const per = {};  // sym -> {S, scores, rows}
    const rows = [];
    const syms = Object.keys(data).filter(s => data[s] && data[s].length >= WARMUP + H + 60);
    syms.forEach((sym, k) => {
      onProgress(`A calcular indicadores ${sym} (${k + 1}/${syms.length})`);
      const S = E.seriesAll(data[sym]);
      const scores = new Array(S.N).fill(null);
      for (let i = WARMUP; i < S.N; i++) scores[i] = E.scoreIndicators(E.indAt(S, i), 0).score;
      per[sym] = { S, scores };
      for (let i = WARMUP; i < S.N - H; i++) {
        const f = feat(S, i); if (!f) continue;
        rows.push({ sym, i, date: S.dates[i], f, score: scores[i], r: S.c[i + H] / S.c[i] - 1, r5: S.c[Math.min(i + 5, S.N - 1)] / S.c[i] - 1 });
      }
    });
    if (rows.length < 500 || syms.length < 5) throw new Error('Dados insuficientes: são precisas pelo menos 5 ações com ~1,5 anos de histórico.');

    // retorno relativo (em excesso da média do universo no mesmo dia)
    const byDate = new Map();
    for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
    for (const g of byDate.values()) { const m = mean(g.map(x => x.r)); for (const x of g) x.ex = g.length >= 3 ? x.r - m : 0; }

    // divisão temporal: treino | embargo | teste (último ano)
    const dates = [...byDate.keys()].sort();
    const testStart = dates[Math.max(0, dates.length - TEST_DAYS)];
    const trainEnd = dates[Math.max(0, dates.length - TEST_DAYS - EMBARGO)];
    const tr = rows.filter(r => r.date < trainEnd), te = rows.filter(r => r.date >= testStart);

    // escolha de lambda com validação interna (último 25% do treino)
    onProgress('A treinar o modelo…');
    const trDates = [...new Set(tr.map(r => r.date))].sort();
    const innerCut = trDates[Math.floor(trDates.length * 0.75)];
    const trA = tr.filter(r => r.date < innerCut), trB = tr.filter(r => r.date >= innerCut);
    let best = { lam: 1, ic: -Infinity };
    for (const lam of [0.001, 0.01, 0.1, 1, 10]) {
      const st = standardizer(trA.map(r => r.f));
      const m = ridgeFit(trA.map(r => st.apply(r.f)), trA.map(r => r.ex), lam);
      const tmp = trB.map(r => ({ ...r, p: predict(m, st.apply(r.f)) }));
      const ic = dailyIC(tmp, 'p').ic;
      if (ic > best.ic) best = { lam, ic };
    }
    const st = standardizer(tr.map(r => r.f));
    const mTr = ridgeFit(tr.map(r => st.apply(r.f)), tr.map(r => r.ex), best.lam);
    for (const r of te) r.p = predict(mTr, st.apply(r.f));
    for (const r of te) r.s = r.score;
    const oosModel = { ...dailyIC(te, 'p'), ...quintileSpread(te, 'p') };
    const oosRules = { ...dailyIC(te, 's'), ...quintileSpread(te, 's') };
    const hitSign = mean(te.map(r => (r.p > 0) === (r.ex > 0) ? 1 : 0));

    // pontuação das regras → retorno absoluto a 20 dias (todo o histórico)
    const bstat = BUCKETS.map(([a, b]) => ({ range: `${a}…${b === 101 ? 100 : b}`, n: 0, sum: 0, up: 0, rs: [] }));
    for (const r of rows) { const k = bucketOf(r.score); if (k < 0) continue; const x = bstat[k]; x.n++; x.sum += r.r; x.up += r.r > 0 ? 1 : 0; x.rs.push(r.r); }
    const buckets = bstat.map(x => ({ range: x.range, n: x.n, mean: x.n ? x.sum / x.n : null, up: x.n ? x.up / x.n : null, median: x.n ? x.rs.sort((a, b) => a - b)[Math.floor(x.n / 2)] : null }));
    const baseline = { mean: mean(rows.map(r => r.r)), up: mean(rows.map(r => r.r > 0 ? 1 : 0)) };

    // calibração de limiares: melhor Sharpe médio no treino; resultado reportado no teste
    onProgress('A calibrar limiares…');
    const grid = [];
    for (const B of [15, 25, 35, 45, 55, 65]) for (const Sl of [-55, -45, -35, -25, -15, 0]) if (Sl < B) grid.push([B, Sl]);
    const evalGrid = (B, Sl, which) => {
      const res = [];
      for (const sym of Object.keys(per)) {
        const { S, scores } = per[sym];
        const iTs = S.dates.findIndex(d => d >= testStart), iTe = S.dates.findIndex(d => d >= trainEnd);
        const [from, to] = which === 'train' ? [WARMUP, (iTe > WARMUP ? iTe : -1)] : [Math.max(WARMUP, iTs), S.N - 1];
        if (from < 0 || to - from < 60 || iTs < 0) continue;
        res.push({ ...simulate(S, scores, from, to, B, Sl), bh: buyHold(S, from, to) });
      }
      return { n: res.length, sharpe: mean(res.map(r => r.sharpe)), ret: mean(res.map(r => r.ret)), bh: mean(res.map(r => r.bh)), trades: mean(res.map(r => r.trades)), win: mean(res.map(r => r.winRate)), mdd: mean(res.map(r => r.mdd)) };
    };
    let bestT = null;
    for (const [B, Sl] of grid) { const g = evalGrid(B, Sl, 'train'); if (!bestT || g.sharpe > bestT.g.sharpe) bestT = { B, Sl, g }; }
    const thresholds = {
      calibrated: { buy: bestT.B, sell: bestT.Sl, train: bestT.g, test: evalGrid(bestT.B, bestT.Sl, 'test') },
      current: { buy: opts.buy ?? 35, sell: opts.sell ?? -35, train: evalGrid(opts.buy ?? 35, opts.sell ?? -35, 'train'), test: evalGrid(opts.buy ?? 35, opts.sell ?? -35, 'test') }
    };

    // modelo final: re-treinado com todo o histórico (mesmo lambda)
    const stAll = standardizer(rows.map(r => r.f));
    const mAll = ridgeFit(rows.map(r => stAll.apply(r.f)), rows.map(r => r.ex), best.lam);
    // escala: previsões ridge são encolhidas → converter em percentil diário + retorno médio histórico por quintil de previsão
    const allP = rows.map(r => ({ ...r, p: predict(mAll, stAll.apply(r.f)) }));
    const pSorted = allP.map(r => r.p).sort((a, b) => a - b);
    const qEdges = [0.2, 0.4, 0.6, 0.8].map(q => pSorted[Math.floor(q * (pSorted.length - 1))]);
    // estatísticas FORA DA AMOSTRA por quintil: modelo de treino, cortes definidos no treino, aplicados ao teste
    const pTr = tr.map(r => predict(mTr, st.apply(r.f))).sort((a, b) => a - b);
    const qEdgesTr = [0.2, 0.4, 0.6, 0.8].map(q => pTr[Math.floor(q * (pTr.length - 1))]);
    const qStats = [0, 1, 2, 3, 4].map(q => {
      const g = te.filter(r => { const k = qEdgesTr.findIndex(e => r.p < e); return (k < 0 ? 4 : k) === q; });
      return { n: g.length, ex: mean(g.map(r => r.ex)), r: mean(g.map(r => r.r)), up: mean(g.map(r => r.r > 0 ? 1 : 0)) };
    });

    // estatísticas por ação: acerto das regras no próprio título (retorno 20d quando pontuação ≥ limiar)
    const perSym = {};
    for (const sym of Object.keys(per)) {
      const rs = rows.filter(r => r.sym === sym);
      const on = rs.filter(r => r.score >= thresholds.calibrated.buy), off = rs.filter(r => r.score < thresholds.calibrated.buy);
      perSym[sym] = { n: rs.length, onN: on.length, onMean: on.length ? mean(on.map(r => r.r)) : null, onUp: on.length ? mean(on.map(r => r.r > 0 ? 1 : 0)) : null, offMean: off.length ? mean(off.map(r => r.r)) : null };
    }

    const verdict = oosModel.ic > 0.05 && oosModel.t > 2 ? 'moderado' : oosModel.ic > 0.02 && oosModel.t > 1.5 ? 'fraco' : 'nulo';
    return {
      version: 1, trainedAt: new Date().toISOString().slice(0, 10), horizon: H, universe: Object.keys(per),
      period: { from: dates[0], trainEnd, testStart, to: dates[dates.length - 1], rows: rows.length, trainRows: tr.length, testRows: te.length },
      lambda: best.lam, features: FEATURES,
      weights: mAll.w, bias: mAll.b, mu: stAll.mu, sg: stAll.sg, qEdges, qStats,
      oos: { model: oosModel, rules: oosRules, hitSign }, verdict,
      buckets, baseline, thresholds, perSym
    };
  }

  // previsão para o último dia de uma série, com um modelo treinado
  function forecast(model, S) {
    const i = S.N - 1, f = feat(S, i);
    if (!f || !model) return null;
    const x = f.map((v, j) => Math.max(-3, Math.min(3, (v - model.mu[j]) / model.sg[j])));
    const p = model.bias + x.reduce((s, v, j) => s + v * model.weights[j], 0);
    let q = model.qEdges.findIndex(e => p < e); if (q < 0) q = 4;
    const contrib = x.map((v, j) => ({ name: model.features[j], c: v * model.weights[j] })).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    return { pred: p, quintile: q + 1, hist: model.qStats[q], contrib: contrib.slice(0, 4) };
  }
  function bucketStats(model, score) { const k = bucketOf(score); return k >= 0 && model ? model.buckets[k] : null; }

  const api = { train, forecast, bucketStats, feat, FEATURES, H, _internal: { ridgeFit, spearman, simulate, dailyIC } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Model = api;
})(typeof self !== 'undefined' ? self : this);
