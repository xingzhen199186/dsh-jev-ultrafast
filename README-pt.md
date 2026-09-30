# dsh-jev-ultrafast

[English](README-en.md) | [中文](README.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

> **Um objetivo entra, uma chamada de ferramenta por passo.** Dê ao DeepSeek Harness um
> objetivo em linguagem natural e deixe o **Jev** (TypeSafe) conduzir o navegador. A página
> é comprimida numa tabela indexada de controles, e uma única requisição decide *qual
> operação* executar e *sobre qual elemento* — assim a sessão gasta uma chamada de
> ferramenta em vez de um turno de modelo por clique.

O que isso rende, em resumo:

- **Uma requisição por passo.** A operação e o seu alvo voltam juntos, então não se pede ao
  modelo que olhe, pense e clique em três turnos separados.
- **Nada de seletores, coordenadas ou código dentro do laço.** Os alvos são índices de uma
  tabela que o plugin monta a partir da página viva, e antes da entrada são reconferidos
  frescor, visibilidade, geometria e oclusão.
- **Ele traz o próprio navegador.** Quando não há nada alcançável, uma execução inicia o
  Chrome ou o Edge que você escolheu e se conecta a ele — com diretório de dados próprio e
  porta livre própria.
- **Ele segue a aba que um clique abre**, e fecha apenas a aba que ele mesmo abriu.
- **`blocked` não é `failed`.** Uma execução que encontra um freio para como `blocked` e
  informa o que ainda era operável na página, então o ponto de travamento fica visível.
- **Ele também lê páginas longas.** Uma segunda ferramenta rola a página tela a tela e
  costura o texto de volta, então um documento mais longo que uma tela volta inteiro — sem
  gastar uma única requisição de decisão.
- **O `done` é conferido, não aceito por confiança.** Escreva o que a página terminada
  precisa mostrar e o plugin vai procurar; uma execução que se declare pronta sem isso volta
  como `blocked`.
- **Toda execução deixa um registro bruto.** Cada execução grava um `trace.jsonl` num
  diretório temporário próprio — o corpo da requisição e a resposta de cada chamada de
  decisão e de cada chamada ao modelo de texto, com a chave substituída por `***` e o que
  passar de 20.000 caracteres cortado — e, com as capturas ligadas, um `frames/NNNNNN.jpg`
  por passo e um `frames.json` com o nome e o horário de cada quadro (cada quadro é uma das
  capturas). O resultado informa esse diretório.
- **Uma chamada ao modelo de texto que cai é repetida; uma conexão que cai não é.** Um 429,
  503 ou 529 vindo do modelo de texto é repetido até duas vezes, esperando 0,5 s e depois
  1 s; uma quebra de rede é reportada como está, que é onde a versão Python de origem traça
  a mesma linha.
- **Dá para assistir a uma execução, não só ler sobre ela.** O host serve uma página de
  inspetor (ver «Como assistir a uma execução» abaixo): comece uma execução à mão, veja a
  tela ao vivo, veja qual elemento cada passo está prestes a escolher e quão segura está a
  decisão do modelo, e pause, avance um passo ou pare **antes** de a ação ser executada — ou
  reveja uma execução terminada quadro a quadro.
- **Dá para começar sem gastar turno de modelo.** Digite `/jev-ultrafast` e fale em linguagem
  natural logo depois — o endereço é opcional: com uma URL na frase não se chama modelo
  nenhum, e sem URL uma chamada pequena ao modelo de texto decide por onde começar. A execução
  começa na hora, com a linha de comando e o seu resultado guardados na interface; sozinho, o
  comando apenas se explica e dá o endereço do inspetor.

É um port independente e não oficial para TypeScript do
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser
Use), empacotado como bundle do DeepSeek Harness.

> **Não oficial.** Este projeto não é afiliado, endossado nem patrocinado pela Browser
> Use ou pela TypeSafe. «Browser Use», «TypeSafe» e «Jev» são marcas de seus
> respectivos titulares, usadas aqui apenas para descrever a procedência e a API que o
> plugin chama. Nenhuma licença de marca é concedida.
>
> **Traga sua própria chave.** O plugin não inclui, empacota, intermedeia nem revende
> acesso à API. Ele resolve sua chave TypeSafe no cofre de credenciais do DeepSeek
> Harness no momento da chamada, e o uso do serviço rege-se pelos termos dele.

## Compatibility

