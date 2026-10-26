# tripo-extractor

Recupera el **GLB** de un modelo de Tripo 3D desde su página pública de Studio, junto con sus texturas PBR, su vista previa y sus metadatos. Pensado para modelos propios o públicos sobre los que tengas derechos.

Tripo no cifra el contenedor: la página se renderiza en servidor y lleva las URLs firmadas del CDN dentro del payload de Nuxt (`__NUXT_DATA__`). El script abre la página con un navegador real para pasar Cloudflare, lee ese payload y descarga el GLB directamente. Si el payload no está disponible, hay dos modos alternativos: interceptar el GLB que carga el visor (**red**) o reconstruirlo desde WebGL (**gpu**).

---

## Requisitos

- **Node.js 20 o superior** (probado con Node 24).
- **Brave, Chrome o Edge** instalado.
- Conexión a internet.
- `npm install` la primera vez.

## Instalación

```bat
cd "E:\workspaces\05-Inteligencia Artificial y ML\HERRAMIENTAS IA\tripo-extractor"
npm install
```

## Uso

```bat
node extraer.mjs <url-o-id> [opciones]
```

Ejemplos:

```bat
node extraer.mjs "https://studio.tripo3d.ai/3d-model/steampunk-airship-with-striped-balloon-wooden-hull-and-metallic-brace-8dce1dae-e552-42cd-9e63-bb068bd04ceb"

node extraer.mjs 8dce1dae-e552-42cd-9e63-bb068bd04ceb --salida "D:\modelos"

node extraer.mjs <url> --sin-texturas --sin-preview --sin-entrada

node extraer.mjs <url> --animaciones

node extraer.mjs <url> --modo red
node extraer.mjs <url> --modo gpu
```

### Modos de extracción

| Modo | Qué obtiene | Rig / animaciones | Cuándo usarlo |
|---|---|---|---|
| `payload` (defecto) | El GLB original desde la URL firmada del payload de Nuxt. | Sí (rig en el GLB; clips aparte). | Caso normal. Es el de mejor calidad. |
| `red` | El mismo GLB original, interceptando la respuesta que descarga el visor. | Sí (idéntico al de `payload`). | Si el payload no expone la URL, cambia de estructura o falla la descarga directa. |
| `gpu` | Una malla estática reconstruida desde los buffers y texturas de WebGL. | No: sin skin ni animaciones. | Si no hay URL, ni respuesta de red, ni payload; o para comprobar qué está renderizando la GPU. |

`payload` y `red` producen **el mismo archivo byte a byte** (mismo SHA-256). `gpu` produce una malla equivalente en triángulos, pero estática y con las texturas leídas de la GPU.

### Opciones

| Opción | Efecto |
|---|---|
| `--salida <dir>` | Carpeta base de salida. Por defecto `./salidas`. |
| `--modo <payload\|red\|gpu>` | Método de extracción. Por defecto `payload`. |
| `--gpu` | Atajo de `--modo gpu`. |
| `--gpu-completo` | En modo `gpu`, no cuantizar la geometría ni recomprimir las texturas. |
| `--sin-texturas` | No extraer los mapas PBR incrustados en el GLB. |
| `--sin-preview` | No descargar la vista previa ni el render. |
| `--sin-entrada` | No descargar la imagen de entrada (la que generó el modelo). |
| `--animaciones` | Descargar también los GLB de retargeting (si el proyecto los tiene). |
| `--visible` | Mostrar el navegador (si el modo headless falla). |
| `--navegador <ruta>` | Ruta explícita a `brave.exe`, `chrome.exe` o `msedge.exe`. |

### Salida

```
salidas/
└─ <project-id>/
   ├─ modelo.glb              GLB original en modo payload
   ├─ modelo-red.glb          GLB original en modo red
   ├─ modelo-gpu.glb          malla estática en modo gpu
   ├─ metadata.json           nombre, prompt, autor, método, hashes, caducidad de la firma
   ├─ preview.webp            vista previa oficial del proyecto
   ├─ render.webp             render del visor (malla texturizada)
   ├─ entrada.jpg             imagen de entrada usada para generar el modelo
   ├─ texturas/
   │  ├─ color.jpg            4096×4096 (si el modelo es PBR)
   │  ├─ normal.jpg           2048×2048
   │  └─ metallicRoughness.jpg
   └─ animaciones/            solo con --animaciones
      ├─ walk.glb             clip de animación (sin malla)
      ├─ dance_02.glb
      └─ …                    el nombre sale del clip; si no existe, movimiento_N
```

