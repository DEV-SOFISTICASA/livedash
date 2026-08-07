// LiveDash · Loop do worker (Render Background Worker)
// Roda o robô (robo-servidor.js) em passes contínuos, um atrás do outro.
// - Intervalo alvo entre INÍCIOS de passe: ROBO_INTERVALO_MIN (padrão 5 min)
// - Se um passe demorar mais que o intervalo, respira ROBO_RESPIRO_S (padrão 60s) e segue
// - Queda do passe não derruba o worker (spawn em processo filho)

const { spawn } = require('child_process');

const INTERVALO_MS = (parseFloat(process.env.ROBO_INTERVALO_MIN) || 5) * 60000;
const RESPIRO_MS = (parseInt(process.env.ROBO_RESPIRO_S) || 60) * 1000;

function passe() {
  return new Promise((res) => {
    const p = spawn('node', ['robo-servidor.js'], { stdio: 'inherit' });
    p.on('close', (code) => res(code));
    p.on('error', (e) => { console.log('[loop] erro ao iniciar passe:', e.message); res(-1); });
  });
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('[loop] worker LiveDash no ar · intervalo alvo:', INTERVALO_MS / 60000, 'min');
  for (let n = 1; ; n++) {
    const t0 = Date.now();
    console.log('[loop] passe #' + n + ' — ' + new Date().toISOString());
    const code = await passe();
    const dur = Date.now() - t0;
    console.log('[loop] passe #' + n + ' terminou (code ' + code + ') em ' + Math.round(dur / 1000) + 's');
    await espera(Math.max(INTERVALO_MS - dur, RESPIRO_MS));
  }
})();
