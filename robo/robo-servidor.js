// LiveDash · Robô-servidor
// Roda no Render (ou local). Para cada conta:
//  1. abre o painel da plataforma com os cookies (Playwright assina a chamada)
//  2. captura a URL da lista de lives que a própria página dispara e pagina
//  3. parseia e grava no Supabase
//
// TikTok: sessões tts_sessions com loja normal  -> grava tts_lives:<loja>
// Shopee: sessões tts_sessions com loja "shp-X" -> grava shp_lives:<X>
//
// Local:   node robo-servidor.js
// Cookies: sessions/<loja>.json (storageState do Playwright; Shopee = shp-<loja>.json)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SB_URL = process.env.SB_URL || 'https://nqgfxpbzybobzsrevvom.supabase.co';
const SB_KEY = process.env.SB_KEY; // service role — vem do secret
const COMPASS = 'https://shop.tiktok.com/streamer/compass/live-details/view';
const STATS = [3, 2, 20, 23, 310, 325, 39, 29, 330, 72, 343, 313];
const MAP = { 3: 'gmv', 2: 'orders', 20: 'views', 23: 'impressions', 325: 'gmv_hour', 72: 'ctr', 29: 'avg_watch_s' };

const FLAGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--disable-extensions', '--disable-features=site-per-process',
  '--renderer-process-limit=2', '--no-zygote'];

function parseLive(r, loja) {
  const met = {};
  (r.analytics_metrics || []).forEach((m) => { if (MAP[m.stats_type]) met[MAP[m.stats_type]] = +m.raw_value; });
  return {
    room_id: r.room_id, loja, title: r.room_title,
    started_at: new Date(+r.room_create_timestamp).toISOString(),
    finished_at: new Date(+r.room_finish_timestamp).toISOString(),
    duration_min: Math.round((+r.room_finish_timestamp - +r.room_create_timestamp) / 60000),
    gmv: met.gmv || 0, orders: met.orders || 0, views: met.views || 0, impressions: met.impressions || 0,
    ctr: met.ctr || 0, gmv_hour: met.gmv_hour || 0, avg_watch_s: met.avg_watch_s || 0,
  };
}

