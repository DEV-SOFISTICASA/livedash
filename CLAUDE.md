# LiveDash — guia rápido pra quem for mexer (Claude ou humano)

Dashboard de lives TikTok Shop + Shopee das lojas do Gabriel. Tudo em `index.html` (~2,6 MB, CSS/JS/dados embutidos, 8 blocos `<script>` inline).
No ar em https://livedash-1gc1.onrender.com (site estático no Render, deploy automático no push pra `main`).
Robô de coleta: `robo/` (worker Docker no Render, passe a cada ~6 min; push fora de `robo/` não rebuilda o worker).
Estado e memória do projeto: `~/.claude/projects/C--Users-gabri/memory/livedash.md` (ler antes de codar).

## Como editar sem quebrar
- Nunca imprimir o arquivo inteiro (linhas base64 gigantes): `sed -n 'A,Bp' | cut -c1-300`, `grep -n`.
- Patch por script Node com `indexOf` do trecho exato (um marcador único) — heredoc/sed quebram nas aspas e nos `${}`.
- Depois de qualquer edição: validar os 8 blocos inline com `new Function(codigo)` (regex `<script(?![^>]*src)`). Tem que dar 8/8.
- Vars de tema são `--surface/--surface-2/--border/--text-2/--text-3/--accent` (definidas em `html[style]`); NUNCA fallback com cor fixa (vira preto no tema claro).
- `STORES` é `let` no escopo do script (no console use `STORES`, não `window.STORES`); `window.STORES_ALL` = todas as lojas antes do filtro de marketplace.
- Seção nova: HTML `data-tab-content` + `SEC_KEYS` + `TUDO_SECTIONS` + `LABELS` + chip `.tn-chip` + `NM`/`IC` da nav mobile (IC aparece 2×) + chamar o render nos 2 pontos de `render()`.
- `PREMIO` (la-premio) é o blob sincronizado entre aparelhos (pessoas, faixas, cronograma). Salvar com `savePremioOnly(true)`.

## Como testar
- Servidor local: entrada `livedash` no `~/.claude/launch.json` (porta 8129). Página deslogada: esconder `#sbAuthOverlay`, tirar `body.no-stores`, injetar lojas fictícias em `STORES` (+ `window.STORES_ALL`) e chamar o render da seção.
- O pane do app não tira print dessa página; pra ver o layout: extrair os `<style>` + o `outerHTML` renderizado num harness e usar `chrome.exe --headless=new --screenshot` (celular = iframe de 390px, o Chrome não encolhe a janela abaixo de ~500px).
- Sempre conferir em 375–390 px: nada pode rolar de lado.

## Regras do Gabriel que valem aqui
- Dinheiro absoluto em destaque, % é detalhe. Zero emoji na UI (ícones SVG). Lista sempre ordenada por gravidade.
- Chaves (Supabase/Render) só coladas no chat, nunca no repo nem na memória.
