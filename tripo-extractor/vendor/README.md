# Terceros

## `webglripper.js`

Motor de captura WebGL copiado de **[WebGLRipper](https://github.com/int3re/WebGLRipper)** (rama `main`, descargado el 2026-10-23).

- Autor original: Rilshrink; reescritura y mantenimiento: int3re.
- Licencia: MIT (ver `webglripper.LICENSE`).
- Se usa únicamente en `--modo gpu`: engancha WebGL, graba un frame y reconstruye un GLB estático con las texturas leídas de la GPU.
- No se ha modificado el archivo; se inyecta tal cual con `context.addInitScript({ path })`.

Si actualizas el motor, sustituye `webglripper.js` por la versión nueva y conserva la licencia.