async function coletarLoja(loja, storageState) {
  // Flags de economia de memoria: o worker Starter do Render tem 512MB
  const browser = await chromium.launch({ headless: true, args: FLAGS });
  // try/finally: se estourar no meio, o browser PRECISA fechar (Chromium zumbi
  // come a memória e o passe seguinte morre de "Page crashed" — 15/08)
  try {
  const ctx = await browser.newContext({ storageState, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();

  await page.route('**/*', (rt) => {
    const t = rt.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return rt.abort();
    return rt.continue();
  });

  let signedUrl = null;
  page.on('request', (req) => {
    if (req.url().includes('detail_performance/list') && !signedUrl) signedUrl = req.url();
  });

  await page.goto(COMPASS, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const t0 = Date.now();
  while (!signedUrl && Date.now() - t0 < 45000) await page.waitForTimeout(1000);
  if (!signedUrl) throw new Error('nao capturou a URL assinada (sessao pode ter expirado)');

  // A API do TikTok so expoe os ultimos ~180 dias. Busca a janela maxima (179 dias).
  const end = Date.now();
  const start = end - 179 * 86400 * 1000;
  const vistos = new Set();
  const all = [];
  let p = 1, total = 999;
  while (all.length < total && p <= 60) {
    const body = JSON.stringify({
      time_selector: { time_range_period: 6, start_timestamp: String(start), end_timestamp: String(end), timezone: 'America/Sao_Paulo' },
      stats_types: STATS, page_number: p, page_size: 20, sort_key: 0, sort_order: 1,
    });
    const resp = await page.request.post(signedUrl, { data: body, headers: { 'content-type': 'application/json' } });
    const j = await resp.json();
    if (j.code !== 0) throw new Error('API code ' + j.code + ': ' + j.message);
    total = j.data.total_count;
    const rooms = j.data.room_level_detail_data || [];
    if (!rooms.length) break;
    for (const x of rooms) { if (!vistos.has(x.room_id)) { vistos.add(x.room_id); all.push(parseLive(x, loja)); } }
    p++;
  }
  return all;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ═══════════════ SHOPEE (mesma receita: a página busca, a gente escuta) ═══════════════
// O Creator da Shopee muda nomes de campos entre versões; o leitor entende os
// campos pelo NOME (listas de regex em ordem de preferência) e uma AMOSTRA das
// respostas cruas fica gravada em shp_descoberta:<loja> pra calibrar o leitor.

const SHOPEE_PAGS = [
  'https://creator.shopee.com.br/insight/live/list',
  'https://creator.shopee.com.br',
];

function shpAchaPrio(o, regs) {
  for (const re of regs) { for (const k of Object.keys(o)) if (re.test(k)) return o[k]; }
  return undefined;
}
function shpNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object') return shpNum(v.value != null ? v.value : v.amount);
  const n = +String(v).replace(/[^\d.-]/g, '');
  return isFinite(n) ? n : 0;
}
function shpData(v) { // aceita segundos ou milissegundos
  const n = +v;
  if (!n) return null;
  const ms = n > 1e12 ? n : (n > 1e9 ? n * 1000 : null);
  if (!ms) return null;
  const d = new Date(ms);
  return (d.getFullYear() >= 2024 && d.getFullYear() <= 2100) ? d : null;
}

function shpParseLive(o, loja) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const id = shpAchaPrio(o, [/^session_?id$/i, /^(room|live)_?id$/i]);
  const ini = shpData(shpAchaPrio(o, [/^(start|begin|create)_?(time|ts|at|timestamp)$/i]));
  if (id == null || !ini) return null;
  const fim = shpData(shpAchaPrio(o, [/^(end|finish|stop)_?(time|ts|at|timestamp)$/i]));
  const titulo = shpAchaPrio(o, [/^(session_?)?title$/i, /^(session|live|room)_?name$/i, /^name$/i, /^title$/i]);
  let gmv = shpNum(shpAchaPrio(o, [/^gmv$/i, /(sales|gmv)_?(amount|value)/i, /^order_?amount$/i, /revenue/i]));
  const orders = shpNum(shpAchaPrio(o, [/^orders?$/i, /(placed|confirmed)_?orders?($|_?(count|cnt|num))/i, /order_?(count|cnt|num)/i, /items?_?sold/i]));
  const views = shpNum(shpAchaPrio(o, [/^(uv|views?|viewers?)$/i, /unique_?(viewers?|views?)/i, /(view|watch|viewer)_?(count|cnt|num|uv)/i, /audience/i]));
  const likes = shpNum(shpAchaPrio(o, [/^likes?$/i, /like_?(count|cnt|num)/i]));
  const comments = shpNum(shpAchaPrio(o, [/^comments?$/i, /comment_?(count|cnt|num)/i]));
  if (!(views || orders || gmv || fim)) return null; // precisa de algum sinal de live real

  // dinheiro da Shopee pode vir em centavos ou x100000 (padrão interno de preço);
  // o ticket médio das lojas é ~R$20-80, então dá pra desdobrar pelo tamanho.
  if (orders > 0 && gmv > 0) {
    const ticket = gmv / orders;
    if (ticket > 200000) gmv = gmv / 100000;
    else if (ticket > 2000) gmv = gmv / 100;
  } else if (gmv > 5e7) gmv = gmv / 100000;

  const agora = new Date();
  const fimReal = fim || agora; // sem fim = AO VIVO agora (mesma semântica do TikTok)
  return {
    room_id: String(id), loja, title: String(titulo || '(sem título)').slice(0, 160),
    started_at: ini.toISOString(),
    finished_at: fimReal.toISOString(),
    duration_min: Math.max(1, Math.round((fimReal - ini) / 60000)),
    gmv: gmv || 0, orders: orders || 0, views: views || 0, impressions: 0,
    ctr: 0, gmv_hour: 0, avg_watch_s: 0,
    likes: likes || 0, comments: comments || 0,
  };
}

// procura listas de lives dentro de qualquer resposta JSON
function shpGarimpa(json, out, loja) {
  if (Array.isArray(json)) {
    json.forEach((x) => {
      const l = shpParseLive(x, loja);
      if (l) out.push(l); else shpGarimpa(x, out, loja);
    });
  } else if (json && typeof json === 'object') {
    Object.values(json).forEach((v) => shpGarimpa(v, out, loja));
  }
}

async function coletarLojaShopee(loja, storageState) {
  const browser = await chromium.launch({ headless: true, args: FLAGS });
  try {
  const ctx = await browser.newContext({ storageState, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();

  await page.route('**/*', (rt) => {
    const t = rt.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return rt.abort();
    return rt.continue();
  });

  const capturas = [];
  let listaReq = null; // a chamada que devolveu a LISTA (pra paginar do mesmo jeito)
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/shopee/i.test(url) || !/live|session|insight|dashboard|\/lm\//i.test(url)) return;
      const ct = String(resp.headers()['content-type'] || '');
      if (!ct.includes('json')) return;
      const json = await resp.json().catch(() => null);
      if (!json) return;
      capturas.push({ url: url.slice(0, 400), corpo: json });
      if (!listaReq) {
        const teste = [];
        shpGarimpa(json, teste, loja);
        if (teste.length) {
          const req = resp.request();
          listaReq = { url: resp.url(), metodo: req.method(), body: req.postData() || null };
        }
      }
    } catch (e) {}
  });

  for (const u of SHOPEE_PAGS) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(9000);
    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.waitForTimeout(3000);
    if (listaReq) break; // já achou a lista — não precisa das outras páginas
  }

  const todas = [];
  capturas.forEach((c) => shpGarimpa(c.corpo, todas, loja));

  // pagina a lista repetindo a MESMA chamada com a página seguinte
  if (listaReq) {
    const ids = new Set(todas.map((l) => l.room_id));
    for (let p = 2; p <= 40; p++) {
      let r = null;
      try {
        if (listaReq.metodo === 'GET') {
          const u = new URL(listaReq.url);
          const alvo = ['page', 'pageNo', 'pageNumber', 'page_no', 'page_num', 'pn', 'offset'].find((k) => u.searchParams.has(k));
          if (!alvo) break;
          if (alvo === 'offset') {
            const ps = +(u.searchParams.get('pageSize') || u.searchParams.get('page_size') || u.searchParams.get('limit') || 10) || 10;
            u.searchParams.set('offset', String((p - 1) * ps));
          } else u.searchParams.set(alvo, String(p));
          r = await page.request.get(u.toString());
        } else {
          let b = null;
          try { b = JSON.parse(listaReq.body || 'null'); } catch (e) {}
          if (!b || typeof b !== 'object') break;
          const alvo = ['page', 'pageNo', 'pageNumber', 'page_no', 'pageNum'].find((k) => k in b);
          if (!alvo) break;
          b[alvo] = p;
          r = await page.request.post(listaReq.url, { data: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
        }
        const j = await r.json();
        const lote = [];
        shpGarimpa(j, lote, loja);
        let novos = 0;
        lote.forEach((l) => { if (!ids.has(l.room_id)) { ids.add(l.room_id); todas.push(l); novos++; } });
        if (!lote.length || !novos) break; // página vazia ou repetida = fim
      } catch (e) { break; }
    }
  }

  const mapa = new Map();
  todas.forEach((l) => mapa.set(l.room_id, l));
  const lives = Array.from(mapa.values());
  if (!lives.length && !capturas.length) throw new Error('sessão Shopee não respondeu (cookie pode ter expirado — reconecte a loja)');

  // amostra crua (texto truncado, sempre válido) pra calibrar o leitor se precisar
  const amostra = capturas.slice(0, 4).map((c) => ({ url: c.url, corpo_txt: JSON.stringify(c.corpo).slice(0, 12000) }));
  return { lives, amostra, capturas: capturas.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ═══════════════ Supabase (comum) ═══════════════

async function lerHistorico(prefixo, loja) {
  const r = await fetch(SB_URL + '/rest/v1/livedash_state?key=eq.' + prefixo + ':' + loja + '&select=data', {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
  });
  if (r.status >= 300) return [];
  const rows = await r.json();
  return (rows[0] && rows[0].data && rows[0].data.lives) || [];
}

async function gravarSupabase(prefixo, loja, colhidas) {
  // MERGE por room_id: mantém o histórico antigo, atualiza as que voltaram, adiciona as novas
  const antigas = await lerHistorico(prefixo, loja);
  const mapa = new Map();
  for (const l of antigas) mapa.set(l.room_id, l);
  let novas = 0, atualizadas = 0;
  for (const l of colhidas) {
    if (mapa.has(l.room_id)) atualizadas++; else novas++;
    mapa.set(l.room_id, l);
  }
  const lives = Array.from(mapa.values()).sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  const payload = { _type: prefixo, loja, gerado_em: new Date().toISOString(), total: lives.length, lives };
  const r = await fetch(SB_URL + '/rest/v1/livedash_state', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: prefixo + ':' + loja, data: payload, updated_at: new Date().toISOString() }),
  });
  if (r.status >= 300) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
  return { total: lives.length, novas, atualizadas, mantidas: lives.length - novas - atualizadas };
}

async function gravarAmostraShopee(loja, amostra) {
  try {
    await fetch(SB_URL + '/rest/v1/livedash_state', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: 'shp_descoberta:' + loja, data: { gerado_em: new Date().toISOString(), amostra }, updated_at: new Date().toISOString() }),
    });
  } catch (e) {}
}

