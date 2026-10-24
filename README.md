# 3D Extractor

Dos herramientas de línea de comandos para recuperar modelos **GLB** desde páginas públicas de **Meshy** y **Tripo 3D**, con sus texturas, vistas previas y metadatos. Pensadas para modelos propios o públicos sobre los que tengas derechos.

| Herramienta | Qué hace | Método |
|---|---|---|
| [`meshy-extractor`](meshy-extractor/) | Descarga el GLB de un modelo público de Meshy, con sus mapas PBR y su preview. | Reproduce el worker de descifrado del visor de Meshy. |
| [`tripo-extractor`](tripo-extractor/) | Descarga el GLB de un modelo público de Tripo Studio, con sus texturas PBR, preview, entrada y clips de animación. | Lee el payload de Nuxt, intercepta la respuesta del visor o captura el frame WebGL. |

## Requisitos

- **Node.js 20 o superior** (probado con Node 24).
- **Brave, Chrome o Edge** instalado.
- Conexión a internet.
- `npm install` en cada herramienta la primera vez.

## Uso rápido

### Meshy

```bat
cd meshy-extractor
npm install
node extraer.mjs "https://www.meshy.ai/es/3d-models/888fabf2-9177-490e-a78c-1d8ef8d1cdb3"
```

### Tripo

```bat
cd tripo-extractor
npm install
node extraer.mjs "https://studio.tripo3d.ai/3d-model/orange-fox-with-headset-stylized-3d-character-with-white-chest-and-pa-b7bd7346-90d4-4ec7-8b8f-525fc00b0907"
```

Tripo admite tres modos:

```bat
node extraer.mjs <url>                 :: payload (defecto): URL firmada del payload de Nuxt
node extraer.mjs <url> --modo red      :: intercepta el GLB que descarga el visor
node extraer.mjs <url> --modo gpu      :: reconstruye la malla desde WebGL (estática, sin rig)
```

Cada carpeta tiene su propio `README.md` con todas las opciones, la estructura de salida y la solución de problemas.

## Salida

Cada modelo se guarda en `salidas/<id>/`:

```
modelo.glb          GLB (o modelo-red.glb / modelo-gpu.glb según el modo)
metadata.json       nombre, prompt, autor, hashes, caducidad de la firma
preview.webp        vista previa oficial
render.webp         render del visor
entrada.jpg         imagen de entrada
texturas/           mapas PBR extraídos
animaciones/        clips de retargeting (Tripo, opcional)
```

## Verificar un GLB

Desde la carpeta de la herramienta correspondiente:

```bat
node verificar.mjs "salidas\<id>\modelo.glb"
```

## Cómo funciona, en breve

- **Meshy** sirve un contenedor propietario `.meshy` que el visor descifra en el navegador. `meshy-extractor` ejecuta el mismo worker dentro de `www.meshy.ai` y transfiere el GLB resultante a Node.
- **Tripo** renderiza la página en servidor y publica la URL firmada del GLB en el payload de Nuxt. `tripo-extractor` la lee; si no está disponible, puede interceptar la respuesta del visor o capturar los buffers y texturas de WebGL con [WebGLRipper](https://github.com/int3re/WebGLRipper) (MIT).

## Aviso de uso

Usa estas herramientas únicamente con modelos propios o con permiso explícito del titular. Recuperan assets que los visores sirven a tu navegador para visualizarlos; no convierten en libre un modelo privado ni sustituyen una licencia. Respeta los términos de Meshy y Tripo y los derechos de autor.

## Licencia

MIT. Consulta [`LICENSE`](LICENSE). El modo `gpu` de Tripo incluye el motor de WebGLRipper bajo su propia licencia MIT en `tripo-extractor/vendor/webglripper.LICENSE`.