| Superfície | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` e `0.2.0-rc.1` (as duas rodam aqui); o plugin declara `>=0.1.7-rc.2 <0.3.0-0` em `peerDependencies`, então uma versão fora dessa faixa é recusada pelo portão de compatibilidade do harness antes de carregar, com o motivo impresso |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Windows, macOS, Linux |
| Desktop | Funciona no app de desktop (Electron); o perfil é gerido pelo próprio app, então a instalação é à parte — ver *Install* |
| Navegador | Chrome ou Edge: escolha um na página de ajustes e pressione 「启动并连接」, que o plugin o inicia para você (diretório de perfil próprio, porta livre própria). Você também pode iniciar um por conta própria com `--remote-debugging-port` e o plugin o encontrará — e quando não há absolutamente nada alcançável, uma tarefa inicia esse navegador por si mesma, então o botão não é pré-requisito |
| Credenciais | `TYPESAFE_API_KEY`; além disso, quando é preciso escrever num campo, uma chave para o modelo de texto: num predefinido esse nome padrão é o que a convenção do fornecedor usa (no caso do DeepSeek, `DEEPSEEK_API_KEY`), e os caminhos internos do DSH não precisam de nenhuma |

## What it does

O plugin registra duas ferramentas.

**`jev_browser_task`** conduz uma página em direção a um objetivo, rodando todo o laço dentro
de uma única chamada. Ela recebe quatro argumentos:

| Argumento | Obrigatório | Significado |
|---|---|---|
| `goal` | sim | A tarefa inteira numa frase, incluindo todo valor a digitar e todo filtro a definir. O laço vê apenas essa frase e a página atual, nunca a sua conversa. |
| `url` | sim | A página a abrir primeiro. O espaço de ações não tem uma operação de «ir para um endereço», então o ponto de entrada só pode vir daqui. |
| `maxSteps` | não | Sobrepõe o orçamento de passos só nesta execução, sem tocar na configuração. |
| `expect` | não | Textos que a página terminada precisa mostrar, escritos antes da execução e conferidos pelo plugin depois. Prefixe um deles com `!` para exigir que ele *não* esteja lá. É isso que impede o `done` de ser a última palavra do modelo que fez o trabalho. |

Ela devolve `status` (`done` / `blocked` / `failed`), `reason`, `verification`, `url`,
`title`, `text`, `steps`, `decisions`, `elapsedMs`, `actions`, `elements`,
`omittedActions` e `textCalls`, mais o caminho do diretório de registro da própria execução.
Quando o `status` é `blocked` ou `failed`, `elements` traz o que ainda era operável na
página, para ficar claro onde a execução travou. `omittedActions` conta os controles que a
página ofereceu além dos 250 que cabem na tabela; a lista de passos marca um passo sobre o
qual o próprio modelo ficou em dúvida (abaixo de metade de probabilidade); e com as capturas
ligadas ela também devolve o caminho absoluto, dentro do diretório temporário do sistema, da
imagem da última tela.

**`jev_browser_read`** lê uma página em vez de agir sobre ela. Ela recebe `url` e,
opcionalmente, `maxScreens` (padrão 20) e `maxChars` (padrão 60000). Ela recolhe o texto
visível tela a tela, descarta as linhas que telas consecutivas compartilham e devolve o texto
inteiro, então um documento mais longo que uma tela volta completo. Ela não chama nenhum
modelo de decisão e não clica em nada: este é o caminho barato, e ler é a única coisa que ela
faz. Ela para por um de quatro motivos — a página acabou, o orçamento de telas acabou, o
orçamento de caracteres acabou ou a página parou de rolar — e diz qual foi; uma tela que
encheu exatamente o limite de 6000 caracteres de uma tela é contada e sinalizada como
possivelmente cortada. Uma aba recém-aberta engole o primeiro evento de rolagem (descoberto
numa execução real), então uma tela que não se moveu é empurrada mais uma vez.

Por que ler precisa de um caminho próprio: o snapshot é só da área visível por decisão de
projeto. Ele descarta toda linha fora da tela e corta o que sobra em 6000 caracteres, e esse
mesmo texto viaja junto com *toda* requisição de decisão, então ampliá-lo encareceria cada
passo. A ferramenta de tarefa, portanto, vê uma tela; a ferramenta de leitura percorre a
página inteira.

**O que uma execução deixa para trás.** Toda execução grava num diretório temporário próprio:
um `trace.jsonl` com o corpo da requisição e a resposta de cada chamada de decisão e de cada
chamada ao modelo de texto, com a chave substituída por `***` e o que passar de 20.000
caracteres truncado; e, com as capturas ligadas, um `frames/NNNNNN.jpg` por passo e um
`frames.json` com o nome e o horário de cada quadro. O resultado informa esse diretório, então
o intercâmbio bruto pode ser lido depois.

**Como assistir a uma execução.** O host também serve um inspetor interativo em
`http://127.0.0.1:3080/jev-ultrafast/inspector`. Lá você pode começar uma execução à mão,
assistir à tela atual, ver qual elemento cada passo está selecionando e quão segura está a
decisão do modelo, e pausar, avançar um passo ou parar **antes** de a ação ser executada. Uma
execução que já aconteceu pode ser assistida de novo: os quadros dela são reproduzidos no
ritmo em que foram tirados, e o JSON bruto de cada requisição pode ser desdobrado. A página é
um arquivo HTML inteiro emitido pelo host, e não um bundle de cliente, então nada precisa ser
reconstruído para obtê-la; só a própria página dispensa token, enquanto cada endpoint que ela
chama usa o mesmo token da página de ajustes.

O laço por dentro tem quatro passos:

1. **Observar** — um script injetado lê os controles visíveis numa tabela indexada
   (papel, nome, valor atual, estado marcado/selecionado).
2. **Decidir** — uma requisição ao TypeSafe devolve a operação (`CLICK`, `TYPE_TEXT`,
   `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`) junto com um alvo
   candidato para cada operação disponível; só o alvo da operação escolhida é
   executado.
3. **Digitar** — apenas quando a operação é `TYPE_TEXT`, um modelo pequeno compatível
   com OpenAI escreve o valor do campo.
4. **Executar** — antes da entrada, frescor, visibilidade, geometria e oclusão são
   reavaliados, e a ação é registrada *antes* de observar seu resultado, para que uma
   navegação não possa apagá-la.

O modelo nunca emite seletores, coordenadas ou código executável: os alvos são índices
da tabela observada, emitidos pelo plugin.

### Ou digite o comando de barra (uma URL não gasta turno de modelo)

Digite `/jev-ultrafast` no campo de entrada:

- `/jev-ultrafast <frase>` — executa uma vez; a URL é opcional e pode aparecer em qualquer
  posição da frase, e um domínio nu (por exemplo `example.com`) também vale. Por exemplo
  `/jev-ultrafast https://www.example.com encontre o preço e diga quanto é`, ou
  `/jev-ultrafast 查一下明天北京的天气`.
  Quando a frase não traz nenhuma URL, o modelo de texto escolhido na página de ajustes responde
  por onde começar — uma chamada pequena a mais; se ele não souber dizer, a resposta pede que
  você escreva a URL.
  O comando responde na hora e a execução continua em segundo plano (dá para acompanhar o
  andamento ou pará-la no painel de tarefas da sessão); ao terminar, devolve o resultado.
