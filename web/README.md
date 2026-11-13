# Chest Lookout

Chest Lookout é a versão web, não oficial, do ChestCounter: o **mesmo analisador de replays** do programa de Windows, compilado para WebAssembly.
Você abre a página, arrasta os arquivos `.replay` (ou a pasta `Demos` inteira) e vê o total de baús, tesouros,
partidas e companheiros.

- **Sem instalação, sem overlay, sem atualização automática.** É só uma página.
- **Nada é enviado a servidor.** Os replays são lidos dentro do navegador; o histórico fica guardado nele
  (IndexedDB). Use **Exportar histórico** para ter uma cópia, pois limpar os dados do navegador apaga tudo.
- **Mesma contagem do programa original:** `ReplayAnalyzer.cs`, `Models.cs` e `Profiles.cs` são os arquivos de
  `src/ChestCounter`, apenas referenciados por este projeto.

O que não existe aqui: contagem ao vivo durante a partida, overlay, página para OBS, abrir junto com o Fortnite.

## O que a página faz

- **Filtros** por período e por modo (solo, duplas, trios, esquadrões): valem para os números, as tabelas e a
  imagem do resumo.
- **Detalhe da partida:** clique em uma linha de *Partidas* para ver os baús na ordem em que foram abertos, os
  tesouros e a equipe. Dali também se exclui a partida (ela não volta se o replay for adicionado de novo).
- **Duas contas na mesma partida** ficam com um registro cada. Com o replay do companheiro no histórico, o
  detalhe mostra o número exato dele em vez do mínimo visto.
- **Imagem do resumo** em três formatos (4:5, 1:1 e 9:16), com ou sem o nome da conta, mostrada numa prévia
  antes de salvar ou compartilhar.
- **Proteção do histórico:** a página pede ao navegador para não apagar os dados sozinho, avisa quando há
  partidas sem backup, baixa um backup antes de *Apagar tudo* e aceita históricos antigos ou danificados sem
  quebrar.
- **Listas curtas:** partidas, tesouros e companheiros mostram poucas linhas, com "Mostrar mais / menos".
- **Gráfico de 7 ou 30 dias**, baús **por modo**, resumo de **tesouros por tipo** e a **parte de cada
  companheiro** nos baús do time.
- **Exportar sem os IDs Epic dos companheiros** (Ajustes), para mandar o histórico a outra pessoa.
- **Analisador guardado no navegador** (`sw.js`): só a primeira visita depois de cada atualização baixa tudo.
- **Abas** (Resumo, Tempestade, Gráficos, Listas) para a página não ficar comprida.
- **Tempestade:** para cada baú e tesouro, se você estava na zona segura ou dentro da tempestade, com as
  porcentagens em texto e em barras (no total, por fase e por partida) e um mapa dos pontos. É uma análise só da
  versão web (`Storm.cs`): lê o replay uma segunda vez, no modo completo do leitor, por isso a leitura demora
  mais. Partidas lidas antes dela precisam do replay de novo.
- **Mapa** (`map.js`): pontos dos baús com cor por tempestade, tipo, fase ou momento; só tesouros; calor dos
  baús; calor da rota (por onde você andou); onde você pousa (primeiro baú de cada partida). Dá para aproximar,
  arrastar e tocar num ponto para ver o baú. O detalhe de cada partida tem o mapa dela, com a rota e os baús
  numerados. Não há imagem do mapa do jogo por baixo.
- **Gráficos:** baús por minuto de partida, por dia da semana e hora, e recordes.
- **Copiar diagnóstico** (Ajustes): versão, navegador, modo do analisador e os últimos erros, para pedir ajuda.

## Manter atualizado

O formato dos replays muda com as temporadas, e o projeto original acompanha. O workflow **Update analyzer from
the original project** roda toda semana (ou à mão, em Actions): copia `lib/` e `src/` do original, reaplica as
mudanças do navegador (`web/patches/browser.patch`), confere que a versão web compila e só então salva e
republica. Se algo não encaixar, a execução falha, o GitHub avisa por e-mail e o site publicado fica como estava.

Cada publicação grava a versão no rodapé da página e no endereço dos arquivos, para o navegador não misturar
arquivos de duas versões.

## Visual

