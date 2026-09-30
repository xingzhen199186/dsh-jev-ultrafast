# dsh-jev-ultrafast

[English](README-en.md) | [中文](README.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

> **Un objetivo de entrada, una llamada de herramienta por paso.** Dale a DeepSeek Harness
> un objetivo en lenguaje natural y deja que **Jev** (TypeSafe) conduzca el navegador. La
> página se comprime en una tabla indexada de controles, y una sola petición decide a la vez
> *qué operación* ejecutar y *sobre qué elemento* ejecutarla — así la sesión paga una llamada
> de herramienta en lugar de un turno de modelo por cada clic.

Qué se gana con eso, en resumen:

- **Una petición por paso.** La operación y su objetivo vuelven juntos, así que no se le pide
  al modelo mirar, pensar y hacer clic a lo largo de tres turnos distintos.
- **Sin selectores, coordenadas ni código en el bucle.** Los objetivos son índices de una
  tabla que el plugin fabrica a partir de la página viva, y la frescura, la visibilidad, la
  geometría y la oclusión se vuelven a comprobar justo antes de la entrada.
- **Trae su propio navegador.** Cuando no hay nada alcanzable, una ejecución arranca el
  Chrome o el Edge que hayas elegido y se conecta a él — su propio directorio de datos, su
  propio puerto libre.
- **Sigue la pestaña que abre un clic**, y solo cierra la pestaña que abrió él mismo.
- **`blocked` no es `failed`.** Una ejecución que topa con un freno se detiene como `blocked`
  e informa de lo que todavía era operable en la página, así que el punto donde se atascó
  queda a la vista.
- **También lee páginas largas.** Una segunda herramienta recorre la página pantalla a
  pantalla y vuelve a unir el texto, así que un documento más largo que una pantalla vuelve
  entero — sin gastar una sola petición de decisión.
- **`done` se comprueba, no se da por bueno.** Escribe lo que la página terminada tiene que
  mostrar y el plugin irá a buscarlo; una ejecución que se declara terminada sin eso vuelve
  como `blocked`.
- **Cada ejecución deja un registro en bruto.** Cada ejecución escribe un `trace.jsonl` —el
  registro de los intercambios— en un directorio temporal propio: el cuerpo de la petición y
  la respuesta de cada llamada de decisión y de cada llamada al modelo de texto, con la clave
  borrada a `***` y todo lo que pase de 20 000 caracteres cortado; además, con las capturas
  encendidas, un `frames/NNNNNN.jpg` por paso y un `frames.json` que anota el nombre y el
  momento de cada fotograma. El resultado nombra ese directorio.
- **Una llamada al modelo de texto que se cae se reintenta; una conexión cortada no.** Un
  429, 503 o 529 del modelo de texto se reintenta hasta dos veces, esperando 0,5 s y luego
  1 s; una caída de red se informa tal cual, que es donde la versión Python de aguas arriba
  traza la misma línea.
- **Puedes ver una ejecución, no solo leer sobre ella.** El host sirve una página de
  inspección (véase «Ver una ejecución» más abajo): iniciar una ejecución a mano, ver la
  pantalla en vivo, ver qué elemento va a elegir cada paso y cuán seguro está el modelo, y
  pausar, avanzar o detener **antes** de que la acción se ejecute — o reproducir fotograma a
  fotograma una ejecución ya acabada.
- **Puedes arrancarlo sin gastar un turno de modelo.** Escribe `/jev-ultrafast` en el campo de
  entrada y di la tarea justo después, en lenguaje natural: si la frase lleva una dirección, la
  ejecución arranca de inmediato sin ninguna llamada de modelo; si no la lleva, una llamada
  pequeña al modelo de texto decide por dónde empezar. La línea del comando y su resultado
  quedan en la interfaz; por sí solo, el comando solo se explica y da la dirección del inspector.

Es un port independiente y no oficial a TypeScript de
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser
Use), empaquetado como bundle de DeepSeek Harness. Aguas arriba es Python con un poco de
JavaScript; el bucle, el script de instantánea de la página y los prompts de aquí están
reescritos a partir de él.

> **No oficial.** Este proyecto no está afiliado, respaldado ni patrocinado por
> Browser Use ni por TypeSafe. «Browser Use», «TypeSafe» y «Jev» son marcas de sus
> respectivos titulares, usadas aquí solo para describir la procedencia y la API que
> llama el plugin. No se concede licencia de marca.
>
> **Trae tu propia clave.** El plugin no incluye, empaqueta, intermedia ni revende
> acceso a la API. Resuelve tu clave de TypeSafe desde el almacén de credenciales de
> DeepSeek Harness en el momento de la llamada, y tu uso de ese servicio se rige por
> sus propios términos.

## Compatibility