- `/jev-ultrafast` sozinho — devolve apenas esta explicação e o endereço do inspetor interativo.

O comando e seu resultado ficam na interface: nunca passam a fazer parte da conversa. Uma frase
que traz uma URL não gasta nenhum turno de modelo nem nenhuma chamada de modelo; uma frase sem
URL gasta uma chamada pequena a mais, a que pergunta ao modelo de texto da página de ajustes por
onde começar. O nome só pode ser ASCII em minúsculas (é uma regra do DSH), e é por isso que é
`/jev-ultrafast` e não um nome em chinês; o endereço, quando a frase o traz, pode ficar em
qualquer posição dela e não precisa de nada à sua volta. As capturas
passo a passo continuam dependendo do interruptor «uma captura a cada passo» da página de ajustes:
com ele desligado, esta execução só deixa o registro em bruto dos seus intercâmbios.

Numa sessão totalmente nova, na primeira vez a tela pode ficar na página de boas-vindas (como se
nada tivesse acontecido): envie qualquer outra coisa e o cartão do comando já está ali na conversa.

Três freios limitam uma execução: a contagem de ações chega a `maxSteps`; as chamadas de
decisão chegam a `2 × maxSteps`; ou três passos consecutivos deixam a página sem mudança. Uma
execução que termina assim acaba como `blocked`, e não como falha — ela não chegou lá, ela não
quebrou.

O plugin abre a própria conexão com o navegador e deliberadamente **não** usa o slot
`ctx.browserUse`: ele precisa conduzir a página passo a passo, no ritmo dele, e não é para
isso que serve o contrato «entregue a página a um provedor» daquele slot.

**Ainda não feito:** o pacote não está no npm, então ele se instala de um tarball ou de um
diretório local; os resultados de ferramenta hoje usam o cartão genérico, e nenhum cartão rico
próprio foi escrito para ele; várias abas só são tratadas na medida de seguir a aba que um
clique abre (a execução nunca troca para uma aba que você já tinha); upload de arquivos e
arrastar-e-soltar, assim como qualquer coisa dentro de Shadow DOM, de iframes ou de um canvas,
nunca estiveram no espaço de ações, nem na origem nem aqui.

Dois limites da evidência valem a pena saber. A ferramenta de tarefa devolve no máximo 6000
caracteres da página final, e procura um marcador de sucesso apenas naquela tela final — um
marcador guardado mais abaixo numa página muito longa não é encontrado ali, e é por isso que
uma verificação que falha significa «não confirmado», e não «não é verdade». A ferramenta de
leitura é o caminho para olhar mais longe.

