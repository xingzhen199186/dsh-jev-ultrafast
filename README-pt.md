# dsh-jev-ultrafast

[English](README-en.md) | [中文](README.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> Dê ao DeepSeek Harness um objetivo em uma frase. O plugin conduz um navegador de verdade e conclui a tarefa. Em cada passo, um serviço de decisão escolhe «qual operação» e «sobre qual elemento». Isso não gasta turnos de conversa do modelo principal.

## O que é isto

Ele acrescenta uma capacidade ao DeepSeek Harness (daqui em diante, DSH): **conduzir o navegador com um objetivo em linguagem natural**.

O caminho comum é o modelo olhar a página, pensar um passo e clicar. Cada clique gasta um turno de conversa. Aqui a divisão é outra. Primeiro a página vira uma **tabela de controles numerados** (daqui em diante, **tabela de elementos**). Uma requisição decide ao mesmo tempo «qual operação» e «sobre qual elemento». O modelo principal só entra no começo, para dar o objetivo, e no fim, para ler o resultado. Assim, uma tarefa de vários passos gasta uma única chamada de ferramenta.

Ele é um plugin (bundle), não uma skill. Ele registra duas ferramentas e um comando de barra:

| Entrada | O que faz |
|---|---|
| Ferramenta `jev_browser_task` | Executa um objetivo em uma frase. Aceita `expect` para conferir. Volta com o resultado e com o texto da página final |
| Ferramenta `jev_browser_read` | Lê uma página longa tela a tela e costura o texto, sem repetições. Não gasta requisição de decisão |
| Comando `/jev-ultrafast` | Você diz o que fazer direto na caixa de entrada. Sem passar pelo modelo principal |

Uma execução real (medida nesta máquina):

```text
Objetivo: pesquisar 《人生复本》 e me dar as informações gerais
Resultado: concluído · 2 passos · 5 decisões · 14,6 segundos
Parou em: 人生复本第一季 - 搜索 — https://cn.bing.com/search?q=人生复本第一季
Trecho lido na página: cerca de 12.300 resultados; episódios da 1ª temporada (S1 E5–E9); Douban 8,5/10 (21 mil pessoas)……
```

## De onde vem (upstream)

**Este é um projeto portado, não original.** O upstream é o [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use). O upstream é uma implementação em Python, com cerca de 690 linhas. Este projeto o reescreveu em TypeScript e o empacotou como plugin do DSH. O repositório deste projeto é [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).

**Ele não é oficial.** Este projeto não tem vínculo, endosso nem patrocínio da Browser Use ou da TypeSafe. «Browser Use», «TypeSafe» e «Jev» são marcas de seus respectivos titulares. As menções aqui servem apenas para dizer de onde ele vem e de quem é a API que o plugin chama.

O que veio do upstream está listado arquivo por arquivo em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Os pontos principais:

| Arquivo do upstream | Arquivo deste projeto | O que foi trazido |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | O script de snapshot dentro da página, quase sem mudança |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | Os prompts da decisão, quase sem mudança |
| `jev_ultrafast/model.py` | `src/decision/*` | A tabela de elementos, a requisição que decide operação e alvo, a checagem da resposta |
| `jev_ultrafast/agent.py` | `src/loop.ts` | O laço principal, o tratamento de decisão vencida, o cache de valores de texto |
| `jev_ultrafast/browser.py` | `src/browser/*` | A guarda de frescor, as checagens de visibilidade e de geometria antes da ação |

O upstream depende de `browser-harness`. Ele cuida da conexão com o navegador, do processo daemon e das caixas de permissão. Não existe equivalente disso em TypeScript. Este projeto reescreveu essa parte seguindo o Chrome DevTools Protocol e com **zero dependências**.

Há outros dois caminhos de origem. O repositório guarda apenas os nomes deles, sem link verificável. Aqui vai a informação como ela é:

- **browser-use**: outro projeto de agente de navegador. Este projeto pegou três coisas dele: a limpeza dos endereços nos registros (18 parâmetros de retorno de login viram `REDACTED`), a nova observação quando um número não existe mais (só para depois de 2 vezes seguidas) e o relato honesto quando o conteúdo fica dentro de um frame.
- **dsh-advisor-group**: outro plugin de DSH do mesmo autor. A tabela de fornecedores de texto deste projeto, e a pequena parte que chama o serviço de modelos do DSH, vieram dele (2026-09-29).

## O que preparar antes

1. **Node.js**: `^22.19.0 || >=24.0.0`. Confira com `node --version`.
2. **DSH**: a geração `0.2.0-rc.1`. A declaração de dependências do plugin cobre de `0.1.7-rc.2` até antes de `0.3.0`.
3. **Um navegador**: Edge ou Chrome.
4. **Duas chaves** (conforme o caminho que você escolher): a chave do serviço de decisão e a chave do modelo de texto. O plugin não traz chave embutida. Na hora da chamada, ele lê as suas do cofre de credenciais do DSH.

## Instalação

Ponta web (`dsh web`):

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast#v0.1.0
```

Por padrão o pnpm não roda os scripts de build de pacotes de código-fonte. A primeira instalação falha. Use a chave de pacote que ele imprimir, libere no `pnpm-workspace.yaml` daquele profile e instale de novo.

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

Offline, use o pacote gerado nesta máquina. Primeiro `pnpm pack`, depois:

```sh
dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz
```

**A ponta desktop segue outro caminho.** O profile do aplicativo desktop é gerido pelo próprio aplicativo. A linha de comando recusa na hora: `profile "desktop" is managed exclusively by the Electron application`. Faça assim:

1. No aplicativo, clique em **Plugins → Adicionar plugin**.
2. Cole o **caminho absoluto** do tarball.
3. Depois de instalar, clique em «Ativar agora».
4. **Reinicie o aplicativo uma vez.**

O passo 4 não é enfeite. A carga de inicialização da ponta desktop é entregue uma única vez, na abertura do aplicativo. Sem reiniciar, a página do plugin não recebe o próprio token (as ferramentas em si funcionam).

## Como usar

### Ferramenta `jev_browser_task`

Dê um objetivo em uma frase e ela conclui a tarefa. Também aceita `expect`. Escreva `expect` como «o que precisa aparecer na página quando der certo». Se não conferir, ela reporta `blocked` e não confia na autoavaliação do modelo.

Exemplo: em `goal`, «encontre o preço mais baixo deste voo e diga quanto é»; em `url`, o endereço da página de consulta; em `expect`, `["R$"]`.

### Ferramenta `jev_browser_read`

Dê um endereço e ela lê tela a tela, tira as repetições e devolve o texto costurado. Esse caminho não gasta requisição de decisão. Use para textos longos, documentação e especificações.

Não importa se a página é mais alta que uma tela. Cada tela é rolada de novo e no fim tudo vira um texto só.

### Comando `/jev-ultrafast`

Diga o que fazer direto na caixa de entrada.

- `/jev-ultrafast https://www.example.com encontre o preço e diga quanto é` — a frase tem endereço. Nenhum modelo é chamado antes de começar.
- `/jev-ultrafast veja a previsão do tempo em Pequim amanhã` — a frase não tem endereço. Se ela nomeia um site, o reconhecimento é local. São 13 sites reconhecidos: Baidu, Bing, Google, Zhihu, Weibo, Douban, Taobao/Tmall, JD, Xiaohongshu, Douyin, Bilibili, Wikipédia e GitHub. Só quando não reconhece é que ele pergunta uma vez ao modelo de texto. Se não conseguir, começa pelo buscador, com o Bing como padrão.
- `/jev-ultrafast` (sem argumentos) — devolve só uma explicação e o endereço do inspetor interativo.

O comando volta na hora. A tarefa continua no quadro de tarefas em segundo plano do DSH. No painel «Tarefas», no topo da sessão, você vê o progresso e pode parar. Ao terminar, o resultado volta.

O nome do comando só aceita ASCII, por isso ele é `/jev-ultrafast`.

### Inspetor interativo

Abra `http://127.0.0.1:3080/jev-ultrafast/inspector` no navegador. Trocar a porta ou o host também funciona. Na página de configuração, no bloco **Navegador**, o botão «Abrir o inspetor interativo» também abre.

Ali você pode começar uma execução à mão, ver a tela atual, ver qual elemento cada passo escolheu e qual a confiança do modelo. Antes de a ação ser executada, dá para «Pausar / Avançar um passo / Parar». Também dá para rever execuções antigas, quadro a quadro, no ritmo real.

## Configuração

A página fica em **Configurações → Jev browser**. Hoje são **22 campos**. Todos são do tipo «muda sem reiniciar»: salvou, valeu. E nenhum interrompe uma tarefa em andamento.

### Duas portas

| Porta | Dois caminhos | Chave |
|---|---|---|
| Serviço de decisão | TypeSafe direto; ou o canal de decisão do OpenRouter | Lida do cofre de credenciais do DSH. O plugin não guarda outra cópia |
| Modelo de texto | Sete fornecedores predefinidos; ou `dsh:<id do fornecedor>` (um modelo já configurado no DSH) | No caminho predefinido, usa a própria chave; no caminho interno do DSH, quem cuida disso é o DSH |

Os sete predefinidos são: DeepSeek oficial, OpenRouter, Alibaba Cloud Bailian, Zhipu AI, Moonshot Kimi, SiliconFlow e OpenAI.

No caminho do OpenRouter, o nome do modelo tem um til: `~typesafe/jev-latest`. **Não é erro de digitação.** Sem o til, a requisição vai para um modelo que não existe.

As duas listas de fornecedores são agrupadas por origem. Ao escolher «interno do DSH», a linha da chave vira a frase «quem cuida disso é o DSH» e nenhuma caixa de colar aparece.

No caminho interno do DSH, o plugin envia a identidade da sessão atual (`GenerateOptions.sessionId`). Rotas roteadas por sessão precisam disso. Sem isso, a rota recusa a resposta.

### Navegador: dois modos de conexão

**O navegador que você já usa** (padrão). Ele aproveita o seu estado de login atual. Na primeira vez, faça assim:

1. Na barra de endereços desse navegador, abra `edge://inspect/#remote-debugging` (no Chrome, `chrome://inspect/#remote-debugging`).
2. Marque «Permitir depuração remota».
3. Quando aparecer a caixa «Permitir depuração remota?», clique em «Permitir». Você também pode clicar antes em «Conectar o seu navegador», na página de configuração, para segurar a conexão.

Depois de marcar uma vez, funciona com o navegador aberto ou fechado. Se estiver fechado, o plugin o abre para você — sem passar nenhum parâmetro, o mesmo que dar um duplo clique no ícone (desde 2026-10-03, a regra «nunca iniciar o seu perfil do dia a dia» foi removida por decisão do usuário). A porta de depuração dele vem junto.

**Só uma vez por sessão de navegador.** Depois de conectar, o plugin segura essa conexão. Executar tarefas, ler páginas e abrir abas novas não mostram mais a caixa. Só fechar o navegador por completo e abrir de novo cria uma sessão nova, e aí ele pergunta outra vez.

**O navegador do próprio plugin.** Ele abre outro diretório de dados, separado do seu. Em sites que exigem login, faça o login uma vez nessa janela; depois ele fica guardado.

Com «o navegador que você já usa» escolhido, esse bloco ainda tem duas coisas:

- **Ver quanto login dá para levar**: só conta quantos cookies existem no navegador do dia a dia e em quais domínios. Desconecta em seguida e não escreve nada.
- **Levar o login para o navegador do plugin**: escreve os cookies lá e confere site por site. Ele lê e escreve pelo canal de depuração, sem tocar nos arquivos do perfil.

### Outros interruptores

O que se muda com frequência fica à vista. O que quase nunca muda fica em «Configurações avançadas», como o caminho do executável do navegador, o diretório de dados e os endereços e nomes de chave das duas portas.

Alguns interruptores que vale conhecer:

- **Reconhecer botões personalizados** (ligado por padrão): também lista como candidatos elementos comuns que receberam um clique por script. Em muitos sites os botões são `div` ou `span`. Desligado, ele só reconhece controles nativos.
- **Tratamento quando uma camada cobre o alvo** (ligado por padrão): quando o alvo está coberto e não dá para clicar, o plugin coloca nos candidatos o elemento que atrapalha e a opção «fechar a camada com Esc». Assim o modelo pode fechar essa camada sozinho.
- **Qual seguir quando abrem várias páginas novas** (ligado por padrão): quando um passo abre várias páginas novas, ele segue só a que combina com o objetivo do passo, pelo endereço ou pelo título. Se nenhuma combina, ele não segue e fica na página atual.
- **Controle central** (desligado por padrão): no começo da execução, outro modelo escreve uma lista conferível e a verifica durante o percurso. Sem essa marca, ele não pode declarar conclusão. Ele usa o modelo da coluna «Modelo de texto».

O limite de saída de uma decisão é `393216` por padrão. Quando o servidor recusa, o plugin lê o limite que veio na resposta e pergunta de novo com esse número.

## Limites de comportamento

- **Ele só fecha as abas que ele mesmo abriu.** Depois de seguir uma aba aberta por um clique, ela fica ali para você ver. No fim, ele fecha apenas a que ele abriu.
- **Ele não toma conta das suas abas.** Ele não troca para abas que já eram suas.
- **Nunca fecha, nunca escreve direto no perfil do seu navegador do dia a dia e nunca passa parâmetros de depuração para ele.** A cadeia que leva o login só lê desse navegador.
- **Ele não clica em caixa de diálogo nem faz login por você.** A caixa «Permitir depuração remota?» é você quem clica.
- **Não embute, não intermedeia e não revende nenhum acesso de API.** Só aceita chave própria. A chave não entra no arquivo de configuração nem no registro da sessão.
- **Cada passo deixa rastro.** Cada execução grava um `trace.jsonl` num diretório temporário. Dentro dele estão cada requisição e cada resposta de decisão. As chaves viram `***`; parâmetros de retorno de login, como `code` e `token` no endereço, viram `REDACTED`. O resultado informa o caminho desse diretório.

## Limitações conhecidas

- **O texto da página final que a ferramenta devolve tem no máximo 6000 caracteres**, e o `expect` procura só no texto da **última tela**. Então «não conferiu» quer dizer apenas que não deu para confirmar ali; não quer dizer que não aconteceu. Para ver mais longe, use `jev_browser_read`.
- **Desvios gastam passos.** Exemplo: pedir o ranking da área de anime do Bilibili pode fazer ele clicar na caixa de busca e entrar na página de resultados. Quando o alvo não está na página, ele não tem outro caminho.
- **Botão coberto é tentado até o limite.** Um botão coberto por uma camada e impossível de fechar é tentado 7 vezes; depois ele para e nomeia o que estava cobrindo.
- **Ir e voltar entre duas páginas aciona o freio.** Nove chegadas alternadas entre duas páginas e ele para. Tarefas que realmente precisam de mais de 4 idas e voltas também são interrompidas, e a frase final nomeia as duas páginas.
- **Ele não entra em elementos dentro de iframe, Shadow DOM ou canvas.** Ele diz com honestidade «o conteúdo de dentro não dá para ver». Se houver um endereço interno, ele informa.
- **Não faz upload de arquivo nem arrastar e soltar.**
- **Página que só troca imagens cai no ramo «sem mudança».** O plugin julga se o conteúdo chegou pelo texto da página, não pela rede.
- **Com «o navegador que você já usa», você não pode usar esse navegador durante os minutos da tarefa.** Enquanto o interruptor de depuração estiver ligado, em teoria outros programas desta máquina também conseguem se conectar a ele.
- **Os registros ficam no diretório temporário do sistema, incluem o texto das páginas e não são apagados automaticamente.**
- **Os cinco READMEs ficaram alinhados em estrutura e conteúdo em 2026-10-05.**
- **A versão é 0.1.0 e não é alterada sem pedido.** Este plugin não foi publicado no npm. O código está no GitHub.

## Desenvolvimento e verificação

```sh
pnpm install
pnpm typecheck   # checagem de tipos
pnpm test        # testes unitários
pnpm build       # gera lib/
pnpm pack        # gera o tgz
```

Os testes de integração com navegador de verdade são pulados por padrão. Para rodá-los, use a variável de ambiente:

```sh
JEV_BROWSER=1 pnpm test
```

Suíte atual: **44 arquivos de teste** e **724 casos**. Desses, **704 passam e 20 são pulados**. Os 20 pulados precisam de um navegador de verdade.

As evidências ficam em dois lugares:

- **Registro de execução**: cada execução grava um `trace.jsonl`, com cada requisição e cada resposta de decisão e cada chamada ao modelo de texto.
- **Documento de engenharia** [ENGINEERING.md](ENGINEERING.md): registra as mudanças passo a passo, com os números medidos e os identificadores dos registros que as sustentam.

## Fontes e ligações

- **Upstream**: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use).
- **Lista do port**: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Arquivo por arquivo, o que foi trazido e o que não foi.
- **TypeSafe Jev**: serviço externo, não distribuído com este pacote. Este pacote não contém o código, os pesos do modelo nem as credenciais dele. Os termos de serviço estão em <https://typesafe.ai/legal/terms>.
- **Repositório deste projeto**: [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).
- **A base de conhecimento local do mantenedor** (fora do controle de versão) tem outra entrada deste plugin: instalação, configuração e verificação a cada rodada.

## Licença

MIT, veja [LICENSE](LICENSE). O copyright do upstream e as notas de terceiros estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
