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

// Formato REAL do sessionList (calibrado 01/09 com a monaco): startTime e
// duration em MILISSEGUNDOS, status 2 = encerrada (diferente de 2 = no ar),
// placedSales = GMV em reais, placedOrders = pedidos.
function shpParseLive(o, loja) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.sessionId == null || o.startTime == null) return null;
  const ini = +o.startTime;
  if (!(ini > 1e12)) return null;
  const durMs = +o.duration || 0;
  let aoVivo = (o.status != null) ? (+o.status !== 2) : !durMs;
  if (aoVivo && Date.now() - ini > 24 * 3600e3) aoVivo = false; // "no ar" ha 24h+ = dado podre
  const fim = aoVivo ? Date.now() : (ini + durMs);
  return {
    room_id: String(o.sessionId), loja, title: String(o.title || '(sem título)').slice(0, 160),
    started_at: new Date(ini).toISOString(),
    finished_at: new Date(fim).toISOString(),
    duration_min: Math.max(1, Math.round((fim - ini) / 60000)),
    gmv: +o.confirmedSales || 0, orders: +o.confirmedOrders || 0,   // só CONFIRMADOS (pedido 01/09)
    gmv_placed: +o.placedSales || 0, orders_placed: +o.placedOrders || 0,
    items: +o.confirmedItemSold || 0, items_placed: +o.placedItemSold || 0,
    views: +o.views || 0, impressions: 0, ctr: 0, gmv_hour: 0,
    avg_watch_s: Math.round((+o.avgViewsDuration || 0) / 1000),
    likes: +o.likes || 0, comments: +o.comments || 0, followers: +o.followersGrowth || 0,
    viewers: +o.viewers || 0, peak: +o.peakViewers || +o.peakViews || 0,
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
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/shopee/i.test(url) || !/live|session|insight|dashboard|\/lm\//i.test(url)) return;
      if (/deo\.shopeemobile/.test(url)) return; // estaticos/traducoes
      const ct = String(resp.headers()['content-type'] || '');
      if (!ct.includes('json')) return;
      const json = await resp.json().catch(() => null);
      if (!json) return;
      capturas.push({ url: url.slice(0, 400), corpo: json });
    } catch (e) {}
  });

  await page.goto(SHOPEE_PAGS[0], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // (02/09) O realtime/sessionList só devolve ~3 dias — era o buraco de 28-30/08.
  // O HISTÓRICO vem do liveList/v2 em janelas de 30 dias (timeDim=30d&endDate=…),
  // recuando até esvaziar. O realtime continua: pega a live EM ANDAMENTO e traz
  // views/likes que o v2 manda nulos. Merge por sessionId, v2 ganha no dinheiro.
  const SHP_RT = 'https://creator.shopee.com.br/supply/api/lm/sellercenter/realtime/sessionList';
  const SHP_V2 = 'https://creator.shopee.com.br/supply/api/lm/sellercenter/liveList/v2';
  const porId = new Map();

  // 1) realtime (recentes)
  for (let p = 1; p <= 10; p++) {
    let j = null;
    try {
      const r = await page.request.get(SHP_RT + '?page=' + p + '&pageSize=50&name=&orderBy=&sort=');
      j = await r.json();
    } catch (e) { break; }
    if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.list) || !j.data.list.length) break;
    j.data.list.forEach((o) => { const l = shpParseLive(o, loja); if (l) porId.set(l.room_id, l); });
    if (porId.size >= (+j.data.total || 0)) break;
  }

  // 2) histórico em janelas de 30 dias (até ~meio ano)
  for (let w = 0; w < 6; w++) {
    const endDate = new Date(Date.now() - w * 30 * 86400000).toISOString().slice(0, 10);
    let daJanela = 0;
    for (let p = 1; p <= 40; p++) {
      let j = null;
      try {
        const r = await page.request.get(SHP_V2 + '?page=' + p + '&pageSize=50&name=&orderBy=&sort=&timeDim=30d&endDate=' + endDate);
        j = await r.json();
      } catch (e) { break; }
      if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.list) || !j.data.list.length) break;
      j.data.list.forEach((o) => {
        const l = shpParseLive(o, loja);
        if (!l) return;
        daJanela++;
        const antes = porId.get(l.room_id);
        if (antes) {
          // O insight (v2) PROCESSA COM ATRASO: live de hoje vem zerada nele.
          // v2 só ganha quando traz dinheiro; senão o realtime (antes) prevalece
          // — foi o bug de 02/09 que ZEROU o dia corrente no painel.
          const v2TemDinheiro = (l.gmv_placed > 0 || l.orders_placed > 0 || l.gmv > 0);
          const antesTemDinheiro = (antes.gmv_placed > 0 || antes.gmv > 0 || antes.orders > 0);
          const m = (!v2TemDinheiro && antesTemDinheiro)
            ? Object.assign({}, l, antes)   // realtime ganha
            : Object.assign({}, antes, l);  // v2 ganha (live processada)
          ['views', 'likes', 'followers', 'comments', 'viewers', 'peak', 'avg_watch_s'].forEach((k) => {
            if (!m[k] && (antes[k] || l[k])) m[k] = antes[k] || l[k];
          });
          porId.set(l.room_id, m);
        } else porId.set(l.room_id, l);
      });
      if (daJanela >= (+j.data.total || 0)) break;
    }
    if (!daJanela && w > 0) break; // janela antiga vazia = fim do histórico da conta
  }

  // fallback: garimpa o que a própria página buscou (se os diretos mudarem/quebrarem)
  if (!porId.size) {
    await page.waitForTimeout(8000);
    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.waitForTimeout(3000);
    const achadas = [];
    capturas.forEach((c) => shpGarimpa(c.corpo, achadas, loja));
    achadas.forEach((l) => porId.set(l.room_id, l));
  }

  const lives = Array.from(porId.values());
  if (!lives.length && !capturas.length) throw new Error('sessão Shopee não respondeu (cookie pode ter expirado — reconecte a loja)');

  // amostra crua (sessionList primeiro) pra recalibrar o leitor se a Shopee mudar
  const ord = capturas.slice().sort((a, b) => (/sessionList|liveList/.test(b.url) ? 1 : 0) - (/sessionList|liveList/.test(a.url) ? 1 : 0));
  const amostra = ord.slice(0, 4).map((c) => ({ url: c.url, corpo_txt: JSON.stringify(c.corpo).slice(0, 12000) }));
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