| Superficie | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` y `0.2.0-rc.1` (las dos se han ejecutado aquí); el plugin declara `>=0.1.7-rc.2 <0.3.0-0` en `peerDependencies`, así que el harness rechaza una versión fuera de ese rango en su puerta de compatibilidad antes de cargarlo, con el motivo impreso |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Windows, macOS, Linux |
| Escritorio | Funciona en la app de escritorio (Electron); su perfil lo gestiona la propia app, así que la instalación va aparte — véase el párrafo de escritorio en *Install* más abajo |
| Navegador | Chrome o Edge: elige uno en la página de ajustes y pulsa 「启动并连接」, y el plugin lo arranca por ti (su propio directorio de datos, su propio puerto libre). También puedes arrancar uno tú mismo con `--remote-debugging-port` y el plugin lo encontrará — y cuando no haya nada alcanzable, una tarea arranca ella misma ese navegador, así que el botón no es un requisito previo |
| Credenciales | `TYPESAFE_API_KEY`; además, cuando hay que escribir en un campo, una clave para el modelo de texto: en un preset ese nombre por defecto es el que usa la convención del proveedor (en el caso de DeepSeek, `DEEPSEEK_API_KEY`), y las rutas integradas de DSH no necesitan ninguna |

## What it does

El plugin registra dos herramientas.

**`jev_browser_task`** conduce una página hacia un solo objetivo, ejecutando todo el bucle
dentro de una única llamada. Recibe cuatro argumentos:

| Argumento | ¿Obligatorio? | Significado |
|---|---|---|
| `goal` | sí | Toda la tarea en una frase, con cada valor que haya que escribir y cada filtro que haya que fijar. El bucle solo ve esta frase y la página actual, nunca tu conversación. |
| `url` | sí | La página que se abre primero. El espacio de acciones no tiene ninguna operación de «ir a una dirección», así que el punto de entrada solo puede venir de aquí. |
| `maxSteps` | no | Sustituye el presupuesto de pasos solo para esta ejecución, sin tocar la configuración. |
| `expect` | no | Cadenas que la página terminada tiene que mostrar, escritas antes de la ejecución y comprobadas después por el plugin. Pon un `!` delante de una para exigir que *no* esté ahí. Esto es lo que impide que «done» sea la última palabra del modelo que hizo el trabajo. |

Devuelve `status` (`done` / `blocked` / `failed`), `reason`, `verification`, `url`,
`title`, `text`, `steps`, `decisions`, `elapsedMs`, `actions`, `elements`,
`omittedActions` y `textCalls`, además de la ruta del directorio de registro de la propia
ejecución. Cuando `status` es `blocked` o `failed`, `elements` lleva lo que todavía era
operable en la página, de modo que se ve dónde se atascó la ejecución. `omittedActions`
cuenta los controles que la página ofrecía más allá de los 250 que caben en la tabla; la
lista de pasos marca un paso sobre el que el propio modelo dudaba (por debajo de la mitad
de probabilidad); y con las capturas encendidas también devuelve la ruta absoluta, dentro
del directorio temporal del sistema, de la imagen de la última pantalla.

**`jev_browser_read`** lee una página en vez de actuar sobre ella. Recibe `url` y, de forma
opcional, `maxScreens` (por defecto 20) y `maxChars` (por defecto 60000). Recoge el texto
visible pantalla a pantalla, descarta las líneas que comparten pantallas consecutivas y
devuelve el texto entero, así que un documento más largo que una pantalla vuelve completo.
No llama a ningún modelo de decisión y no hace clic en nada: esta es la vía barata, y leer
es lo único que hace. Se detiene por uno de cuatro motivos — la página se acabó, se agotó
el presupuesto de pantallas, se agotó el presupuesto de caracteres o la página dejó de
desplazarse — y dice cuál fue; una pantalla que llenó exactamente el límite de 6000
caracteres de una sola pantalla se cuenta y se marca como posiblemente cortada. Una
pestaña recién abierta se traga el primer evento de desplazamiento (descubierto en una
ejecución real), así que una pantalla que no se movió se empuja una vez más.

Por qué leer necesita su propia vía: la instantánea es solo del área visible por diseño.
Descarta toda línea que esté fuera de pantalla y limita lo que queda a 6000 caracteres, y
ese mismo texto viaja con *cada* petición de decisión, así que ensancharlo encarecería cada
paso. La herramienta de tarea, por tanto, ve una pantalla; la de lectura recorre la página.

**Qué deja atrás una ejecución.** Cada ejecución escribe en un directorio temporal propio:
un `trace.jsonl` que contiene el cuerpo de la petición y la respuesta de cada llamada de
decisión y de cada llamada al modelo de texto, con la clave borrada a `***` y todo lo que
pase de 20 000 caracteres truncado; además, con las capturas encendidas, un
`frames/NNNNNN.jpg` por paso y un `frames.json` que anota el nombre y el momento de cada
fotograma. El resultado informa de ese directorio, así que el intercambio en bruto puede
volver a leerse después.

**Ver una ejecución.** El host también sirve en
`http://127.0.0.1:3080/jev-ultrafast/inspector` un inspector interactivo, es decir, una
página desde la que se mira una ejecución y se la controla. Ahí puedes iniciar una ejecución
a mano, ver la pantalla actual, ver qué elemento selecciona cada paso y cuán seguro está el
modelo, y pausar, avanzar o detener **antes** de que la acción se ejecute. Una ejecución
que ya ocurrió puede volver a verse: sus fotogramas se reproducen al ritmo al que se
tomaron, y el JSON en bruto de cada petición puede desplegarse. La página es un único
archivo HTML emitido por el host en vez de un bundle de cliente, así que no hay que
reconstruir nada para obtenerla; solo la página misma no necesita token, mientras que cada
endpoint al que llama toma el mismo token que la página de ajustes.

El bucle interno tiene cuatro pasos:

1. **Observar** — un script inyectado lee los controles visibles en una tabla indexada
   (rol, nombre, valor actual, estado marcado/seleccionado).
2. **Decidir** — una petición a TypeSafe devuelve la operación (`CLICK`, `TYPE_TEXT`,
   `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`) junto con un
   objetivo candidato por cada operación disponible; solo se ejecuta el objetivo de la
   operación elegida.
3. **Escribir** — solo si la operación es `TYPE_TEXT`, un modelo pequeño compatible con
   OpenAI redacta el valor del campo.
4. **Ejecutar** — antes de la entrada se revisan de nuevo frescura, visibilidad,
   geometría y oclusión, y la acción se registra *antes* de observar su resultado.

El modelo nunca emite selectores, coordenadas ni código ejecutable: los objetivos son
índices de la tabla observada, emitidos por el plugin.

Tres frenos acotan una ejecución: el número de acciones llega a `maxSteps`; las llamadas de
decisión llegan a `2 × maxSteps`; o tres pasos consecutivos dejan la página sin cambios. Una
ejecución que se detiene así termina como `blocked`, no como un fallo — no llegó, no se cayó.

