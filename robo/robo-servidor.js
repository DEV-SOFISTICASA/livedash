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

  // pagina todas as lives replicando a URL assinada (paginacao vai no corpo)
  const end = Date.now();
  const start = end - 90 * 86400 * 1000;
  const all = [];
  let p = 1, total = 999;
  while (all.length < total && p <= 30) {
    const body = JSON.stringify({
      time_selector: { time_range_period: 6, start_timestamp: String(start), end_timestamp: String(end), timezone: 'America/Sao_Paulo' },
      stats_types: STATS, page_number: p, page_size: 20, sort_key: 0, sort_order: 1,
    });
    const resp = await page.request.post(signedUrl, { data: body, headers: { 'content-type': 'application/json' } });
    const j = await resp.json();
    if (j.code !== 0) throw new Error('API code ' + j.code + ': ' + j.message);
    total = j.data.total_count;
    all.push(...(j.data.room_level_detail_data || []).map((x) => parseLive(x, loja)));
    p++;
  }
  await browser.close();
  return all;
}

async function gravarSupabase(loja, lives) {
  const payload = { _type: 'tts_lives', loja, gerado_em: new Date().toISOString(), total: lives.length, lives };
  const r = await fetch(SB_URL + '/rest/v1/livedash_state', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: 'tts_lives:' + loja, data: payload, updated_at: new Date().toISOString() }),
  });
  if (r.status >= 300) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
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
      await gravarSupabase(c.loja, lives);
      console.log('  OK', c.loja, '->', lives.length, 'lives | GMV R$', lives.reduce((s, l) => s + l.gmv, 0).toFixed(2));
    } catch (e) {
      console.log('  FALHOU', c.loja, '->', e.message.slice(0, 100));
    }
  }
  console.log('Fim.');
  process.exit(0);
})();