Estilo pixel / CRT com toques de battle royale: fundo azul-noite com roxo de tempestade, azul elétrico e
amarelo neon, botões e etiquetas inclinados, faixas nas cores de raridade (só decoração), bordas quadradas e
linhas de varredura (a animação de cintilação some com "reduzir movimento" no sistema). As fontes Press Start 2P,
Silkscreen e VT323 (licença OFL) ficam em `wwwroot/fonts` e são servidas pelo próprio site.

## Publicar no GitHub Pages

1. Coloque este repositório na sua conta do GitHub (fork ou repositório novo) com a branch `main`.
2. Em **Settings → Pages → Build and deployment**, escolha **Source: GitHub Actions**.
3. Em **Actions**, habilite os workflows se o GitHub pedir, abra **Web version (GitHub Pages)** e clique em
   **Run workflow** (ou faça qualquer push em `main` que mexa em `web/`).
4. Quando terminar, o endereço aparece no próprio workflow: `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

O workflow tenta compilar com AOT (leitura bem mais rápida) e, se isso falhar, publica a versão interpretada.

## Rodar no seu computador

Precisa do [.NET 10 SDK](https://dotnet.microsoft.com/download).

```
dotnet publish web/ChestCounter.Web -c Release -o out
```

Depois sirva a pasta `out/wwwroot` com qualquer servidor de arquivos estáticos (por exemplo
`npx serve out/wwwroot`) e abra o endereço indicado. Abrir o `index.html` direto do disco não funciona: o
navegador só carrega WebAssembly por `http://`.

## Como usar

1. No PC do jogo, deixe **Gravar replays** ativado no Fortnite.
2. Depois de jogar, copie os `.replay` de `%LOCALAPPDATA%\FortniteGame\Saved\Demos` para onde quiser (outro PC,
   pendrive, nuvem).
3. Abra a página e arraste os arquivos. Cada partida é contada uma vez só; arquivos repetidos são ignorados.

**Zip:** em vez de arquivos soltos, dá para escolher ou arrastar um `.zip` com os replays (também dentro de
subpastas). Os arquivos são descompactados um por vez no navegador; zip com senha não é aceito.

**Imagem do resumo:** o botão **Imagem do resumo** abre uma prévia do PNG (1080 de largura) com o total, as principais
estatísticas e os últimos 7 dias. O nome da conta só entra se a caixa ao lado estiver marcada.

**Chegar na pasta:** o botão **Copiar caminho** copia `%LOCALAPPDATA%\FortniteGame\Saved\Demos` (o Windows troca
`%LOCALAPPDATA%` pela pasta de cada usuário). Clique em **Escolher pasta**, cole na barra de endereço da janela e
aperte Enter.

**Lembrar uma pasta (Chrome e Edge):** a página guarda a pasta escolhida e o botão **Atualizar** a relê com um
clique. O navegador recusa pastas dentro de `AppData`, então isso serve para uma pasta para onde você copia os
replays (Documentos, pendrive, pasta sincronizada), não para a `Demos` original.

Replay de partida ainda em andamento não pode ser lido (o Fortnite só grava a chave no fim): adicione de novo
quando ela terminar.

## Estrutura

| Arquivo | Função |
|---|---|
| `ChestCounter.Web/Analysis.cs` | Recebe os bytes do replay, chama `ReplayAnalyzer` e devolve JSON. |
| `ChestCounter.Web/Storm.cs` | Posição do jogador e estado da tempestade em cada baú e tesouro. |
| `ChestCounter.Web/Interop.cs` | Funções exportadas para o JavaScript (`[JSExport]`). |
| `ChestCounter.Web/Shims.cs` | Substitutos mínimos das classes de desktop citadas pelos arquivos compartilhados. |
| `ChestCounter.Web/wwwroot/engine.js`, `worker.js`, `runtime.js` | Carregam o runtime .NET (em um worker) e expõem `analyze(file)`. |
| `ChestCounter.Web/wwwroot/app.js`, `stats.js`, `store.js` | Página, estatísticas e histórico. |
| `ChestCounter.Web/wwwroot/zip.js`, `summary-image.js` | Leitura de `.zip` e imagem do resumo. |
| `smoke-test.mjs`, `stamp-version.mjs` | Teste rápido e carimbo de versão do site publicado, usados pelo workflow. |
| `sync-upstream.sh`, `patches/browser.patch`, `UPSTREAM` | Atualização do analisador a partir do projeto original. |
