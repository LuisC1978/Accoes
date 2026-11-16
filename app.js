'use strict';
const $ = s => document.querySelector(s);
const E = window.Engine;
const BASE = 'EUR';

// ---------- Estado ----------
const DEF = {
  settings: { tdKey: '', fhKey: '', cash: 0, riskPct: 1, maxPosPct: 20, maxLossPct: 15, buyThreshold: 35, sellThreshold: -35, takeProfitPct: 25, riskAdjust: true },
  groups: window.Risk.DEFAULT_GROUPS,
  portfolio: [],
  watchlist: 'NBIS, PWR, P, CRWV, A, NVDA, AVGO, MRVL, WDC, VRT, NOW, CEG, OKLO, IONQ, RGTI, APLD, META, GALP:XLIS, EDP:XLIS, JMT:XLIS'
};
function load() {
  try { const s = JSON.parse(localStorage.getItem('acc_state')); if (s) return { ...DEF, ...s, settings: { ...DEF.settings, ...s.settings } }; } catch (e) {}
  return JSON.parse(JSON.stringify(DEF));
}
let S = load();
const save = () => { try { localStorage.setItem('acc_state', JSON.stringify(S)); } catch (e) {} };
const results = {}; // sym -> {ind, sc, dec, meta, news}
let lastPrompt = { title: '', text: '' };

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (v, d = 2) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
const cur = c => ({ USD: '$', EUR: '€', GBP: '£' }[c] || (c || ''));
const status = t => { $('#status').textContent = t || ''; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- API Twelve Data (8 pedidos/min no plano grátis) ----------
const calls = [];
async function throttle() {
  const now = Date.now();
  while (calls.length && now - calls[0] > 61000) calls.shift();
  if (calls.length >= 8) {
    const wait = 61000 - (now - calls[0]) + 300;
    status(`Limite grátis: a aguardar ${Math.ceil(wait / 1000)}s…`);
    await new Promise(r => setTimeout(r, wait));
    return throttle();
  }
  calls.push(Date.now());
}
function parseSym(raw) {
  const [symbol, mic] = raw.trim().toUpperCase().split(':');
  return { symbol, mic };
}
// Cache de séries em IndexedDB (~1000 barras por ação não cabem em localStorage)
const IDB = (() => {
  const mem = new Map(); let dbp = null;
  const open = () => dbp || (dbp = new Promise(res => {
    try { const r = indexedDB.open('accoes', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }
    catch (e) { res(null); }
  }));
  const tx = async (mode, fn) => { const db = await open(); if (!db) return null; return new Promise(res => { const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => res(null); }); };
  return {
    get: async k => mem.has(k) ? mem.get(k) : (await tx('readonly', s => s.get(k))) ?? null,
    set: async (k, v) => { mem.set(k, v); await tx('readwrite', s => s.put(v, k)); },
    clear: async () => { mem.clear(); await tx('readwrite', s => s.clear()); }
  };
})();
async function tdSeries(raw, size = 1000) {
  const key = 'c_' + raw + '_' + size;
  try { const c = await IDB.get(key); if (c && c.day === today()) return c; } catch (e) {}
  if (!S.settings.tdKey) throw new Error('Falta a chave Twelve Data (Definições).');
  const { symbol, mic } = parseSym(raw);
  const u = new URL('https://api.twelvedata.com/time_series');
  u.search = new URLSearchParams({ symbol, interval: '1day', outputsize: size, apikey: S.settings.tdKey, ...(mic ? { mic_code: mic } : {}) });
  await throttle();
  const r = await fetch(u); const j = await r.json();
  if (j.status !== 'ok') throw new Error(j.message || 'Erro Twelve Data');
  const bars = j.values.map(v => ({ datetime: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0) })).reverse();
  const out = { day: today(), bars, meta: j.meta };
  await IDB.set(key, out);
  return out;
}
const fxCache = {};
async function fxRate(c) {
  if (!c || c === BASE) return 1;
  if (fxCache[c]) return fxCache[c];
  const d = await tdSeries(`${c}/${BASE}`, 2);
  return (fxCache[c] = d.bars[d.bars.length - 1].close);
}
async function news(raw) {
  if (!S.settings.fhKey || raw.includes(':') || raw.includes('/')) return [];
  const key = 'acc_n_' + raw;
  try { const c = JSON.parse(localStorage.getItem(key)); if (c && c.day === today()) return c.items; } catch (e) {}
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  try {
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(raw)}&from=${from}&to=${today()}&token=${S.settings.fhKey}`);
    const j = await r.json();
    const items = Array.isArray(j) ? j.slice(0, 12).map(n => ({ headline: n.headline, source: n.source, url: n.url, t: n.datetime })) : [];
    try { localStorage.setItem(key, JSON.stringify({ day: today(), items })); } catch (e) {}
    return items;
  } catch (e) { return []; }
}
function clearCache() {
  Object.keys(localStorage).filter(k => k.startsWith('acc_c_') || k.startsWith('acc_n_')).forEach(k => localStorage.removeItem(k));
  IDB.clear();
}
// limpa a cache antiga (versão 1) de localStorage, que ocupava espaço
Object.keys(localStorage).filter(k => k.startsWith('acc_c_')).forEach(k => localStorage.removeItem(k));

// ---------- Modelo histórico ----------
let MODEL = null;
try { MODEL = JSON.parse(localStorage.getItem('acc_model')); } catch (e) {}
// só um modelo com validação estatisticamente significativa ("moderado") mexe nas decisões
const modelUsable = () => MODEL && MODEL.verdict === 'moderado';

// ---------- Análise ----------
async function analyse(raw) {
  const d = await tdSeries(raw);
  if (d.bars.length < 60) throw new Error('Histórico insuficiente');
  const ind = E.computeIndicators(d.bars);
  const nw = await news(raw);
  const ns = E.newsSentiment(nw);
  const sc = E.scoreIndicators(ind, ns.score);
  const fx = await fxRate(d.meta.currency);
  const fc = MODEL ? window.Model.forecast(MODEL, ind.S) : null;
  const bs = MODEL ? window.Model.bucketStats(MODEL, sc.score) : null;
  return { ind, sc, meta: d.meta, news: nw, ns, fx, fc, bs };
}
function modelOverlay(sym, r) {
  const d = r.dec; if (!d || !MODEL) return;
  const pct = v => (v >= 0 ? '+' : '') + fmt(v * 100, 1) + '%';
  if (r.bs && r.bs.n >= 30) d.reasons.push(`Histórico (3 anos, ${MODEL.universe.length} ações): com pontuação ${r.bs.range}, o retorno médio a 20 dias foi ${pct(r.bs.mean)} e subiu em ${fmt(r.bs.up * 100, 0)}% dos casos (n=${r.bs.n}).`);
  if (!r.fc) return;
  const h = r.fc.hist;
  d.reasons.push(`Modelo 20d: quintil ${r.fc.quintile}/5${modelUsable() ? '' : ' (modelo sem poder preditivo validado — só indicativo)'}. No ano de validação, este quintil rendeu ${pct(h.r)} (${pct(h.ex)} vs universo) e subiu em ${fmt(h.up * 100, 0)}% dos casos.`);
  if (!modelUsable()) return;
  if (d.action === 'COMPRAR' && r.fc.quintile <= 2) {
    d.reasons.push('O modelo histórico é desfavorável (quintil baixo): compra suspensa até os dois concordarem.');
    d.action = 'SINAL COMPRA'; d.qty = 0; d.blockedBuy = true;
  }
  const pos = S.portfolio.find(p => p.sym === sym);
  if (pos && d.action === 'MANTER' && r.fc.quintile === 1 && r.sc.score < S.settings.buyThreshold)
    d.reasons.push('Atenção: modelo no quintil mais fraco — considerar reduzir ou apertar o stop.');
}
function portfolioValue() {
  let v = +S.settings.cash || 0, cost = 0;
  for (const p of S.portfolio) {
    const r = results[p.sym];
    if (r) { v += p.qty * r.ind.close * r.fx; cost += p.qty * p.avg * r.fx; }
  }
  return { v, cost };
}
function decideAll(syms) {
  const { v } = portfolioValue();
  for (const s of syms) {
    const r = results[s]; if (!r) continue;
    const pos = S.portfolio.find(p => p.sym === s);
    r.dec = E.decide(r.ind, r.sc, pos ? { qty: pos.qty, avgPrice: pos.avg } : null, { portfolioValue: v, cash: +S.settings.cash || 0, fx: r.fx }, S.settings);
    modelOverlay(s, r);
    riskOverlay(s, r);
  }
}
async function runList(syms, btn) {
  btn.disabled = true;
  const errs = [];
  for (let i = 0; i < syms.length; i++) {
    status(`A analisar ${syms[i]} (${i + 1}/${syms.length})…`);
    try { results[syms[i]] = await analyse(syms[i]); }
    catch (e) { errs.push(`${syms[i]}: ${e.message}`); if (/chave/i.test(e.message)) break; }
  }
  btn.disabled = false;
  status(errs.length ? `${errs.length} erro(s)` : 'Atualizado ' + new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }));
  if (errs.length) alert(errs.join('\n'));
}

// ---------- Radar de risco ----------
let RADAR = null;
try { RADAR = JSON.parse(localStorage.getItem('acc_radar')); } catch (e) {}
const pc = (v, d = 0) => v == null || isNaN(v) ? '—' : fmt(v * 100, d) + '%';
const pcs = (v, d = 1) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + fmt(v * 100, d) + '%';
const thrTxt = v => fmt(v * 100, (v * 1000) % 10 ? 1 : 0) + '%';
function radarUniverse() {
  const groups = window.Risk.parseGroups(S.groups);
  return { groups, syms: [...new Set([...S.portfolio.map(p => p.sym), ...watchSyms(), ...Object.values(groups).flat()])] };
}
// fetchAll=true descarrega o que faltar (gasta créditos); false usa só o que já está em cache
async function computeRadar(fetchAll, btn) {
  const { groups, syms } = radarUniverse(), series = {}, errs = [];
  const prog = t => { $('#rProg').textContent = t; if (fetchAll) status(t); };
  if (btn) btn.disabled = true;
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    try {
      if (results[s] && results[s].ind.S && !fetchAll) { series[s] = results[s].ind.S; continue; }
      if (fetchAll) prog(`A descarregar ${s} (${k + 1}/${syms.length})…`);
      const d = fetchAll ? await tdSeries(s, 1000) : await IDB.get('c_' + s + '_1000');
      if (d && d.bars && d.bars.length >= 60) series[s] = E.seriesAll(d.bars);
    } catch (e) { errs.push(`${s}: ${e.message}`); if (/chave/i.test(e.message)) break; }
  }
  if (btn) btn.disabled = false;
  if (Object.keys(series).length >= 3) {
    await new Promise(r => setTimeout(r, 30));
    const out = window.Risk.analyse(groups, series);
    if (out.groups.length) {
      RADAR = out;
      try { localStorage.setItem('acc_radar', JSON.stringify(RADAR)); } catch (e) {}
    }
  }
  if (fetchAll) {
    prog(RADAR && RADAR.groups.length ? `Radar atualizado com dados até ${RADAR.asOf}${errs.length ? ` · ${errs.length} erro(s)` : ''}.` : 'Dados insuficientes para o radar (são precisas pelo menos 3 ações por grupo).');
    if (errs.length) alert(errs.join('\n'));
    decideAll(Object.keys(results)); renderPortfolio(); renderTop();
  }
  renderRadar();
}
// um radar com mais de 4 dias não mexe nas decisões
const radarFresh = () => !!(RADAR && RADAR.computedAt && Date.now() - new Date(RADAR.computedAt).getTime() < 4 * 864e5);
const radarFor = sym => radarFresh() && RADAR.bySym ? RADAR.bySym[sym] : null;
function riskOverlay(sym, r) {
  const d = r.dec, g = radarFor(sym);
  r.risk = g || null;
  if (!d || !g || g.score < 40) return;
  const grp = RADAR.groups.find(x => x.name === g.name), ex = grp && grp.expect;
  d.reasons.push(`Radar de risco: ${g.name} em nível ${g.level.toUpperCase()} (${g.score}/100).` + (ex ? ` Neste nível, o grupo caiu ${thrTxt(ex.thr)} ou mais nas 20 sessões seguintes em ${pc(ex.p)} dos casos (referência: ${pc(ex.base)}).` : ''));
  if (!S.settings.riskAdjust) return;
  if (g.verdict === 'nulo') { d.reasons.push('No histórico deste grupo o radar não distinguiu as quedas: o aviso é só informativo e as quantidades não mudam.'); return; }
  const pos = S.portfolio.find(p => p.sym === sym);
  if (g.level === 'Alto') {
    if (d.action === 'COMPRAR') { d.action = 'SINAL COMPRA'; d.qty = 0; d.blockedBuy = true; d.reasons.push('Compra suspensa enquanto o risco do grupo estiver ALTO.'); }
    else if (pos && d.action === 'MANTER' && r.ind.atr) d.reasons.push(`Risco ALTO no grupo: considerar reduzir a posição ou subir o stop para 1,5×ATR (${fmt(r.ind.close - 1.5 * r.ind.atr)}).`);
  } else if (d.action === 'COMPRAR' && d.qty > 1) {
    d.qty = Math.max(1, Math.floor(d.qty / 2));
    d.reasons.push('Risco ELEVADO no grupo: quantidade reduzida a metade.');
  }
}
const riskChip = r => r.risk && r.risk.score >= 40 ? ` · risco ${esc(r.risk.name)}: <b class="${r.risk.level === 'Alto' ? 'neg' : ''}">${r.risk.level}</b>` : '';
function radarBanner() {
  if (!RADAR || !RADAR.groups || !RADAR.groups.length) return `<div class="card rb" data-go="risco"><b>🚨 Radar de risco</b> <span class="mut">por calcular. Toca para abrir.</span></div>`;
  const hot = RADAR.groups.filter(g => g.score >= 40);
  return `<div class="card rb" data-go="risco"><div class="row"><b>🚨 Radar de risco</b><span class="sp"></span><span class="mut">${radarFresh() ? `dados até ${esc(RADAR.asOf)}` : `desatualizado (${esc(RADAR.asOf)}): toca para atualizar`} ›</span></div>
    ${hot.length ? hot.map(g => `<span class="badge lv-${g.level}">${esc(g.name)} · ${g.level} ${g.score}</span>`).join('') : '<span class="mut">Sem grupos em risco elevado ou alto.</span>'}</div>`;
}
function renderRadar() {
  const b = radarBanner();
  $('#radarBanner1').innerHTML = b; $('#radarBanner2').innerHTML = b;
  const el = $('#rReport');
  if (!RADAR || !RADAR.groups || !RADAR.groups.length) { el.innerHTML = '<div class="card mut">Ainda sem radar. Toca em "Atualizar radar": descarrega o histórico da carteira, da watchlist e dos grupos (1 crédito por ação que ainda não esteja em cache hoje).</div>'; return; }
  const vt = { forte: ['pos', 'O radar distinguiu bem as quedas deste grupo no histórico.'], indicios: ['', 'Indícios favoráveis no histórico, mas a amostra é pequena.'], nulo: ['neg', 'No histórico deste grupo o radar não distinguiu as quedas. Usa-o só como informação.'] };
  el.innerHTML = RADAR.groups.map((g, k) => {
    const v = g.vals, bt = g.bt, ex = g.expect;
    const sig = g.signals.length ? `<ul class="r">${g.signals.map(s => `<li>${esc(s.txt)} <span class="mut">(+${s.pts})</span></li>`).join('')}</ul>` : '<div class="mut" style="margin:6px 0">Sem sinais de alerta ativos.</div>';
    let hist = '<div class="note">Histórico insuficiente para testar este grupo.</div>';
    if (bt) {
      const s = bt.epSummary;
      hist = `<div style="margin-top:10px"><b>Teste com o histórico (${esc(bt.from)} → ${esc(bt.to)})</b></div>
      <div class="${vt[bt.verdict][0]}" style="font-size:13px;margin:4px 0">${vt[bt.verdict][1]}</div>
      <div class="tw"><table><tr><th>Nível de risco</th><th>Dias</th><th>Queda ≥${thrTxt(bt.thr)} em 20 sessões</th><th>Pior queda média</th></tr>
      ${bt.levels.map(l => `<tr><td>${l.level}</td><td class="n">${pc(l.share)}</td><td class="n"><b>${l.n ? pc(l.p) : '—'}</b></td><td class="n">${l.n ? pcs(l.dd) : '—'}</td></tr>`).join('')}
      <tr><td><i>Qualquer dia</i></td><td></td><td class="n">${pc(bt.base.p)}</td><td class="n">${pcs(bt.base.dd)}</td></tr></table></div>
      <div class="note">Com risco Elevado ou Alto houve queda grande em ${pc(bt.hi.p)} dos casos, contra ${pc(bt.lo.p)} com risco mais baixo${bt.lift ? ` (${fmt(bt.lift, 1)}× mais)` : ''}. Significância z = ${fmt(bt.z, 1)} (abaixo de 2 pode ser acaso).</div>
      ${bt.episodes.length ? `<div style="margin-top:10px"><b>Quedas de ${thrTxt(bt.ep)} ou mais desde um pico</b></div>
      <div class="tw"><table><tr><th>Pico</th><th>Queda total</th><th>Primeiro alerta</th><th>Já tinha caído</th><th>Caiu depois</th></tr>
      ${bt.episodes.map(e => `<tr><td>${esc(e.peak)}</td><td class="n">${pcs(e.depth, 0)}${e.open ? ' (em curso)' : ''}</td><td class="n">${e.alert ? esc(e.alert) : 'sem alerta'}</td><td class="n">${e.alert ? pcs(e.atDrop) : '—'}</td><td class="n"><b>${e.alert ? pcs(e.after) : '—'}</b></td></tr>`).join('')}</table></div>
      <div class="note">${s.alerted} de ${s.n} quedas tiveram alerta (Elevado ou Alto); em média o alerta surgiu com o grupo ${pcs(s.atDrop)} abaixo do pico e a queda continuou mais ${pcs(s.after)}. Atenção: o alerta surge quase sempre depois de a queda começar, e isto acontece até com dados aleatórios. A tabela de cima é o teste mais sério.</div>` : '<div class="note">Sem quedas grandes neste período.</div>'}
      <div style="margin-top:10px"><b>Que sinais anteciparam quedas</b></div>
      <div class="tw"><table><tr><th>Sinal</th><th>Dias ativo</th><th>Queda grande a seguir</th><th>vs normal</th></tr>
      ${bt.signalLift.map(x => `<tr><td>${esc(x.name)}</td><td class="n">${x.n}</td><td class="n">${pc(x.p)}</td><td class="n"><b class="${x.lift >= 1.5 ? 'neg' : ''}">${x.lift == null ? '—' : fmt(x.lift, 1) + '×'}</b></td></tr>`).join('')}</table></div>`;
    }
    return `<div class="card">
      <div class="row"><span class="tick">${esc(g.name)}</span><span class="mut">${g.nMembers} ações</span><span class="sp"></span><span class="badge lv-${g.level}">${g.level.toUpperCase()} ${g.score}</span></div>
      <div class="rbar"><i style="left:${g.score}%"></i></div>
      <div class="mut">Há 5 sessões: ${g.prev5 ?? '—'} · ${g.pctile != null ? `mais alto do que em ${pc(g.pctile)} dos dias do histórico` : ''}${g.few ? ' · poucas ações: leitura menos fiável' : ''}</div>
      ${ex ? `<div class="entry">Com este nível, o grupo caiu <b>${thrTxt(ex.thr)} ou mais</b> nas 20 sessões seguintes em <b>${pc(ex.p)}</b> dos casos (num dia qualquer: ${pc(ex.base)}). Pior queda média: ${pcs(ex.dd)}.</div>` : ''}
      ${sig}
      <canvas class="rk" data-risk="${k}"></canvas>
      <div class="legend"><b style="background:#e6edf3"></b>Índice do grupo<b style="background:#f5b642"></b>EMA50<b style="background:#f5b64266;height:8px"></b>Risco elevado<b style="background:#ff5c5c77;height:8px"></b>Risco alto · ${esc(g.spark.dates[0])} → ${esc(g.spark.dates[1])}</div>
      <details><summary>Valores, teste histórico e ações do grupo</summary>
        <table>
          <tr><td>Ações acima da EMA50 (amplitude)</td><td>${pc(v.breadth)}</td></tr>
          <tr><td>Índice vs EMA50 / EMA200</td><td>${pcs(v.vsE50)} / ${pcs(v.vsE200)}</td></tr>
          <tr><td>Distância ao máximo de 52 semanas</td><td>${pcs(v.fromHigh)}</td></tr>
          <tr><td>Retorno 5 / 20 sessões</td><td>${pcs(v.r5)} / ${pcs(v.r20)}</td></tr>
          <tr><td>Volatilidade vs média de 60 sessões</td><td>${v.volRatio == null ? '—' : fmt(v.volRatio, 2) + '×'}</td></tr>
          <tr><td>Correlação média entre ações (20 sessões)</td><td>${v.corr == null ? '—' : fmt(v.corr, 2)}</td></tr>
          <tr><td>Dias de distribuição (25 sessões)</td><td>${v.dist}</td></tr>
        </table>
        ${hist}
        <div style="margin-top:10px"><b>Ações do grupo</b></div>
        <table><tr><th>Ação</th><th>vs EMA50</th><th>RSI</th><th>20 sessões</th></tr>
        ${g.members.map(m => m.stale ? `<tr><td>${esc(m.sym)}</td><td class="n mut" colspan="3">sem dados nesta data</td></tr>` : `<tr><td><b>${esc(m.sym)}</b></td><td class="n ${m.vsE50 >= 0 ? 'pos' : 'neg'}">${pcs(m.vsE50)}</td><td class="n">${m.rsi ?? '—'}</td><td class="n ${m.r20 >= 0 ? 'pos' : 'neg'}">${pcs(m.r20)}</td></tr>`).join('')}</table>
      </details></div>`;
  }).join('') + (Object.values(RADAR.missing || {}).some(a => a.length) ? `<div class="card note">Sem dados para: ${esc([...new Set(Object.values(RADAR.missing).flat())].join(', '))}. Verifica os tickers em Config → Grupos do radar.</div>` : '')
  + `<div class="card note"><b>O que o radar consegue e não consegue.</b> (1) Não prevê a notícia que desencadeia uma queda (resultados, eleições, regulação). Mede se o grupo está frágil, e é nessas alturas que as más notícias fazem mais estragos. (2) Costuma avisar nos primeiros dias da queda, não antes do pico. (3) Dá falsos alarmes: vê na tabela quantas vezes o risco Alto não acabou em queda. (4) Três anos têm poucas quedas grandes, por isso a estatística é fraca. (5) Os grupos são feitos com ações escolhidas hoje (enviesamento de sobrevivência). É apoio à decisão, não aconselhamento financeiro.</div>`;
  drawCharts();
}
function drawRiskCharts() {
  document.querySelectorAll('canvas[data-risk]').forEach(cv => {
    if (!cv.offsetParent || !RADAR) return;
    const g = RADAR.groups[+cv.dataset.risk]; if (!g) return;
    const s = g.spark, N = s.idx.length, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
    const vals = [...s.idx, ...s.e50.filter(x => x != null)], mn = Math.min(...vals), mx = Math.max(...vals);
    const X = k => k / (N - 1) * (W - 4) + 2, Y = v => H - 4 - (v - mn) / (mx - mn || 1) * (H - 8), bw = (W - 4) / (N - 1) + 0.6;
    for (let k = 0; k < N; k++) { const sc = s.score[k]; if (sc == null || sc < 40) continue; c.fillStyle = sc >= 60 ? '#ff5c5c77' : '#f5b64255'; c.fillRect(X(k) - bw / 2, 0, bw, H); }
    const line = (a, col, w) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); let f = true; a.forEach((v, k) => { if (v == null) return; f ? c.moveTo(X(k), Y(v)) : c.lineTo(X(k), Y(v)); f = false; }); c.stroke(); };
    line(s.e50, '#f5b642', 1.2); line(s.idx, '#e6edf3', 1.6);
  });
}
function radarText() {
  if (!RADAR || !RADAR.groups || !RADAR.groups.length) return '';
  return `Radar de risco de setor da app (dados até ${RADAR.asOf}; pontuação 0–100, Elevado ≥40, Alto ≥60):\n` + RADAR.groups.map(g => {
    const v = g.vals, bt = g.bt;
    return `- ${g.name} (${g.nMembers} ações): ${g.level} ${g.score} (há 5 sessões ${g.prev5 ?? '—'}). Amplitude ${pc(v.breadth)} acima da EMA50; índice ${pcs(v.vsE50)} vs EMA50, ${pcs(v.vsE200)} vs EMA200, ${pcs(v.fromHigh)} do máximo de 52s; 20 sessões ${pcs(v.r20)}; volatilidade ${v.volRatio == null ? '—' : fmt(v.volRatio, 2) + '×'}; correlação ${v.corr == null ? '—' : fmt(v.corr, 2)}. Sinais: ${g.signals.map(s => s.txt).join('; ') || 'nenhum'}.`
      + (bt ? ` Histórico: queda ≥${thrTxt(bt.thr)} em 20 sessões em ${pc(bt.hi.p)} dos dias com risco ≥Elevado vs ${pc(bt.lo.p)} nos restantes (z=${fmt(bt.z, 1)}, veredicto ${bt.verdict}).` : '');
  }).join('\n');
}
function promptRisk() {
  const pos = S.portfolio.map(p => `${p.sym} ${p.qty} @ ${p.avg}`).join('; ') || '(sem posições registadas)';
  return `És um trader especialista em NASDAQ e PSI20. Data: ${today()}. Responde em português europeu.
${radarText()}
A minha carteira: ${pos}. Liquidez €${fmt(+S.settings.cash || 0, 0)}.

1) Para cada grupo em risco Elevado ou Alto, pesquisa as notícias dos últimos dias e identifica o que está a causar a pressão (resultados, regulação, política, juros, posicionamento de fundos). 2) Diz se as notícias confirmam ou contrariam o risco técnico, e se vês sinais de que a queda está a acabar ou a agravar-se. 3) Para a minha carteira: que posições reduzir, proteger com stop ou manter, com níveis concretos. 4) Que sinais devo esperar antes de voltar a comprar nesses grupos. Confirma preços atuais. Se não tiveres dados, diz "não sei".`;
}

// ---------- Render ----------
function scoreBar(s) {
  const w = Math.abs(s) / 2, col = s >= 0 ? 'var(--buy)' : 'var(--sell)';
  return `<div class="bar"><i style="${s >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${col}"></i></div>`;
}
function actionLabel(dec) {
  if (!dec) return '';
  const q = dec.qty ? ` ${fmt(dec.qty, 0)}` : '';
  return `<span class="badge ${dec.action.replace(/\s/g, '_')}">${dec.action}${q}</span>`;
}
function entryLine(r) {
  const e = r.dec && r.dec.entry; if (!e) return '';
  const c = cur(r.meta.currency);
  const zone = e.now ? `${c}${fmt(e.low)} – ${c}${fmt(e.high)}` : `${c}${fmt(e.low)} – ${c}${fmt(e.high)}`;
  const when = e.breakout ? `só se recuperar a ${e.ref}` : e.now ? 'entrada possível já (ordem limite nesta zona)' : `aguardar recuo até à ${e.ref}`;
  return `<div class="entry"><div><span class="mut">Entrada</span> <b>${zone}</b> <span class="mut">· ${when}</span></div>
    <div><span class="mut">Stop</span> <b class="neg">${c}${fmt(e.stop)}</b> <span class="mut">· Alvo</span> <b class="pos">${c}${fmt(r.dec.target)}</b> <span class="mut">· Risco/retorno</span> <b>${e.rr != null ? fmt(e.rr, 1) + '×' : '—'}</b></div></div>`;
}
function indTable(r) {
  const i = r.ind, c = cur(r.meta.currency);
  const rel = v => v ? ` <span class="${i.close >= v ? 'pos' : 'neg'}">${i.close >= v ? '▲' : '▼'}</span>` : '';
  return `<table>
  <tr><td>Data do fecho</td><td>${esc(i.date)}</td></tr>
  <tr><td>EMA13 / EMA50</td><td>${fmt(i.ema13)}${rel(i.ema13)} / ${fmt(i.ema50)}${rel(i.ema50)}</td></tr>
  <tr><td>EMA100 / EMA200</td><td>${fmt(i.ema100)}${rel(i.ema100)} / ${fmt(i.ema200)}${rel(i.ema200)}</td></tr>
  <tr><td>Bollinger (20,2)</td><td>${fmt(i.bbLower)} – ${fmt(i.bbUpper)} · %B ${fmt(i.pctB)}${i.squeeze ? ' · squeeze' : ''}</td></tr>
  <tr><td>RSI14</td><td>${fmt(i.rsi, 1)}</td></tr>
  <tr><td>MACD / sinal / hist</td><td>${fmt(i.macd)} / ${fmt(i.macdSignal)} / ${fmt(i.macdHist)}</td></tr>
  <tr><td>ATR14</td><td>${fmt(i.atr)} (${fmt(i.atr / i.close * 100, 1)}%)</td></tr>
  <tr><td>Volume vs média 20d</td><td>${fmt(i.volAvg20 ? i.volume / i.volAvg20 : null, 2)}×</td></tr>
  <tr><td>Máx / mín 52 sem.</td><td>${c}${fmt(i.hi52)} / ${c}${fmt(i.lo52)}</td></tr>
  <tr><td>Stop técnico (2×ATR)</td><td>${c}${fmt(r.dec?.stop)}</td></tr>
  <tr><td>Alvo técnico</td><td>${c}${fmt(r.dec?.target)} (${fmt(r.dec?.upsidePct, 1)}%)</td></tr>
  </table>`;
}
function detailBlock(sym, r) {
  const comps = r.sc.components.map(c => `<li>${c.pts > 0 ? '+' : ''}${c.pts} · ${esc(c.txt)}</li>`).join('');
  const hl = r.news.length ? r.news.slice(0, 6).map(n => `<div class="hl">• <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a> <span class="mut">${esc(n.source)}</span></div>`).join('')
    : `<div class="mut">${sym.includes(':') ? 'Notícias automáticas só para ações EUA (Finnhub).' : S.settings.fhKey ? 'Sem notícias nos últimos 7 dias.' : 'Adiciona a chave Finnhub para ver notícias.'}</div>`;
  return `<details><summary>Indicadores, gráfico e notícias</summary>
    <canvas data-sym="${esc(sym)}"></canvas>
    <div class="legend"><b style="background:#e6edf3"></b>Preço<b style="background:#4ea1ff"></b>EMA13<b style="background:#f5b642"></b>EMA50<b style="background:#c678dd"></b>EMA200<b style="background:#39485a;height:8px"></b>Bollinger</div>
    ${indTable(r)}<div class="mut" style="margin-top:8px">Componentes da pontuação</div><ul class="r">${comps}</ul>
    <div class="mut">Notícias (sentimento ${r.ns.score > 0 ? '+' : ''}${r.ns.score})</div>${hl}</details>`;
}
function renderPortfolio() {
  const { v, cost } = portfolioValue();
  const inv = v - (+S.settings.cash || 0);
  $('#pv').textContent = `€${fmt(v)}`;
  const pl = inv - cost;
  $('#pl').innerHTML = cost ? `<span class="${pl >= 0 ? 'pos' : 'neg'}">${pl >= 0 ? '+' : ''}€${fmt(pl)} (${fmt(pl / cost * 100, 1)}%)</span>` : '—';
  $('#cashInfo').textContent = `Liquidez: €${fmt(+S.settings.cash || 0)} · ${S.portfolio.length} posições`;
  $('#posList').innerHTML = S.portfolio.length ? S.portfolio.map((p, idx) => {
    const r = results[p.sym];
    if (!r) return `<div class="card"><div class="row"><span class="tick">${esc(p.sym)}</span><span class="sp mut">${fmt(p.qty, 0)} × ${fmt(p.avg)}</span><button class="x" data-edit="${idx}">✎</button><button class="x" data-del="${idx}">✕</button></div><div class="mut">Carrega em "Analisar carteira".</div></div>`;
    const i = r.ind, c = cur(r.meta.currency), d = r.dec;
    return `<div class="card">
      <div class="row"><span class="tick">${esc(p.sym)}</span><span class="mut">${esc(r.meta.exchange || '')}</span><span class="sp"></span>${actionLabel(d)}<button class="x" data-edit="${idx}">✎</button><button class="x" data-del="${idx}">✕</button></div>
      <div class="row"><span class="big">${c}${fmt(i.close)}</span><span class="${i.changePct >= 0 ? 'pos' : 'neg'}">${i.changePct >= 0 ? '+' : ''}${fmt(i.changePct)}%</span><span class="sp"></span>
        <span class="mut">${fmt(p.qty, 0)} × ${c}${fmt(p.avg)} · <span class="${d.plPct >= 0 ? 'pos' : 'neg'}">${d.plPct >= 0 ? '+' : ''}${fmt(d.plPct, 1)}%</span></span></div>
      ${scoreBar(r.sc.score)}<div class="mut">Pontuação ${r.sc.score}${riskChip(r)}</div>
      ${entryLine(r)}
      <ul class="r">${d.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${detailBlock(p.sym, r)}</div>`;
  }).join('') : '<div class="card mut">Ainda sem posições. Adiciona com "+ Posição".</div>';
  drawCharts();
}
function renderTop() {
  const syms = watchSyms();
  const ranked = syms.filter(s => results[s] && results[s].dec).map(sym => ({ sym, r: results[sym] }))
    .sort((a, b) => (b.r.sc.score + Math.min(30, (b.r.dec.upsidePct || 0)) / 3) - (a.r.sc.score + Math.min(30, (a.r.dec.upsidePct || 0)) / 3));
  const hotGroup = x => S.settings.riskAdjust && x.r.risk && x.r.risk.level === 'Alto' && x.r.risk.verdict !== 'nulo';
  let top;
  if (modelUsable()) {
    // modelo validado: candidatos com tendência aceitável (regras) E modelo favorável; ordenar pela previsão do modelo
    top = ranked.filter(x => x.r.fc && x.r.sc.score >= S.settings.buyThreshold - 10 && x.r.fc.quintile >= 4 && !['VENDER', 'EVITAR'].includes(x.r.dec.action) && !hotGroup(x))
      .sort((a, b) => b.r.fc.pred - a.r.fc.pred).slice(0, 5);
  } else top = ranked.filter(x => x.r.sc.score >= S.settings.buyThreshold && !hotGroup(x)).slice(0, 5);
  const rest = ranked.filter(x => !top.includes(x));
  const card = (x, n) => {
    const r = x.r, i = r.ind, c = cur(r.meta.currency);
    const trend = i.close > i.ema200 ? (i.ema50 > i.ema200 ? 'tendência de alta consolidada' : 'acima da EMA200, EMA50 ainda abaixo') : 'abaixo da EMA200';
    const mom = i.rsi > 70 ? 'sobrecomprado, melhor esperar recuo' : i.rsi < 35 ? 'sobrevendido' : 'momentum saudável';
    return `<div class="card ${n ? 'pick' : ''}">
      <div class="row">${n ? `<span class="rank">#${n}</span>` : ''}<span class="tick">${esc(x.sym)}</span><span class="mut">${esc(r.meta.exchange || '')}</span><span class="sp"></span>${actionLabel(r.dec)}</div>
      <div class="row"><span class="big">${c}${fmt(i.close)}</span><span class="${i.changePct >= 0 ? 'pos' : 'neg'}">${i.changePct >= 0 ? '+' : ''}${fmt(i.changePct)}%</span><span class="sp"></span><span class="mut">Alvo técnico ${c}${fmt(r.dec.target)} (<b class="pos">+${fmt(r.dec.upsidePct, 1)}%</b>)</span></div>
      ${scoreBar(r.sc.score)}<div class="mut">Pontuação ${r.sc.score} · ${trend} · RSI ${fmt(i.rsi, 0)} (${mom}) · notícias ${r.ns.score > 0 ? '+' : ''}${r.ns.score}${r.fc ? ` · <b>modelo Q${r.fc.quintile}/5</b>` : ''}${riskChip(r)}</div>
      ${n ? entryLine(r) : ''}
      ${n ? `<ul class="r">${r.dec.reasons.map(x => `<li><b>${esc(x)}</b></li>`).join('')}${r.sc.components.filter(c => c.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 4).map(c => `<li>${esc(c.txt)}</li>`).join('')}</ul>` : ''}
      ${detailBlock(x.sym, r)}</div>`;
  };
  $('#topList').innerHTML = (top.length ? top.map((x, k) => card(x, k + 1)).join('') : (ranked.length ? '<div class="card mut">Nenhuma ação da watchlist passa hoje o limiar de compra.</div>' : ''))
    + (rest.length ? `<div class="mut" style="margin:12px 0 8px">Restantes (por pontuação)</div>` + rest.map(x => card(x, 0)).join('') : '');
  drawCharts();
}
function drawCharts() {
  document.querySelectorAll('details').forEach(d => d.ontoggle = () => d.open && drawCharts());
  drawRiskCharts();
  document.querySelectorAll('canvas[data-sym]').forEach(cv => {
    if (!cv.offsetParent) return;
    const r = results[cv.dataset.sym]; if (!r) return;
    const s = r.ind.series, N = Math.min(150, s.close.length), st = s.close.length - N;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const seg = a => a.slice(st);
    const all = [...seg(s.close), ...seg(s.bbU), ...seg(s.bbL), ...seg(s.e50), ...seg(s.e200)].filter(v => v != null);
    const mn = Math.min(...all), mx = Math.max(...all);
    const X = k => k / (N - 1) * (W - 4) + 2, Y = v => H - 4 - (v - mn) / (mx - mn || 1) * (H - 8);
    g.fillStyle = '#39485a55'; g.beginPath();
    let f = true; seg(s.bbU).forEach((v, k) => { if (v == null) return; f ? g.moveTo(X(k), Y(v)) : g.lineTo(X(k), Y(v)); f = false; });
    for (let k = N - 1; k >= 0; k--) { const v = seg(s.bbL)[k]; if (v != null) g.lineTo(X(k), Y(v)); }
    g.fill();
    const line = (a, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); let f = true; seg(a).forEach((v, k) => { if (v == null) return; f ? g.moveTo(X(k), Y(v)) : g.lineTo(X(k), Y(v)); f = false; }); g.stroke(); };
    line(s.e200, '#c678dd', 1.2); line(s.e50, '#f5b642', 1.2); line(s.e13, '#4ea1ff', 1); line(s.close, '#e6edf3', 1.6);
  });
}

// ---------- Pedido para o Claude ----------
function indLine(sym, r) {
  const i = r.ind;
  return `${sym} (${r.meta.exchange || ''}, ${r.meta.currency}) fecho ${i.date}: ${fmt(i.close)} (${fmt(i.changePct)}%) | EMA13 ${fmt(i.ema13)} EMA50 ${fmt(i.ema50)} EMA100 ${fmt(i.ema100)} EMA200 ${fmt(i.ema200)} | BB20 ${fmt(i.bbLower)}–${fmt(i.bbUpper)} %B ${fmt(i.pctB)} | RSI ${fmt(i.rsi, 1)} | MACD hist ${fmt(i.macdHist, 3)} | ATR ${fmt(i.atr)} | vol/média ${fmt(i.volAvg20 ? i.volume / i.volAvg20 : null)}× | máx52s ${fmt(i.hi52)} | pontuação regras ${r.sc.score}`
    + (r.fc ? ` | modelo 20d quintil ${r.fc.quintile}/5 (hist. validação: ${fmt(r.fc.hist.r * 100, 1)}%, sobe ${fmt(r.fc.hist.up * 100, 0)}%; fatores: ${r.fc.contrib.map(c => c.name + (c.c > 0 ? ' +' : ' −')).join(', ')})` : '')
    + (r.dec && r.dec.entry ? ` | entrada sugerida ${fmt(r.dec.entry.low)}–${fmt(r.dec.entry.high)} (${r.dec.entry.now ? 'já' : 'aguardar recuo'}), stop ${fmt(r.dec.entry.stop)}, alvo ${fmt(r.dec.target)}` : '')
    + (r.news.length ? `\n   Notícias 7d: ${r.news.slice(0, 5).map(n => n.headline).join(' || ')}` : '');
}
function promptPortfolio() {
  const { v } = portfolioValue();
  const lines = S.portfolio.filter(p => results[p.sym]).map(p => {
    const r = results[p.sym];
    return `- ${indLine(p.sym, r)}\n   Posição: ${p.qty} a ${p.avg} (P/L ${fmt(r.dec.plPct, 1)}%). Decisão das regras: ${r.dec.action}${r.dec.qty ? ' ' + r.dec.qty : ''}. ${r.dec.reasons.join(' ')}`;
  }).join('\n');
  return `És um trader especialista em NASDAQ e PSI20. Data: ${today()}. Responde em português europeu.
A minha carteira vale ~€${fmt(v, 0)}, com liquidez de €${fmt(+S.settings.cash || 0, 0)}. Regras: risco ${S.settings.riskPct}% por operação, peso máximo de ${S.settings.maxPosPct}% por ação, stop-loss de ${S.settings.maxLossPct}%.
A minha app calculou estes indicadores diários e decisões por regras técnicas:
${lines}
${radarText()}

Para cada ação: 1) pesquisa as notícias mais recentes (últimos dias) e confirma o preço atual; 2) diz se concordas com a decisão (COMPRAR X / MANTER / VENDER X) e ajusta a quantidade se as notícias o justificarem; 3) justifica em 2–3 linhas (catalisadores, riscos, níveis técnicos de entrada/stop). Termina com um resumo em tabela. Se não tiveres dados para algo, diz "não sei".`;
}
function promptTop() {
  const syms = watchSyms().filter(s => results[s]).sort((a, b) => results[b].sc.score - results[a].sc.score);
  const lines = syms.slice(0, 10).map(s => `- ${indLine(s, results[s])}`).join('\n');
  return `És um trader especialista em NASDAQ e PSI20. Data: ${today()}. Responde em português europeu.
