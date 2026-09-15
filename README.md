# LINHA DE FRENTE 🚩

RTS multiplayer de **conquista territorial** que roda no navegador — um jogo *original* no espírito do
gênero popularizado por Territorial.io / OpenFront / FrontWars: você começa com um punhado de tiles,
expande, constrói cidades e portos, concentra exércitos, lança mísseis e vence dominando **72% do mapa**
ou sendo o último império de pé.

> **Nota de originalidade (importante):** este projeto **não copia código, arte, mapas ou nome** de
> FrontWars/VexxusArts (software proprietário), nem de OpenFrontIO (AGPL-3.0) ou Territorial.io.
> Mecânicas e ideias de jogo não são protegidas por copyright; todo o código, balanceamento, arte
> vetorial e gerador de mapas aqui são autoria própria. Se você quiser redistribuir com outro nome,
> mantenha nomes/marcas de terceiros fora.

![gameplay](screens/06-tarde.png)

*Números centralizados por região (ordens de expansão/invasão não têm marcador: o fluxo das tropas é o feedback):*

![expansao](screens/11-expansao-fluxo.png)

---

## Rodando

```bash
npm install
npm run build      # bundle do cliente (public/bundle.js) + servidor (dist/server.cjs)
npm start          # http://localhost:3000  (bind 0.0.0.0)
```

| script | o que faz |
|---|---|
| `npm run build` | compila tudo (esbuild) |
| `npm run watch` | rebuild automático |
| `npm run dev` | build + sobe o servidor |
| `npm run typecheck` | `tsc --noEmit` estrito |
| `npm run simtest` | simulação headless só de bots (balanceamento/desempenho) |
| `npm test` | os 4 testes: sim, protocolo, navegador, carga |

Sem servidor por perto? O menu tem **“Jogar offline”** — a mesma simulação roda 100% no seu navegador.

---

## Como se joga

| ação | controle |
|---|---|
| mover câmera | `WASD`/setas, arrastar área vazia, arrastar no minimapa |
| zoom | roda do mouse, `Q`/`E` |
| centralizar no seu império | `C` |
| **expandir** | **clique num tile vazio**: ordem de expansão contínua naquela direção — ocupa todo espaço livre enquanto houver soldados, para em fronteira inimiga sem atacar; ao chegar no alvo, segue em frente; sem tropas, cessa; `Esc` cancela |
| **invadir** | **clique num tile inimigo**: ordem de invasão contínua — suas tropas ocupam o território dele (do clique para fora) enquanto houver soldados; sem soldados, o ataque cessa; arrastar entre tiles seus ainda faz ataque/transferência manual |
| transferir tropas | selecione um tile seu e clique em outro tile seu |
| selecionar / desmarcar | clique num tile seu (com outra origem selecionada, transfere) |
| construir | `3` cidade · `4` posto · `5` porto · `6` silo, depois clique num tile seu |
| míssil nuclear | `N`, clique no alvo (círculos = alcance/raio) |
| força do ataque | slider ou `1`/`2` |
| números de tropas | `Espaço` |
| chat | `Enter` |

**Números de tropas:** um único número **centralizado por região conectada** (não tile a tile),
crescendo em tempo real; as ordens de expansão/invasão aparecem pelo próprio movimento das tropas (sem bandeirinhas).

**Regras em uma linha:** tropas crescem por tile (teto maior em cidades), ouro vem de território +
cidades + portos, postos multiplicam a defesa, montanhas defendem mais, e a **morte súbita**
(a partir de 8 min) encolhe exércitos e anula fortificações para a partida sempre terminar.

---

## Arquitetura

```
src/
  shared/            ← simulacao autoritativa, usada pelo servidor E pelo modo offline
    constants.ts     ← TODO o balanceamento num lugar só
    mapgen.ts        ← continentes proceduralmente (value-noise + fbm, semente reproducivel)
    game.ts          ← tick, combate, construcoes, nucleares, vitoria, diffs de rede
    bot.ts           ← IA: ondas de agressao, ataques convergentes, fluxo BFS de reforco
                       (game.ts inclui a ordem de expansao: BFS do alvo + conquista só de neutro)
    codec.ts         ← base64 portatil + quantizacao de tropas (economiza banda)
    protocol.ts      ← contratos cliente<->servidor
  server/
    index.ts         ← HTTP estatico + WebSocket, salas/lobbies, loop 20Hz, broadcast 10Hz
  client/
    state.ts         ← espelho do mundo + BFS de caminho de ataque
    render.ts        ← Canvas 2D: camada base 1px/tile + upscale, fronteiras, obras, HUD de mapa
    main.ts          ← rede, input (mouse/teclado/toque), telas, modo offline
scripts/             ← testes (ver abaixo)
```

