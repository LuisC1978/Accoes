'use strict';
const $ = s => document.querySelector(s);
const E = window.Engine;
const BASE = 'EUR';

// ---------- Estado ----------
const DEF = {
  settings: { tdKey: '', fhKey: '', cash: 0, riskPct: 1, maxPosPct: 20, maxLossPct: 15, buyThreshold: 35, sellThreshold: -35, takeProfitPct: 25 },
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
async function tdSeries(raw, size = 300) {
  const key = 'acc_c_' + raw + '_' + size;
  try { const c = JSON.parse(localStorage.getItem(key)); if (c && c.day === today()) return c; } catch (e) {}
  if (!S.settings.tdKey) throw new Error('Falta a chave Twelve Data (Definições).');
  const { symbol, mic } = parseSym(raw);
  const u = new URL('https://api.twelvedata.com/time_series');
  u.search = new URLSearchParams({ symbol, interval: '1day', outputsize: size, apikey: S.settings.tdKey, ...(mic ? { mic_code: mic } : {}) });
  await throttle();
  const r = await fetch(u); const j = await r.json();
  if (j.status !== 'ok') throw new Error(j.message || 'Erro Twelve Data');
  const bars = j.values.map(v => ({ datetime: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0) })).reverse();
  const out = { day: today(), bars, meta: j.meta };
  try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) { clearCache(); }
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
}

// ---------- Análise ----------
async function analyse(raw) {
  const d = await tdSeries(raw);
  if (d.bars.length < 60) throw new Error('Histórico insuficiente');
  const ind = E.computeIndicators(d.bars);
  const nw = await news(raw);
  const ns = E.newsSentiment(nw);
  const sc = E.scoreIndicators(ind, ns.score);
  const fx = await fxRate(d.meta.currency);
  return { ind, sc, meta: d.meta, news: nw, ns, fx };
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
      ${scoreBar(r.sc.score)}<div class="mut">Pontuação ${r.sc.score}</div>
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
  const top = ranked.filter(x => x.r.sc.score >= S.settings.buyThreshold).slice(0, 5);
  const rest = ranked.filter(x => !top.includes(x));
  const card = (x, n) => {
    const r = x.r, i = r.ind, c = cur(r.meta.currency);
    const trend = i.close > i.ema200 ? (i.ema50 > i.ema200 ? 'tendência de alta consolidada' : 'acima da EMA200, EMA50 ainda abaixo') : 'abaixo da EMA200';
    const mom = i.rsi > 70 ? 'sobrecomprado, melhor esperar recuo' : i.rsi < 35 ? 'sobrevendido' : 'momentum saudável';
    return `<div class="card ${n ? 'pick' : ''}">
      <div class="row">${n ? `<span class="rank">#${n}</span>` : ''}<span class="tick">${esc(x.sym)}</span><span class="mut">${esc(r.meta.exchange || '')}</span><span class="sp"></span>${actionLabel(r.dec)}</div>
      <div class="row"><span class="big">${c}${fmt(i.close)}</span><span class="${i.changePct >= 0 ? 'pos' : 'neg'}">${i.changePct >= 0 ? '+' : ''}${fmt(i.changePct)}%</span><span class="sp"></span><span class="mut">Alvo técnico ${c}${fmt(r.dec.target)} (<b class="pos">+${fmt(r.dec.upsidePct, 1)}%</b>)</span></div>
      ${scoreBar(r.sc.score)}<div class="mut">Pontuação ${r.sc.score} · ${trend} · RSI ${fmt(i.rsi, 0)} (${mom}) · notícias ${r.ns.score > 0 ? '+' : ''}${r.ns.score}</div>
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

Para cada ação: 1) pesquisa as notícias mais recentes (últimos dias) e confirma o preço atual; 2) diz se concordas com a decisão (COMPRAR X / MANTER / VENDER X) e ajusta a quantidade se as notícias o justificarem; 3) justifica em 2–3 linhas (catalisadores, riscos, níveis técnicos de entrada/stop). Termina com um resumo em tabela. Se não tiveres dados para algo, diz "não sei".`;
}
function promptTop() {
  const syms = watchSyms().filter(s => results[s]).sort((a, b) => results[b].sc.score - results[a].sc.score);
  const lines = syms.slice(0, 10).map(s => `- ${indLine(s, results[s])}`).join('\n');
  return `És um trader especialista em NASDAQ e PSI20. Data: ${today()}. Responde em português europeu.
A minha app ordenou esta watchlist por pontuação técnica diária (EMA13/50/100/200, Bollinger, RSI, MACD, volume, notícias):
${lines}

Pesquisa as notícias de hoje e escolhe as TOP 5 com melhor perspetiva de ganho no curto/médio prazo (podes incluir outra ação fora da lista se houver um catalisador forte hoje). Para cada uma dá: âmbito de atividade, perspetiva de ganho (alvo e % de potencial, com consenso de analistas se existir), justificação (notícias + técnica), nível de risco e zona de entrada/stop. Confirma os preços atuais. Se não tiveres dados, diz "não sei".`;
}
function setPrompt(title, text) {
  lastPrompt = { title, text };
  $('#cTitle').textContent = title; $('#cText').textContent = text;
  showTab('claude');
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
  await runList(syms, e.target); decideAll(syms); renderPortfolio();
};
$('#watch').value = S.watchlist;
$('#watch').onchange = () => { S.watchlist = $('#watch').value; save(); };
$('#btnScan').onclick = async e => {
  S.watchlist = $('#watch').value; save();
  const syms = watchSyms();
  await runList(syms, e.target); decideAll(syms); renderTop();
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
$('#sSave').onclick = () => {
  Object.entries(F).forEach(([id, k]) => { const v = $('#' + id).value.trim(); S.settings[k] = /Key$/.test(k) ? v : parseFloat(v) || 0; });
  save(); decideAll(Object.keys(results)); renderPortfolio(); renderTop(); status('Definições guardadas');
};
$('#sClear').onclick = () => { clearCache(); status('Cache limpa'); };
$('#sExport').onclick = async () => {
  const txt = JSON.stringify({ portfolio: S.portfolio, watchlist: S.watchlist, settings: { ...S.settings, tdKey: '', fhKey: '' } });
  try { await navigator.clipboard.writeText(txt); alert('Dados copiados (sem as chaves API). Guarda-os numa nota.'); } catch (e) { prompt('Copia:', txt); }
};
$('#sImport').onclick = () => {
  const t = prompt('Cola aqui os dados exportados:'); if (!t) return;
  try { const j = JSON.parse(t); S.portfolio = j.portfolio || S.portfolio; S.watchlist = j.watchlist || S.watchlist; S.settings = { ...S.settings, ...j.settings, tdKey: S.settings.tdKey, fhKey: S.settings.fhKey }; save(); location.reload(); }
  catch (e) { alert('Formato inválido'); }
};

renderPortfolio();
if (!S.settings.tdKey) { showTab('def'); status('Configura a chave API'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
