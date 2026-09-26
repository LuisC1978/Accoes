/* Modelo histórico (v2): validação walk-forward, features cross-sectional, backtest das regras e calibração de limiares.
   Sem dependências. Browser (window.Model) e Node (require). */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.Engine;

  const VERSION = 2;
  const H = 20;               // horizonte de previsão (sessões) = passo do walk-forward
  const WARMUP = 252;         // precisa de EMA200 e máximo de 52 semanas estáveis
  const EMBARGO = H;          // o alvo de uma linha de treino tem de terminar antes da data de teste
  const MIN_TRAIN_DATES = 252;// ~1 ano de treino antes do primeiro período de teste
  const TRAIN_WINDOW = 756;   // janela móvel de treino (~3 anos): adapta-se a mudanças de regime
  const TEST_DAYS = 252;      // último ~1 ano: validação dos limiares das regras
  const MIN_PEERS = 5;        // ações mínimas por data para comparar entre si
  const COST = 0.002;         // custo por rotação completa (compra + venda) no backtest do modelo
  const LAMBDAS = [0.01, 0.1, 1, 10];

  // 11 indicadores. Saíram 3 quase redundantes, que tornavam os pesos instáveis:
  // 'EMA50 vs EMA200' (= Preço vs EMA200 − Preço vs EMA50), 'EMA13 vs EMA50' (≈ MACD) e 'Largura Bollinger' (≈ ATR %).
  const FEATURES = [
    'Preço vs EMA200', 'Preço vs EMA50', 'Inclinação EMA50 (10d)', 'RSI14', 'MACD hist / preço',
    'Bollinger %B', 'Volume relativo × direção', 'Retorno 20d', 'Retorno 60d', 'Volatilidade (ATR %)', 'Distância ao máx. 52s'
  ];

  function feat(S, i) {
    const c = S.c[i];
    if (i < 60) return null;
    const v = [
      c / S.e200[i] - 1, c / S.e50[i] - 1, S.e50[i] / S.e50[i - 10] - 1,
      (S.rsi[i] - 50) / 50, S.macdHist[i] / c,
      S.bbU[i] != null ? (c - S.bbL[i]) / (S.bbU[i] - S.bbL[i]) - 0.5 : null,
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
  function tStat(x) { if (x.length < 2) return 0; const m = mean(x), s = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1)); return s > 0 ? m / (s / Math.sqrt(x.length)) : 0; }
  // t de Newey-West (2 desfasamentos): robusto a autocorrelação entre períodos consecutivos
  function tNW(x, lags = 2) {
    const n = x.length; if (n < 3) return 0;
    const m = mean(x), e = x.map(v => v - m);
    let s = e.reduce((a, v) => a + v * v, 0) / n;
    for (let L = 1; L <= lags; L++) { let g = 0; for (let t = L; t < n; t++) g += e[t] * e[t - L]; s += 2 * (1 - L / (lags + 1)) * g / n; }
    return s > 0 ? m / Math.sqrt(s / n) : 0;
  }
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

  // z-score entre as ações da mesma data (remove o "nível do mercado": só interessa quem está melhor que quem)
  function crossZ(fs) {
    const F = fs[0].length, out = fs.map(() => new Array(F));
    for (let j = 0; j < F; j++) {
      const col = fs.map(f => f[j]), m = mean(col), s = sd(col);
      for (let k = 0; k < fs.length; k++) out[k][j] = s > 1e-12 ? Math.max(-3, Math.min(3, (col[k] - m) / s)) : 0;
    }
    return out;
  }
  const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  // quintil (0..4) de cada elemento dentro do seu grupo
  const quintiles = vals => { const rk = ranks(vals), n = vals.length; return rk.map(v => Math.min(4, Math.floor(5 * v / n))); };

  // regime de mercado a partir do índice de referência (QQQ): risk-off quando está abaixo da EMA200
  function regimeSeries(bench) {
    if (!bench || bench.length < 210) return null;
    const c = bench.map(b => b.close), e = E.ema(c, 200), m = new Map();
    bench.forEach((b, i) => { if (e[i] != null) m.set(b.datetime, { above200: c[i] > e[i], close: c[i], ema200: e[i], i }); });
    return m;
  }
  function regimeNow(bench) {
    const m = regimeSeries(bench); if (!m) return null;
    const d = bench[bench.length - 1].datetime, r = m.get(d);
    return r ? { date: d, riskOff: !r.above200, close: r.close, ema200: r.ema200, dist: r.close / r.ema200 - 1 } : null;
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

  // escolhe lambda só com o próprio conjunto de treino (últimos 25% como validação interna)
  function pickLambda(tr) {
    const ds = [...new Set(tr.map(r => r.date))].sort(), cut = ds[Math.floor(ds.length * 0.75)];
    const A = tr.filter(r => r.date < cut), B = tr.filter(r => r.date >= cut);
    if (A.length < 200 || B.length < 50) return 1;
    let best = { lam: 1, ic: -Infinity };
    for (const lam of LAMBDAS) {
      const m = ridgeFit(A.map(r => r.x), A.map(r => r.ex), lam);
      const ics = [];
      for (const g of groupBy(B, 'date').values()) if (g.length >= MIN_PEERS) ics.push(spearman(g.map(r => predict(m, r.x)), g.map(r => r.ex)));
      const ic = mean(ics); if (ic > best.ic) best = { lam, ic };
    }
    return best.lam;
  }

  /*
   data: { SYM: bars[] }  (barras diárias ascendentes, idealmente ~1000)
   opts: { bench: bars[] do QQQ (opcional), buy, sell, onProgress }
  */
  function train(data, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const per = {};
    const rows = [];
    const syms = Object.keys(data).filter(s => data[s] && data[s].length >= WARMUP + H + 60);
    syms.forEach((sym, k) => {
      onProgress(`A calcular indicadores ${sym} (${k + 1}/${syms.length})`);
      const S = E.seriesAll(data[sym]);
      const scores = new Array(S.N).fill(null);
      for (let i = WARMUP; i < S.N; i++) scores[i] = E.scoreIndicators(E.indAt(S, i), 0).score;
      per[sym] = { S, scores };
      for (let i = WARMUP; i < S.N; i++) {
        const f = feat(S, i); if (!f) continue;
        const fwd = i + H < S.N ? S.c[i + H] / S.c[i] - 1 : null;
        rows.push({ sym, i, date: S.dates[i], f, score: scores[i], r: fwd != null && isFinite(fwd) ? fwd : null });
      }
    });
    if (syms.length < MIN_PEERS || rows.length < 500) throw new Error('Dados insuficientes: são precisas pelo menos 5 ações com ~1,5 anos de histórico.');

    // por data: features normalizadas entre ações e retorno em excesso da média do universo
    const byDate = groupBy(rows, 'date');
    const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_PEERS);
    const dIdx = new Map(dates.map((d, k) => [d, k]));
    for (const d of dates) {
      const g = byDate.get(d), Z = crossZ(g.map(r => r.f));
      g.forEach((r, k) => { r.x = Z[k]; r.di = dIdx.get(d); });
      const kn = g.filter(r => r.r != null), m = mean(kn.map(r => r.r));
      for (const r of g) r.ex = r.r != null ? r.r - m : null;
    }
    const usable = rows.filter(r => r.x);
    const known = usable.filter(r => r.ex != null);

    // ---------- walk-forward: re-treino a cada 20 sessões, só com o passado, períodos de teste sem sobreposição ----------
    const regime = regimeSeries(opts.bench);
    const benchIdx = opts.bench ? new Map(opts.bench.map((b, i) => [b.datetime, i])) : null;
    const periods = [], testRows = [], lambdas = [];
    const first = MIN_TRAIN_DATES + EMBARGO;
    const nSteps = Math.max(0, Math.floor((dates.length - first) / H));
    for (let k = 0, r = first; r < dates.length; r += H, k++) {
      const g = byDate.get(dates[r]).filter(x => x.x && x.ex != null);
      if (g.length < MIN_PEERS) continue;
      onProgress(`Walk-forward: período ${k + 1}/${nSteps}…`);
      const hi = r - EMBARGO - 1, lo = Math.max(0, hi - TRAIN_WINDOW);
      const tr = known.filter(x => x.di >= lo && x.di <= hi);
      if (tr.length < 500) continue;
      const lam = pickLambda(tr); lambdas.push(lam);
      const m = ridgeFit(tr.map(x => x.x), tr.map(x => x.ex), lam);
      const p = g.map(x => predict(m, x.x)), q = quintiles(p), qs = quintiles(g.map(x => x.score));
      g.forEach((x, j) => testRows.push({ ...x, p: p[j], q: q[j], qs: qs[j] }));
      const qRet = [0, 1, 2, 3, 4].map(k2 => mean(g.filter((_, j) => q[j] === k2).map(x => x.r)));
      const qRetS = [0, 1, 2, 3, 4].map(k2 => mean(g.filter((_, j) => qs[j] === k2).map(x => x.r)));
      let bench = null;
      if (benchIdx && benchIdx.has(dates[r])) { const bi = benchIdx.get(dates[r]); if (bi + H < opts.bench.length) bench = opts.bench[bi + H].close / opts.bench[bi].close - 1; }
      const reg = regime ? regime.get(dates[r]) : null;
      periods.push({
        date: dates[r], n: g.length, ic: spearman(p, g.map(x => x.ex)), icRules: spearman(g.map(x => x.score), g.map(x => x.ex)),
        qRet, qRetS, top: g.filter((_, j) => q[j] === 4).map(x => x.sym), ew: mean(g.map(x => x.r)), bench,
        riskOff: reg ? !reg.above200 : null
      });
    }
    if (periods.length < 3) throw new Error('Histórico insuficiente para o walk-forward (são precisos ~2 anos depois do aquecimento).');

    // ---------- resumo fora da amostra ----------
    const ics = periods.map(p => p.ic), icsR = periods.map(p => p.icRules);
    const qStats = [0, 1, 2, 3, 4].map(k => {
      const g = testRows.filter(x => x.q === k);
      return { n: g.length, ex: mean(g.map(x => x.ex)), r: mean(g.map(x => x.r)), up: mean(g.map(x => x.r > 0 ? 1 : 0)) };
    });
    const topHit = key => mean(testRows.filter(x => x[key] === 4).map(x => x.ex > 0 ? 1 : 0));
    const block = (icArr, qk) => ({
      ic: mean(icArr), t: tStat(icArr), tNW: tNW(icArr), hit: mean(icArr.map(v => v > 0 ? 1 : 0)),
      top: mean(periods.map(p => p[qk][4])), bottom: mean(periods.map(p => p[qk][0])),
      spread: mean(periods.map(p => p[qk][4] - p[qk][0])), topHit: topHit(qk === 'qRet' ? 'q' : 'qs')
    });
    const oosModel = block(ics, 'qRet'), oosRules = block(icsR, 'qRetS');
    const monotonic = spearman([0, 1, 2, 3, 4], qStats.map(q => q.ex));

    // carteira simulada: top quintil do modelo, igual peso, rebalanceada a cada 20 sessões, com custos
    const curve = (rets) => { let eq = 1, pk = 1, dd = 0; for (const x of rets) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { ret: eq - 1, mdd: dd }; };
    const ann = rets => { const s = sd(rets); return s > 1e-9 ? mean(rets) / s * Math.sqrt(252 / H) : 0; };
    let prev = null; const strat = periods.map(p => {
      const turn = prev ? p.top.filter(s => !prev.includes(s)).length / (p.top.length || 1) : 1; prev = p.top;
      return p.qRet[4] - turn * COST;
    });
    const ewR = periods.map(p => p.ew), bR = periods.every(p => p.bench != null) ? periods.map(p => p.bench) : null;
    const backtest = {
      model: { ...curve(strat), sharpe: ann(strat) },
      universe: { ...curve(ewR), sharpe: ann(ewR) },
      bench: bR ? { ...curve(bR), sharpe: ann(bR) } : null,
      beatUniverse: mean(periods.map((p, k) => strat[k] > p.ew ? 1 : 0))
    };
    const on = periods.filter(p => p.riskOff === false).map(p => p.ic), off = periods.filter(p => p.riskOff === true).map(p => p.ic);
    const byRegime = { riskOn: on.length ? { ic: mean(on), n: on.length } : null, riskOff: off.length ? { ic: mean(off), n: off.length } : null };

    // Veredicto exigente: só "moderado" permite ao modelo influenciar decisões.
    const tMin = Math.min(oosModel.t, oosModel.tNW);
    const verdict = periods.length >= 12 && oosModel.ic > 0.03 && tMin >= 2 && monotonic > 0.5 ? 'moderado'
      : oosModel.ic > 0 && tMin >= 1.5 ? 'fraco' : 'nulo';

    // ---------- pontuação das regras → retorno absoluto a 20 dias (todo o histórico conhecido) ----------
    const kn = rows.filter(r => r.r != null);
    const bstat = BUCKETS.map(([a, b]) => ({ range: `${a}…${b === 101 ? 100 : b}`, n: 0, sum: 0, up: 0, rs: [] }));
    for (const r of kn) { const k = bucketOf(r.score); if (k < 0) continue; const x = bstat[k]; x.n++; x.sum += r.r; x.up += r.r > 0 ? 1 : 0; x.rs.push(r.r); }
    const buckets = bstat.map(x => ({ range: x.range, n: x.n, mean: x.n ? x.sum / x.n : null, up: x.n ? x.up / x.n : null, median: x.n ? x.rs.sort((a, b) => a - b)[Math.floor(x.n / 2)] : null }));
    const baseline = { mean: mean(kn.map(r => r.r)), up: mean(kn.map(r => r.r > 0 ? 1 : 0)) };

    // ---------- limiares das regras: escolhidos no treino, avaliados no último ano ----------
    onProgress('A calibrar limiares…');
    const testStart = dates[Math.max(0, dates.length - TEST_DAYS)];
    const trainEnd = dates[Math.max(0, dates.length - TEST_DAYS - EMBARGO)];
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
    // só vale a pena aplicar se melhorar claramente fora da amostra
    thresholds.worthApplying = (thresholds.calibrated.buy !== thresholds.current.buy || thresholds.calibrated.sell !== thresholds.current.sell)
      && thresholds.calibrated.test.sharpe >= thresholds.current.test.sharpe + 0.1;

    // ---------- modelo final: janela mais recente, lambda mais escolhido no walk-forward ----------
    const lamFinal = [...LAMBDAS].sort((a, b) => lambdas.filter(x => x === b).length - lambdas.filter(x => x === a).length)[0];
    const lastKnown = Math.max(...known.map(r => r.di));
    const fin = known.filter(r => r.di > lastKnown - TRAIN_WINDOW);
    const mAll = ridgeFit(fin.map(r => r.x), fin.map(r => r.ex), lamFinal);

    const perSym = {};
    for (const sym of Object.keys(per)) {
      const rs = kn.filter(r => r.sym === sym);
      const on2 = rs.filter(r => r.score >= thresholds.calibrated.buy), off2 = rs.filter(r => r.score < thresholds.calibrated.buy);
      perSym[sym] = { n: rs.length, onN: on2.length, onMean: on2.length ? mean(on2.map(r => r.r)) : null, onUp: on2.length ? mean(on2.map(r => r.r > 0 ? 1 : 0)) : null, offMean: off2.length ? mean(off2.map(r => r.r)) : null };
    }

    return {
      version: VERSION, trainedAt: new Date().toISOString().slice(0, 10), horizon: H, universe: Object.keys(per),
      period: { from: dates[0], wfFrom: periods[0].date, wfTo: periods[periods.length - 1].date, to: dates[dates.length - 1], trainEnd, testStart,
        rows: usable.length, testRows: testRows.length, periods: periods.length, trainWindow: TRAIN_WINDOW },
      lambda: lamFinal, features: FEATURES,
      weights: mAll.w, bias: mAll.b, qStats, monotonic,
      oos: { model: oosModel, rules: oosRules }, verdict, backtest, byRegime,
      periods: periods.map(p => ({ date: p.date, ic: p.ic, icRules: p.icRules, riskOff: p.riskOff })),
      buckets, baseline, thresholds, perSym
    };
  }

  /* Previsão para o último dia, comparando as ações entre si.
     seriesMap: { SYM: S (de Engine.seriesAll) }. Devolve { SYM: {pred, quintile, pct, hist, contrib, date} }.
     Só compara ações com a mesma data de fecho mais recente (a mais comum). Precisa de ≥5. */
  function forecastAll(model, seriesMap) {
    if (!model || model.version !== VERSION) return {};
    const items = [];
    for (const [sym, S] of Object.entries(seriesMap)) {
      if (!S || S.N < WARMUP) continue;
      const f = feat(S, S.N - 1); if (f) items.push({ sym, f, date: S.dates[S.N - 1] });
    }
    const cnt = {}; for (const x of items) cnt[x.date] = (cnt[x.date] || 0) + 1;
    const date = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || (b > a ? 1 : -1))[0];
    const g = items.filter(x => x.date === date);
    if (g.length < MIN_PEERS) return {};
    const Z = crossZ(g.map(x => x.f)), p = Z.map(z => predict({ w: model.weights, b: model.bias }, z)), q = quintiles(p), rk = ranks(p);
    const out = {};
    g.forEach((x, k) => {
      const contrib = Z[k].map((v, j) => ({ name: model.features[j], c: v * model.weights[j] })).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
      out[x.sym] = { pred: p[k], quintile: q[k] + 1, pct: Math.round(100 * rk[k] / Math.max(1, g.length - 1)), hist: model.qStats[q[k]], contrib: contrib.slice(0, 4), date, peers: g.length };
    });
    return out;
  }
  function bucketStats(model, score) { const k = bucketOf(score); return k >= 0 && model ? model.buckets[k] : null; }

  const api = { train, forecastAll, bucketStats, feat, regimeNow, FEATURES, H, VERSION, _internal: { ridgeFit, spearman, simulate, tNW, crossZ } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Model = api;
})(typeof self !== 'undefined' ? self : this);
