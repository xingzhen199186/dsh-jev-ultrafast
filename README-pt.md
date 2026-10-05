# dsh-jev-ultrafast

[English](README-en.md) | [中文](README.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> A implementação para DeepSeek Harness do jev-ultrafast: conduza um navegador de verdade com objetivos em linguagem natural dentro de uma conversa do DSH, com o modelo Jev fazendo o controle do navegador.

## O que é isto

Ele acrescenta uma capacidade ao DeepSeek Harness (daqui em diante DSH): **conduzir um navegador a partir de um objetivo escrito em linguagem natural**.

O jeito comum é o modelo olhar a página, pensar um passo e clicar uma vez. Cada clique gasta um turno de conversa. Aqui a divisão é outra. Primeiro a página é comprimida em uma **tabela numerada de controles** (a **tabela de elementos**). Uma única requisição fixa ao mesmo tempo «qual operação» e «sobre qual elemento». O modelo principal só fala no começo, para dar o objetivo, e no fim, para ler o resultado. Assim uma tarefa de vários passos custa uma só chamada de ferramenta.

É um plugin (um bundle), não uma skill. Ele registra duas ferramentas e um comando de barra:

| Entrada | O que faz |
|---|---|
| Ferramenta `jev_browser_task` | Executa a tarefa a partir de um objetivo de uma frase. Aceita `expect` para verificar. Devolve o resultado e o texto da página final |
| Ferramenta `jev_browser_read` | Lê uma página longa tela por tela e a remonta sem repetições. Não gasta requisição de decisão |
| Comando `/jev-ultrafast` | Diz o que fazer direto na caixa de entrada. O modelo principal não precisa participar |

## De onde vem (upstream)

**Isto é um port, não trabalho original.** O projeto upstream é o [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use). O upstream é uma implementação em Python de cerca de 690 linhas. Este projeto o reescreve em TypeScript e o empacota como plugin do DSH. O repositório próprio deste projeto é [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).

**Não é um produto oficial.** Este projeto não tem vínculo, aval ou patrocínio do Browser Use nem do TypeSafe. «Browser Use», «TypeSafe» e «Jev» são marcas de seus respectivos donos. Eles são citados aqui apenas para indicar a origem e para dizer a quais interfaces o plugin chama.

O que foi tirado do upstream está listado peça por peça em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). O essencial:

| Arquivo upstream | Arquivo deste projeto | O que foi tirado |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | O script de instantâneo dentro da página, quase sem mudanças |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | Os prompts de decisão, quase sem mudanças |
| `jev_ultrafast/model.py` | `src/decision/*` | A tabela de elementos, uma requisição para operação e alvo, a conferência das respostas |
| `jev_ultrafast/agent.py` | `src/loop.ts` | O laço principal, o tratamento de decisões vencidas, o cache de valores de texto |
| `jev_ultrafast/browser.py` | `src/browser/*` | A guarda de frescor, as verificações de visibilidade e geometria antes da ação |

O upstream depende do `browser-harness`. Ele cuida da conexão do navegador, do daemon e das caixas de permissão. Em TypeScript não há equivalente. Este projeto reescreveu essa parte sobre o Chrome DevTools Protocol.

## O que preparar antes

1. **Node.js**: `^22.19.0 || >=24.0.0`. Confira com `node --version`.
2. **DSH**: a geração `0.2.0-rc.1`. A declaração de dependências do plugin cobre de `0.1.7-rc.2` até antes de `0.3.0`.
3. **Um navegador**: Edge ou Chrome.
4. **Duas chaves** (conforme a rota que você escolher): uma para o serviço de decisão e uma para o modelo de texto. O plugin não guarda chave própria. Na hora da chamada ele lê as suas no cofre de credenciais do DSH.

## Instalação

O mais simples é instalar pelo nome do pacote no npm. Troque `<profile>` pelo nome do seu perfil (por exemplo `web`):

```sh
dsh plugin --profile <profile> add dsh-jev-ultrafast
```

Reinicie o DSH uma vez depois de instalar. A metade externa do plugin só carrega na inicialização; sem reiniciar, a página do plugin não consegue o próprio token (as ferramentas funcionam).

Há duas alternativas.

**Instalar do GitHub** (use quando quiser acompanhar o código mais recente):

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast
```

`#v0.1.0` agora aponta para o mesmo código que o 0.1.0 do npm (a tag foi movida em 2026-10-05). Fique atento a uma coisa: este projeto mantém o número de versão em 0.1.0 e não o muda com o conteúdo, então **a cada futura atualização de conteúdo tanto essa tag quanto a versão do npm vão ficar atrás do código mais recente**. Para acompanhar o código mais recente, use a forma sem `#`, ou ponha um id de commit depois do `#`.

Instalar do GitHub leva um passo a mais: o pnpm não roda por padrão os scripts de build de um pacote de código-fonte, então a primeira instalação falha. Libere a chave de pacote que ele imprimir, no `pnpm-workspace.yaml` desse perfil, e instale de novo.

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

