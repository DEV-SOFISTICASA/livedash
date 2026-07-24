// LiveDash · Robô-servidor
// Roda no GitHub Actions (ou local). Para cada conta:
//  1. abre a pagina do Compass com os cookies (Playwright assina a chamada)
//  2. captura a URL assinada e pagina TODAS as lives (replay leve)
//  3. parseia e grava no Supabase
//
// Local:   node robo-servidor.js
// Cookies: sessions/<loja>.json (storageState do Playwright)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SB_URL = process.env.SB_URL || 'https://nqgfxpbzybobzsrevvom.supabase.co';
const SB_KEY = process.env.SB_KEY; // service role — vem do secret no GitHub
const COMPASS = 'https://shop.tiktok.com/streamer/compass/live-details/view';
const STATS = [3, 2, 20, 23, 310, 325, 39, 29, 330, 72, 343, 313];
const MAP = { 3: 'gmv', 2: 'orders', 20: 'views', 23: 'impressions', 325: 'gmv_hour', 72: 'ctr', 29: 'avg_watch_s' };

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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ storageState, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();

  // captura a URL assinada da chamada de lives que a pagina dispara sozinha
  let signedUrl = null;
  page.on('request', (req) => {
    if (req.url().includes('detail_performance/list') && !signedUrl) signedUrl = req.url();
  });

  await page.goto(COMPASS, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const t0 = Date.now();
  while (!signedUrl && Date.now() - t0 < 45000) await page.waitForTimeout(1000);
  if (!signedUrl) { await browser.close(); throw new Error('nao capturou a URL assinada (sessao pode ter expirado)'); }

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
  await browser.close();
  return all;
}

async function lerHistorico(loja) {
  // lê o acumulado que já está no Supabase (pra fundir com a coleta nova)
  const r = await fetch(SB_URL + '/rest/v1/livedash_state?key=eq.tts_lives:' + loja + '&select=data', {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
  });
  if (r.status >= 300) return [];
  const rows = await r.json();
  return (rows[0] && rows[0].data && rows[0].data.lives) || [];
}

async function gravarSupabase(loja, colhidas) {
  // MERGE por room_id: mantém o histórico antigo, atualiza as que voltaram, adiciona as novas
  const antigas = await lerHistorico(loja);
  const mapa = new Map();
  for (const l of antigas) mapa.set(l.room_id, l);       // base = histórico guardado
  let novas = 0, atualizadas = 0;
  for (const l of colhidas) {
    if (mapa.has(l.room_id)) atualizadas++; else novas++;
    mapa.set(l.room_id, l);                                // coleta nova sobrescreve os números
  }
  const lives = Array.from(mapa.values()).sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  const payload = { _type: 'tts_lives', loja, gerado_em: new Date().toISOString(), total: lives.length, lives };
  const r = await fetch(SB_URL + '/rest/v1/livedash_state', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: 'tts_lives:' + loja, data: payload, updated_at: new Date().toISOString() }),
  });
  if (r.status >= 300) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
  return { total: lives.length, novas, atualizadas, mantidas: lives.length - novas - atualizadas };
}

async function lerSessoes() {
  // servidor (GitHub): le do Supabase (tabela tts_sessions).
  // local com FONTE=local: le da pasta sessions/ (pra testar).
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
    try {
      const lives = await coletarLoja(c.loja, c.storageState);
      const m = await gravarSupabase(c.loja, lives);
      console.log('  OK', c.loja, '-> coletadas', lives.length, '| acumulado', m.total,
        '(' + m.novas + ' novas, ' + m.atualizadas + ' atualizadas, ' + m.mantidas + ' guardadas)');
    } catch (e) {
      console.log('  FALHOU', c.loja, '->', e.message.slice(0, 100));
    }
  }
  console.log('Fim.');
  process.exit(0);
})();