A minha app ordenou esta watchlist por pontuação técnica diária (EMA13/50/100/200, Bollinger, RSI, MACD, volume, notícias):
${lines}
${radarText()}

Pesquisa as notícias de hoje e escolhe as TOP 5 com melhor perspetiva de ganho no curto/médio prazo (podes incluir outra ação fora da lista se houver um catalisador forte hoje). Para cada uma dá: âmbito de atividade, perspetiva de ganho (alvo e % de potencial, com consenso de analistas se existir), justificação (notícias + técnica), nível de risco e zona de entrada/stop. Confirma os preços atuais. Se não tiveres dados, diz "não sei".`;
}
function setPrompt(title, text) {
  lastPrompt = { title, text };
  $('#cTitle').textContent = title; $('#cText').textContent = text;
  showTab('claude');
}

// ---------- Modelo: treino e relatório ----------
const P = v => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + fmt(v * 100, 1) + '%';
async function trainModel(btn) {
  const universe = [...new Set([...S.portfolio.map(p => p.sym), ...watchSyms()])];
  if (universe.length < 5) return alert('São precisas pelo menos 5 ações (carteira + watchlist).');
  btn.disabled = true;
  const prog = t => { $('#mProg').textContent = t; status(t); };
  const data = {}, errs = [];
  for (let k = 0; k < universe.length; k++) {
    prog(`A descarregar histórico ${universe[k]} (${k + 1}/${universe.length})…`);
    try { data[universe[k]] = (await tdSeries(universe[k], 1000)).bars; } catch (e) { errs.push(`${universe[k]}: ${e.message}`); if (/chave/i.test(e.message)) break; }
  }
  await new Promise(r => setTimeout(r, 50));
  try {
    const m = window.Model.train(data, { buy: S.settings.buyThreshold, sell: S.settings.sellThreshold, onProgress: prog });
    m.snapshot = Object.keys(data).filter(s => m.universe.includes(s)).map(sym => {
      const Ser = E.seriesAll(data[sym]), fc = window.Model.forecast(m, Ser);
      return fc ? { sym, date: Ser.dates[Ser.N - 1], close: Ser.c[Ser.N - 1], score: E.scoreIndicators(E.indAt(Ser, Ser.N - 1), 0).score, q: fc.quintile, pred: fc.pred, top: fc.contrib.slice(0, 2).map(c => c.name + (c.c > 0 ? ' ↑' : ' ↓')).join(', ') } : null;
    }).filter(Boolean).sort((a, b) => b.pred - a.pred);
    m.skipped = universe.filter(s => !m.universe.includes(s));
    MODEL = m;
    try { localStorage.setItem('acc_model', JSON.stringify(m)); } catch (e) {}
    for (const s of Object.keys(results)) { results[s].fc = window.Model.forecast(MODEL, results[s].ind.S); results[s].bs = window.Model.bucketStats(MODEL, results[s].sc.score); }
    decideAll(Object.keys(results)); renderPortfolio(); renderTop();
    prog(`Modelo treinado com ${m.universe.length} ações${errs.length ? ` · ${errs.length} erro(s)` : ''}.`);
  } catch (e) { prog('Erro: ' + e.message); }
  if (errs.length) alert(errs.join('\n'));
  btn.disabled = false;
  renderModel();
}
function renderModel() {
  const m = MODEL, el = $('#mReport');
  if (!m) { el.innerHTML = '<div class="card mut">Ainda sem modelo. Carrega em "Treinar". Com 40+ ações demora ~6 min por causa do limite grátis de 8 pedidos/min (uma vez por semana chega).</div>'; return; }
  const o = m.oos, vtxt = { moderado: 'Poder preditivo MODERADO', fraco: 'Poder preditivo FRACO', nulo: 'Sem poder preditivo comprovado' }[m.verdict];
  const vexp = { moderado: 'O modelo ordenou as ações melhor do que o acaso no ano de validação, com significância estatística. A app usa-o para filtrar compras e ordenar o Top 5.',
    fraco: 'Há algum sinal no ano de validação, mas pouco robusto. A app mostra-o só como indicação e não deixa que mude as decisões.',
    nulo: 'No ano de validação o modelo não ordenou as ações melhor do que o acaso. A app mostra-o só como indicação e mantém as regras técnicas.' }[m.verdict];
  const T = m.thresholds, tr = (lbl, x) => `<tr><td>${lbl}</td><td class="n">${fmt(x.sharpe, 2)}</td><td class="n">${P(x.ret)}</td><td class="n">${P(x.bh)}</td><td class="n">${fmt(x.trades, 1)}</td><td class="n">${fmt(x.win * 100, 0)}%</td><td class="n">${P(x.mdd)}</td></tr>`;
  const maxW = Math.max(...m.weights.map(Math.abs));
  const wrows = m.features.map((f, i) => ({ f, w: m.weights[i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .map(x => `<tr><td>${esc(x.f)}</td><td class="n"><span class="wbar" style="width:${Math.round(Math.abs(x.w) / maxW * 70)}px;background:${x.w > 0 ? 'var(--buy)' : 'var(--sell)'}"></span> ${x.w > 0 ? '+' : '−'}</td></tr>`).join('');
  el.innerHTML = `
  <div class="card"><div class="verdict v-${m.verdict}">${vtxt}</div><p class="mut">${vexp}</p>
    <table>
      <tr><th>Validação fora da amostra (${esc(m.period.testStart)} → ${esc(m.period.to)})</th><th>Modelo</th><th>Regras</th></tr>
      <tr><td>IC médio (correlação previsão × retorno relativo 20d)</td><td class="n">${fmt(o.model.ic, 3)}</td><td class="n">${fmt(o.rules.ic, 3)}</td></tr>
      <tr><td>Estatística t (≥2 = significativo)</td><td class="n">${fmt(o.model.t, 1)}</td><td class="n">${fmt(o.rules.t, 1)}</td></tr>
      <tr><td>Retorno 20d — top 20% das previsões</td><td class="n">${P(o.model.top)}</td><td class="n">${P(o.rules.top)}</td></tr>
      <tr><td>Retorno 20d — pior 20%</td><td class="n">${P(o.model.bottom)}</td><td class="n">${P(o.rules.bottom)}</td></tr>
      <tr><td>Diferença top − pior</td><td class="n"><b>${P(o.model.spread)}</b></td><td class="n"><b>${P(o.rules.spread)}</b></td></tr>
      <tr><td>Top 20% bateu o universo</td><td class="n">${fmt(o.model.topHit * 100, 0)}%</td><td class="n">${fmt(o.rules.topHit * 100, 0)}%</td></tr>
    </table>
    <div class="note">Treino ${esc(m.period.from)} → ${esc(m.period.trainEnd)} · ${m.period.trainRows} observações · teste ${m.period.testRows} · ${m.universe.length} ações · treinado a ${esc(m.trainedAt)}${m.skipped.length ? ` · sem histórico suficiente: ${esc(m.skipped.join(', '))}` : ''}</div></div>

  <div class="card"><b>Previsão por quintil do modelo (ano de validação)</b>
    <table><tr><th>Quintil</th><th>Retorno 20d</th><th>vs universo</th><th>Subiu</th><th>n</th></tr>
    ${m.qStats.map((q, k) => `<tr><td>Q${k + 1}${k === 4 ? ' (melhor)' : k === 0 ? ' (pior)' : ''}</td><td class="n">${P(q.r)}</td><td class="n">${P(q.ex)}</td><td class="n">${fmt(q.up * 100, 0)}%</td><td class="n">${q.n}</td></tr>`).join('')}</table>
    <div class="note">Se o modelo funciona, os retornos sobem de Q1 para Q5.</div></div>

  <div class="card"><b>Pontuação das regras → o que aconteceu a 20 dias (3 anos)</b>
    <table><tr><th>Pontuação</th><th>Média</th><th>Mediana</th><th>Subiu</th><th>n</th></tr>
    ${m.buckets.map(b => `<tr><td>${esc(b.range)}</td><td class="n">${P(b.mean)}</td><td class="n">${P(b.median)}</td><td class="n">${b.up == null ? '—' : fmt(b.up * 100, 0) + '%'}</td><td class="n">${b.n}</td></tr>`).join('')}
    <tr><td><i>Qualquer dia (referência)</i></td><td class="n">${P(m.baseline.mean)}</td><td></td><td class="n">${fmt(m.baseline.up * 100, 0)}%</td><td></td></tr></table></div>

  <div class="card"><b>Limiares de compra/venda</b>
    <div class="tw"><table><tr><th></th><th>Sharpe</th><th>Retorno</th><th>Comprar e manter</th><th>Trades</th><th>Acerto</th><th>Queda máx.</th></tr>
    ${tr(`Atuais ${T.current.buy}/${T.current.sell} — treino`, T.current.train)}${tr(`Atuais — validação`, T.current.test)}
    ${tr(`Calibrados ${T.calibrated.buy}/${T.calibrated.sell} — treino`, T.calibrated.train)}${tr(`Calibrados — validação`, T.calibrated.test)}</table></div>
    <div class="note">Média por ação, custos de 0,1% por operação, stop a 2×ATR. Os limiares foram escolhidos só com o treino, por isso a linha "validação" é o teste honesto.</div>
    <div class="row" style="margin-top:8px"><button class="b2" id="mApply">Aplicar ${T.calibrated.buy}/${T.calibrated.sell}</button></div></div>

  <div class="card"><b>Previsões atuais (${esc(m.snapshot[0]?.date || '')})</b>
    <table><tr><th>Ação</th><th>Pontuação</th><th>Quintil</th><th>Fatores principais</th></tr>
    ${m.snapshot.map(x => `<tr><td><b>${esc(x.sym)}</b></td><td class="n">${x.score}</td><td class="n"><b class="${x.q >= 4 ? 'pos' : x.q <= 2 ? 'neg' : ''}">Q${x.q}</b></td><td class="n mut">${esc(x.top)}</td></tr>`).join('')}</table></div>

  <div class="card"><b>Peso de cada indicador no modelo</b><table>${wrows}</table>
    <div class="note">Verde: valores altos anteciparam retornos relativos melhores. Vermelho: anteciparam piores.</div></div>

  <div class="card note"><b>Limitações importantes.</b> (1) <b>Enviesamento de sobrevivência:</b> a watchlist foi escolhida hoje, com ações que já sabemos que correram bem, por isso os retornos absolutos estão inflacionados. A comparação relativa (IC, quintis) é mais fiável. (2) O backtest não inclui notícias. (3) Um único ano de validação é pouco: um regime de mercado diferente (juros a 5%, subidas da Fed) pode inverter o que funcionou. (4) O modelo prevê retorno <i>relativo</i> entre as ações da lista, não a direção do mercado. É uma ferramenta de apoio, não aconselhamento financeiro.</div>`;
  const ap = $('#mApply');
  if (ap) ap.onclick = () => {
    S.settings.buyThreshold = T.calibrated.buy; S.settings.sellThreshold = T.calibrated.sell; save();
    $('#sBuy').value = T.calibrated.buy; $('#sSell').value = T.calibrated.sell;
    decideAll(Object.keys(results)); renderPortfolio(); renderTop(); status(`Limiares ${T.calibrated.buy}/${T.calibrated.sell} aplicados`);
  };
}
function promptModel() {
  const m = MODEL, o = m.oos, T = m.thresholds;
  const pos = S.portfolio.map(p => `${p.sym} ${p.qty} @ ${p.avg}`).join('; ') || '(sem posições)';
  return `És um trader especialista em NASDAQ e PSI20. Data: ${today()}. Responde em português europeu.