> **Estado.** O plugin está implementado: registra duas ferramentas — `jev_browser_task`,
> cujo laço é o descrito acima e o que de fato executa, e `jev_browser_read`; a versão atual
> é a `0.1.0`, uma prévia de desenvolvedor. Ainda não foi publicado no npm — instala-se de um
> tarball local (ver [Install](#install)). O próprio DeepSeek Harness está iterando rápido,
> então conte com reverificar este plugin contra ele. O plano
> por etapas e o que falta estão em [`tasks/todo.md`](tasks/todo.md).

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-jev-ultrafast-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-jev-ultrafast'
```

**No app de desktop o caminho é outro.** O perfil pertence ao aplicativo e a linha de comando
o recusa de imediato (`profile "desktop" is managed exclusively by the Electron
application`). No app, abra **插件 → 添加插件** (Plugins → Adicionar plugin), cole o
**caminho absoluto** do tarball (por exemplo `C:\Users\você\dsh-jev-ultrafast-0.1.0.tgz`),
depois clique em 立即启用 (Ativar agora) e **reinicie o app uma vez**.

Esse reinício não é o plugin sendo exigente; o motivo está fora dele. O payload de
inicialização do desktop — a lista de injeções com que a página começa — é enviado uma única
vez por inicialização do aplicativo, e ativar um plugin acontece depois disso. Sem o reinício,
a página de ajustes do plugin não consegue ver o próprio token e reporta uma linha em chinês
dizendo isso, enquanto a ferramenta em si funciona bem. O app web não tem esse passo: ele
renderiza o seu índice a cada requisição.

Antes de uma execução, duas coisas precisam estar no lugar.

A primeira é um navegador que o plugin consiga alcançar. A rota mais curta é escolher um na
própria página do plugin: **Configurações → Jev 浏览器**, escolha Chrome ou Edge no menu
suspenso do bloco do navegador, depois pressione 「启动并连接」. O plugin inicia o executável
daquele navegador com um **diretório de perfil próprio** (separado daquele em que você navega
— faça login uma vez dentro dele e ele guarda esse estado), deixa o navegador escolher uma
porta livre e deixa o endereço naquele diretório de perfil, então nenhum número de porta
precisa ser digitado e um DSH reiniciado o encontra de novo. Chrome e Edge recusam uma porta
de depuração no perfil padrão desde a versão 136, e é por isso que «o plugin inicia um limpo»
é também a única forma de um clique só. **Esse clique não é obrigatório, porém**: quando não
há nenhum navegador alcançável, uma tarefa inicia o escolhido por conta própria e se conecta a
ele, e diz isso no resultado. O botão mantém o outro uso — um site que precisa de login ganha
esse login uma vez, à mão, dentro daquela janela.

Você também pode iniciar por conta própria uma instância dedicada e deixar o botão em paz:

```sh
# Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/jev-profile --no-first-run
# Edge
msedge --remote-debugging-port=9222 --user-data-dir=/tmp/jev-profile --no-first-run
```

No Windows, escreva o caminho por extenso:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 --user-data-dir="C:\Users\<você>\jev-profile" `
  --no-first-run --no-default-browser-check
```

Com `cdpUrl` deixado vazio, o plugin procura nesta ordem: o endereço configurado → as
variáveis de ambiente `BU_CDP_URL` / `BU_CDP_WS` → o arquivo de porta que o próprio navegador
escreveu (incluindo os dois diretórios de perfil que o plugin iniciou) → as duas portas de
depuração convencionais, 9222 e 9223. Se nenhuma delas responder, ele falha com uma mensagem
em chinês dizendo como iniciar um navegador e mencionando aquele botão. Se o seu já estiver
escutando em outro lugar, defina `cdpUrl`. **Com os dois navegadores rodando, uma tarefa
conduz o que você escolheu no menu suspenso** — ele é ordenado à frente do outro, em vez de
vencer o que iniciou primeiro.

A segunda são as duas chaves. O caminho mais curto é digitá-las na própria página do plugin
nas configurações do DSH (a próxima seção), que as escreve no arquivo de credenciais do DSH;
elas também podem ser guardadas como credenciais (a decisão usa `TYPESAFE_API_KEY` por
padrão, e o modelo de texto o nome padrão do caminho escolhido) ou exportadas no ambiente
que inicia o DSH. A falta de uma
delas produz um erro em chinês que nomeia qual está ausente. As chaves nunca são escritas na
configuração — a configuração guarda os **nomes das variáveis**.

## Configuration

Cada chave pode ser alterada no `cordis.yml` ou na própria página de ajustes do plugin
(ver a seção seguinte); os nomes são planos, sem aninhamento. A coluna de padrão é o que
se obtém sem escrever nada.

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `browserKind` | `chrome` \| `edge` | `chrome` | Qual navegador o 「启动并连接」 inicia, e qual uma tarefa inicia por conta própria quando nada está alcançável. Ele ganha um diretório de perfil próprio, então isto só escolhe qual deles. |
| `browserPath` | string | vazio | Onde fica o executável daquele navegador. Só é preciso quando ele está instalado fora dos lugares usuais (uma cópia portátil, digamos). |
| `cdpUrl` | string | vazio | Porta de depuração do navegador, ex. `http://127.0.0.1:9222`; vazio = busca automática |
| `userDataDir` | string | vazio | Diretório de dados do navegador, só se usou um não padrão |
| `decisionProvider` | `typesafe` \| `openrouter` | `typesafe` | Por qual porta se chega ao serviço de decisão: o endpoint próprio da TypeSafe ou a rota alpha da OpenRouter; ver «Dois caminhos» abaixo |
| `decisionEndpoint` | string | vazio | Endereço completo do serviço de decisão; vazio usa o do provedor escolhido, só precisa ser preenchido numa rota de revenda |
| `decisionModel` | string | vazio | Nome do modelo de decisão; vazio usa o do provedor escolhido |
| `decisionKeyRef` | string | vazio | *Nome* da credencial da decisão (nome de variável de ambiente), não a chave; vazio usa o do provedor escolhido |
| `textProvider` | string | `deepseek` | Por qual caminho o modelo de texto vai: um nome predefinido (`deepseek`, `openrouter`, `bailian`, `zhipu`, `moonshot`, `siliconflow`, `openai`), ou `dsh:<id do provedor>` (um modelo já configurado no DSH); ver «Por qual caminho o modelo de texto vai» abaixo |
| `textBaseUrl` | string | vazio | Endereço compatível com OpenAI do modelo de texto; vazio usa o do caminho escolhido |
| `textModel` | string | vazio | Nome do modelo de texto; vazio usa o modelo padrão do caminho escolhido; o caminho `dsh:` não tem padrão, é preciso escolher um |
| `textKeyRef` | string | vazio | *Nome* da credencial do modelo de texto; vazio usa o nome do caminho escolhido; no caminho `dsh:` a chave fica com o próprio DSH |
| `textReasoning` | `none` \| `auto` | `none` | `none` desliga o raciocínio: preencher campo é copiar |
| `maxSteps` | number | `60` | Máximo de ações; o de decisões é o dobro |
| `screenshots` | boolean | `false` | Captura a cada passo (bem mais lento) |

A configuração é validada pelo schema Schemastery `Config` em `src/config.ts`, então um valor
inválido falha na hora de carregar em vez de rodar quebrado. As credenciais aparecem apenas
como *referências* (nomes de variáveis de ambiente) e são resolvidas a cada chamada via
`ctx.credentials`.

Os dois campos `keyRef` guardam um *nome* de credencial e carregam o papel `credential-ref`.
Todo campo é `volatile`, e é isso que permite à página de ajustes salvar e valer de imediato:
um valor alterado com o DSH rodando é usado pela próxima tarefa, sem reiniciar. O *valor* por
trás de um nome vai na linha 密钥 do bloco correspondente da página, que escreve o próprio
arquivo de credenciais do DSH — igualmente imediato.

### Por qual caminho o modelo de texto vai

O modelo de texto só é usado para «escrever num campo», e ele também tem a própria forma de
escolher caminho, em duas classes:

| Classe | O que é | Endereço e chave |
|---|---|---|
| Predefinido (`deepseek`, `openrouter`, `bailian`, `zhipu`, `moonshot`, `siliconflow`, `openai`) | uma tabela que o plugin traz | o endereço, o modelo padrão e o nome de credencial padrão vêm dessa tabela; o valor da chave é guardado no arquivo de credenciais do DSH pelo campo de colagem da página de ajustes |
| Interno do DSH (`dsh:<id do provedor>`, por exemplo `dsh:deepseek-official`) | um modelo já configurado no DSH | o endereço e a chave ficam com o próprio DSH; a página de ajustes só escolhe um modelo e não desenha campo de colagem |

Vale o caminho que for escolhido, e os outros três campos o seguem quando ficam vazios —
igual ao serviço de decisão mais abaixo—. O prefixo `dsh:` não é enfeite: no DSH também pode
haver um provedor chamado `deepseek`, e com o prefixo «o predefinido deepseek do plugin» e
«o deepseek do DSH» são duas opções lado a lado, que não se deslocam uma à outra; e um valor
já guardado também não será tomado pelo outro só porque o DSH registre depois um provedor
com o mesmo nome.

Os predefinidos aceitam apenas as casas de protocolo OpenAI porque a esta metade de texto
basta «dar uma frase e pedir um JSON». Outros protocolos como Anthropic ou Gemini funcionam
igualmente bem pelo caminho interno do DSH, sem nenhuma lacuna de capacidade.

**Um problema transitório é repetido; uma conexão quebrada não.** Uma chamada ao modelo de
texto que volta 429, 503 ou 529 é repetida até duas vezes, esperando 0,5 s e depois 1 s. Uma
queda de rede não é repetida de forma alguma e é reportada como está — a mesma linha que a
versão Python de origem traça.

**Um compromisso**: o nome de credencial padrão do predefinido DeepSeek está escrito
`DEEPSEEK_API_KEY` segundo a convenção do fornecedor, e o DSH também usa esse nome — então
esse caminho já sai de fábrica «configurado». Para que ele use uma chave só dele, ponha
outra coisa em «nome da chave» dentro de «ajustes avançados» da página de ajustes.

### Dois caminhos para o serviço de decisão

As duas portas diferem em exatamente três valores — o endereço, o nome do modelo e sob
qual nome de credencial está a chave. Como andam juntos, a configuração nomeia só a porta
e deixa os outros três segui-la; a página mostra em cinza o valor que um campo vazio vai
usar, então trocar de provedor não exige copiar nada nem deixa sobras.

| Provedor | Endereço | Modelo | Nome da credencial |
|---|---|---|---|
| TypeSafe, direto | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |

O til inicial no nome do modelo da OpenRouter não é erro de digitação: é assim que essa
rota escreve o mesmo modelo, e tirá-lo pede um modelo que não existe. Também já se viu que
essa rota quer o corpo da requisição embrulhado num envelope `decisionsRequest`, então
nessa porta o plugin envia primeiro o corpo plano e só reenvia uma vez embrulhado quando o
corpo é recusado com 400 ou 422 — uma recusa de forma, não de conteúdo. O endpoint próprio
da TypeSafe nunca embrulha. Nenhuma das duas portas foi exercitada contra um serviço real
a partir desta máquina, que não tem chave para nenhuma delas.

**De onde vem uma chave.** Os campos acima guardam nomes, não chaves; o DSH resolve o nome
numa ordem fixa: o ambiente do processo conforme herdado na inicialização, depois a seção
`refs:` do próprio arquivo de credenciais `~/.dsh/.credentials.yaml`, depois um `.env` no
diretório de trabalho e, por fim, `~/.dsh/.env`. O nome é o nome da variável, sem prefixo.

O caminho mais curto é a própria página do plugin (a seção 「密钥」 abaixo): ela escreve esse
arquivo de credenciais para você, tem efeito imediato e não exige saber onde o arquivo está.
Os outros dois caminhos continuam funcionando — defina uma variável de ambiente de mesmo
nome no mesmo terminal antes de iniciar o `dsh web`, ou acrescente uma linha sob `refs:` no
`.credentials.yaml`, que o DSH recarrega sozinho. Um `.env` também serve, mas não pode
definir nenhum nome começando por `DSH_`, pois aí o DSH se recusa a iniciar.

Há uma camada que a página não consegue mudar: **o ambiente herdado na inicialização vence,
e é lido uma única vez, naquele momento.** Quando o valor de um nome vem de lá, a página
marca aquela linha com 「这一页改不了它」 e não oferece nenhum campo, explicando por quê. Essa
recusa é deliberada: uma gravação que parecesse ter dado certo enquanto a resolução
continuasse devolvendo o valor antigo do ambiente seria pior que um «isto está fora do meu
alcance» dito com honestidade.

## A página do plugin nas configurações do DSH

Abra **Configurações → Jev 浏览器**. A página tem quatro blocos — o do **navegador**, o do
**serviço de decisão**, o do **modelo de texto** e o da **tarefa** — e cada um é disposto do
mesmo jeito: uma linha dizendo como aquela parte está agora e, logo em seguida, os controles
que a mudam. Essas linhas de estado vêm de uma ida e volta real, e não de um palpite:
«conectado» significa que um endpoint de depuração respondeu *e* que um snapshot voltou de uma
aba de verdade, e «falta uma chave» fica logo acima da caixa que resolve isso. A página nunca
te manda para outra parte dela para consertar o que acabou de reportar.

O bloco do navegador traz mais uma coisa: um menu suspenso 「用哪个浏览器」 (Chrome / Edge) e um
botão 「启动并连接」. Pressione-o e o plugin inicia aquele navegador e se conecta, escrevendo o
resultado direto nesta página. Ele salva o bloco primeiro — só aquele bloco, então nada
digitado pela metade em outro bloco é gravado por ele. Quando o executável não é encontrado,
ele lista onde procurou; abra os ajustes avançados e preencha **浏览器程序** (o programa do
navegador) para uma cópia portátil guardada em outro lugar. Abaixo desse par fica mais um botão,
「打开交互式检查器」, que leva direto à página do inspetor descrita acima; ele monta o endereço a
partir de onde você está lendo isto, então acerta em qualquer porta.

Duas coisas que ele faz e que a ferramenta sozinha não consegue relatar. Ele diz se cada nome
de credencial é resolvido — nunca qual é o valor. E 测一次决策服务 envia uma pergunta de
decisão real, que é a única forma de provar que o endereço, o nome do modelo e a chave
funcionam juntos; essa gasta uma chamada, então só roda quando você a aciona.

A configuração é editada nesses mesmos blocos. Os salvamentos passam pelo próprio serviço de
configuração do DSH, então a validação e a checagem de «alguém acabou de mudar isto» são do
harness, não nossas; a mudança cai na camada de patch do perfil como uma sobreposição
direcionada por id. Os blocos do **serviço de decisão** e do **modelo de texto** trazem cada um
o seu próprio 保存: pressionar um grava apenas os campos daquele bloco — as sobreposições que
ele guarda nos ajustes avançados incluídas — e deixa em paz as edições não salvas do outro
bloco. O botão no fim da página chama-se 保存全部改动 e grava todas as mudanças da página de
uma vez. De um jeito ou de outro, a configuração vai primeiro e as chaves coladas depois. Essa
ordem não é cosmética: um nome de credencial que você acabou de digitar num campo só passa a
poder guardar um valor depois que a configuração que o nomeia é salva, então um só clique pode
trocar um nome *e* dar um valor a ele.

O provedor é um menu suspenso, e a caixa do **modelo** logo abaixo dele pode ficar vazia: o
espaço reservado cinza mostra então o que aquela porta vai usar, de modo que trocar de provedor
não exige copiar nada nem deixa sobras. O modelo vale a pena ser visto ao lado do seu provedor,
e é por isso que ele fica no bloco; o **endereço** e o **nome da credencial** são as
sobreposições que se toca uma vez, e elas esperam atrás da seção recolhível 「高级设置」, no fim
da página.

O bloco «modelo de texto» é igual: no seu menu suspenso de **provedor** aparecem dois grupos
com título — o primeiro (「DSH 内置（由 DSH 管理地址和密钥）」) lista os modelos já
configurados no DSH e o segundo (「插件预设（本插件直连）」) os predefinidos que o plugin
traz —, e os textos das opções são nomes simples, sem prefixo; abaixo do menu suspenso
desenha-se agora mais uma linha cinza que descreve o provedor escolhido (se o caminho
escolhido for um interno do DSH essa linha não é desenhada, porque a dica do campo e a linha
da chave já dizem que o endereço e a credencial são do DSH); com o **modelo** vazio usa-se
o modelo padrão desse caminho, e a lista de candidatos daquela caixa pode ser aberta para
escolher um ou escrever por cima. Ao escolher um predefinido, aquela casa traz consigo o
endereço, o modelo e o nome da credencial, e abaixo se desenha o campo de colagem como
sempre; ao escolher o interno do DSH, aquela linha da chave é trocada por uma linha dizendo
que quem cuida dela é o próprio DSH e não se desenha campo de colagem — o endereço e a chave
desse caminho estão no DSH, fora do alcance desta página.

Abaixo dela está a seção 「密钥」. Os nomes que ela lista são exatamente os que esta
configuração vai usar: os nomes padrão das duas portas (assim a outra chave pode ficar
guardada antes de trocar de provedor) mais qualquer nome que você mesmo tenha digitado na
configuração. Cole um valor, pressione 保存 e ele é escrito no arquivo de credenciais do
DSH, usado pela próxima tarefa sem reiniciar; 清除 remove a entrada daquele arquivo. Depois
disso a página mostra apenas «configurado» e de onde o valor vem: a interface de
credenciais do DSH responde se um nome está definido, qual camada venceu e se ele é
gravável, e nunca entrega o valor a nenhuma página, então esta página não pode mostrá-lo
mesmo se quisesse. Quando o valor vem do ambiente de inicialização, não há caixa nenhuma, e a
linha diz isso.

A página já não detalha onde fica o arquivo da chave nem do que ele não protege. O caminho
aparece onde importa: quando o ambiente de inicialização encobre um nome, aquela linha
nomeia o arquivo e oferece as duas saídas. O resto pertence aqui, e não à página: o
arquivo é aberto apenas para a sua própria conta de usuário, e o DSH não entrega o
caminho dele ao modelo — mas os processos de ferramentas de uma IA rodam como o mesmo
usuário, então conseguem lê-lo. A própria documentação do DSH diz isso com mais
suavidade do que nós: é discrição, não uma fronteira. Proteger-se de uma IA local exige o
chaveiro do sistema operacional, que ainda não existe.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test          # 168 testes unitários (15 arquivos), sem chave e sem rede
pnpm run build
```

A camada de navegador tem 14 testes de integração próprios, pulados por padrão e rodados
apenas contra um navegador de verdade:

```sh
JEV_BROWSER=1 pnpm exec vitest run tests/browser.integration.test.ts
```

No Windows isso é `$env:JEV_BROWSER='1'; pnpm exec vitest run
tests/browser.integration.test.ts`. Ele se conecta à porta 9222 por padrão, ou à que
`JEV_CDP_URL` indicar.

Você também pode montá-lo sem empacotar: `dsh web --patch ./scratch/cordis.yml`, que já aponta
para o `lib/index.mjs` construído neste repositório.

O que já foi verificado até agora: 168 testes unitários passam (15 arquivos); os 14 testes de integração do
navegador passam, executados aqui contra o Edge (os 11 anteriores, contra o Chrome 153.0.8010.53 e
o Edge 154.0.4258.37, todas verdes); uma verificação `dsh-plugin-dev check` passou na ocasião,
mas esse CLI vem com a skill de desenvolvimento de plugins e já não está no PATH desta máquina,
então aquele item não foi rodado de novo; e um tarball de `pnpm pack` instala e carrega num
perfil descartável limpo. A seção de chaves da página foi exercitada contra uma instância
descartável em dezesseis verificações: guardar, a linha virar «vem do arquivo de
credenciais», o valor continuar configurado depois de reiniciar o processo, e o 清除 devolver
o nome a não configurado; um nome encoberto pelo ambiente de inicialização recusa a gravação
e diz por quê; um nome fora da lista da página (403), um valor vazio e uma requisição sem o
token são recusados cada um; e em oito corpos de resposta o valor não apareceu nenhuma vez.

A página reagrupada foi então percorrida numa instância descartável com o tarball empacotado
instalado: um 保存 muda a configuração e guarda uma chave ao mesmo tempo, e os dois valem de
imediato; um nome de credencial digitado no formulário pode guardar um valor nesse mesmo
salvamento; 清除 remove a entrada do arquivo; e um nome fornecido pelo ambiente mostra o seu
estado sem caixa de entrada.

Depois 0.2.0-rc.1 e o app de desktop também foram percorridos: o plugin passa o portão de
compatibilidade de 0.2.0-rc.1 com base naquela declaração `>=0.1.7-rc.2 <0.3.0-0` (nenhuma
linha «disabling profile plugin» no `--dump-config`); as injeções do índice continuam sendo
reconstruídas a cada requisição ali, então o token que a página recebe é o mesmo que a rota da
ferramenta aceita, e uma requisição sem ele continua sendo recusada com 403; a instalação no
desktop passou pelo 添加插件 do próprio app, com o caminho absoluto do tarball, e depois de
reiniciar o aplicativo o payload de inicialização contém `global/__JEV_ULTRAFAST_TOKEN__` e a
página reporta estado ao vivo sem erro de token; e editar o 调试端口 no desktop e salvar grava
aquela linha na camada de patch do perfil, limpar grava o valor limpo, e a página continua
utilizável nos dois salvamentos — que é a cara de um campo de configuração que de fato não
precisa de recarga.

A 0.2.8 devolveu o modelo ao bloco dele, e essa mudança foi conferida numa instância com o
pacote real instalado: o modelo de decisão fica sob o seu fornecedor com um espaço reservado
que o segue (a TypeSafe mostra `jev-latest`, a OpenRouter `~typesafe/jev-latest`), os ajustes
avançados ficam com seis itens, e a linha de nota sob cada fornecedor foi lida corretamente
nos dois estados — a da OpenRouter nomeia o canal alpha e o til — enquanto escolher o interno
do DSH já não repete o que a dica de cima e a linha da chave de baixo já dizem. A mesma versão
fixou o texto da linha 「现在」 do bloco de decisão: ela agora reporta a rota salva, o modelo
**e o nome da credencial** juntos — a caixa de chave abaixo continua seguindo o rascunho,
porque um valor precisa ser colado antes de poder ser salvo, e uma frase que misturasse a rota
salva com um nome de chave em rascunho descreveria um estado que nunca existiu (visto ao vivo:
com o fornecedor trocado mas não salvo, a linha ainda dizia `TypeSafe 官方直连 · jev-latest ·
密钥 TYPESAFE_API_KEY 还没有值。` enquanto a linha da chave já era `OPENROUTER_API_KEY`).

**Nenhuma chamada de decisão real foi feita com uma chave real** — esta máquina não tem
nenhuma. O plano por etapas e seus critérios de aceitação estão em
[`tasks/todo.md`](tasks/todo.md). A versão 0.2.9 dá ao bloco do serviço de decisão e ao bloco do modelo de texto o seu próprio botão «保存»: pressionar um grava apenas as mudanças desse bloco — as suas sobreposições nas configurações avançadas incluídas — e as edições não guardadas do outro bloco não são levadas junto; o botão no fim da página agora chama-se «保存全部改动» e grava tudo de uma vez. Numa página real isto foi verificado escrevendo uma mudança em cada bloco e pressionando o «保存» próprio do bloco de decisão: apenas a mudança do bloco de decisão foi guardada, enquanto o bloco de texto continuava a indicar uma mudança não guardada, e a sua caixa mantinha o valor não guardado. A versão 0.2.10 removeu da página de configurações aquela seção recolhível de nota de rodapé: agora a página termina na linha 「保存全部改动」, a sua única revelação restante é a dos ajustes avançados, e os dois blocos de serviço mantêm o próprio 「保存」.

O 「启动并连接」 da 0.2.12 foi rodado de verdade contra a mesma instância instalada por tarball,
duas vezes: o menu suspenso abriu já no **Edge**, que era a escolha guardada antes (então a
escolha sobrevive a um reinício de processo); um clique iniciou e conectou o **Chrome** (porta
60856 — uma porta aleatória, porque é o navegador que a escolhe, em vez de 9222 estar fixado);
trocar para Edge e clicar de novo conectou o **Edge** (`Edg/154.0.4258.37`, porta 60376)
*enquanto o Chrome ainda rodava*. Essa segunda rodada é onde o conserto de ordenação aparece:
na primeira implementação a linha de estado ainda apontava para o Chrome, porque a descoberta
não tinha posto o navegador escolhido em primeiro lugar. Captura:
`scratch/review-0212-browser-block.png`; sonda: `scratch/probe-0212c.js`.

**A 0.2.13 é a primeira execução ponta a ponta** (2026-09-29, pedida como 「用插件搜 DeepSeek
DSH 桌面版的下载页」). A metade do navegador funciona: a ferramenta realmente abriu o Bing e
leu de volta o texto da página e 20 elementos acionáveis. A metade da decisão parou em
**HTTP 401**, e a causa não estava no plugin: as duas credenciais de decisão da máquina
(`OPENROUTER_API_KEY` e `TYPESAFE_API_KEY`) são **o mesmo valor de 35 caracteres** (colado nos
dois campos), e nenhum dos dois serviços o aceita — enviado à OpenRouter ele responde «Missing
Authentication header» (não reconhece nem a forma; uma chave falsa bem formada recebe «User not
found.», então ele está de fato lendo a chave), e enviado ao endpoint próprio da TypeSafe ele
responde «Cannot authenticate with the server». Dois fatos saíram da mesma investigação: o
endpoint público de `openrouter.ai` responde 200 sem chave (então o caminho de rede está bom) e
o canal alpha da OpenRouter **aceita** uma chave bearer (então a porta OpenRouter do plugin é
viável — só precisa de uma chave de verdade). A execução também expôs um defeito real no
plugin, corrigido nesta versão: uma recusa dizia apenas «HTTP 401», o que não distingue «esta
chave não é reconhecida» de «esta requisição não é do agrado do endpoint». As palavras do
próprio serviço agora viajam junto numa linha, cortada em 240 caracteres, com a chave
substituída por `***` antes — fixado por um teste unitário. Instalado no perfil web do dia a
dia, os dois artefatos byte a byte idênticos ao repositório, `--dump-config` com saída 0.

**A 0.2.14 segue a aba que um clique abre** (no mesmo dia, mais tarde). A execução da 0.2.13
deixou uma cena reveladora: três abas de resultados do Bing realmente estavam abertas, enquanto
a execução reportava «a página não mudou por 3 passos» — todo clique tinha funcionado, o site
tinha aberto cada resultado numa aba nova, e a execução estava olhando só a aba à qual se tinha
ligado. Duas coisas mudaram. Primeiro, um passo que deixa esta aba no mesmo endereço enquanto
traz uma página nova à existência agora move a execução para essa página e diz isso, então a
próxima decisão vê o que o clique fez; um passo em que o endereço desta aba *de fato* mudou
fica onde está, e a linha do passo reporta a nova janela em vez de fingir que nada aconteceu. O
endereço é o teste, e não a página inteira, porque um resultado de busca que fica «visitado»
redesenha a página em que está — sob a regra de impressão digital que este plugin usou
primeiro, a execução ao vivo se recusou a seguir no Bing exatamente por isso. Segundo, uma
execução agora fecha apenas a aba que ela criou: a página para a qual se moveu continua aberta,
então o que a tarefa foi procurar continua lá quando ela termina. Sete testes novos (três no
laço, dois para a linha que o usuário lê, um teste de integração de navegador real que clica
num link `target="_blank"` e afirma que a segunda página foi lida), mais uma execução ao vivo
contra o serviço de decisão real — Bing → 冯时 → o artigo da 百度百科: um passo, seguido,
página final o próprio artigo, onde o mesmo objetivo levava quatro passos e terminava na
própria página de busca do Baike antes do conserto. Instalado no perfil web do dia a dia, os
dois artefatos byte a byte idênticos ao repositório, `--dump-config` com saída 0.

**A 0.2.15 faz uma tarefa iniciar o navegador por conta própria** (no mesmo dia, mais tarde). A
pergunta era se o modelo principal, chamando este plugin da página da conversa, conseguiria
iniciar e conectar em vez de mandar o leitor primeiro à página de ajustes. Consegue: iniciar um
navegador aqui é inteiramente mecânico (achar o executável, entregar-lhe um diretório de perfil,
deixar que ele escolha uma porta, esperar a porta responder), e o botão da 0.2.12 roda esse
mesmo código. «Um modelo não tem mãos» significava que um modelo não consegue iniciar um
processo sozinho — uma chamada de ferramenta é a mão do próprio plugin, e é por isso que a
fronteira se move em vez de quebrar. Então uma execução agora procura um navegador primeiro e,
quando nada está alcançável *e* nada foi fixado, inicia o navegador que a página de ajustes
nomeia — a mesma busca de executável, o mesmo diretório de perfil, o mesmo truque do arquivo de
porta — e diz isso no resultado. Duas bordas são mantidas de propósito. Um `cdpUrl` ou
`userDataDir` fixado é uma instrução, e não uma dica: quando um deles está definido e morto, a
execução reporta isso em vez de iniciar um navegador diferente, porque iniciar um navegador que
ninguém pediu é uma resposta pior do que dizer que o endereço não responde. E o modelo nunca
nomeia um executável nem uma porta: o executável vem dos ajustes, a porta do próprio navegador.
Verificado: 7 testes unitários novos (`ensureBrowser` fixando quando um navegador é iniciado,
qual deles, e quando nenhum é; `launchNote` fixando a única linha que o usuário lê), 126
passando no total; duas execuções ao vivo — uma com o diretório de perfil do plugin apontado
para um diretório descartável de modo que nada estivesse alcançável, que realmente iniciou o
Edge (`Edg/154.0.4258.37`) e se conectou a ele, depois do que aquela instância foi mandada sair
para que nenhuma janela ficasse para trás; e uma com um navegador já rodando, que não iniciou
nada. Instalado no perfil web do dia a dia, os dois artefatos byte a byte idênticos,
`--dump-config` com saída 0.

**Limites conhecidos, ditos sem rodeios**: o perfil do desktop ainda está na 0.2.1 e o `dsh
web` diário na 3080 ainda roda os artefatos antigos até ser reiniciado, então atualizar o app de
desktop significa instalar o tarball lá de novo. A própria página do inspetor só pega uma
compilação nova depois de um reinício do `dsh web`, e a sua superfície de clique ainda não foi
clicada num navegador de verdade — o que um navegador de verdade conferiu foi a *semântica* de
pausar / avançar / parar (uma pausa realmente segura o clique, liberar realmente clica, parar
de vez realmente não clica). «Gravar» significa os quadros reproduzidos no ritmo em que foram
tirados; nenhum arquivo de vídeo é produzido. O registro cai no diretório temporário do
sistema, contém texto de página, e nada o limpa automaticamente.

## License

MIT. Parte do código deriva do jev-ultrafast (MIT, © 2026 Browser Use); a lista de
arquivos derivados está em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