### Decisões que valem destaque

- **Servidor autoritativo, 20 Hz de simulação / 10 Hz de broadcast.** Cada cliente tem seu próprio
  “cursor de diff” (`collectChangesFor`), então quem entra no meio da partida recebe tudo e quem já
  está dentro recebe só o que mudou — com orçamento de mudanças por pacote e tropas **quantizadas**
  (passo 1 / 2 / 10 / 50) para a banda ficar pequena (~2 KB por broadcast em partida calma).
- **Uma simulação, dois mundos:** `Game` não toca em nada de Node nem de DOM, por isso o modo offline
  é literalmente o mesmo código do servidor rodando no navegador.
- **Render em camada base:** terreno+território viram um `ImageData` de `w×h` (1 px/tile) redesenhado
  só quando a posse de tiles muda (`world.rev`), e um único `drawImage` com upscale nearest-neighbor
  pinta o mapa — 60 fps com 10.560 tiles.
- **Morte súbita progressiva** (`SUDDEN_DEATH_AT`): sem ela, RTS de território puro empata para sempre
  (medido em simulação: 20 min de impasse). Com ela, toda partida termina.

### Protocolo (resumo)

```
cliente → servidor: hello | rooms | create | join | start | cmd(attack/build/nuke) | chat | leave | ping
servidor → cliente: welcome | rooms | joined | lobby | map | tick | over | chat | err | pong
```

`map` traz o terreno em base64 (1 byte/tile) + snapshot completo; `tick` traz diffs
`[índice, dono, tropas, obra]`, placar e eventos.

---

## Passe visual "OpenFront-like" (v0.2.0)

Rota híbrida: o fork do OpenFrontIO (AGPL-3.0) fica **separado**, em `../openfront-fork/`, como
referência jogável (porta 9000). **Este projeto não contém código nem assets deles** — o visual
abaixo é uma reimplementação original da *linguagem de design*:

- Oceano navy profundo (`#0a1628`) com faixa rasa mais clara e contorno escuro de costa
- Preenchimentos pastel dessaturados por jogador; montanha no mesmo tom, um ponto mais escura
- Fronteiras grossas escuras + realce interno fino (bisel), nas divisas e na costa
- Serras estilizadas (crista + neve) sobre montanhas em zoom >= 6
- Ícones flat contornados: cidade = torres ameadas, posto = escudo, porto = âncora, silo = míssil
- Um número por região, branco com contorno escuro; UI navy/azul/ouro (teal aposentado)

Screenshots originais: `screens/12-menu-azul.png`, `13-close-construcoes.png`,
`14-serras.png`, `15-costa.png` (gerados por `node scripts/visualshot.mjs`).

### Licenças (rota híbrida)

- `openfront-fork/`: clone do OpenFrontIO sob **AGPL-3.0 + Seção 7** (avisos de copyright
  preservados). Mods locais documentados no próprio fork: porta do master 3000→3200 e
  `allowedHosts` no Vite (preview do sandbox). Assets de `/resources` são CC BY-SA 4.0;
  nada de `/proprietary` é extraído ou usado.
- `linha-de-frente/` (este repo): código e arte 100% originais. Mecânicas de jogo e
  linguagem visual (ideias) não são copiáveis por copyright; nenhum trecho do repo deles
  foi copiado para cá.

---

## v0.3.0 — visual organico, HUD responsivo, balanceamento

- **Contornos "em onda"**: fronteiras e costa deixaram de ser quadradas por tile.
  O renderer traca o contorno de cada mascara (marching squares nos cantos da
  grade, selas desambiguadas) e suaviza com quadraticas pelos pontos medios;
  o preenchimento usa blend bilinear — resultado organico estilo FrontWars/OpenFront.
- **HUD responsivo**: breakpoints em 1400/1150/950/760 px; painel de ratio empilha
  acima do minimapa; barra de construcao limitada pelo espaco livre. Verificado por
  `scripts/uitest.mjs` (detector automatico de sobreposicao em 4 resolucoes).