A minha app treinou um modelo com 3 anos de dados diários de ${m.universe.length} ações (ridge sobre ${m.features.length} indicadores técnicos: EMAs 13/50/100/200, Bollinger, RSI, MACD, volume, momentum 20/60d, ATR, distância ao máximo de 52 semanas). Treino ${m.period.from}→${m.period.trainEnd}, validação fora da amostra ${m.period.testStart}→${m.period.to}.
Resultado da validação: IC ${fmt(o.model.ic, 3)} (t=${fmt(o.model.t, 1)}) vs regras IC ${fmt(o.rules.ic, 3)}; top 20% ${P(o.model.top)} vs pior 20% ${P(o.model.bottom)} a 20 dias. Veredicto: ${m.verdict}.
Quintis (validação): ${m.qStats.map((q, k) => `Q${k + 1} ${P(q.r)}`).join(', ')}.
Limiares calibrados ${T.calibrated.buy}/${T.calibrated.sell}: Sharpe validação ${fmt(T.calibrated.test.sharpe, 2)}, retorno ${P(T.calibrated.test.ret)} vs comprar e manter ${P(T.calibrated.test.bh)}. Atuais ${T.current.buy}/${T.current.sell}: Sharpe ${fmt(T.current.test.sharpe, 2)}.
Pesos principais: ${m.features.map((f, i) => [f, m.weights[i]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5).map(([f, w]) => `${f} ${w > 0 ? '+' : '−'}`).join(', ')}.
Previsões atuais (${m.snapshot[0]?.date}): ${m.snapshot.map(x => `${x.sym} Q${x.q} (pont. ${x.score}, ${fmt(x.close)})`).join('; ')}.
${radarText()}
A minha carteira: ${pos}. Liquidez €${fmt(+S.settings.cash || 0, 0)}.

1) Avalia criticamente a fiabilidade do modelo com estes números (sobreajuste, enviesamento de sobrevivência, regime de juros atual). 2) Para cada posição da carteira: COMPRAR X / MANTER / VENDER X, combinando o modelo com as notícias de hoje. 3) Top 5 picks: âmbito de atividade, alvo e potencial (consenso de analistas), justificação (modelo + técnica + notícias), risco e zona de entrada/stop. Confirma preços atuais. Se não tiveres dados, diz "não sei".`;
}

// ---------- UI ----------
function watchSyms() { return [...new Set(S.watchlist.split(/[,\s;]+/).map(s => s.trim().toUpperCase()).filter(Boolean))]; }
function showTab(t) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.id === 't-' + t));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  window.scrollTo(0, 0); drawCharts();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.t));

let editIdx = -1;
$('#btnAdd').onclick = () => { editIdx = -1; $('#fSym').value = $('#fQty').value = $('#fAvg').value = ''; $('#addForm').hidden = false; $('#fSym').focus(); };
$('#fCancel').onclick = () => { $('#addForm').hidden = true; };
$('#fSave').onclick = () => {
  const sym = $('#fSym').value.trim().toUpperCase(), qty = parseFloat($('#fQty').value), avg = parseFloat($('#fAvg').value);
  if (!sym || !(qty > 0) || !(avg > 0)) return alert('Preenche ticker, quantidade e preço médio.');
  if (editIdx >= 0) S.portfolio[editIdx] = { sym, qty, avg }; else {
    const ex = S.portfolio.find(p => p.sym === sym);
    if (ex) { ex.avg = (ex.avg * ex.qty + avg * qty) / (ex.qty + qty); ex.qty += qty; } else S.portfolio.push({ sym, qty, avg });
  }
  save(); $('#addForm').hidden = true; decideAll(S.portfolio.map(p => p.sym)); renderPortfolio();
};
$('#posList').onclick = e => {
  const d = e.target.dataset;
  if (d.del != null && confirm(`Remover ${S.portfolio[d.del].sym}?`)) { S.portfolio.splice(+d.del, 1); save(); renderPortfolio(); }
  if (d.edit != null) { editIdx = +d.edit; const p = S.portfolio[editIdx]; $('#fSym').value = p.sym; $('#fQty').value = p.qty; $('#fAvg').value = p.avg; $('#addForm').hidden = false; window.scrollTo(0, 0); }
};
$('#btnAnalyse').onclick = async e => {
  const syms = S.portfolio.map(p => p.sym);
  if (!syms.length) return alert('Adiciona posições primeiro.');
  await runList(syms, e.target); await computeRadar(false); decideAll(syms); renderPortfolio();
};
$('#watch').value = S.watchlist;
$('#watch').onchange = () => { S.watchlist = $('#watch').value; save(); };
$('#btnScan').onclick = async e => {
  S.watchlist = $('#watch').value; save();
  const syms = watchSyms();
  await runList(syms, e.target); await computeRadar(false); decideAll(Object.keys(results)); renderTop(); renderPortfolio();
};
$('#btnClaudeP').onclick = () => S.portfolio.some(p => results[p.sym]) ? setPrompt('Análise da carteira', promptPortfolio()) : alert('Analisa a carteira primeiro.');
$('#btnClaudeT').onclick = () => watchSyms().some(s => results[s]) ? setPrompt('Top 5 do dia', promptTop()) : alert('Calcula o Top 5 primeiro.');
$('#cCopy').onclick = async () => { try { await navigator.clipboard.writeText(lastPrompt.text); status('Copiado'); } catch (e) { alert('Não foi possível copiar'); } };
$('#cShare').onclick = async () => {
  if (navigator.share) { try { await navigator.share({ title: lastPrompt.title, text: lastPrompt.text }); } catch (e) {} }
  else $('#cCopy').onclick();
};
$('#cOpen').onclick = async () => { try { await navigator.clipboard.writeText(lastPrompt.text); } catch (e) {} window.open('https://claude.ai/new', '_blank'); status('Pedido copiado: cola-o no Claude'); };

const F = { sTd: 'tdKey', sFh: 'fhKey', sCash: 'cash', sRisk: 'riskPct', sMax: 'maxPosPct', sLoss: 'maxLossPct', sBuy: 'buyThreshold', sSell: 'sellThreshold', sTp: 'takeProfitPct' };
Object.entries(F).forEach(([id, k]) => $('#' + id).value = S.settings[k]);
$('#sRiskAdj').checked = S.settings.riskAdjust !== false;
$('#sGroups').value = S.groups || window.Risk.DEFAULT_GROUPS;
$('#sSave').onclick = () => {
  Object.entries(F).forEach(([id, k]) => { const v = $('#' + id).value.trim(); S.settings[k] = /Key$/.test(k) ? v : parseFloat(v) || 0; });
  S.settings.riskAdjust = $('#sRiskAdj').checked;
  const gOld = S.groups; S.groups = $('#sGroups').value.trim() || window.Risk.DEFAULT_GROUPS;
  save();
  if (gOld !== S.groups) computeRadar(false);
  decideAll(Object.keys(results)); renderPortfolio(); renderTop(); status('Definições guardadas');
};
$('#sClear').onclick = () => { clearCache(); status('Cache limpa'); };
$('#sExport').onclick = async () => {
  const txt = JSON.stringify({ portfolio: S.portfolio, watchlist: S.watchlist, groups: S.groups, settings: { ...S.settings, tdKey: '', fhKey: '' } });
  try { await navigator.clipboard.writeText(txt); alert('Dados copiados (sem as chaves API). Guarda-os numa nota.'); } catch (e) { prompt('Copia:', txt); }
};
$('#sImport').onclick = () => {
  const t = prompt('Cola aqui os dados exportados:'); if (!t) return;
  try { const j = JSON.parse(t); S.portfolio = j.portfolio || S.portfolio; S.watchlist = j.watchlist || S.watchlist; S.groups = j.groups || S.groups; S.settings = { ...S.settings, ...j.settings, tdKey: S.settings.tdKey, fhKey: S.settings.fhKey }; save(); location.reload(); }
  catch (e) { alert('Formato inválido'); }
};

$('#mTrain').onclick = e => trainModel(e.target);
$('#mClaude').onclick = () => MODEL ? setPrompt('Modelo + carteira + Top 5', promptModel()) : alert('Treina o modelo primeiro.');
$('#rUpdate').onclick = e => computeRadar(true, e.target);
$('#rClaude').onclick = () => RADAR && RADAR.groups && RADAR.groups.length ? setPrompt('Radar de risco', promptRisk()) : alert('Atualiza o radar primeiro.');
document.addEventListener('click', e => { const go = e.target.closest('[data-go]'); if (go) showTab(go.dataset.go); });
renderModel();
renderRadar();
renderPortfolio();
if (!S.settings.tdKey) { showTab('def'); status('Configura a chave API'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
