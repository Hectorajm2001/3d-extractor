# meshy-extractor

Recupera el **GLB** de un modelo de Meshy desde su página pública, junto con sus texturas PBR y su vista previa. Pensado para modelos propios o públicos sobre los que tengas derechos.

La página de Meshy no ofrece un `.glb` directo: el visor descarga un contenedor propietario `model.meshy` y lo descifra en el navegador con un worker ligado al dominio. Este script reproduce ese mismo proceso de forma automática.

---

## Requisitos

- **Node.js 18 o superior** (probado con Node 24).
- **Brave, Chrome o Edge** instalado.
- Conexión a internet.
- `npm install` la primera vez.

## Instalación

```bat
cd "E:\workspaces\05-Inteligencia Artificial y ML\HERRAMIENTAS IA\meshy-extractor"
npm install
```

## Uso

```bat
node extraer.mjs <url-o-id> [opciones]
```

Ejemplos:

```bat
node extraer.mjs "https://www.meshy.ai/es/3d-models/019dd323-03a2-77fe-915e-239595f2e69b?share_type=3d-models"

node extraer.mjs 019dd323-03a2-77fe-915e-239595f2e69b --salida "D:\modelos"

node extraer.mjs <url> --sin-texturas --sin-preview
```

### Opciones

| Opción | Efecto |
|---|---|
| `--salida <dir>` | Carpeta base de salida. Por defecto `./salidas`. |
| `--sin-texturas` | No descargar los mapas PBR sueltos. |
| `--sin-preview` | No descargar la imagen de vista previa. |
| `--visible` | Mostrar el navegador (si el modo headless falla). |
| `--navegador <ruta>` | Ruta explícita a `brave.exe`, `chrome.exe` o `msedge.exe`. |

### Salida

```
salidas/
└─ <task-id>/
   ├─ modelo.glb        GLB con mallas y texturas embebidas
   ├─ metadata.json     nombre, triángulos, vértices, AABB, licencia, hashes
   ├─ preview.png       vista previa oficial
   └─ texturas/
      ├─ color.png
      ├─ normal.png
      ├─ roughness.png
      └─ metallic.png
```

## Verificar el resultado

```bat
node verificar.mjs "salidas\<task-id>\modelo.glb"
```

Imprime tamaño, SHA-256, cabecera, triángulos, vértices, skins, animaciones, morph targets y texturas.

Ejemplo ya validado (modelo público de la comunidad de Meshy):

| Métrica | Valor |
|---|---:|
| Tamaño | 20.26 MB |
| Triángulos | 659,684 |
| Vértices | 387,119 |
| Texturas | 4 WebP |
| SHA-256 | `858198a4b717cfa37ea331f0927a8f102f79e6f1663cf8978ce7aa6e3776aeb2` |

## Cómo funciona

1. **ID de la tarea.** Se extrae el UUID de la URL de la página.
2. **Metadatos públicos.** Se consulta `GET /meshyd-api/web/public/v2/tasks/{id}` desde el propio dominio. Devuelve nombre, conteos, AABB y la URL firmada del contenedor `.meshy`.
3. **Origen correcto.** Se abre la página en Chromium para que el worker de descifrado se ejecute en `www.meshy.ai`, que es el dominio autorizado.
4. **Autorización del worker.** El visor firma `hostname:timestamp` con una mezcla FNV-1a y la clave interna `Meshy_Crypto_Key`, y se lo envía al worker `/resource/decrypt/loader-worker.min.js`.
5. **Descifrado.** El worker convierte el contenedor `.meshy` en un GLB.
6. **Transferencia.** El GLB se envía por trozos de 4 MB desde la página a Node y se escribe en disco. Así se evita el límite de descargas del navegador para archivos grandes.
7. **Extras.** Se descargan los mapas PBR y la vista previa, y se escribe `metadata.json` con hashes.

## ¿Y la captura WebGL/GPU?

Se probó a capturar el frame WebGL de la página pública con [WebGLRipper](https://github.com/int3re/WebGLRipper). En una sesión sin login, el visor de Meshy responde `AuthError: NO_TOKEN` y no dibuja el modelo, así que no hay nada que capturar. Aunque se iniciara sesión, la captura devolvería una malla estática reconstruida (sin el GLB original ni sus mapas PBR tal cual), mientras que el método del worker ya obtiene el GLB original descifrado. Por eso este proyecto no incluye un modo GPU: el modo del worker es el camino correcto para Meshy.

## Limitaciones

- **Solo modelos públicos o compartidos.** Si la página exige inicio de sesión o el modelo es privado sin enlace público, la API no devolverá el contenedor.
- **La firma caduca.** Las URLs del CDN llevan una firma temporal; el script pide una nueva en cada ejecución. No guardes la URL como si fuera permanente.
- **El GLB no trae rig.** Es una malla estática: sin esqueleto, sin animaciones y sin morph targets. Para lip sync hay que reconstruir la boca, añadir párpados y riggear.
- **Peso.** Los modelos de Meshy pueden superar los 2 M de triángulos y los 45 MB. Para web hay que decimar y comprimir texturas.
- **Texturas separadas.** El GLB ya incluye las texturas; la carpeta `texturas/` es para edición o para reconstruir materiales en Blender.

## Aviso de uso

Usa esta herramienta únicamente con modelos propios o con permiso explícito del titular. El proceso recupera un asset que Meshy sirve a tu navegador para visualizarlo; no convierte en libre un modelo privado ni sustituye una licencia. Respeta los términos de Meshy y los derechos de autor.

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `No encontré Brave/Chrome/Edge` | Ruta no estándar | `--navegador "C:\ruta\brave.exe"` o variable `MESHY_BROWSER` |
| `La tarea no expone un contenedor .meshy` | ID incorrecto o modelo privado sin enlace público | Comprueba la URL en el navegador |
| `autorización: ...` o `Domain not allowed` | El worker no corre en `www.meshy.ai` | No cambies el dominio de la página |
| El navegador headless no carga | Bloqueo de bot o política local | `--visible` |
| `fetch .meshy: HTTP 403` | Firma caducada entre pasos | Vuelve a ejecutar el script |
| El proceso se corta por memoria | Modelo muy grande | Cierra otras pestañas/procesos y reintenta |

## Archivos

| Archivo | Función |
|---|---|
| `extraer.mjs` | Extracción completa (GLB + texturas + metadata). |
| `verificar.mjs` | Inspección y validación de un GLB. |
| `package.json` | Dependencia `playwright-core`. |
| `salidas/` | Resultados (ignorada por git). |

## Licencia

MIT. Consulta [`../LICENSE`](../LICENSE).