El plugin abre su propia conexión con el navegador y deliberadamente **no** usa la ranura
`ctx.browserUse`: necesita conducir la página paso a paso a su propio ritmo, y eso no es
para lo que sirve el contrato de esa ranura, que es «entregar la página a un proveedor».

**Todavía no está hecho:** el paquete no está en npm, así que se instala desde un tarball o
un directorio local; los resultados de las herramientas usan por ahora la tarjeta genérica y
no se ha escrito una tarjeta rica propia para él; las pestañas múltiples solo se manejan en
la medida de seguir la pestaña que abre un clic (la ejecución nunca se cambia a una pestaña
que ya tuvieras); las subidas de archivos y el arrastrar y soltar, así como cualquier cosa
dentro de Shadow DOM, iframes o un canvas, nunca han estado en el espacio de acciones, ni
aguas arriba ni aquí.

Conviene conocer dos límites de la evidencia. La herramienta de tarea devuelve como mucho
6000 caracteres de la página final, y busca una marca de éxito solo en esa pantalla final —
una marca situada más abajo en una página muy larga no se encuentra ahí, y por eso una
comprobación fallida significa «no confirmado» y no «no es cierto». La herramienta de
lectura es la forma de mirar más lejos.

### O también escribe el comando de barra (una URL no gasta turno de modelo)

Escribe `/jev-ultrafast` en el campo de entrada:

- `/jev-ultrafast <lo que quieras hacer>` — la dirección es opcional y puede ir en cualquier
  punto de la frase, incluso como dominio desnudo (`example.com`); por ejemplo
  `/jev-ultrafast https://www.example.com encuentra el precio y di cuál es`, o
  `/jev-ultrafast mira qué tiempo hace mañana en Pekín`.
  Si la frase lleva una dirección, no se llama a ningún modelo antes de arrancar; si no lleva
  ninguna, esa frase se le pasa al modelo de texto elegido en la página de ajustes para que
  conteste por dónde empezar —una llamada pequeña de más— y, cuando el modelo tampoco sabe qué
  sitio abrir, la respuesta te pide que escribas la dirección.
  El comando responde al instante y la ejecución continúa en segundo plano (puedes ver su avance
  o detenerla en el panel de tareas de la sesión); al terminar te devuelve el resultado.
- `/jev-ultrafast` por sí solo — devuelve solo esta explicación y la dirección del inspector interactivo.

El comando y su resultado se quedan en la interfaz: nunca pasan a formar parte de la conversación,
y no gastan ninguna llamada de modelo cuando la frase lleva una dirección; cuando no la lleva, esa
frase le cuesta una llamada pequeña de más al modelo de texto elegido en la página de ajustes, que
es el que decide por dónde empezar. El nombre tiene que ser ASCII en minúsculas (es una regla de
DSH), y por eso es `/jev-ultrafast` y no un nombre en chino. Las capturas paso a paso siguen
dependiendo del interruptor «una captura en cada paso» de la página de ajustes: con él apagado,
esta ejecución solo deja el registro en bruto de sus intercambios.

En una sesión completamente nueva, la primera vez la pantalla puede quedarse en la página de
bienvenida (como si no hubiera pasado nada): envía cualquier otra cosa y la tarjeta del comando ya
está ahí.

