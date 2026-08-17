// LiveDash · Loop do worker (Render Background Worker)
// Roda o robô (robo-servidor.js) em passes contínuos, um atrás do outro.
// - Intervalo alvo entre INÍCIOS de passe: ROBO_INTERVALO_MIN (padrão 5 min)
// - Se um passe demorar mais que o intervalo, respira ROBO_RESPIRO_S (padrão 60s) e segue
// - Queda do passe não derruba o worker (spawn em processo filho)

const { spawn } = require('child_process');

const INTERVALO_MS = (parseFloat(process.env.ROBO_INTERVALO_MIN) || 5) * 60000;
const RESPIRO_MS = (parseInt(process.env.ROBO_RESPIRO_S) || 60) * 1000;

// Teto de tempo por passe: se o Chromium travar, o filho fica pendurado pra sempre
// e o robô inteiro para em silêncio (aconteceu 15/08 → 35h sem coleta).
const TETO_MS = (parseFloat(process.env.ROBO_TETO_MIN) || 14) * 60000;

function passe() {
  return new Promise((res) => {
    const p = spawn('node', ['robo-servidor.js'], { stdio: 'inherit' });
    let fim = false;
    const t = setTimeout(() => {
      if (fim) return;
      console.log('[loop] PASSE TRAVADO (>' + TETO_MS / 60000 + ' min) — matando e reiniciando o worker');
      try { p.kill('SIGKILL'); } catch (e) { /* já morreu */ }
      // sai com erro de propósito: o Render sobe um container limpo,
      // sem Chromium zumbi comendo memória
      setTimeout(() => process.exit(1), 3000);
    }, TETO_MS);
    p.on('close', (code) => { fim = true; clearTimeout(t); res(code); });
    p.on('error', (e) => { fim = true; clearTimeout(t); console.log('[loop] erro ao iniciar passe:', e.message); res(-1); });
  });
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('[loop] worker LiveDash no ar · intervalo alvo:', INTERVALO_MS / 60000,
              'min · teto por passe:', TETO_MS / 60000, 'min');
  let seguidasRuins = 0;
  for (let n = 1; ; n++) {
    const t0 = Date.now();
    console.log('[loop] passe #' + n + ' — ' + new Date().toISOString());
    const code = await passe();
    const dur = Date.now() - t0;
    console.log('[loop] passe #' + n + ' terminou (code ' + code + ') em ' + Math.round(dur / 1000) + 's');
    // 3 passes seguidos com erro = container provavelmente sujo: reinicia limpo
    seguidasRuins = code === 0 ? 0 : seguidasRuins + 1;
    if (seguidasRuins >= 3) {
      console.log('[loop] 3 passes seguidos com erro — reiniciando o worker');
      process.exit(1);
    }
    await espera(Math.max(INTERVALO_MS - dur, RESPIRO_MS));
  }
})();