**Sem internet**: use um tarball empacotado na sua própria máquina. Rode `pnpm pack` primeiro e depois:

```sh
dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz
```

As linhas de comando acima só valem para perfis que a linha de comando gerencia. O aplicativo de desktop gerencia o próprio perfil `desktop`, e a linha de comando o recusa de imediato: `profile "desktop" is managed exclusively by the Electron application`. No desktop, instale assim: clique em **插件 (Plugins)** na barra lateral esquerda para abrir a página de plugins, e depois em **添加插件 (Adicionar plugin)**; digite `dsh-jev-ultrafast` (ou o endereço do repositório deste projeto, ou um caminho de pasta local) e clique em **安装 (Instalar)**. A «origem de instalação» (安装源) dessa caixa vem por padrão em **npm 官方源**; se a rede estiver lenta na China, troque para **中国大陆镜像源**. Quando terminar, ative conforme indicado, e então **reinicie o aplicativo uma vez**.

Essa reinicialização não é opcional. A carga de inicialização do desktop é enviada uma só vez, quando o aplicativo inicia. Sem a reinicialização, a página do plugin não consegue o próprio token (as ferramentas funcionam).

## Como se usa

Diga o que você quer direto na caixa de entrada, em linguagem natural:

“用浏览器打开 https://www.example.com 该网页读取内容”

“用jev浏览器搜索美剧《人生复本》”

“调用插件dsh-jev-ultrafast打开这个页面 https://www.example.com ”

Ou:

- `/jev-ultrafast https://www.example.com 找到价格并说明是多少` — a frase traz um endereço. Nenhum modelo é chamado antes de começar.
- `/jev-ultrafast 查一下明天北京的天气` — a frase não traz endereço. Se ela citar um site, ele é reconhecido localmente. São 13 sites reconhecidos: 百度、必应、谷歌、知乎、微博、豆瓣、淘宝天猫、京东、小红书、抖音、B 站、维基、GitHub. Só quando nenhum é reconhecido ele pergunta uma vez ao modelo de texto. Se este não responder nada, a execução começa por um buscador, Bing por padrão.

## Configuração

A página de ajustes fica em **设置 (Configurações) → Jev 浏览器 (Navegador Jev)**.

### As duas portas

| Porta | Duas rotas | Chave |
|---|---|---|
| Serviço de decisão | TypeSafe direto; ou o canal de decisões do OpenRouter | Lida no cofre de credenciais do DSH. O plugin não guarda nenhuma |
| Modelo de texto | Sete fornecedores predefinidos; ou `dsh:<id do fornecedor>` (um modelo já configurado no DSH) | A rota predefinida usa a chave dela; a rota interna do DSH é gerenciada pelo próprio DSH |

### Navegador: as duas formas de conexão

**O navegador que você já usa** (o padrão). Ele usa direto o seu estado de login atual. Na primeira vez, faça assim:

1. Na barra de endereços desse navegador, abra `edge://inspect/#remote-debugging` (`chrome://inspect/#remote-debugging` no Chrome).
2. Marque «允许远程调试» (Permitir depuração remota).
3. Quando aparecer a caixa «允许远程调试?» (Permitir depuração remota?), clique em Permitir. Você também pode clicar antes em «连接你的浏览器» (Conectar seu navegador) na página de ajustes, para segurar a conexão você mesmo.

Depois de marcar uma vez, funciona aberto ou fechado. Se estiver fechado, o plugin o abre para você — sem nenhum argumento, igual a dar dois cliques no ícone (desde 2026-10-03 a linha vermelha «nunca iniciar seu perfil diário» foi removida por decisão do usuário). A porta de depuração dele vem junto.

**Só uma vez por sessão de navegador.** Depois de conectar, o plugin segura essa conexão. Rodar tarefas, ler páginas e abrir abas novas não traz a caixa de volta. Só fechar o navegador por completo e abrir de novo conta como sessão nova, e aí ele pergunta mais uma vez.

**O navegador próprio do plugin.** Ele usa uma pasta de dados separada, independente da sua diária. Para um site que exija login, entre uma vez naquela janela e fica guardado.

Quando «o navegador que você já usa» está escolhido, esse bloco oferece mais duas coisas:

- **Ver quanto login dá para levar**: ele só conta quantos cookies o navegador diário tem e em quais domínios estão. Ele se desconecta logo após contar e não escreve nada.
- **Despejar o login no navegador próprio do plugin**: ele escreve os cookies e depois confere site por site. Lê e escreve pelo canal de depuração e não toca nos arquivos do perfil.

## Desenvolvimento e verificação

```sh
pnpm install
pnpm typecheck   # checagem de tipos
pnpm test        # testes unitários
pnpm build       # constrói lib/
pnpm pack        # gera o tgz
```

Os testes de integração com navegador real são pulados por padrão. Para rodá-los, acrescente a variável de ambiente:

```sh
JEV_BROWSER=1 pnpm test
```

## Licença

MIT, veja [LICENSE](LICENSE). O copyright do upstream e os avisos de terceiros estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
