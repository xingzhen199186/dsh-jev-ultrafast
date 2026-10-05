# dsh-jev-ultrafast

[English](README-en.md) | [中文](README.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> Dale a DeepSeek Harness un objetivo en una frase. El plugin conduce un navegador real hasta terminar la tarea. En cada paso, un servicio de decisiones elige «qué operación» y «sobre qué elemento»; eso no gasta turnos de conversación del modelo principal.

## Qué es esto

Añade una capacidad a DeepSeek Harness (en adelante, DSH): **conducir el navegador con un objetivo escrito en lenguaje natural**.

Lo habitual es que el modelo mire la página, piense un paso y haga un clic. Cada clic gasta un turno de conversación. Aquí el reparto es otro. Primero, la página se comprime en una **tabla de controles con índices** (en adelante, **tabla de elementos**). Después, una sola petición decide a la vez «qué operación» y «sobre qué elemento». El modelo principal solo pone el objetivo al principio y lee el resultado al final. Por eso una tarea de varios pasos gasta una sola llamada de herramienta.

Es un plugin (bundle), no una skill. Registra dos herramientas y un comando de barra:

| Entrada | Qué hace |
|---|---|
| Herramienta `jev_browser_task` | Ejecuta un objetivo escrito en una frase. Puede llevar `expect` para verificar. Devuelve el resultado y el texto de la página final |
| Herramienta `jev_browser_read` | Lee una página larga pantalla a pantalla y vuelve a unir el texto sin duplicados. No gasta peticiones de decisión |
| Comando `/jev-ultrafast` | Di lo que hay que hacer directamente en el cuadro de entrada. No hace falta que participe el modelo principal |

Una ejecución real (medida en esta máquina):

```text
Objetivo: busca «人生复本» y dime su información general
Resultado: completado · 2 pasos · 5 decisiones · 14,6 s
Última parada: 人生复本第一季 - 搜索 — https://cn.bing.com/search?q=人生复本第一季
Lo leído en la página (extracto): unos 12 300 resultados; episodios de la temporada 1 (S1 E5–E9); Douban 8,5/10 (21 000 votos)……
```

## Origen upstream

**Este es un proyecto portado, no original.** El upstream es [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use). El upstream está escrito en Python y tiene unos 690 renglones. Este proyecto lo reescribe en TypeScript y lo empaqueta como plugin de DSH. El repositorio de este proyecto es [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).

**No es un producto oficial.** Este proyecto no tiene dependencia, respaldo ni patrocinio de Browser Use ni de TypeSafe. «Browser Use», «TypeSafe» y «Jev» son marcas de sus respectivos dueños. Aquí se mencionan solo para explicar el origen y para decir a qué interfaces llama el plugin.

Lo que se trajo del upstream está listado archivo por archivo en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Lo esencial:

| Archivo del upstream | Archivo de este proyecto | Qué se trajo |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | El script de instantánea dentro de la página, casi igual |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | Las preguntas que usa el servicio de decisiones, casi iguales |
| `jev_ultrafast/model.py` | `src/decision/*` | La tabla de elementos, una petición que decide operación y objetivo, y la comprobación de la respuesta |
| `jev_ultrafast/agent.py` | `src/loop.ts` | El bucle principal, el trato de las decisiones caducadas y la caché de valores de texto |
| `jev_ultrafast/browser.py` | `src/browser/*` | La comprobación de frescura y los controles de visibilidad y geometría antes de cada acción |

El upstream depende de `browser-harness`. Ese paquete gestiona la conexión al navegador, el proceso demonio y las ventanas de permiso. En TypeScript no hay equivalente. Este proyecto reescribió esa parte contra Chrome DevTools Protocol y **sin dependencias**.

Hay otros dos orígenes. El repositorio solo guarda sus nombres y no tiene enlaces que se puedan comprobar. Por eso aquí se dicen tal cual:

- **browser-use**: otro proyecto de agentes de navegador. Este proyecto le tomó tres cosas: borrar los parámetros de retorno de inicio de sesión en los registros (18 parámetros se sustituyen por `REDACTED`), volver a observar cuando un índice no acierta (solo se detiene si pasa más de 2 veces seguidas) e informar con sinceridad cuando el contenido está dentro de un marco.
- **dsh-advisor-group**: otro plugin de DSH del mismo autor. La tabla de proveedores de modelo de texto de este proyecto, y la parte pequeña que llama al servicio de modelos de DSH, se portaron desde él (2026-09-29).

## Qué necesitas antes de empezar

1. **Node.js**: `^22.19.0 || >=24.0.0`. Compruébalo con `node --version`.
2. **DSH**: la generación `0.2.0-rc.1`. La declaración de dependencias del plugin cubre desde `0.1.7-rc.2` hasta antes de `0.3.0`.
3. **Un navegador**: Edge o Chrome.
4. **Dos claves** (según la vía que elijas): la clave del servicio de decisiones y la clave del modelo de texto. El plugin no incluye claves. En cada llamada lee las tuyas desde el almacén de credenciales de DSH.

## Instalación

Lado web (`dsh web`):

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast#v0.1.0
```

pnpm no ejecuta los scripts de construcción de paquetes de código fuente por defecto. La primera instalación falla. Copia la clave de paquete que pnpm imprime, autorízala en el `pnpm-workspace.yaml` de ese profile y vuelve a instalar.

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

Sin red, usa el paquete que armaste en esta máquina. Primero `pnpm pack` y después:

```sh
dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz
```

**El lado de escritorio va por otro camino.** La aplicación de escritorio gestiona su propio profile. La línea de comandos lo rechaza: `profile "desktop" is managed exclusively by the Electron application`. Haz esto:

1. En la aplicación, pulsa **Plugins → Añadir plugin**.
2. Pega la **ruta absoluta** del tarball.
3. Cuando termine, pulsa «Activar ahora».
4. **Reinicia la aplicación una vez.**

El paso 4 no sobra. La carga de arranque del lado de escritorio se entrega una sola vez, al arrancar la aplicación. Sin reiniciar, la página del plugin no recibe su token (las herramientas sí funcionan).

## Cómo se usa

### Herramienta `jev_browser_task`

Dale un objetivo en una frase y lo completa. También puedes darle `expect`. Escribe en `expect` «lo que tiene que aparecer en la página cuando la tarea esté hecha». Si no se comprueba, la ejecución vuelve como `blocked`; el plugin no se cree la opinión del modelo sobre sí mismo.

Ejemplo: en `goal` escribe «encuentra el precio más bajo de este vuelo y dime cuánto es», en `url` la dirección de la página de búsqueda y en `expect` `["€"]`.

### Herramienta `jev_browser_read`

Dale una dirección. Lee la página pantalla a pantalla, quita duplicados y te la devuelve unida. Esta vía no gasta peticiones de decisión. Úsala para leer artículos largos, documentación o especificaciones.

No importa que la página sea más alta que una pantalla. El desplazamiento se repite en cada pantalla y al final se une todo en un solo texto.

### Comando `/jev-ultrafast`

Di lo que hay que hacer directamente en el cuadro de entrada.

- `/jev-ultrafast https://www.example.com encuentra el precio y dime cuánto es` — la frase lleva una dirección. Antes de arrancar no llama a ningún modelo.
- `/jev-ultrafast mira el tiempo que hará mañana en Pekín` — la frase no lleva dirección. Si la frase nombra un sitio, el plugin lo reconoce en local. Reconoce 13 sitios: Baidu, Bing, Google, Zhihu, Weibo, Douban, Taobao/Tmall, JD, Xiaohongshu, Douyin, Bilibili, Wikipedia y GitHub. Solo si no lo reconoce pregunta una vez al modelo de texto. Si tampoco hay respuesta, empieza por un buscador; por defecto, Bing.
- `/jev-ultrafast` (sin argumentos) — solo devuelve una explicación y la dirección del inspector interactivo.

El comando vuelve enseguida. La tarea sigue en segundo plano dentro de DSH. En el panel «Tareas» de la cabecera de la sesión puedes ver el avance y pararla. Cuando termina, devuelve el resultado.

El nombre del comando solo admite ASCII; por eso es `/jev-ultrafast`.

### Inspector interactivo

Abre en el navegador `http://127.0.0.1:3080/jev-ultrafast/inspector`. Funciona con otro puerto y otro host. También puedes abrirlo desde la sección **Navegador** de la página de ajustes, con el botón «Abrir el inspector interactivo».

Allí puedes iniciar una ejecución a mano, ver la pantalla actual, ver qué elemento se elige en cada paso y ver con cuánta confianza decide el modelo. Antes de ejecutar una acción puedes «Pausar / Paso a paso / Detener». También puedes revisar ejecuciones anteriores y reproducirlas fotograma a fotograma a ritmo real.

## Configuración

La página de ajustes está en **Ajustes → Jev navegador**. Hoy tiene **22 campos**. Todos son del tipo «no hace falta reiniciar»: se guardan y ya funcionan, y no interrumpen la tarea que esté corriendo.

### Dos puertas

| Puerta | Dos vías | Clave |
|---|---|---|
| Servicio de decisiones | TypeSafe directo; o el canal de decisiones de OpenRouter | Se lee del almacén de credenciales de DSH. El plugin no guarda ninguna copia |
| Modelo de texto | Siete proveedores predefinidos; o `dsh:<id del proveedor>` (un modelo ya configurado en DSH) | La vía predefinida usa su propia clave; la vía integrada de DSH la gestiona DSH |

Los siete predefinidos son: DeepSeek oficial, OpenRouter, Alibaba Cloud Bailian, Zhipu AI, Moonshot Kimi, SiliconFlow y OpenAI.

La vía de OpenRouter lleva una tilde en el nombre del modelo: `~typesafe/jev-latest`. **No es una errata.** Si la quitas, te llevará a un modelo que no existe.

Los dos desplegables de proveedor agrupan las opciones por origen. Si eliges «integrado en DSH», la fila de la clave se sustituye por una frase: «lo gestiona DSH». No se dibuja caja para pegar nada.

Cuando la vía es la integrada de DSH, el plugin envía la identidad de la sesión actual (`GenerateOptions.sessionId`). Las vías que enrutan por sesión lo necesitan. Sin eso, la vía rechaza la petición.

### Navegador: dos formas de conectarse

**El navegador que ya usas** (por defecto). Aprovecha tu sesión iniciada tal como está. La primera vez hay que hacer esto:

1. En la barra de direcciones de ese navegador, abre `edge://inspect/#remote-debugging` (en Chrome, `chrome://inspect/#remote-debugging`).
2. Marca «Permitir depuración remota».
3. Cuando aparezca la ventana «¿Permitir depuración remota?», pulsa «Permitir». También puedes pulsar antes «Conectar tu navegador» en la página de ajustes y dejar la conexión en manos del plugin.

Después de marcarlo una vez, funciona esté abierto o cerrado. Si está cerrado, el plugin te lo abre: sin pasarle ningún parámetro, igual que si hicieras doble clic en el icono (desde 2026-10-03, la línea roja «nunca arrancar tu perfil diario» se retiró por decisión del usuario). Su propio puerto de depuración viaja con él.

**Solo se permite una vez por sesión del navegador.** Una vez conectado, el plugin mantiene esa conexión. Ejecutar tareas, leer páginas y abrir pestañas nuevas ya no muestra ninguna ventana. Solo si cierras el navegador del todo y lo vuelves a abrir hay sesión nueva, y preguntará otra vez.

**El navegador propio del plugin.** Abre otro directorio de datos, separado del tuyo. En los sitios que pidan inicio de sesión, inicia sesión una vez en esa ventana y se conserva.

Con «el navegador que ya usas» seleccionado, en ese bloque hay dos cosas más que puedes hacer:

- **Ver cuántos inicios de sesión se pueden llevar**: solo cuenta cuántas cookies hay en tu navegador diario y en qué dominios están. Al terminar se desconecta en el acto y no escribe nada.
- **Llevar los inicios de sesión al navegador propio del plugin**: escribe las cookies y después comprueba sitio por sitio. Lo hace por el canal de depuración; no toca los archivos del perfil.

### Otros interruptores

Lo que se cambia a menudo está a la vista. Lo que casi nunca se cambia queda en «Ajustes avanzados»: por ejemplo, la ubicación del programa del navegador, el directorio de datos y las direcciones y nombres de clave de las dos puertas.

Algunos interruptores que conviene conocer:

- **Reconocer botones personalizados** (activado por defecto): incluye como candidatos los elementos normales que llevan un clic puesto por script. En muchos sitios el botón es un `div` o un `span`. Si lo apagas, solo se reconocen los controles nativos.
- **Qué hacer cuando una capa tapa el objetivo** (activado por defecto): cuando una capa flotante tapa el objetivo y no se puede pulsar, el plugin pone en la lista de candidatos el elemento que estorba y la acción «cerrar la capa con Esc». Así el modelo puede cerrarla por su cuenta.
- **A qué página nueva seguir cuando salen varias** (activado por defecto): si un clic abre varias páginas nuevas, sigue solo la que coincide con el objetivo del paso por dirección o por título. Si ninguna coincide, no sigue a ninguna y se queda donde estaba.
- **Control central** (desactivado por defecto): al arrancar, otro modelo escribe una lista de comprobación verificable y la revisa durante la ejecución. Si un criterio no se cumple, la ejecución no puede declararse terminada. Usa el modelo de la columna «modelo de texto».

El límite de salida de una decisión es `393216` por defecto. Si el servidor lo rechaza, el plugin lee su propio límite en la respuesta del servidor y vuelve a preguntar con ese número.

## Límites de comportamiento

- **Solo cierra las pestañas que abrió él.** Cuando sigue una pestaña abierta por un clic, esa página se queda para que la veas. Al terminar solo cierra la que abrió él.
- **No se apodera de tus pestañas.** No cambia a las pestañas que ya tenías.
- **Nunca cierra tu navegador diario, nunca escribe directamente en su perfil y nunca le pasa parámetros de depuración.** La cadena que copia inicios de sesión solo lee de ese navegador.
- **No pulsa ventanas por ti ni inicia sesión por ti.** La ventana «¿Permitir depuración remota?» la pulsas tú.
- **No incluye, no intermediia y no revende ningún acceso a API.** Solo admite claves propias. Las claves no entran en el archivo de configuración ni en el registro de la sesión.
- **Cada paso deja rastro.** Cada ejecución escribe un `trace.jsonl` en un directorio temporal. Contiene cada petición y cada respuesta de decisión. Las claves se sustituyen por `***` y los parámetros de retorno de inicio de sesión, como `code` o `token`, por `REDACTED`. El resultado indica la ruta de ese directorio.

## Limitaciones conocidas

- **La página final que devuelve la herramienta tiene como máximo 6000 caracteres**, y `expect` solo busca en el texto de la **última pantalla**. Por eso «no se comprobó» solo significa que no se confirmó ahí; no significa que la tarea no se hiciera. Si necesitas ver más lejos, usa `jev_browser_read`.
- **Los rodeos gastan pasos.** Ejemplo: si le pides la lista de éxitos de animación de Bilibili, puede pulsar antes el cuadro de búsqueda y entrar en la página de resultados. Cuando la entrada del objetivo no está en la página, no tiene otro camino.
- **Un botón tapado se reintenta hasta el límite.** Si una capa tapa un botón y no se puede cerrar, lo intenta 7 veces seguidas, se detiene y nombra lo que lo tapaba.
- **Ir y volver entre dos páginas frena la ejecución.** Se detiene tras 9 aterrizajes alternos entre dos páginas. Una tarea que de verdad necesite más de 4 rondas de ida y vuelta también se detendrá; el mensaje final nombra esas dos páginas.
- **No entra en elementos dentro de iframe, Shadow DOM ni canvas.** Dice con sinceridad «el contenido de dentro no se ve». Si hay una dirección interna, la da.
- **No hace subida de archivos ni arrastrar y soltar.**
- **Una página que solo cambia de imagen cae en la rama «sin cambios».** El plugin decide si el contenido llegó por el texto de la página, no por la red.
- **Con «el navegador que ya usas» seleccionado, no puedes usarlo a la vez durante los minutos que dura la tarea.** Mientras ese interruptor de depuración está encendido, en teoría otros programas de esta máquina también pueden conectarse a él.
- **Los rastros quedan en el directorio temporal del sistema, incluyen el texto de la página y no se limpian solos.**
- **Los cinco README quedaron alineados en estructura y contenido el 2026-10-05.**
- **La versión es 0.1.0 y no se cambia por iniciativa propia.** Este plugin no está publicado en npm. El código está en GitHub.

## Desarrollo y verificación

```sh
pnpm install
pnpm typecheck   # comprobación de tipos
pnpm test        # pruebas unitarias
pnpm build       # construye lib/
pnpm pack        # genera el tgz
```

Las pruebas de integración con navegador real se saltan por defecto. Para ejecutarlas, añade la variable de entorno:

```sh
JEV_BROWSER=1 pnpm test
```

Conjunto actual: **44 archivos de prueba** y **724 casos**. De ellos, **704 pasan y 20 se saltan**. Los 20 que se saltan necesitan un navegador real.

Las pruebas están en dos sitios:

- **Rastros de ejecución**: cada ejecución escribe un `trace.jsonl`. Contiene cada petición y cada respuesta de decisión, y cada llamada al modelo de texto.
- **Documento de ingeniería** [ENGINEERING.md](ENGINEERING.md): registra los cambios paso a paso, con las cifras medidas y los identificadores de rastro que los sostienen.

## Origen y enlaces relacionados

- **Upstream**: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use).
- **Lista de portes**: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Archivo por archivo, qué se trajo y qué no.
- **TypeSafe Jev**: servicio externo, no se distribuye con este paquete. Este paquete no incluye su código, sus pesos de modelo ni sus credenciales. Sus términos de servicio están en <https://typesafe.ai/legal/terms>.
- **Repositorio de este proyecto**: [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).
- **La base de conocimiento local del mantenedor** (no entra en el repositorio) guarda otra ficha del plugin: instalación, configuración y verificaciones una por una.

## Licencia

MIT, ver [LICENSE](LICENSE). El copyright del upstream y las notas de terceros están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
