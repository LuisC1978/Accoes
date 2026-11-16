/* Radar de risco de setor: mede a fragilidade de um grupo de ações (amplitude, divergência, distribuição,
   volatilidade, correlação, quebra de tendência) e testa contra o histórico o que aconteceu depois de cada nível.
   Os pesos são fixos (não são ajustados aos dados), por isso todo o histórico serve de teste.
   Sem dependências. Browser (window.Risk) e Node (require). */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.Engine;

  const H = 20;        // horizonte (sessões) em que se mede a queda seguinte
  const WARM = 252;    // sessões de aquecimento (EMA200 e máximo de 52 semanas do índice do grupo)
  const MINM = 3;      // mínimo de ações por grupo
  const SPARK = 500;   // sessões guardadas para o gráfico
  const levelOf = s => s >= 60 ? 'Alto' : s >= 40 ? 'Elevado' : s >= 20 ? 'Moderado' : 'Baixo';
  const LEVELS = ['Baixo', 'Moderado', 'Elevado', 'Alto'];

  const DEFAULT_GROUPS = [
    'Semicondutores: NVDA, AVGO, MRVL, AMD, TSM, MU, QCOM, ARM, AMAT, LRCX, ALAB, SIMO, WDC, STX',
    'Infraestrutura IA: NBIS, CRWV, APLD, IREN, VRT, PWR, ETN, GEV, ANET, P',
    'Energia nuclear: CEG, VST, OKLO, SMR',
    'Software: NOW, PLTR, META',
    'Quântica: IONQ, RGTI, QBTS'
  ].join('\n');

  function parseGroups(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
      const k = line.indexOf(':'); if (k < 1) continue;
      const name = line.slice(0, k).trim();
      // os tickers PSI20 têm ':' (GALP:XLIS): separar só por vírgulas/espaços depois do primeiro ':'
      const syms = line.slice(k + 1).split(/[,\s;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      if (name && syms.length) out[name] = [...new Set(syms)];
    }
    return out;
  }

  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const variance = a => { const m = mean(a); return mean(a.map(x => (x - m) ** 2)); };
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const r3 = v => v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000;

  /* members: [{sym, S}] com S = Engine.seriesAll(bars). ref: Map(data → nível do índice de mercado) opcional. */
  function analyseGroup(name, members, ref) {
    members = members.filter(m => m.S && m.S.N >= 60);
    if (members.length < MINM) return null;
    const M = members.length, count = new Map();
    for (const m of members) for (const d of m.S.dates) count.set(d, (count.get(d) || 0) + 1);
    const need = Math.max(MINM, Math.ceil(M * 0.5));
    const dates = [...count.keys()].filter(d => count.get(d) >= need).sort();
    const T = dates.length;
    if (T < 80) return null;
    const pos = members.map(m => { const p = new Map(); m.S.dates.forEach((d, i) => p.set(d, i)); return p; });

    // ---- séries do grupo ----
    const ret = new Array(T).fill(0), idx = new Array(T).fill(100), breadth = new Array(T).fill(null), hot = new Array(T).fill(null),
      volp = new Array(T).fill(null), relVol = new Array(T).fill(null), rows = new Array(T);
    for (let t = 0; t < T; t++) {
      const d = dates[t], row = new Array(M).fill(null), rs = [], vp = [], rv = [];
      let a50 = 0, n50 = 0, h = 0, nR = 0;
      for (let j = 0; j < M; j++) {
        const i = pos[j].get(d); if (i == null || i < 1) continue;
        const S = members[j].S, r = S.c[i] / S.c[i - 1] - 1;
        if (!isFinite(r)) continue;
        row[j] = r; rs.push(r);
        if (S.e50[i] != null) { n50++; if (S.c[i] > S.e50[i]) a50++; }
        if (S.rsi[i] != null) { nR++; if (S.rsi[i] > 70) h++; }
        if (S.atr[i] != null) vp.push(S.atr[i] / S.c[i]);
        if (S.volAvg[i] > 0 && S.vol[i] > 0) rv.push(S.vol[i] / S.volAvg[i]);
      }
      rows[t] = row;
      ret[t] = t === 0 ? 0 : mean(rs);
      idx[t] = t === 0 ? 100 : idx[t - 1] * (1 + ret[t]);
      breadth[t] = n50 >= MINM ? a50 / n50 : null;
      hot[t] = nR >= MINM ? h / nR : null;
      volp[t] = vp.length >= MINM ? mean(vp) : null;
      relVol[t] = rv.length >= MINM ? median(rv) : null;
    }
    const e13 = E.ema(idx, 13), e50 = E.ema(idx, 50), e200 = E.ema(idx, 200);
    const hi = new Array(T), sig60 = new Array(T).fill(null), volAvg = new Array(T).fill(null), corr = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
      let h = -Infinity; for (let k = Math.max(0, t - 251); k <= t; k++) if (idx[k] > h) h = idx[k];
      hi[t] = h;
      if (t >= 60) sig60[t] = Math.sqrt(variance(ret.slice(t - 59, t + 1)));
      if (t >= 60) { const w = volp.slice(t - 59, t + 1).filter(x => x != null); volAvg[t] = w.length >= 30 ? mean(w) : null; }
      if (t >= 20) { // correlação média entre membros (20 sessões), pela razão entre a variância do índice e a variância média
        const ok = []; for (let j = 0; j < M; j++) { let full = true; for (let k = t - 19; k <= t; k++) if (rows[k][j] == null) { full = false; break; } if (full) ok.push(j); }
        if (ok.length >= MINM) {
          const vs = ok.map(j => { const a = []; for (let k = t - 19; k <= t; k++) a.push(rows[k][j]); return variance(a); });
          const im = []; for (let k = t - 19; k <= t; k++) im.push(mean(ok.map(j => rows[k][j])));
          const v = mean(vs), n = ok.length;
          if (v > 0) corr[t] = Math.max(-1, Math.min(1, (n * variance(im) / v - 1) / (n - 1)));
        }
      }
    }
    const distDays = t => { let c = 0; for (let k = Math.max(61, t - 24); k <= t; k++) if (sig60[k] != null && ret[k] <= -0.5 * sig60[k] && (relVol[k] == null || relVol[k] >= 1.05)) c++; return c; };
    const rel20 = t => {
      if (!ref || t < 20) return null;
      const a = ref.get(dates[t]), b = ref.get(dates[t - 20]);
      return a && b ? (idx[t] / idx[t - 20]) - (a / b) : null;
    };

    // ---- sinais e pontuação no dia t (só dados até t) ----
    function signals(t) {
      const out = [], add = (id, pts, txt) => out.push({ id, pts, txt });
      const pct = (v, d = 0) => (v * 100).toFixed(d).replace('.', ',') + '%';
      if (e50[t] != null && idx[t] < e50[t]) add('abaixo50', 10, `Índice do grupo ${pct(1 - idx[t] / e50[t], 1)} abaixo da EMA50`);
      if (e13[t] != null && e50[t] != null && e13[t] < e50[t]) add('cruz13', 5, 'EMA13 do grupo abaixo da EMA50');
      if (e200[t] != null && idx[t] < e200[t]) add('abaixo200', 5, 'Índice do grupo abaixo da EMA200');
      if (breadth[t] != null && breadth[t] < 0.4) add('amplitude', 10, `Amplitude fraca: só ${pct(breadth[t])} das ações acima da EMA50`);
      if (t >= 10 && breadth[t] != null && breadth[t - 10] != null && breadth[t] - breadth[t - 10] <= -0.25) add('amplitudeCai', 10, `Amplitude caiu ${Math.round((breadth[t - 10] - breadth[t]) * 100)} pontos percentuais em 10 sessões`);
      if (breadth[t] != null && idx[t] >= hi[t] * 0.95 && breadth[t] < 0.55) add('divergencia', 15, `Divergência: índice perto do máximo mas só ${pct(breadth[t])} das ações acima da EMA50`);
      const dd = distDays(t);
      if (dd >= 7) add('distribuicao', 15, `${dd} dias de distribuição em 25 sessões (quedas com volume acima da média)`);
      else if (dd >= 5) add('distribuicao', 10, `${dd} dias de distribuição em 25 sessões (quedas com volume acima da média)`);
      if (volp[t] != null && volAvg[t]) { const q = volp[t] / volAvg[t]; if (q >= 1.5) add('volatilidade', 15, `Volatilidade ${q.toFixed(1).replace('.', ',')}× a média de 60 sessões`); else if (q >= 1.25) add('volatilidade', 10, `Volatilidade ${q.toFixed(1).replace('.', ',')}× a média de 60 sessões`); }
      if (corr[t] != null && corr[t - 20] != null && corr[t] >= 0.55 && corr[t] - corr[t - 20] >= 0.15) add('correlacao', 10, `Correlação entre as ações subiu para ${corr[t].toFixed(2).replace('.', ',')} (movem-se em bloco)`);
      if (e200[t] != null && idx[t] / e200[t] - 1 >= 0.35) add('esticado', 5, `Índice ${pct(idx[t] / e200[t] - 1)} acima da EMA200 (esticado)`);
      if (hot[t] != null && hot[t] >= 0.5) add('sobrecompra', 5, `${pct(hot[t])} das ações com RSI acima de 70`);
      const rl = rel20(t);
      if (rl != null && rl <= -0.06) add('fraquezaRel', 10, `Rendeu ${pct(-rl, 1)} menos do que o mercado em 20 sessões`);
      if (t >= 5 && sig60[t] != null && idx[t] / idx[t - 5] - 1 <= -1.5 * sig60[t] * Math.sqrt(5)) add('choque', 10, `Queda rápida: ${pct(idx[t] / idx[t - 5] - 1, 1)} em 5 sessões`);
      return out;
    }
    const start = Math.min(T - 1, Math.max(WARM, 200));
    const score = new Array(T).fill(null), sigs = new Array(T).fill(null);
    for (let t = start; t < T; t++) { sigs[t] = signals(t); score[t] = Math.min(100, sigs[t].reduce((s, x) => s + x.pts, 0)); }

    // ---- teste histórico ----
    const L = T - 1;
    let bt = null;
    if (T - start >= 120) {
      const obs = [];
      for (let t = start; t < T - H; t++) {
        let mn = Infinity; for (let k = 1; k <= H; k++) if (idx[t + k] < mn) mn = idx[t + k];
        obs.push({ t, dd: mn / idx[t] - 1, r: idx[t + H] / idx[t] - 1, s: score[t] });
      }
      // limiar de "queda grande": de uma lista fixa, o que tem frequência histórica mais próxima de 20%
      let thr = 0.10, bestGap = Infinity;
      for (const c of [0.05, 0.075, 0.10, 0.15, 0.20]) { const p = mean(obs.map(o => o.dd <= -c ? 1 : 0)); if (Math.abs(p - 0.2) < bestGap) { bestGap = Math.abs(p - 0.2); thr = c; } }
      const ev = o => o.dd <= -thr ? 1 : 0;
      const base = { n: obs.length, p: mean(obs.map(ev)), dd: mean(obs.map(o => o.dd)), r: mean(obs.map(o => o.r)) };
      const levels = LEVELS.map(k => { const g = obs.filter(o => levelOf(o.s) === k); return { level: k, n: g.length, share: g.length / obs.length, p: g.length ? mean(g.map(ev)) : null, dd: g.length ? mean(g.map(o => o.dd)) : null, r: g.length ? mean(g.map(o => o.r)) : null }; });
      const hiG = obs.filter(o => o.s >= 40), loG = obs.filter(o => o.s < 40);
      const ids = {}; for (let t = start; t < T - H; t++) for (const s of sigs[t]) (ids[s.id] = ids[s.id] || []).push(t);
      const byT = new Map(obs.map(o => [o.t, o]));
      const NAMES = { abaixo50: 'Índice abaixo da EMA50', cruz13: 'EMA13 abaixo da EMA50', abaixo200: 'Índice abaixo da EMA200', amplitude: 'Amplitude fraca (<40%)', amplitudeCai: 'Amplitude a cair depressa', divergencia: 'Divergência índice/amplitude', distribuicao: 'Dias de distribuição', volatilidade: 'Volatilidade a expandir', correlacao: 'Correlação a subir', esticado: 'Esticado acima da EMA200', sobrecompra: 'Sobrecompra generalizada', fraquezaRel: 'Fraqueza face ao mercado', choque: 'Queda rápida em 5 sessões' };
      const signalLift = Object.keys(ids).map(id => { const g = ids[id].map(t => byT.get(t)); const p = mean(g.map(ev)); return { id, name: NAMES[id] || id, n: g.length, p, lift: base.p > 0 ? p / base.p : null }; }).sort((a, b) => (b.lift || 0) - (a.lift || 0));

      // episódios: quedas ≥ 1,5× o limiar desde um pico
      const EP = Math.max(0.10, 1.5 * thr), episodes = [];
      let peak = idx[start], pi = start, cur = null;
      const close = () => {
        let at = null; for (let t = Math.max(start, cur.pi - 10); t <= cur.ti; t++) if (score[t] >= 40) { at = t; break; }
        episodes.push({ peak: dates[cur.pi], trough: dates[cur.ti], depth: cur.trough / cur.peak - 1,
          alert: at != null ? dates[at] : null, atDrop: at != null ? Math.min(0, idx[at] / cur.peak - 1) : null, after: at != null ? cur.trough / idx[at] - 1 : null,
          early: at != null && idx[at] / cur.peak - 1 > -0.05, open: cur.open || false });
      };
      for (let t = start + 1; t < T; t++) {
        if (!cur) { if (idx[t] > peak) { peak = idx[t]; pi = t; } else if (idx[t] / peak - 1 <= -EP) cur = { pi, peak, ti: t, trough: idx[t] }; }
        else {
          if (idx[t] < cur.trough) { cur.trough = idx[t]; cur.ti = t; }
          if (idx[t] >= cur.peak * (1 - EP / 3)) { close(); cur = null; peak = idx[t]; pi = t; }
        }
      }
      if (cur) { cur.open = true; close(); }
      const al = episodes.filter(e => e.alert);
      bt = { thr, ep: EP, base, levels, signalLift, episodes,
        hi: { n: hiG.length, p: hiG.length ? mean(hiG.map(ev)) : null }, lo: { n: loG.length, p: loG.length ? mean(loG.map(ev)) : null },
        epSummary: { n: episodes.length, alerted: al.length, early: episodes.filter(e => e.early).length, atDrop: al.length ? mean(al.map(e => e.atDrop)) : null, after: al.length ? mean(al.map(e => e.after)) : null },
        from: dates[start], to: dates[T - 1 - H] };
      // O radar distinguiu? Compara a frequência de quedas grandes com risco ≥ Elevado e com risco mais baixo.
      // As janelas de 20 sessões sobrepõem-se, por isso o nº efetivo de observações independentes é ≈ n / 20.
      const n1 = bt.hi.n / H, n2 = bt.lo.n / H, pp = base.p;
      const lift = bt.lo.p > 0 && bt.hi.p != null ? bt.hi.p / bt.lo.p : null;
      const z = n1 > 0 && n2 > 0 && pp > 0 && pp < 1 ? (bt.hi.p - bt.lo.p) / Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2)) : 0;
      bt.lift = lift; bt.z = z;
      bt.verdict = lift != null && lift >= 1.5 && z >= 2 ? 'forte' : lift != null && lift >= 1.3 && z >= 0.8 ? 'indicios' : 'nulo';
    }

    const hist = score.slice(start, L).filter(x => x != null);
    const sc = score[L] ?? 0, lv = levelOf(sc), lvStat = bt ? bt.levels.find(x => x.level === lv) : null;
    const s0 = Math.max(0, T - SPARK);
    return {
      name, asOf: dates[L], nMembers: M, few: M < 5,
      score: sc, level: lv, signals: sigs[L] || [], pctile: hist.length ? hist.filter(x => x <= sc).length / hist.length : null,
      prev5: score[L - 5] ?? null,
      vals: { breadth: r3(breadth[L]), vsE50: e50[L] ? r3(idx[L] / e50[L] - 1) : null, vsE200: e200[L] ? r3(idx[L] / e200[L] - 1) : null, fromHigh: r3(idx[L] / hi[L] - 1),
        volRatio: volp[L] != null && volAvg[L] ? r3(volp[L] / volAvg[L]) : null, corr: r3(corr[L]), dist: distDays(L), r5: L >= 5 ? r3(idx[L] / idx[L - 5] - 1) : null, r20: L >= 20 ? r3(idx[L] / idx[L - 20] - 1) : null },
      expect: lvStat && lvStat.n >= 20 ? { p: lvStat.p, dd: lvStat.dd, n: lvStat.n, thr: bt.thr, base: bt.base.p } : null,
      members: members.map((m, j) => { const i = pos[j].get(dates[L]); if (i == null) return { sym: m.sym, stale: true }; const S = m.S; return { sym: m.sym, vsE50: S.e50[i] ? r3(S.c[i] / S.e50[i] - 1) : null, rsi: S.rsi[i] != null ? Math.round(S.rsi[i]) : null, r20: i >= 20 ? r3(S.c[i] / S.c[i - 20] - 1) : null }; }),
      bt,
      spark: { dates: [dates[s0], dates[L]], idx: idx.slice(s0).map(v => Math.round(v * 10) / 10), e50: e50.slice(s0).map(v => v == null ? null : Math.round(v * 10) / 10), score: score.slice(s0) },
      _idxByDate: new Map(dates.map((d, t) => [d, idx[t]]))
    };
  }

  /* groups: {nome: [tickers]}; series: {ticker: S}. Acrescenta "Mercado EUA" (todos sem ':') e "PSI20" (todos ':XLIS'). */
  function analyse(groups, series) {
    const have = s => series[s] && series[s].N >= 60;
    const all = Object.keys(series).filter(have);
    const us = all.filter(s => !s.includes(':') && !s.includes('/')), pt = all.filter(s => s.endsWith(':XLIS'));
    const out = [], missing = {};
    const mk = (name, syms, ref) => analyseGroup(name, syms.filter(have).map(sym => ({ sym, S: series[sym] })), ref);
    const market = us.length >= 5 ? mk('Mercado EUA', us, null) : null;
    const ref = market ? market._idxByDate : null;
    for (const [name, syms] of Object.entries(groups)) {
      missing[name] = syms.filter(s => !have(s));
      const g = mk(name, syms, syms.every(s => !s.includes(':')) ? ref : null);
      if (g) out.push(g);
    }
    if (pt.length >= MINM && !groups.PSI20) { const g = mk('PSI20', pt, null); if (g) out.push(g); }
    if (market) out.push(market);
    for (const g of out) delete g._idxByDate;
    out.sort((a, b) => b.score - a.score);
    const bySym = {};
    for (const g of out) for (const m of g.members) { const c = bySym[m.sym]; if (!c || g.score > c.score) bySym[m.sym] = { name: g.name, score: g.score, level: g.level, verdict: g.bt ? g.bt.verdict : 'nulo' }; }
    return { computedAt: new Date().toISOString().slice(0, 10), asOf: out.length ? out.map(g => g.asOf).sort().pop() : null, groups: out, bySym, missing };
  }

  const api = { analyse, analyseGroup, parseGroups, levelOf, DEFAULT_GROUPS, LEVELS, H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Risk = api;
})(typeof self !== 'undefined' ? self : this);
