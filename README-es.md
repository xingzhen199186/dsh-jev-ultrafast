# dsh-jev-ultrafast

[English](README-en.md) | [中文](README.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> La implementación para DeepSeek Harness de jev-ultrafast: conduce un navegador real con objetivos en lenguaje natural dentro de una conversación de DSH, y el modelo Jev se encarga del control del navegador.

## Qué es esto

Añade una capacidad a DeepSeek Harness (en adelante DSH): **conducir un navegador a partir de un objetivo escrito en lenguaje natural**.

Lo habitual es que el modelo mire la página, piense un paso y haga un clic. Cada clic gasta un turno de conversación. Aquí el reparto es distinto. Primero la página se comprime en una **tabla numerada de controles** (la **tabla de elementos**). Una sola petición fija a la vez «qué operación» y «sobre qué elemento». El modelo principal solo habla al principio, para dar el objetivo, y al final, para leer el resultado. Así una tarea de varios pasos cuesta una sola llamada a herramienta.

Es un plugin (un bundle), no una skill. Registra dos herramientas y una orden con barra:

| Entrada | Qué hace |
|---|---|
| Herramienta `jev_browser_task` | Hace la tarea a partir de un objetivo de una frase. Acepta `expect` para verificar. Devuelve el resultado y el texto de la página final |
| Herramienta `jev_browser_read` | Lee una página larga pantalla a pantalla y la vuelve a unir sin repetir nada. No gasta peticiones de decisión |
| Orden `/jev-ultrafast` | Dice qué hacer directamente en el cuadro de entrada. El modelo principal no tiene que participar |

## Origen upstream

**Esto es un port, no trabajo original.** El proyecto upstream es [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use). Upstream es una implementación en Python de unas 690 líneas. Este proyecto lo reescribe en TypeScript y lo empaqueta como plugin de DSH. El repositorio propio de este proyecto es [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).

**No es un producto oficial.** Este proyecto no tiene filiación, respaldo ni patrocinio de Browser Use ni de TypeSafe. «Browser Use», «TypeSafe» y «Jev» son marcas de sus respectivos dueños. Se nombran aquí solo para indicar el origen y para decir a qué interfaces llama el plugin.

Lo que se tomó de upstream está listado pieza por pieza en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Lo esencial:

| Archivo upstream | Archivo de este proyecto | Qué se tomó |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | El script de instantánea dentro de la página, casi sin cambios |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | Las indicaciones (prompts) de decisión, casi sin cambios |
| `jev_ultrafast/model.py` | `src/decision/*` | La tabla de elementos, una petición para operación y objetivo, la comprobación de respuestas |
| `jev_ultrafast/agent.py` | `src/loop.ts` | El bucle principal, el tratamiento de decisiones caducadas, la caché de valores de texto |
| `jev_ultrafast/browser.py` | `src/browser/*` | La guarda de frescura, las comprobaciones de visibilidad y geometría antes de actuar |

Upstream depende de `browser-harness`. Se encarga de la conexión del navegador, del demonio y de los diálogos de permiso. En TypeScript no hay equivalente. Este proyecto reescribió esa parte contra el Chrome DevTools Protocol.

## Qué necesitas antes de empezar

1. **Un DSH**: el lado web (`dsh web`) o la aplicación de escritorio, cualquiera de los dos sirve. El plugin funciona en ambos lados, así que instálalo en el lado que estés usando. Pide la generación `0.2.0-rc.1` (la declaración de dependencias del plugin cubre desde `0.1.7-rc.2` hasta antes de `0.3.0`).
2. **Un navegador**: Edge o Chrome.
3. **Claves** (según la ruta que elijas): una para el servicio de decisiones y otra para el modelo de texto. El plugin no guarda ninguna clave propia. En el momento de la llamada lee las tuyas del almacén de credenciales de DSH.

## Instalación

Lado web:

```sh
dsh plugin --profile web add dsh-jev-ultrafast
```

Reinicia DSH una vez después de instalar.

Lado de escritorio:

Haz clic en **插件 (Plugins)** en la barra lateral izquierda para abrir la página de plugins, y luego en **添加插件 (Añadir plugin)**; escribe `dsh-jev-ultrafast` (o la dirección del repositorio de este proyecto, o una ruta de directorio local) y pulsa **安装 (Instalar)**. El «origen de instalación» (安装源) de ese diálogo viene por defecto en **npm 官方源**; si la red va lenta en China, cambia a **中国大陆镜像源**. Cuando termine, actívalo según te indique, y luego **reinicia la aplicación una vez**.

## Cómo se usa

Di lo que quieres directamente en el cuadro de entrada, en lenguaje natural:

“用浏览器打开 https://www.example.com 该网页读取内容”

“用jev浏览器搜索美剧《人生复本》”

“调用插件dsh-jev-ultrafast打开这个页面 https://www.example.com ”

O bien

- `/jev-ultrafast https://www.example.com 找到价格并说明是多少` — la frase incluye una dirección. No se llama a ningún modelo antes de empezar.
- `/jev-ultrafast 查一下明天北京的天气` — la frase no incluye dirección. Si nombra un sitio, se reconoce localmente. Hay 13 sitios reconocidos: 百度、必应、谷歌、知乎、微博、豆瓣、淘宝天猫、京东、小红书、抖音、B 站、维基、GitHub. Solo cuando no reconoce ninguno pregunta una vez al modelo de texto. Si no responde nada, la ejecución empieza desde un buscador, Bing por defecto.

## Configuración

La página de ajustes está en **设置 (Ajustes) → Jev 浏览器 (Navegador Jev)**.

### Las dos puertas

| Puerta | Dos rutas | Clave |
|---|---|---|
| Servicio de decisiones | TypeSafe directo; o el canal de decisiones de OpenRouter | Se lee del almacén de credenciales de DSH. El plugin no guarda ninguna |
| Modelo de texto | Siete proveedores predefinidos; o `dsh:<id del proveedor>` (un modelo ya configurado en DSH) | La ruta predefinida usa su propia clave; la ruta interna de DSH la gestiona DSH |

### Navegador: las dos formas de conexión

**El navegador que ya usas** (por defecto). Usa directamente tu estado de sesión actual. La primera vez hay que hacer esto:

1. En la barra de direcciones de ese navegador, abre `edge://inspect/#remote-debugging` (`chrome://inspect/#remote-debugging` en Chrome).
2. Marca «允许远程调试» (Permitir depuración remota).
3. Cuando aparezca el cuadro «允许远程调试?» (¿Permitir depuración remota?), pulsa Permitir. También puedes pulsar antes «连接你的浏览器» (Conecta tu navegador) en la página de ajustes, para sostener tú la conexión.

Una vez marcado, funciona tanto si el navegador está abierto como cerrado. Si está cerrado, el plugin te lo abre — sin ningún argumento, igual que hacer doble clic en el icono (desde el 2026-10-03 la línea roja «nunca iniciar tu perfil diario» se retiró por decisión del usuario). Su propio puerto de depuración viene con él.

**Solo una vez por sesión de navegador.** Cuando conecta, el plugin sostiene esa conexión. Ejecutar tareas, leer páginas y abrir pestañas nuevas no vuelven a mostrar el cuadro. Solo cerrar el navegador del todo y volver a abrirlo cuenta como sesión nueva, y entonces pregunta una vez más.

**El navegador propio del plugin.** Usa un directorio de datos aparte, independiente del tuyo diario. Para un sitio que exija inicio de sesión, inicia sesión una vez en esa ventana y se conserva.

Cuando está elegido «el navegador que ya usas», ese bloque ofrece dos cosas más:

- **Ver cuánto inicio de sesión se puede llevar**: solo cuenta cuántas cookies tiene el navegador diario y en qué dominios están. Se desconecta en seguida tras contar y no escribe nada.
- **Verter el inicio de sesión en el navegador propio del plugin**: escribe las cookies y luego comprueba sitio por sitio. Lee y escribe por el canal de depuración y no toca los archivos del perfil.

## Desarrollo y verificación

```sh
pnpm install
pnpm typecheck   # comprobación de tipos
pnpm test        # pruebas unitarias
pnpm build       # construye lib/
pnpm pack        # genera el tgz
```

Las pruebas de integración con navegador real se omiten por defecto. Para ejecutarlas, añade la variable de entorno:

```sh
JEV_BROWSER=1 pnpm test
```

## Licencia

MIT, consulta [LICENSE](LICENSE). El copyright de upstream y los avisos de terceros están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