> **Estado.** Versión `0.1.0`, vista previa de desarrollador. El plugin está implementado:
> registra dos herramientas — `jev_browser_task`, cuyo bucle es el descrito arriba y el que
> realmente se ejecuta, y `jev_browser_read`. No está publicado en npm — se instala desde un
> tarball local (véase [Install](#install)). DeepSeek Harness está iterando rápido, así que
> hay que contar con volver a comprobar este plugin contra él.
> El plan por etapas y lo que queda pendiente están en [`tasks/todo.md`](tasks/todo.md).

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-jev-ultrafast-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-jev-ultrafast'
```

**En la app de escritorio** el perfil lo administra la propia aplicación y la línea de
comandos lo rechaza (`profile "desktop" is managed exclusively by the Electron
application`). Abra **插件 → 添加插件** (Complementos → Añadir complemento), pegue la
**ruta absoluta** del tarball, pulse 立即启用 (Activar ahora) y **reinicie la app una
vez**: el payload de arranque se envía una sola vez por arranque, así que sin reiniciar
la página del plugin no recibe su token y muestra un aviso en chino, aunque la
herramienta funcione igual. La versión web no tiene ese paso: su índice se renderiza en
cada petición.

Antes de una ejecución tienen que estar listas dos cosas.

La primera, un navegador al que el plugin pueda llegar. La vía más corta es elegir uno en la
propia página del plugin: **Ajustes → Jev 浏览器**, elige Chrome o Edge en el desplegable
del bloque del navegador y pulsa 「启动并连接」. El plugin arranca el ejecutable de ese
navegador con un **directorio de datos propio** (un perfil de navegador aparte, el del plugin
y no el tuyo: inicia sesión una vez dentro de él y conserva ese estado), deja que el navegador
elija un puerto libre y guarda la dirección en ese directorio de datos, así que no hay que
teclear ningún puerto y un DSH reiniciado lo encuentra otra vez. Chrome y Edge rechazan un
puerto de depuración sobre el perfil predeterminado desde la versión 136, y por eso «el plugin
arranca uno limpio» es también la única forma de hacerlo con una sola pulsación. **Sin
embargo, esa pulsación no es obligatoria**: cuando no hay ningún navegador alcanzable, una
tarea arranca ella misma el que se haya elegido y se conecta a él, y lo dice en su resultado.
El botón conserva su otro uso: un sitio que necesita iniciar sesión recibe ese inicio de
sesión una vez, a mano, dentro de esa ventana.

También puedes arrancar tú mismo una instancia dedicada y no tocar el botón:

```sh
# Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/jev-profile --no-first-run
# Edge
msedge --remote-debugging-port=9222 --user-data-dir=/tmp/jev-profile --no-first-run
```

En Windows hay que escribir la ruta completa:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 --user-data-dir="C:\Users\<tú>\jev-profile" `
  --no-first-run --no-default-browser-check
```

Con `cdpUrl` vacío, el plugin busca en este orden: la dirección configurada → las variables
de entorno `BU_CDP_URL` / `BU_CDP_WS` → el archivo de puerto que escribió el propio navegador
(entre ellos, los dos directorios de datos que arrancó el plugin) → los dos puertos
convencionales 9222 y 9223. Si ninguno responde, falla con un mensaje en chino que explica
cómo arrancar un navegador y menciona ese botón. Si el tuyo ya está escuchando en otro sitio,
pon `cdpUrl`. **Con los dos navegadores en marcha, una tarea conduce el que hayas elegido en
el desplegable** — se ordena por delante del otro, en vez de ganar el que se arrancó primero.

La segunda, las dos claves. La vía más corta es escribirlas en la propia página del plugin en
los ajustes de DSH (la sección siguiente), que las escribe en el archivo de credenciales de
DSH; también pueden guardarse como credenciales (la decisión usa `TYPESAFE_API_KEY` por
defecto, y el modelo de texto el nombre por defecto de la ruta elegida) o exportarse en el
entorno que arranca DSH. Si falta una, se produce un error en chino que nombra cuál falta.
Las claves nunca se escriben en la configuración: la configuración contiene los **nombres de
variables**.

## Configuration

Cada clave se puede cambiar en `cordis.yml` o en la propia página de ajustes del plugin
(véase la sección siguiente); los nombres son planos, sin anidamiento. La columna de
valores predeterminados es lo que se obtiene sin escribir nada.

| Clave | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `browserKind` | `chrome` \| `edge` | `chrome` | Qué navegador arranca 「启动并连接」, y cuál arranca una tarea por su cuenta cuando no hay nada alcanzable. Se le da un directorio de datos propio, así que esto solo elige cuál. |
| `browserPath` | string | vacío | Dónde vive el ejecutable de ese navegador. Solo hace falta cuando está instalado fuera de los sitios habituales (una copia portátil, por ejemplo). |
| `cdpUrl` | string | vacío | Punto de acceso de depuración del navegador, p. ej. `http://127.0.0.1:9222`; vacío = búsqueda automática |
| `userDataDir` | string | vacío | Directorio de datos del navegador, solo si se usó uno no predeterminado |
| `decisionProvider` | `typesafe` \| `openrouter` | `typesafe` | Por qué puerta se llega al servicio de decisión: el punto de acceso propio de TypeSafe o la ruta alpha de OpenRouter; véase «Dos rutas» más abajo |
| `decisionEndpoint` | string | vacío | Dirección completa del servicio de decisión; vacío usa la del proveedor elegido, solo hay que rellenarla en una ruta de reventa |
| `decisionModel` | string | vacío | Nombre del modelo de decisión; vacío usa el del proveedor elegido |
| `decisionKeyRef` | string | vacío | *Nombre* de la credencial de decisión (nombre de variable de entorno), no la clave; vacío usa el del proveedor elegido |
| `textProvider` | string | `deepseek` | Por qué camino va el modelo de texto: un nombre predefinido (`deepseek`, `openrouter`, `bailian`, `zhipu`, `moonshot`, `siliconflow`, `openai`), o `dsh:<id del proveedor>` (un modelo ya configurado en DSH); véase «Por qué camino va el modelo de texto» más abajo |
| `textBaseUrl` | string | vacío | Dirección compatible con OpenAI del modelo de texto; vacío usa la del camino elegido |
| `textModel` | string | vacío | Nombre del modelo de texto; vacío usa el modelo predeterminado del camino elegido; el camino `dsh:` no tiene valor predeterminado, hay que elegir uno |
| `textKeyRef` | string | vacío | *Nombre* de la credencial del modelo de texto; vacío usa el nombre del camino elegido; en el camino `dsh:` la clave la lleva DSH mismo |
| `textReasoning` | `none` \| `auto` | `none` | `none` desactiva el razonamiento del modelo de texto (rellenar un campo es copiar, no razonar); `auto` usa el valor predeterminado de cada proveedor |
| `maxSteps` | number | `60` | Máximo de acciones; el de decisiones es el doble |
| `screenshots` | boolean | `false` | Captura en cada paso (mucho más lento) |

La configuración se valida con el esquema Schemastery `Config` de `src/config.ts`, así que
un valor inválido falla al cargar en vez de ejecutarse roto.

Los dos campos `keyRef` guardan el *nombre* de una credencial y llevan el rol
`credential-ref`; cada credencial se resuelve por llamada mediante `ctx.credentials`. Todos
los campos son `volatile`, y eso es lo que permite que la página de ajustes guarde y surta
efecto de inmediato: un valor cambiado con DSH en marcha lo recoge la siguiente tarea, sin
reiniciar. El *valor* que hay detrás de un nombre se pone en la fila 密钥 del bloque
correspondiente de la página, que escribe el propio archivo de credenciales de DSH: igual de
inmediato.

### Por qué camino va el modelo de texto

El modelo de texto solo se usa para «escribir en un campo», y también tiene su propia forma
de elegir camino, en dos clases:

| Clase | Qué es | Dirección y clave |
|---|---|---|
| Predefinido (`deepseek`, `openrouter`, `bailian`, `zhipu`, `moonshot`, `siliconflow`, `openai`) | una tabla que trae el plugin | la dirección, el modelo predeterminado y el nombre de credencial predeterminado los da esa tabla; el valor de la clave lo guarda en el archivo de credenciales de DSH el campo de pegado de la página de ajustes |
| Integrado en DSH (`dsh:<id del proveedor>`, por ejemplo `dsh:deepseek-official`) | un modelo ya configurado en DSH | la dirección y la clave las lleva DSH mismo; la página de ajustes solo elige un modelo y no dibuja campo de pegado |

Manda el camino que se elija, y los otros tres campos lo siguen cuando quedan vacíos —igual
que el servicio de decisión de más abajo—. El prefijo `dsh:` no es adorno: en DSH también
puede haber un proveedor llamado `deepseek`, y con el prefijo «el predefinido deepseek del
plugin» y «el deepseek de DSH» son dos opciones paralelas que no se desplazan la una a la
otra; y un valor ya guardado tampoco se tomará por el otro solo porque DSH registre después
un proveedor con el mismo nombre.

Los predefinidos solo aceptan las casas de protocolo OpenAI porque a esta mitad de texto le
basta con «dar una frase y pedir un JSON». Otros protocolos como Anthropic o Gemini
funcionan igual de bien por el camino integrado de DSH, sin ninguna carencia de capacidad.

**Los problemas transitorios se reintentan; una conexión rota no.** Una llamada al modelo de
texto que vuelve 429, 503 o 529 se reintenta hasta dos veces, esperando 0,5 s y luego 1 s.
Una caída de red no se reintenta en absoluto y se informa tal cual — la misma línea que traza
la versión Python de aguas arriba.

**Un compromiso**: el nombre de credencial predeterminado del predefinido DeepSeek está
escrito `DEEPSEEK_API_KEY` según la convención del proveedor, y DSH también usa ese nombre
— así que este camino sale de fábrica ya «configurado». Para que use una clave propia, pon
otra cosa en «nombre de la clave» dentro de «ajustes avanzados» de la página de ajustes.

### Dos rutas hacia el servicio de decisión

Las dos puertas se diferencian en exactamente tres valores: la dirección, el nombre del
modelo y bajo qué nombre de credencial está la clave. Como van juntos, la configuración
solo nombra la puerta y deja que los otros tres la sigan; la página muestra en gris el
valor que usará un campo vacío, así que cambiar de proveedor no exige copiar nada ni deja
residuos.

| Proveedor | Dirección | Modelo | Nombre de la credencial |
|---|---|---|---|
| TypeSafe, directo | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |

La tilde inicial en el nombre del modelo de OpenRouter no es una errata: es como esa ruta
escribe el mismo modelo, y quitarla pide un modelo que no existe. También se ha visto que
esa ruta quiere el cuerpo de la petición envuelto en un envoltorio `decisionsRequest`, así
que por esa puerta el plugin envía primero el cuerpo plano y solo reintenta una vez
envuelto cuando el cuerpo es rechazado con 400 o 422 —un rechazo de forma, no de
contenido—. El punto de acceso propio de TypeSafe nunca envuelve. Ninguna de las dos
puertas se ha probado contra un servicio real desde esta máquina, que no tiene clave para
ninguna.

**De dónde sale una clave.** Los campos de arriba contienen nombres, no claves; DSH
resuelve el nombre en un orden fijo: el entorno del proceso tal como se heredó al
arrancar, luego la sección `refs:` de su propio archivo de credenciales
`~/.dsh/.credentials.yaml`, luego un `.env` en el directorio de trabajo y, por último,
`~/.dsh/.env`. El nombre es el nombre de la variable, sin prefijo.

La vía más corta es la propia página del plugin (la fila 密钥 de cada bloque): escribe ese
archivo de credenciales por ti, surte efecto de inmediato y no exige saber dónde está
el archivo. Las otras dos vías siguen funcionando: define una variable de entorno con ese
mismo nombre en la misma terminal antes de arrancar `dsh web`, o añade una línea bajo
`refs:` en `.credentials.yaml`, que DSH recarga por su cuenta. Un `.env` también sirve,
pero no puede definir ningún nombre que empiece por `DSH_`, pues entonces DSH se niega a
arrancar.

Hay una capa que la página no puede cambiar: **el entorno heredado al arrancar gana, y se
lee una sola vez, en ese momento.** Cuando el valor de un nombre viene de ahí, la página
marca esa fila como 「这一页改不了它」 y no ofrece ningún campo, explicando por qué. Esa
negativa es deliberada: una escritura que pareciera tener éxito mientras la resolución
siguiera devolviendo el valor antiguo del entorno sería peor que un «esto queda fuera de
mi alcance» dicho con honestidad.

## La página del plugin en los ajustes de DSH

Abre **Ajustes → Jev 浏览器**. La página tiene cuatro bloques — **浏览器**, **决策服务**,
**文本模型**, **任务** — y cada uno está dispuesto de la misma manera: una línea que dice
cómo está esa parte ahora mismo, y luego los controles que la cambian. Esas líneas de estado
vienen de un recorrido de ida y vuelta real y no de una suposición: «conectado» significa que
un punto de acceso de depuración respondió *y* que volvió una instantánea de una pestaña
real, y «falta una clave» se sienta justo encima de la casilla que lo arregla. La página
nunca te manda a otra parte de la página para arreglar lo que acaba de informar.

El bloque del navegador lleva una cosa más: un desplegable 「用哪个浏览器」 (Chrome / Edge) y
un botón 「启动并连接」. Púlsalo y el plugin arranca ese navegador y se conecta, escribiendo
el resultado directamente en esta página. Primero guarda el bloque — solo ese bloque, así que
nada a medio escribir en otro bloque queda confirmado por ello. Cuando no encuentra el
programa, enumera dónde lo ha buscado; abre 高级设置 y rellena **浏览器程序** para una copia
portátil guardada en otro sitio. El navegador que se elija aquí es también el que arranca una
tarea por su cuenta cuando no hay ninguno alcanzable, así que este botón no es un requisito
previo. Debajo de esos hay un botón más, 「打开交互式检查器」, que te lleva directamente a la
página descrita arriba; la dirección la compone a partir de donde estés leyendo esto, así que
es correcta en cualquier puerto.

Dos cosas puede hacer que la herramienta por sí sola no puede informar. Dice si cada nombre
de credencial se resuelve —nunca cuál es el valor—. Y 测一次决策服务 envía una pregunta de
decisión real, que es la única forma de probar que la dirección, el nombre del modelo y la
clave funcionan juntos; esa gasta una llamada, así que solo se ejecuta cuando la pulsas.

La configuración se edita en esos mismos bloques. Los guardados pasan por el propio servicio
de configuración de DSH, así que la validación y la comprobación de «alguien acaba de cambiar
esto» son del harness, no nuestras; el cambio llega a la capa de parches del perfil como una
anulación dirigida por id. Los bloques **决策服务** y **文本模型** llevan cada uno su propio
保存: pulsar uno escribe los campos de ese bloque, sus anulaciones guardadas en 高级设置
incluidas, y deja en paz las ediciones sin guardar del otro bloque. El botón del final de la
página se llama 保存全部改动 y escribe de una vez todos los cambios de la página. En
cualquiera de los dos casos la configuración va primero y las claves pegadas después. Ese
orden no es cosmético: un nombre de credencial que acabas de escribir en un campo solo se
vuelve guardable una vez guardada la configuración que lo nombra, así que una pulsación puede
cambiar un nombre *y* darle un valor.

El proveedor es un desplegable, y la casilla del modelo justo debajo puede quedarse vacía: el
texto gris de marcador de posición muestra entonces lo que usará esa puerta, así que cambiar
de proveedor no exige copiar nada ni deja residuos. El modelo merece verse junto a su
proveedor, y por eso está en el bloque; la dirección y el nombre de la credencial son las
anulaciones que se tocan una vez, y esperan detrás del desplegable 高级设置, al final.

El bloque «modelo de texto» es igual: su desplegable de **proveedor** muestra dos grupos
con título —el primero (「DSH 内置（由 DSH 管理地址和密钥）」) lista los modelos ya
configurados en DSH y el segundo (「插件预设（本插件直连）」) los predefinidos que trae el
plugin—, y los textos de las opciones son nombres simples, sin prefijo; debajo del
desplegable se dibuja ahora una línea gris más que describe el proveedor elegido —de dónde
viene su dirección, dónde pedir su clave— (si el camino elegido es uno integrado de DSH esa
línea no se dibuja, porque la pista del campo y la fila de la clave ya dicen que la dirección
y la credencial las lleva DSH); con el **modelo** vacío se usa el modelo predeterminado de
ese camino, y la lista de candidatos de esa casilla se puede abrir para escoger uno o
escribir encima. Al elegir un predefinido, esa casa trae consigo la dirección, el modelo y el
nombre de la credencial, y debajo se dibuja el campo de pegado como siempre; al elegir el
integrado de DSH, esa fila de la clave se sustituye por una línea que dice que la lleva DSH
mismo y no se dibuja campo de pegado —la dirección y la clave de ese camino están en DSH,
fuera del alcance de esta página—.

Debajo está la sección 「密钥」. Los nombres que lista son exactamente los que usará esta
configuración: los nombres por defecto de las dos puertas (así la otra clave puede quedar
guardada antes de cambiar de proveedor) más cualquier nombre que hayas escrito tú mismo en
la configuración. Cada fila de 密钥 tiene una primera línea que informa del estado de ese
nombre —«todavía sin valor», «configurado, desde el archivo de credenciales de DSH» o «fuera
del alcance de esta página»— y debajo va el campo de pegado. Pega un valor, pulsa 保存 y
queda escrito en el archivo de credenciales de DSH, usado por la siguiente tarea sin
reiniciar; 清除 borra la entrada de ese archivo. Después la página solo muestra «configurado»
y de dónde viene el valor: la interfaz de credenciales de DSH responde si un nombre está
definido, qué capa ganó y si admite escritura, y nunca entrega el valor a ninguna página, así
que esta página no puede mostrarlo aunque quisiera. Cuando el valor viene del entorno de
arranque no hay campo ninguno, y la línea lo dice.

La página ya no detalla dónde vive el archivo de la clave ni de qué no protege. La ruta
aparece donde importa: cuando el entorno de arranque eclipsa un nombre, esa fila nombra el
archivo y ofrece las dos salidas. El resto corresponde aquí y no a la página: el archivo
está abierto solo para tu propia cuenta de usuario, y DSH no entrega su ruta al modelo
—pero los procesos de herramientas de una IA corren como el mismo usuario, así que pueden
leerlo—. La propia documentación de DSH lo dice con más suavidad que nosotros: es
discreción, no una frontera. Protegerse de una IA local exige el llavero del sistema
operativo, que todavía no existe.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test          # 168 pruebas unitarias (15 archivos), sin clave ni red
pnpm run build
```

La capa del navegador tiene sus propias 14 pruebas de integración, omitidas por defecto y
ejecutadas solo contra un navegador real:

```sh
JEV_BROWSER=1 pnpm exec vitest run tests/browser.integration.test.ts
```

En Windows eso es `$env:JEV_BROWSER='1'; pnpm exec vitest run
tests/browser.integration.test.ts`. Se conecta al puerto 9222 por defecto, o al que nombre
`JEV_CDP_URL`.

También puedes montarlo sin empaquetar: `dsh web --patch ./scratch/cordis.yml`, que ya apunta
al `lib/index.mjs` construido de este repositorio.

Hasta ahora se ha verificado lo siguiente: pasan 168 pruebas unitarias (15 archivos); pasan las 14
pruebas de integración del navegador, ejecutadas aquí contra Edge (las 11 anteriores, contra
Chrome 153.0.8010.53 y Edge 154.0.4258.37, todas en verde las dos veces); un tarball de `pnpm pack`
se instala y carga en un perfil desechable limpio. La sección de claves de la página se
ejercitó contra una instancia desechable en dieciséis comprobaciones: guardar, que la fila
pase a «viene del archivo de credenciales», que el valor siga configurado tras reiniciar
el proceso, y que 清除 devuelva el nombre a no configurado; un nombre eclipsado por el
entorno de arranque rechaza la escritura y dice por qué; un nombre fuera de la lista de la
página (403), un valor vacío y una petición sin el token son rechazados cada uno; y en
ocho cuerpos de respuesta el valor no apareció ni una vez. **Todavía no se ha hecho
ninguna llamada de decisión real con una clave real**: esta máquina no tiene ninguna. El
plan por etapas y sus criterios de aceptación están en
[`tasks/todo.md`](tasks/todo.md). Después se recorrieron también la 0.2.0-rc.1 y la app de
escritorio: el plugin pasa la puerta de compatibilidad de la 0.2.0-rc.1 por la fuerza de esa
declaración `>=0.1.7-rc.2 <0.3.0-0` (ninguna línea `disabling profile plugin` en
`--dump-config`); allí sus inyecciones de índice se siguen reconstruyendo en cada petición,
así que el token que recibe la página es el que acepta la ruta de la herramienta, y una
petición sin él sigue siendo rechazada con 403; la instalación de escritorio pasó por el
propio 添加插件 de la app con la ruta absoluta del tarball, y tras reiniciar la aplicación el
payload de arranque contiene `global/__JEV_ULTRAFAST_TOKEN__` y la página informa de su estado
en vivo sin error de token; y editar 调试端口 en el escritorio y guardar escribe esa fila en la
capa de parches del perfil, vaciarla escribe el valor vaciado, y la página sigue siendo usable
tras ambos guardados — que es el aspecto que tiene un campo de configuración que de verdad no
necesita recarga.

Una comprobación `dsh-plugin-dev check` pasó en su momento, pero ese CLI se distribuye con la
habilidad de desarrollo de plugins (el *skill* de DSH) y ya no está en el PATH de esta máquina,
así que ese punto no se volvió a ejecutar.

La 0.2.8 devolvió el modelo a su propio bloque, y ese cambio se comprobó en una instancia con
el paquete real instalado: el modelo de decisión se sienta bajo su proveedor con un marcador
de posición que lo sigue (TypeSafe muestra `jev-latest`, OpenRouter `~typesafe/jev-latest`),
高级设置 se queda con seis elementos, y la línea de nota bajo cada proveedor se leyó
correctamente en los dos estados —la de OpenRouter nombra su canal alpha y la tilde—, mientras
que elegir el integrado de DSH ya no repite lo que la pista de arriba y la fila de la clave de
abajo ya dicen. La misma versión fijó la redacción de la línea 现在 del bloque de decisión:
ahora informa juntos de la ruta, el modelo **y el nombre de la credencial** guardados —la
casilla de la clave de abajo sigue siguiendo el borrador, porque un valor tiene que pegarse
antes de poder guardarse, y una frase que mezclara la ruta guardada con un nombre de clave en
borrador describía un estado que nunca existió (visto en vivo: con el proveedor cambiado pero
sin guardar, la línea seguía diciendo `TypeSafe 官方直连 · jev-latest · 密钥 TYPESAFE_API_KEY
还没有值。` mientras la fila de la clave ya se había vuelto `OPENROUTER_API_KEY`). La versión 0.2.9 da al bloque del servicio de decisión y al bloque del modelo de texto su propio botón «保存»: pulsar uno escribe solo los cambios de ese bloque —sus anulaciones dentro de los ajustes avanzados incluidas— y las ediciones sin guardar del otro bloque no se arrastran; el botón del final de la página ahora se llama «保存全部改动» y escribe todo de una vez. En una página real esto se comprobó escribiendo un cambio en cada bloque y pulsando el «保存» propio del bloque de decisión: solo se almacenó el cambio del bloque de decisión, mientras que el bloque de texto seguía informando de un cambio sin guardar, y su campo conservaba el valor sin guardar. La versión 0.2.10 quitó ese pliegue de nota al pie de la página de ajustes: ahora la página termina en la fila 「保存全部改动」, su única revelación restante es la de los ajustes avanzados, y los dos bloques de servicio conservan su propio 「保存」.

La versión 0.2.12 trajo a la página su 「启动并连接」, que se ejecutó de verdad contra esa
misma instancia instalada desde el tarball, dos veces: el desplegable se abrió con el **Edge**
guardado de la vez anterior (así que la elección sobrevive a un reinicio del proceso); una
pulsación arrancó y conectó **Chrome** (puerto 60856 — un puerto aleatorio, porque lo elige el
navegador en vez de estar fijado el 9222); y cambiar a Edge y volver a pulsar conectó **Edge**
(`Edg/154.0.4258.37`, puerto 60376) *mientras Chrome seguía en marcha*. Esa segunda ronda es
donde se ve el arreglo del orden: en la primera implementación la línea de estado seguía
apuntando a Chrome, porque el descubrimiento no ponía primero el navegador elegido. Captura:
`scratch/review-0212-browser-block.png`; sonda: `scratch/probe-0212c.js`.

**La 0.2.13 es la primera ejecución de extremo a extremo** (2026-09-29, pedida como «用插件搜
DeepSeek DSH 桌面版的下载页»). La mitad del navegador funciona: la herramienta abrió Bing de
verdad y leyó de vuelta el texto de la página y 20 elementos accionables. La mitad de decisión
se paró en **HTTP 401**, y la causa no estaba en el plugin: las dos credenciales de decisión
de la máquina (`OPENROUTER_API_KEY` y `TYPESAFE_API_KEY`) son **el mismo valor de 35
caracteres** (pegado en los dos campos), y ningún servicio lo acepta — enviado a OpenRouter
responde «Missing Authentication header» (ni siquiera reconoce la forma; una clave falsa pero
bien formada recibe «User not found.», así que sí está leyendo la clave), y enviado al punto de
acceso propio de TypeSafe responde «Cannot authenticate with the server». De la misma
investigación salieron dos hechos: el punto de acceso público de `openrouter.ai` responde 200
sin clave (así que el camino de red está bien) y el canal alpha de OpenRouter **sí** acepta una
clave de portador (así que la puerta OpenRouter del plugin es viable — solo necesita una clave
real). La ejecución también destapó un defecto real del plugin, arreglado en esta versión: un
rechazo decía solo «HTTP 401», que no distingue «esta clave no se reconoce» de «esta petición
no es del gusto del endpoint». Ahora las palabras del propio servicio viajan en una línea,
cortadas a 240 caracteres, con la clave misma borrada a `***` antes — fijado por una prueba
unitaria. Instalado en el perfil web diario, los dos artefactos idénticos byte a byte a los del
repositorio, `--dump-config` sale 0.

**La 0.2.14 sigue la pestaña que abre un clic** (el mismo día, más tarde). La ejecución de la
0.2.13 dejó una escena reveladora: había tres pestañas de resultados de Bing abiertas de
verdad, mientras la ejecución informaba de que «la página no cambió en 3 pasos» — cada clic
había funcionado, el sitio abría cada resultado en una pestaña nueva, y la ejecución solo
miraba la pestaña a la que se había adherido. Cambiaron dos cosas. Primero, un paso que deja
esta pestaña en la misma dirección mientras trae a la vida una página nueva ahora mueve la
ejecución a esa página y lo dice, así que la siguiente decisión ve lo que hizo el clic; un paso
en el que la dirección de esta pestaña *sí* se movió se queda donde está, y la línea del paso
informa de la ventana nueva en vez de fingir que no pasó nada. La prueba es la dirección y no
la página entera, porque un resultado de búsqueda que pasa a «visitado» redibuja la página
donde está — con la regla de huella que este plugin usó primero, la ejecución en vivo se
negaba a seguir en Bing exactamente por eso. Segundo, una ejecución ahora cierra solo la
pestaña que creó: la página a la que se movió queda abierta, así que lo que la tarea fue a
buscar sigue ahí cuando termina. Siete pruebas nuevas (tres en el bucle, dos para la única
línea que lee el usuario, una prueba de integración con navegador real que hace clic en un
enlace `target="_blank"` y comprueba que se leyó la segunda página), más una ejecución en vivo
contra el servicio de decisión real — Bing → 冯时 → el artículo de 百度百科: un paso, seguido,
la página final el propio artículo, donde el mismo objetivo necesitaba cuatro pasos y acababa
en la propia página de búsqueda de Baike antes del arreglo. Instalado en el perfil web diario,
los dos artefactos idénticos byte a byte, `--dump-config` sale 0.

**La 0.2.15 hace que una tarea arranque ella misma el navegador** (el mismo día, más tarde). La
pregunta era si el modelo principal, llamando a este plugin desde la página de conversación,
podía arrancar y conectar en vez de mandar al lector primero a la página de ajustes. Puede:
arrancar un navegador aquí es del todo mecánico (encontrar el ejecutable, darle un directorio
de datos, dejar que elija un puerto, esperar a que el puerto responda), y el botón de la
0.2.12 ejecuta ese mismo código. «Un modelo no tiene manos» significaba que un modelo no puede
arrancar un proceso por sí mismo — una llamada de herramienta es la mano del propio plugin, y
por eso la frontera se mueve en vez de romperse. Así que una ejecución ahora busca un navegador
primero, y cuando no hay nada alcanzable *y* nada estaba fijado, arranca el navegador que
nombra la página de ajustes —la misma búsqueda del ejecutable, el mismo directorio de datos,
el mismo truco del archivo de puerto— y lo dice en su resultado. Se conservan dos bordes a
propósito. Un `cdpUrl` o un `userDataDir` fijados son una instrucción y no una pista: cuando
uno de ellos está puesto y muerto, la ejecución lo informa en vez de arrancar otro navegador,
porque arrancar un navegador que nadie pidió es peor respuesta que decir que la dirección no
responde. Y el modelo nunca nombra un ejecutable ni un puerto: el ejecutable viene de los
ajustes, el puerto del propio navegador. Verificado: 7 pruebas unitarias nuevas
(`ensureBrowser` fija cuándo se arranca un navegador, cuál, y cuándo ninguno; `launchNote` fija
la única línea que lee el usuario), 126 en total; dos ejecuciones en vivo — una con el
directorio de datos del plugin apuntando a un directorio desechable, de modo que nada era
alcanzable, que arrancó Edge de verdad (`Edg/154.0.4258.37`) y se conectó a él, tras lo cual se
le pidió a esa instancia que se cerrara para que no quedara ninguna ventana; y otra con un
navegador ya en marcha, que no arrancó nada en absoluto. Instalado en el perfil web diario, los
dos artefactos idénticos byte a byte, `--dump-config` sale 0.

**Límites conocidos, dichos sin rodeos**: el perfil de escritorio sigue en la 0.2.1 y el
`dsh web` diario del 3080 sigue ejecutando los artefactos viejos hasta que se reinicie, así que
actualizar la app de escritorio significa volver a instalar allí el tarball. La propia página
del inspector solo recoge una compilación nueva tras un reinicio de `dsh web`, y su superficie
de clic todavía no se ha recorrido a clic limpio en un navegador real — lo que un navegador
real ha comprobado es la *semántica* de pausar / avanzar / detener (una pausa realmente
retiene el clic, soltar realmente hace clic, detener para siempre realmente no hace clic).
«Grabación» significa los fotogramas reproducidos al ritmo al que se tomaron; no se produce
ningún archivo de vídeo. El registro cae en el directorio temporal del sistema, contiene texto
de página, y nada lo limpia automáticamente.

## License

MIT. Parte del código deriva de jev-ultrafast (MIT, © 2026 Browser Use); la lista de
archivos derivados está en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), y el aviso de
aguas arriba está reproducido en [LICENSE](LICENSE).