- **Balanceamento**: crescimento com rubber-band (atrasado cresce ate 1.5x por tile,
  lider 0.8x); tile no teto transborda devagar para vizinho com folga (exercito flui);
  bots com teto de conquista de neutro por "pensada" (1/2/3 por dificuldade) e
  `FLAT_GROWTH` 1.1 -> 1.5. Simulacao comparada antes/depois: snowball do lider caiu
  de 30.2% para 26.2% aos 900 s sem travar o ritmo da partida.

---

## v0.4.0 — dinamica de exercito estilo OpenFront/FrontWars

Pesquisa (wiki + codigo-fonte do fork AGPL em `../openfront-fork`): no OpenFront o
crescimento e o teto sao **por jogador**, nao por tile:

```
maxTroops = 2 * (tiles^0.6 * 1000 + 50000) + cidades * 25000
crescimento/tick(100ms) = (10 + tropas^0.73 / 4) * (1 - tropas / maxTroops)   // pico em 42% do teto
bots: teto / 3 e crescimento x 0.5   // humano sempre outscale
```

Adaptamos a *dinamica* (nao o codigo) para a nossa escala:

- Tetos por tile altos: planicie 1000, montanha 500, cidade 12k, posto 2.5k, porto/silo 1.8k
  (antes 130/65/... — era isso que travava o exercito em `tiles x 130`).
- Crescimento linear 12/s por tile + 6% proporcional, com rubber-band e **bots com teto /3
  e crescimento x0.5 como no original** — agora o humano ultrapassa os bots.
- Ouro: renda x5 (base 1,0 + 0,04/tile + 3,2/cidade + 8,0/porto) — a taxa acompanha o imperio.
- **Invasao com compromisso total**: a ordem bombeia o exercito inteiro (BFS de fluxo,
  ate 24 transferencias/passo) para a fronteira do alvo e executa todos os ataques
  vencedores (ratio 100%, ate 12/passo); sem soldados, cessa.
- Expansao: 4 tiles neutros por passo (antes 2).

---

## Testes

| teste | comando | o que prova |
|---|---|---|
| Simulação | `npm run simtest -- 1200 12 4242` | bots jogam sozinhos: sem NaN, sem tile duplicado, eliminação e vitória acontecem, ~200-300× tempo real |
| Expansão | `node dist/expandtest.cjs 555 240` | ordem de expansão só toma neutro, **nunca** toma tile de outro jogador (para na fronteira) |
| Protocolo | `node scripts/wstest.mjs` | 13 checagens ponta-a-ponta: lobby, mapa, ataque, construção, rejeições, espectador, chat, ticks |
| Navegador | `node scripts/browser-test.mjs` | Chrome real (puppeteer): menu→lobby→partida, 60 fps, clique/arraste/construção/chat, modo offline; salva screenshots em `screens/` |
| UI/HUD | `node scripts/uitest.mjs` | sem sobreposicao de paineis em 1440/1280/1024/800 px (screens/16-ui-*.png) |
| Visual | `node scripts/visualshot.mjs` | screenshots do passe visual: menu, close de construções, serras e costa |
| Carga | `N=8 SECONDS=60 node scripts/soak.mjs` | 8 clientes agindo como humanos por 60 s: 0 quedas, ~10 ticks/s por cliente |

---

## Balanceamento

Tudo em `src/shared/constants.ts`: tetos de tropa, crescimento, custos, ouro por segundo, defesa,
alcance/raio/cooldown nuclear, tempo de morte súbita, % de vitória. O `simtest` é o seu laboratório:
mude um número, rode 20 min de partida em ~5 s e veja o placar.

## Roadmap (v0.3+)

- [ ] **Alianças e diplomacia**: pedidos/aceites, traição com debuff, comércio entre portos aliados
- [ ] **Guerra naval**: navios de guerra, interceptação de rotas comerciais, bombardeio costeiro
- [ ] Reconexão (reatachar à partida pelo token da sessão) e espectadores com câmera livre
- [ ] Contas, ranking persistente e clãs; torneios
- [ ] Protocolo binário (ArrayBuffer) + delta de fronteiras para partidas com centenas de jogadores
- [ ] Mais mapas (ilhas, anel, deserto) e editor de mapa no lobby