La composición exacta de `texturas/` cambia según el modelo: algunos solo traen `color`, otros PBR completo. Los nombres se toman de las referencias del material glTF (`baseColorTexture`, `normalTexture`, `metallicRoughnessTexture`, etc.). En modo `gpu` las texturas se guardan como JPEG/PNG según lo que lea el motor.

## Verificar el resultado

```bat
node verificar.mjs "salidas\<project-id>\modelo.glb"
node verificar.mjs "salidas\<project-id>\modelo-red.glb"
node verificar.mjs "salidas\<project-id>\modelo-gpu.glb"
```

Imprime tamaño, SHA-256, cabecera, triángulos, vértices, skins, animaciones, morph targets, materiales, texturas y extensiones.

Ejemplo ya validado (modelo público de Tripo con rig):

| Métrica | `payload` / `red` | `gpu` (compacto) |
|---|---:|---:|
| Tamaño | 8.06 MB | 4.51 MB |
| Triángulos | 19,290 | 19,290 |
| Vértices | 18,504 | 19,347 |
| Skins | 1 | 0 |
| Animaciones | 0 (6 clips aparte con `--animaciones`) | 0 |
| Texturas | color 4K JPEG, normal 2K JPEG, metallicRoughness 2K PNG | color 4K JPEG, normal 2K JPEG, metallicRoughness 2K JPEG |
| Extensiones | `KHR_mesh_quantization`, `EXT_meshopt_compression` | `KHR_mesh_quantization` |
| SHA-256 | `6a049286365775e33dfc0dcbcdd223f635b25fbe33d9bef69f0383d08c076173` | `6efcf0e00cedac3914161f3457aa1efc4793b3502d21027fd011fabfa33df5bc` * |

\* La captura GPU depende del frame y de la compresión; el hash puede variar entre ejecuciones.

## Cómo funciona

1. **ID del proyecto.** Se extrae el UUID de la URL (o se usa tal cual si se pasa el ID).
2. **Página con navegador real.** Se abre `studio.tripo3d.ai` en Chromium (Brave/Chrome/Edge). Cloudflare exige un navegador con JavaScript; el modo headless suele bastar.
3. **Payload de Nuxt.** El HTML incluye `<script id="__NUXT_DATA__">` con el estado de la aplicación serializado en formato *devalue*. El script lo deserializa y busca el proyecto en `pinia["3d-model-store"].project`.
4. **Operador activo.** Dentro del proyecto, `operator` indica la versión que muestra el visor (`image_to_model`, `texturing`, `rigging`, etc.) y contiene la `model_url` firmada.
5. **Descarga.** El GLB se baja del CDN con la firma temporal de CloudFront; no hace falta iniciar sesión ni descifrar nada.
6. **Modo red.** Se escucha la respuesta `.glb` que pide el visor, se puntúa por nombre (`tripo_rigging`, `tripo_model`, etc.) y se guarda el mismo archivo que llega al navegador.
7. **Modo gpu.** Se inyecta `vendor/webglripper.js` antes de que cargue la página. El motor engancha `bufferData`, `drawElements`, `texImage2D`, etc., graba un frame y reconstruye un GLB con posiciones, normales, UVs y texturas.
8. **Texturas y extras.** Se leen los `bufferView` de las imágenes del GLB, se guardan según los slots del material y se descargan vista previa, render, entrada y, opcionalmente, los clips de retargeting.

## ¿Se puede descargar desde la caché de la GPU?

**No desde `GPUCache`.** Ese directorio guarda shaders compilados y estado de la pipeline, no el modelo. Lo comprobamos con este mismo zorro: `GPUCache` contenía 5 archivos y 5.8 MB, ninguno con cabecera `glTF` ni datos de malla.

**Sí desde la caché HTTP del navegador.** El GLB completo estaba en `Default\Cache\Cache_Data\f_000042` (8,450,920 bytes, cabecera `glTF`). Es la misma respuesta que descarga el visor. Nuestro `--modo red` obtiene esos bytes de forma directa y fiable, sin tener que parsear el formato interno de la caché de Chrome.

