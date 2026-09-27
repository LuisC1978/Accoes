/* Pontuação adaptativa: reajusta o peso de cada regra da pontuação com o histórico (janela de 3 anos), todos os dias.
   - Parte dos pesos originais (os pontos das regras) e só se afasta deles quando os dados o justificam (encolhimento bayesiano).
   - Pesos comuns a todas as ações + desvio por ação, fortemente encolhido para os comuns (cada ação sozinha tem poucos
     períodos independentes de 20 dias: ~37 em 3 anos, para 16 pesos).
   - Validação walk-forward contra a pontuação original; só é usada nas decisões se prever melhor, com significância.
   Sem dependências. Browser (window.Adaptive) e Node (require). */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.Engine;

  const BUILD = '5.1';
  const H = 20;            // horizonte (sessões)
  const WARMUP = 252;      // EMA200 e máximos de 52 semanas estáveis
  const WINDOW = 756;      // janela de treino: 3 anos
  const MIN_TRAIN = 252;   // mínimo de datas de treino antes do primeiro teste
  const STEP = 10;         // teste a cada 10 sessões (t com Newey-West, 2 desfasamentos)
  const MIN_PEERS = 5;     // ações mínimas por data
  const IC0 = 0.1;         // força do prior: desvio típico esperado do efeito de cada regra (em unidades de IC)
  const A = E.ATOMS.length;

  // Variantes testadas em walk-forward. hl = meia-vida em sessões (0 = todos os dias com o mesmo peso).
  // kappa = força do encolhimento dos pesos por ação para os comuns (Infinity = sem pesos por ação).
  const CONFIGS = [
    { id: 'comum', name: 'Pesos comuns', hl: 0, kappa: Infinity },
    { id: 'comum-rec', name: 'Pesos comuns, dias recentes pesam mais', hl: 252, kappa: Infinity },
    { id: 'acao', name: 'Pesos por ação (ajuste ligeiro)', hl: 0, kappa: 1 },
    { id: 'acao-rec', name: 'Pesos por ação (ligeiro), dias recentes pesam mais', hl: 252, kappa: 1 },
    { id: 'acao-forte', name: 'Pesos por ação (ajuste forte)', hl: 0, kappa: 0.1 },
    { id: 'acao-forte-rec', name: 'Pesos por ação (forte), dias recentes pesam mais', hl: 252, kappa: 0.1 }
  ];

  // ---------- utilitários ----------
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
    for (let k = 0; k < idx.length;) { let j = k; while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++; for (let t = k; t <= j; t++) r[idx[t][1]] = (k + j) / 2; k = j + 1; }
    return r;
  }
  function corr(a, b) {
    const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? n / Math.sqrt(da * db) : 0;
  }
  const spearman = (a, b) => corr(ranks(a), ranks(b));
  function tNW(x, lags = 2) {
    const n = x.length; if (n < 4) return 0;
    const m = mean(x), e = x.map(v => v - m);
    let s = e.reduce((a, v) => a + v * v, 0) / n;
    for (let L = 1; L <= lags; L++) { let g = 0; for (let t = L; t < n; t++) g += e[t] * e[t - L]; s += 2 * (1 - L / (lags + 1)) * g / n; }
    return s > 0 ? m / Math.sqrt(s / n) : 0;
  }
  function solve(M, b) { // Gauss com pivot parcial (M é copiada)
    const n = b.length, X = M.map((r, i) => [...r, b[i]]);
    for (let k = 0; k < n; k++) {
      let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(X[i][k]) > Math.abs(X[p][k])) p = i;
      [X[k], X[p]] = [X[p], X[k]];
      if (Math.abs(X[k][k]) < 1e-15) continue;
      for (let i = k + 1; i < n; i++) { const f = X[i][k] / X[k][k]; if (f) for (let j = k; j <= n; j++) X[i][j] -= f * X[k][j]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = X[i][n]; for (let j = i + 1; j < n; j++) s -= X[i][j] * x[j]; x[i] = Math.abs(X[i][i]) < 1e-15 ? 0 : s / X[i][i]; }
    return x;
  }

  // Estatísticas suficientes (somas ponderadas) para regressão
  const newStats = () => ({ n: 0, sx: new Float64Array(A), sy: 0, syy: 0, sxx: new Float64Array(A * A), sxy: new Float64Array(A) });
  function addRow(s, x, y, w) {
    s.n += w; s.sy += w * y; s.syy += w * y * y;
    for (let j = 0; j < A; j++) {
      const xj = x[j]; if (!xj) continue;
      const wx = w * xj; s.sx[j] += wx; s.sxy[j] += wx * y;
      const o = j * A; for (let k = j; k < A; k++) if (x[k]) s.sxx[o + k] += wx * x[k];
    }
  }
  function addStats(acc, s, w) {
    acc.n += w * s.n; acc.sy += w * s.sy; acc.syy += w * s.syy;
    for (let j = 0; j < A; j++) { acc.sx[j] += w * s.sx[j]; acc.sxy[j] += w * s.sxy[j]; }
    for (let j = 0; j < A * A; j++) acc.sxx[j] += w * s.sxx[j];
  }
  // médias e covariâncias a partir das somas
  function moments(s) {
    const N = s.n, xb = Array.from(s.sx, v => v / N), yb = s.sy / N;
    const C = Array.from({ length: A }, () => new Array(A).fill(0)), c = new Array(A);
    for (let j = 0; j < A; j++) {
      c[j] = s.sxy[j] / N - xb[j] * yb;
      for (let k = j; k < A; k++) { const v = s.sxx[j * A + k] / N - xb[j] * xb[k]; C[j][k] = v; C[k][j] = v; }
    }
    let varS = 0, covSy = 0;
    for (let j = 0; j < A; j++) { covSy += c[j]; for (let k = 0; k < A; k++) varS += C[j][k]; }
    return { N, xb, yb, C, c, varY: s.syy / N - yb * yb, varS, covSy };
  }
  // (C + τI) β = c + τ β0
  function ridgeToward(m, tau, beta0) {
    const M = m.C.map((r, j) => r.map((v, k) => v + (j === k ? tau : 0)));
    return solve(M, m.c.map((v, j) => v + tau * beta0[j]));
  }
  const quad = (C, b) => { let s = 0; for (let j = 0; j < A; j++) for (let k = 0; k < A; k++) s += b[j] * C[j][k] * b[k]; return s; };

  /* ---------- preparação: vetores de pontos por ação e dia ----------
     hist: { SYM: bars[] } só com barras de sessões fechadas (a barra do dia em curso fica de fora). */
  function prepare(hist) {
    const syms = Object.keys(hist).filter(s => hist[s] && hist[s].length >= WARMUP + 40);
    const per = {}, dateSet = new Set();
    for (const sym of syms) {
      const S = E.seriesAll(hist[sym]), rows = [];
      for (let i = WARMUP; i < S.N; i++) {
        const sc = E.scoreIndicators(E.indAt(S, i), 0);
        const r = i + H < S.N ? S.c[i + H] / S.c[i] - 1 : null;
        if (!sc.vec.every(isFinite)) continue;
        rows.push({ sym, date: S.dates[i], x: sc.vec, hand: sc.score, r: r != null && isFinite(r) && Math.abs(r) < 5 ? r : null });
        dateSet.add(S.dates[i]);
      }
      per[sym] = rows;
    }
    const dates = [...dateSet].sort(), di = new Map(dates.map((d, k) => [d, k]));
    const byDate = dates.map(() => []);
    for (const sym of syms) for (const row of per[sym]) { row.d = di.get(row.date); byDate[row.d].push(row); }
    // alvo: retorno a 20 dias em excesso da média das ações nesse dia (a direção do mercado fica para o filtro de regime)
    for (const g of byDate) {
      const kn = g.filter(r => r.r != null), ok = kn.length >= MIN_PEERS, m = ok ? mean(kn.map(r => r.r)) : 0;
      for (const r of g) r.ex = ok && r.r != null ? r.r - m : null;
    }
    const stats = byDate.map(g => { const s = newStats(); for (const r of g) if (r.ex != null) addRow(s, r.x, r.ex, 1); return s; });
    return { syms, dates, byDate, per, stats };
  }

  /* ---------- ajuste numa data: usa só linhas cujo resultado a 20 dias já é conhecido até 'hi' ---------- */
  function fitAt(P, hi, cfg) {
    const lo = Math.max(0, hi - WINDOW + 1), rho = cfg.hl ? Math.pow(0.5, 1 / cfg.hl) : 1;
    const acc = newStats();
    for (let d = lo; d <= hi; d++) if (P.stats[d].n) addStats(acc, P.stats[d], Math.pow(rho, hi - d));
    if (acc.n < 200) return null;
    const m = moments(acc);
    const c0 = m.varS > 0 ? Math.max(0, m.covSy / m.varS) : 0;           // quanto a pontuação original prevê (≥ 0)
    const nEff = acc.n / H;                                                 // observações quase independentes
    const tau = m.varS / (nEff * IC0 * IC0);
    const beta = ridgeToward(m, tau, new Array(A).fill(c0));               // prior = pesos originais
    const vp = quad(m.C, beta), k = vp > 1e-18 ? Math.sqrt(m.varS / vp) : 0; // mesma dispersão da pontuação original
    const Sbar = m.xb.reduce((a, v) => a + v, 0);
    const model = { cfg: cfg.id, hi, date: P.dates[hi], xb: m.xb, Sbar, k, beta, c0, tau, nEff, betaSym: {} };
    if (isFinite(cfg.kappa)) {
      for (const sym of P.syms) {
        const s = newStats();
        for (const r of P.per[sym]) if (r.ex != null && r.d >= lo && r.d <= hi) addRow(s, r.x, r.ex, Math.pow(rho, hi - r.d));
        if (s.n < 120) continue;
        const ms = moments(s);
        const tauS = cfg.kappa * m.varS / ((s.n / H) * IC0 * IC0);
        model.betaSym[sym] = ridgeToward(ms, tauS, beta);                   // prior = pesos comuns
      }
    }
    return model;
  }

  // pontuação adaptativa de um vetor de pontos (mesma escala da original)
  function scoreVec(model, sym, x, news = 0) {
    const b = (model.betaSym && model.betaSym[sym]) || model.beta;
    const mult = b.map(v => model.k * v);
    let s = model.Sbar;
    for (let j = 0; j < A; j++) s += mult[j] * (x[j] - model.xb[j]);
    const base = model.Sbar - mult.reduce((a, m, j) => a + m * model.xb[j], 0);
    return { score: Math.round(Math.max(-100, Math.min(100, s + news))), raw: s, mult, base, perStock: !!(model.betaSym && model.betaSym[sym]) };
  }

  /* ---------- validação walk-forward: cada teste usa só dados anteriores (com 20 sessões de intervalo) ---------- */
  function validate(P, opts = {}) {
    const buyT = opts.buy ?? 35, sellT = opts.sell ?? -35, onProgress = opts.onProgress || (() => {});
    const first = MIN_TRAIN + H + 1, tests = [];
    for (let t = first; t < P.dates.length; t += STEP) {
      const g = P.byDate[t].filter(r => r.ex != null);
      if (g.length >= MIN_PEERS) tests.push(t);
    }
    if (tests.length < 8) return { ok: false, reason: 'Histórico insuficiente para validar (são precisos ~2 anos depois do aquecimento de 1 ano).' };
    const hand = { ic: [], buy: [], sell: [] };
    const res = Object.fromEntries(CONFIGS.map(c => [c.id, { ic: [], buy: [], sell: [] }]));
    tests.forEach((t, k) => {
      if (k % 5 === 0) onProgress(`Pontuação adaptativa: teste ${k + 1}/${tests.length}…`);
      const g = P.byDate[t].filter(r => r.ex != null), ex = g.map(r => r.ex);
      const hs = g.map(r => r.hand);
      hand.ic.push(spearman(hs, ex));
      g.forEach((r, i) => { if (hs[i] >= buyT) hand.buy.push(r.ex); if (hs[i] <= sellT) hand.sell.push(r.ex); });
      const fitted = {};
      for (const cfg of CONFIGS) {
        // os modelos com a mesma meia-vida partilham o ajuste comum; o por-ação é calculado por cima
        const key = cfg.hl + '|' + cfg.kappa;
        fitted[key] = fitted[key] || fitAt(P, t - H - 1, cfg);
        const m = fitted[key];
        const sc = m ? g.map(r => scoreVec(m, r.sym, r.x).raw) : hs;
        const o = res[cfg.id];
        o.ic.push(spearman(sc, ex));
        g.forEach((r, i) => { if (sc[i] >= buyT) o.buy.push(r.ex); if (sc[i] <= sellT) o.sell.push(r.ex); });
      }
    });
    const bucket = a => ({ n: a.length, ex: a.length ? mean(a) : null });
    const handOut = { ic: mean(hand.ic), t: tNW(hand.ic), buy: bucket(hand.buy), sell: bucket(hand.sell) };
    const cfgOut = CONFIGS.map(c => {
      const o = res[c.id], d = o.ic.map((v, i) => v - hand.ic[i]);
      return { id: c.id, name: c.name, ic: mean(o.ic), t: tNW(o.ic), dIC: mean(d), dT: tNW(d), hit: mean(d.map(v => v > 0 ? 1 : 0)), buy: bucket(o.buy), sell: bucket(o.sell) };
    });
    const best = [...cfgOut].sort((a, b) => b.ic - a.ic)[0];
    const active = best.ic > 0 && best.dIC > 0 && best.dT >= 2;
    return {
      ok: true, build: BUILD, date: P.dates[P.dates.length - 1], tests: tests.length, from: P.dates[tests[0]], to: P.dates[tests[tests.length - 1]],
      universe: P.syms.length, hand: handOut, configs: cfgOut, best: best.id, active,
      icSeries: { dates: tests.map(t => P.dates[t]), hand: hand.ic, best: res[best.id].ic },
      reason: active
        ? `${best.name}: IC ${best.ic.toFixed(3).replace('.', ',')} vs original ${handOut.ic.toFixed(3).replace('.', ',')} (melhoria com t=${best.dT.toFixed(1).replace('.', ',')} em ${tests.length} testes).`
        : best.dIC <= 0
          ? `Nenhuma variante previu melhor do que a pontuação original fora da amostra (melhor: ${best.name}, IC ${best.ic.toFixed(3).replace('.', ',')} vs ${handOut.ic.toFixed(3).replace('.', ',')}).`
          : `A melhor variante (${best.name}) previu um pouco melhor (IC ${best.ic.toFixed(3).replace('.', ',')} vs ${handOut.ic.toFixed(3).replace('.', ',')}), mas sem significância (t=${best.dT.toFixed(1).replace('.', ',')}; exige ≥ 2).`
    };
  }

  // ajuste de hoje: todas as linhas cujo resultado a 20 dias já é conhecido
  function fitNow(P, cfgId) {
    const cfg = CONFIGS.find(c => c.id === cfgId) || CONFIGS[0];
    let hi = P.dates.length - 1;
    while (hi > 0 && !P.stats[hi].n) hi--;
    const m = fitAt(P, hi, cfg);
    if (m) { m.cfgName = cfg.name; m.asOf = P.dates[P.dates.length - 1]; m.universe = P.syms.length; }
    return m;
  }

  const api = { BUILD, CONFIGS, prepare, validate, fitNow, fitAt, scoreVec, H, WINDOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Adaptive = api;
})(typeof self !== 'undefined' ? self : this);