async function lerSessoes() {
  // servidor: le do Supabase (tabela tts_sessions; Shopee entra como loja "shp-X").
  // local com FONTE=local: le da pasta sessions/ (Shopee = shp-<loja>.json).
  if (process.env.FONTE === 'local') {
    const dir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('-lives'))
      .map((f) => ({ loja: f.replace('.json', ''), storageState: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  }
  const r = await fetch(SB_URL + '/rest/v1/tts_sessions?select=loja,storage_state&ativo=eq.true', {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
  });
  if (r.status >= 300) throw new Error('ler sessoes Supabase ' + r.status + ': ' + (await r.text()));
  const rows = await r.json();
  return rows.map((x) => ({ loja: x.loja, storageState: x.storage_state }));
}

(async () => {
  if (!SB_KEY) { console.log('Falta SB_KEY (service role).'); process.exit(1); }
  const contas = await lerSessoes();
  console.log('Contas a coletar:', contas.map((c) => c.loja).join(', ') || '(nenhuma)');
  for (const c of contas) {
    const ehShopee = /^shp-/.test(c.loja);
    const nome = ehShopee ? c.loja.replace(/^shp-/, '') : c.loja;
    try {
      if (ehShopee) {
        const res = await coletarLojaShopee(nome, c.storageState);
        await gravarAmostraShopee(nome, res.amostra);
        const m = await gravarSupabase('shp_lives', nome, res.lives);
        console.log('  OK shopee', nome, '-> coletadas', res.lives.length, '(capturas ' + res.capturas + ')',
          '| acumulado', m.total, '(' + m.novas + ' novas, ' + m.atualizadas + ' atualizadas)');
      } else {
        const lives = await coletarLoja(nome, c.storageState);
        const m = await gravarSupabase('tts_lives', nome, lives);
        console.log('  OK', nome, '-> coletadas', lives.length, '| acumulado', m.total,
          '(' + m.novas + ' novas, ' + m.atualizadas + ' atualizadas, ' + m.mantidas + ' guardadas)');
      }
    } catch (e) {
      console.log('  FALHOU', c.loja, '->', e.message.slice(0, 120));
    }
  }
  console.log('Fim.');
  process.exit(0);
})();