**Sí desde la GPU, pero reconstruyendo.** Lo que sí está en la GPU son los buffers y las texturas ya subidos. `--modo gpu` los captura con [WebGLRipper](https://github.com/int3re/WebGLRipper) y reconstruye un GLB estático: mismos 19,290 triángulos y las 3 texturas, pero sin skin ni animaciones y con un peso distinto (4.51 MB en compacto frente a 8.06 MB del original). Es la opción de último recurso.

## Limitaciones

- **Solo modelos públicos o compartidos.** Si la página exige inicio de sesión o el modelo es privado sin enlace público, el payload no incluirá la URL del GLB.
- **La firma caduca.** Las URLs del CDN llevan una firma temporal (normalmente 2–3 días). El script pide una nueva en cada ejecución; no guardes la URL como si fuera permanente.
- **Compresión meshopt.** Los GLB de Tripo usan `EXT_meshopt_compression` y `KHR_mesh_quantization`. Blender 4.1 o superior los importa directamente; en versiones anteriores hay que descomprimirlos con `gltf-transform` o similar.
- **El GLB riggeado no trae animaciones.** Trae esqueleto y skin, pero los clips viven en GLB aparte (retargeting). Usa `--animaciones` para bajarlos: cada clip incluye el mismo esqueleto (mismos nombres de joints) y se puede retargetear al `modelo.glb` en Blender, Unity o three.js.
- **El modo gpu es estático.** No exporta huesos, skin, morph targets ni animaciones; guarda la pose que se está renderizando. Tampoco funciona si el visor dibuja desde un Web Worker con `OffscreenCanvas`.
- **Peso variable.** Hay modelos de ~10 MB con 1 M de triángulos. Para web conviene decimar y comprimir texturas.
- **La estructura de la página puede cambiar.** Si Tripo modifica el payload o el visor, habrá que ajustar `extraer.mjs`. `recon.mjs` sirve para diagnosticar.

## Aviso de uso

Usa esta herramienta únicamente con modelos propios o con permiso explícito del titular. El proceso recupera un asset que Tripo sirve a tu navegador para visualizarlo; no convierte en libre un modelo privado ni sustituye una licencia. Respeta los términos de Tripo y los derechos de autor.

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `No encontré Brave/Chrome/Edge` | Ruta no estándar | `--navegador "C:\ruta\brave.exe"` o variable `TRIPO_BROWSER` |
| `No encontré el payload de Nuxt` | Cloudflare no resolvió el desafío | Reintenta con `--visible`; espera unos segundos. En modo `red`/`gpu` el script continúa sin payload |
| `No encontré los datos del proyecto` | Modelo privado o payload cambiado | Comprueba la URL en el navegador; ejecuta `recon.mjs` o prueba `--modo red` |
| `HTTP 403` al bajar el GLB | Firma caducada entre la carga y la descarga | Vuelve a ejecutar el script o usa `--modo red` |
| `No se interceptó ningún GLB` | El visor no cargó el modelo | Espera a que se vea el modelo; prueba `--visible` |
| `La captura WebGL falló` | El visor no dibujó ningún frame | Abre la página con `--visible`, espera a que se vea el modelo y reintenta |
| El proceso se corta por memoria | Modelo muy grande | Cierra otras pestañas/procesos y reintenta |
| Blender no importa el GLB | Blender < 4.1 (meshopt) | Actualiza Blender o usa `gltf-transform` |

## Archivos

| Archivo | Función |
|---|---|
| `extraer.mjs` | Extracción completa (GLB + texturas + preview + metadata) en los tres modos. |
| `verificar.mjs` | Inspección y validación de un GLB. |
| `recon.mjs` | Diagnóstico: registra el tráfico de la página para depurar cambios. |
| `vendor/webglripper.js` | Motor de captura WebGL (tercero, MIT). |
| `vendor/webglripper.LICENSE` | Licencia MIT de WebGLRipper. |
| `vendor/README.md` | Procedencia y versión del motor. |
| `package.json` | Dependencia `playwright-core`. |
| `salidas/` | Resultados (ignorada por git). |

## Créditos

El modo `gpu` usa **[WebGLRipper](https://github.com/int3re/WebGLRipper)** de Rilshrink/int3re, publicado bajo licencia MIT. El motor se incluye tal cual en `vendor/webglripper.js`; la licencia está en `vendor/webglripper.LICENSE`. Todo el procesamiento ocurre en local.

## Licencia

MIT. Consulta [`../LICENSE`](../LICENSE). El motor de `vendor/` conserva su propia licencia MIT en [`vendor/webglripper.LICENSE`](vendor/webglripper.LICENSE).

