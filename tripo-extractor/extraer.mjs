#!/usr/bin/env node
/**
 * tripo-extractor
 *
 * Recupera el GLB de un modelo público de Tripo 3D desde su página de Studio,
 * junto con las texturas PBR incrustadas, la vista previa y los metadatos.
 *
 * Cómo funciona:
 *   1. Extrae el UUID del proyecto de la URL.
 *   2. Abre la página en un navegador Chromium (Brave/Chrome/Edge) para pasar
 *      la protección de Cloudflare y obtener el HTML renderizado en servidor.
 *   3. Lee el payload de Nuxt (`__NUXT_DATA__`) y localiza el proyecto y su
 *      operador activo. El visor de Tripo recibe las URLs firmadas del GLB ahí.
 *   4. Descarga el GLB directamente desde el CDN firmado.
 *   5. Extrae los mapas PBR incrustados en el GLB y escribe los metadatos.
 *
 * Uso:
 *   node extraer.mjs <url-o-id> [opciones]
 *
 * Opciones:
 *   --salida <dir>       Carpeta base de salida (por defecto ./salidas)
 *   --modo <modo>        payload (defecto), red o gpu
 *   --gpu                Atajo de --modo gpu
 *   --gpu-completo       En modo gpu, no cuantizar ni recomprimir texturas
 *   --sin-texturas       No extraer los mapas PBR del GLB
 *   --sin-preview        No descargar la vista previa ni el render
 *   --sin-entrada        No descargar la imagen de entrada
 *   --animaciones        Descargar también los GLB de retargeting (si existen)
 *   --visible            Mostrar el navegador (útil si el modo headless falla)
 *   --navegador <ruta>   Ruta al ejecutable de Brave/Chrome/Edge
 */

import { chromium } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";

const DEFAULT_BROWSERS = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function parseArgs(argv) {
  const args = {
    base: "salidas",
    texturas: true,
    preview: true,
    entrada: true,
    animaciones: false,
    visible: false,
    navegador: null,
    objetivo: null,
    modo: "payload",
    gpuCompacto: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--salida") args.base = argv[++i];
    else if (a === "--sin-texturas") args.texturas = false;
    else if (a === "--sin-preview") args.preview = false;
    else if (a === "--sin-entrada") args.entrada = false;
    else if (a === "--animaciones") args.animaciones = true;
    else if (a === "--visible") args.visible = true;
    else if (a === "--navegador") args.navegador = argv[++i];
    else if (a === "--modo") args.modo = String(argv[++i]).toLowerCase();
    else if (a === "--gpu") args.modo = "gpu";
    else if (a === "--gpu-completo") args.gpuCompacto = false;
    else if (!a.startsWith("--") && !args.objetivo) args.objetivo = a;
  }
  if (!args.objetivo) {
    console.error("Falta la URL o el ID del proyecto.");
    console.error("Ejemplo: node extraer.mjs https://studio.tripo3d.ai/3d-model/<slug>-<uuid>");
    process.exit(1);
  }
  if (!["payload", "red", "gpu"].includes(args.modo)) {
    console.error(`Modo desconocido: ${args.modo}. Usa payload, red o gpu.`);
    process.exit(1);
  }
  return args;
}

function idFrom(input) {
  const m = String(input).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`No encontré un ID de proyecto en: ${input}`);
  return m[0];
}

async function findBrowser(explicit) {
  if (explicit) {
    await fs.access(explicit);
    return explicit;
  }
  if (process.env.TRIPO_BROWSER) {
    await fs.access(process.env.TRIPO_BROWSER);
    return process.env.TRIPO_BROWSER;
  }
  for (const candidate of DEFAULT_BROWSERS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* siguiente */
    }
  }
  throw new Error(
    "No encontré Brave/Chrome/Edge. Indica la ruta con --navegador o la variable TRIPO_BROWSER.",
  );
}

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function sha256File(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Payload de Nuxt (formato devalue)                                   */
/* ------------------------------------------------------------------ */

function parseNuxtPayload(text) {
  const raw = JSON.parse(text);
  const cache = new Map();

  function resolve(i, depth = 0) {
    if (typeof i !== "number") return i;
    if (i < 0) {
      if (i === -1) return undefined;
      if (i === -2) return null;
      if (i === -3) return NaN;
      if (i === -4) return Infinity;
      if (i === -5) return -Infinity;
      if (i === -6) return -0;
      return undefined;
    }
    if (cache.has(i)) return cache.get(i);
    if (depth > 80) return null;
    const v = raw[i];
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      const tag = v[0];
      if (
        tag === "Ref" ||
        tag === "Reactive" ||
        tag === "ShallowRef" ||
        tag === "ShallowReactive" ||
        tag === "EmptyRef" ||
        tag === "EmptyShallowRef" ||
        tag === "skipHydrate"
      ) {
        return resolve(v[1], depth + 1);
      }
      if (tag === "Date") return new Date(v[1]);
      if (tag === "Set" || tag === "Map") return v.slice(1).map((x) => resolve(x, depth + 1));
      if (tag === "RegExp" || tag === "URL") return v[1];
      if (tag === "BigInt") return v[1];
      const out = [];
      cache.set(i, out);
      for (const x of v) out.push(resolve(x, depth + 1));
      return out;
    }
    const out = {};
    cache.set(i, out);
    for (const [k, val] of Object.entries(v)) out[k] = resolve(val, depth + 1);
    return out;
  }

  return resolve(0);
}

function findProject(root, projectId) {
  const direct = root?.pinia?.["3d-model-store"]?.project;
  if (direct?.id === projectId) return direct;

  const seen = new Set();
  const queue = [root];
  let fallback = null;
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (node.id === projectId && (node.model_url || node.operator?.model_url || node.project_name)) {
      if (node.model_url || node.operator?.model_url) return node;
      fallback ??= node;
    }
    queue.push(...Object.values(node));
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* GLB                                                                 */
/* ------------------------------------------------------------------ */

function leerGlb(buf) {
  if (buf.toString("ascii", 0, 4) !== "glTF") throw new Error("El archivo no es un GLB válido.");
  const version = buf.readUInt32LE(4);
  const declared = buf.readUInt32LE(8);
  let offset = 12;
  let doc = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const chunk = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 0x4e4f534a) doc = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!doc) throw new Error("El GLB no contiene el chunk JSON.");
  return { doc, bin, version, declared };
}

function dimensionesImagen(bytes, mime) {
  try {
    if (mime === "image/png" && bytes.toString("ascii", 1, 4) === "PNG") {
      return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
    }
    if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let off = 2;
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xff) break;
        const marker = bytes[off + 1];
        const len = bytes.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return `${bytes.readUInt16BE(off + 7)}x${bytes.readUInt16BE(off + 5)}`;
        }
        off += 2 + len;
      }
    }
    if (mime === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF") {
      const fmt = bytes.toString("ascii", 12, 16);
      if (fmt === "VP8X") {
        const w = 1 + bytes.readUIntLE(24, 3);
        const h = 1 + bytes.readUIntLE(27, 3);
        return `${w}x${h}`;
      }
      if (fmt === "VP8 ") {
        return `${bytes.readUInt16LE(26) & 0x3fff}x${bytes.readUInt16LE(28) & 0x3fff}`;
      }
      if (fmt === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return `${(bits & 0x3fff) + 1}x${((bits >> 14) & 0x3fff) + 1}`;
      }
    }
  } catch {
    /* dimensión desconocida */
  }
  return null;
}

function extDeMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/ktx2") return "ktx2";
  return "bin";
}

function bytesDeImagen(doc, bin, img) {
  if (img.bufferView != null) {
    const bv = doc.bufferViews[img.bufferView];
    const inicio = bv.byteOffset || 0;
    return bin.subarray(inicio, inicio + bv.byteLength);
  }
  if (typeof img.uri === "string" && img.uri.startsWith("data:")) {
    return Buffer.from(img.uri.split(",")[1], "base64");
  }
  return null;
}

function inventarioGlb(buf) {
  const { doc, bin, version, declared } = leerGlb(buf);
  const acc = doc.accessors ?? [];
  let triangulos = 0;
  let vertices = 0;
  let morphs = 0;
  const aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.indices != null) triangulos += Math.floor(acc[prim.indices].count / 3);
      else if (prim.attributes?.POSITION != null) triangulos += Math.floor(acc[prim.attributes.POSITION].count / 3);
      const pos = prim.attributes?.POSITION;
      if (pos != null) {
        vertices += acc[pos].count;
        if (acc[pos].min && acc[pos].max) {
          for (let k = 0; k < 3; k++) {
            aabb.min[k] = Math.min(aabb.min[k], acc[pos].min[k]);
            aabb.max[k] = Math.max(aabb.max[k], acc[pos].max[k]);
          }
        }
      }
      morphs += (prim.targets ?? []).length;
    }
  }
  const imagenes = (doc.images ?? []).map((img, i) => {
    const bytes = bytesDeImagen(doc, bin, img);
    const mime = img.mimeType || "application/octet-stream";
    return {
      indice: i,
      nombre: img.name ?? null,
      mime,
      bytes: bytes?.length ?? 0,
      dimensiones: bytes ? dimensionesImagen(bytes, mime) : null,
      bufferView: img.bufferView ?? null,
    };
  });
  return {
    doc,
    bin,
    version,
    declared,
    stats: {
      generador: doc.asset?.generator ?? null,
      mallas: (doc.meshes ?? []).length,
      triangulos,
      vertices,
      skins: (doc.skins ?? []).length,
      animaciones: (doc.animations ?? []).length,
      nombresAnimaciones: (doc.animations ?? []).map((a) => a.name ?? null),
      morphs,
      materiales: (doc.materials ?? []).length,
      texturas: (doc.textures ?? []).length,
      imagenes,
      extensiones: doc.extensionsUsed ?? [],
      aabb: Number.isFinite(aabb.min[0]) ? aabb : null,
    },
  };
}

function mapasPbr(doc) {
  const porTextura = (ref) => {
    if (!ref || ref.index == null) return null;
    const tex = doc.textures?.[ref.index];
    if (!tex || tex.source == null) return null;
    return tex.source;
  };
  const mapa = new Map();
  const nombres = [
    ["color", (m) => m.pbrMetallicRoughness?.baseColorTexture],
    ["normal", (m) => m.normalTexture],
    ["metallicRoughness", (m) => m.pbrMetallicRoughness?.metallicRoughnessTexture],
    ["occlusion", (m) => m.occlusionTexture],
    ["emissive", (m) => m.emissiveTexture],
  ];
  for (const [i, mat] of (doc.materials ?? []).entries()) {
    for (const [slot, obtener] of nombres) {
      const img = porTextura(obtener(mat));
      if (img == null) continue;
      if (!mapa.has(img)) mapa.set(img, []);
      const usos = mapa.get(img);
      const nombre = usos.length ? `${slot}_${i + 1}` : slot;
      usos.push({ nombre, material: i, slot });
    }
  }
  return mapa;
}

async function extraerTexturas(glb, outDir) {
  const { doc, bin } = glb;
  const dir = path.join(outDir, "texturas");
  await fs.mkdir(dir, { recursive: true });
  const resultado = {};
  const escritos = new Map();

  for (const [imgIndex, usos] of mapasPbr(doc)) {
    const img = doc.images?.[imgIndex];
    const bytes = img ? bytesDeImagen(doc, bin, img) : null;
    if (!bytes) continue;
    const mime = img.mimeType || "application/octet-stream";
    const ext = extDeMime(mime);
    const primero = usos[0];
    const destino = path.join(dir, `${primero.nombre}.${ext}`);

    if (escritos.has(imgIndex)) {
      const ya = escritos.get(imgIndex);
      for (const uso of usos) resultado[uso.nombre] = { ...ya, material: uso.material, slot: uso.slot };
      continue;
    }

    await fs.writeFile(destino, bytes);
    const entrada = {
      archivo: path.relative(outDir, destino).split(path.sep).join("/"),
      bytes: bytes.length,
      mime,
      dimensiones: dimensionesImagen(bytes, mime),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    for (const uso of usos) resultado[uso.nombre] = { ...entrada, material: uso.material, slot: uso.slot };
    escritos.set(imgIndex, entrada);
  }

  // Imágenes que no estén referenciadas por un material (raro, pero posible).
  const pendientes = [];
  doc.images?.forEach((img, i) => {
    if (escritos.has(i)) return;
    const bytes = bytesDeImagen(doc, bin, img);
    if (!bytes) return;
    const mime = img.mimeType || "application/octet-stream";
    const destino = path.join(dir, `imagen_${i + 1}.${extDeMime(mime)}`);
    pendientes.push(
      fs.writeFile(destino, bytes).then(() => {
        resultado[`imagen_${i + 1}`] = {
          archivo: path.relative(outDir, destino).split(path.sep).join("/"),
          bytes: bytes.length,
          mime,
          dimensiones: dimensionesImagen(bytes, mime),
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        };
      }),
    );
  });
  await Promise.all(pendientes);

  return resultado;
}

/* ------------------------------------------------------------------ */
/* Descargas                                                           */
/* ------------------------------------------------------------------ */

function caducidadFirma(url) {
  try {
    const policy = new URL(url).searchParams.get("Policy");
    if (!policy) return null;
    const b64 = policy.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/");
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    const epoch = json?.Statement?.[0]?.Condition?.DateLessThan?.["AWS:EpochTime"];
    return epoch ? new Date(epoch * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

async function descargar(url, destino, etiqueta = "archivo") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${etiqueta}`);
  const total = Number(res.headers.get("content-length") || 0);
  await fs.mkdir(path.dirname(destino), { recursive: true });

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destino, buf);
    return buf.length;
  }

  const fh = await fs.open(destino, "w");
  let hecho = 0;
  let ultimoPct = -1;
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      hecho += chunk.length;
      if (total) {
        const pct = Math.floor((hecho / total) * 100);
        if (pct !== ultimoPct) {
          ultimoPct = pct;
          process.stdout.write(`\r  ${etiqueta}: ${pct}% (${fmt(hecho)})   `);
        }
      }
    }
  } finally {
    await fh.close();
  }
  if (total) process.stdout.write("\n");
  if (total && hecho !== total) throw new Error(`Tamaño inconsistente en ${etiqueta}: ${hecho} != ${total}`);
  return hecho;
}

function extDeUrl(url) {
  const m = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
  const ext = (m?.[1] || "bin").toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/* ------------------------------------------------------------------ */
/* Modos alternativos: red y WebGL/GPU                                 */
/* ------------------------------------------------------------------ */

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(AQUI, "vendor", "webglripper.js");

function nombreDesdeUrl(url, projectId) {
  try {
    const ultimo = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    const sinId = ultimo.replace(/-[0-9a-f-]{36}$/i, "").replace(/-/g, " ").trim();
    return sinId || projectId;
  } catch {
    return projectId;
  }
}

/**
 * Intercepta las respuestas .glb del visor. Espera 2 s tras la última
 * candidata, puntúa las URLs y devuelve la que parece el modelo principal.
 */
function prepararCapturaRed(page, outDir) {
  const candidatos = [];
  let temporizador = null;
  let resolver;
  let rechazar;
  const promesa = new Promise((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  // Evita un unhandled rejection si el payload tarda más que el tiempo límite
  // y todavía no hemos empezado a esperar la respuesta de red.
  promesa.catch(() => {});
  const limite = setTimeout(() => {
    rechazar(new Error("No se interceptó ningún GLB en la red (modo red)."));
  }, 90_000);

  page.on("response", async (res) => {
    const u = res.url();
    if (!/\.glb(\?|$)/i.test(u)) return;
    if (/retarget|point[_ ]?cloud/i.test(u)) return;
    let buf;
    try {
      buf = await res.body();
    } catch {
      return;
    }
    if (!buf || buf.length < 16 || buf.toString("ascii", 0, 4) !== "glTF") return;
    let score = 10;
    if (/tripo_rigging/i.test(u)) score = 100;
    else if (/tripo_pbr_model/i.test(u)) score = 90;
    else if (/tripo_texture/i.test(u)) score = 80;
    else if (/tripo_model/i.test(u)) score = 70;
    else if (/tripo_mesh_seg/i.test(u)) score = 60;
    const temp = path.join(outDir, `.red-${candidatos.length}.glb`);
    try {
      await fs.writeFile(temp, buf);
    } catch {
      return;
    }
    candidatos.push({ url: u, bytes: buf.length, score, temp });
    console.log(`  GLB en red: ${u.split("?")[0].split("/").pop()} (${fmt(buf.length)})`);
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      clearTimeout(limite);
      const mejor = candidatos
        .slice()
        .sort((a, b) => b.score - a.score || b.bytes - a.bytes)[0];
      resolver(mejor);
    }, 2000);
  });

  return { promesa, candidatos };
}

/** Captura un frame WebGL con el motor de WebGLRipper y guarda el GLB. */
async function capturarWebgl(page, destino, compacto) {
  const motor = await page.evaluate(() => !!window[Symbol.for("webglripper.engine")]);
  if (!motor) throw new Error("El motor WebGL no se cargó en la página (vendor/webglripper.js).");

  await page.evaluate(() => {
    window.__ripEstados = [];
    document.addEventListener("webglripper:ext", (e) => {
      window.__ripEstados.push(String(e.detail));
    });
  });

  const descarga = page.waitForEvent("download", { timeout: 180_000 });
  await page.evaluate((compactar) => {
    const settings = {
      export_format: "glb",
      show_preview: false,
      center_model: false,
      glb_compact: compactar,
      bake_poses: true,
      export_camera: false,
      should_download_zip: false,
    };
    document.dispatchEvent(
      new CustomEvent("webglripper:page", {
        detail: JSON.stringify({ type: "capture", settings, locale: "es" }),
      }),
    );
  }, compacto);

  try {
    const d = await descarga;
    await d.saveAs(destino);
    return d.suggestedFilename();
  } catch (e) {
    const estados = await page.evaluate(() => window.__ripEstados || []).catch(() => []);
    const ultimo = estados.length ? estados[estados.length - 1] : "sin estado";
    throw new Error(`La captura WebGL falló: ${ultimo}`);
  }
}

/* ------------------------------------------------------------------ */
/* Principal                                                           */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv);
const projectId = idFrom(args.objetivo);
const browserPath = await findBrowser(args.navegador);
const outDir = path.resolve(args.base, projectId);
await fs.mkdir(outDir, { recursive: true });

console.log(`Proyecto:  ${projectId}`);
console.log(`Navegador: ${browserPath}`);
console.log(`Modo:      ${args.modo}`);
console.log(`Salida:    ${outDir}`);

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: !args.visible,
  args: ["--disable-blink-features=AutomationControlled"],
});

try {
  const context = await browser.newContext({
    locale: "es-MX",
    viewport: { width: 1400, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  if (args.modo === "gpu") {
    await context.addInitScript({ path: ENGINE_PATH });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (!/favicon|analytics|pinterest|tiktok|doubleclick/i.test(t)) {
        console.log(`  [navegador] ${t.slice(0, 200)}`);
      }
    }
  });

  const url = /^https?:\/\//i.test(args.objetivo)
    ? args.objetivo
    : `https://studio.tripo3d.ai/3d-model/${projectId}`;

  const red = args.modo === "red" ? prepararCapturaRed(page, outDir) : null;

  console.log("Abriendo la página pública…");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });

  console.log("Esperando el payload del visor…");
  let proyecto = null;
  let errorPayload = null;
  try {
    await page.waitForFunction(
      () => (document.getElementById("__NUXT_DATA__")?.textContent?.length ?? 0) > 1000,
      null,
      { timeout: 90_000 },
    );
    const payloadTexto = await page.evaluate(
      () => document.getElementById("__NUXT_DATA__").textContent,
    );
    const root = parseNuxtPayload(payloadTexto);
    proyecto = findProject(root, projectId);
    if (!proyecto) errorPayload = "No encontré los datos del proyecto en el payload de la página.";
  } catch {
    const titulo = await page.title().catch(() => "?");
    errorPayload =
      `No encontré el payload de Nuxt (título: "${titulo}"). ` +
      "Puede ser un desafío de Cloudflare: prueba con --visible.";
  }

  if (errorPayload) {
    if (args.modo === "payload") throw new Error(errorPayload);
    console.log(`  aviso: ${errorPayload}`);
    console.log("  Continúo sin metadatos del payload (modo alternativo).");
  }

  const operador = proyecto?.operator ?? {};
  const modelUrl = proyecto?.model_url || operador.model_url;
  if (args.modo === "payload" && !modelUrl) {
    throw new Error("El proyecto no expone una URL de GLB descargable.");
  }

  const nombre = proyecto?.project_name || nombreDesdeUrl(url, projectId);
  const prompt =
    operador.image_to_model?.prompt || proyecto?.biz_info?.description || null;
  const autor = proyecto?.owner_name || null;

  console.log(`Modelo:    ${nombre}`);
  if (autor) console.log(`Autor:     ${autor}`);
  if (prompt) console.log(`Prompt:    ${prompt}`);

  let glbPath = null;
  let fuenteGlb = null;
  let caduca = null;

  if (args.modo === "payload") {
    caduca = caducidadFirma(modelUrl);
    if (caduca) console.log(`Firma CDN: válida hasta ${caduca}`);
    glbPath = path.join(outDir, "modelo.glb");
    await fs.rm(glbPath, { force: true });
    console.log("Descargando el GLB…");
    await descargar(modelUrl, glbPath, "modelo.glb");
    fuenteGlb = modelUrl;
  } else if (args.modo === "red") {
    console.log("Esperando el GLB que carga el visor…");
    const mejor = await red.promesa;
    for (const c of red.candidatos) {
      if (c.temp !== mejor.temp) await fs.rm(c.temp, { force: true });
    }
    glbPath = path.join(outDir, "modelo-red.glb");
    await fs.rm(glbPath, { force: true });
    await fs.rename(mejor.temp, glbPath);
    fuenteGlb = mejor.url;
    caduca = caducidadFirma(mejor.url);
    console.log(
      `GLB interceptado: ${mejor.url.split("?")[0].split("/").pop()} (${fmt(mejor.bytes)})`,
    );
    if (caduca) console.log(`Firma CDN: válida hasta ${caduca}`);
  } else {
    console.log("Preparando la captura WebGL (malla estática)…");
    await page.waitForSelector("canvas", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(9000);
    glbPath = path.join(outDir, "modelo-gpu.glb");
    await fs.rm(glbPath, { force: true });
    const sugerido = await capturarWebgl(page, glbPath, args.gpuCompacto);
    fuenteGlb = url;
    console.log(`Captura WebGL: ${sugerido}`);
  }

  const glbBytes = (await fs.stat(glbPath)).size;
  const glbHash = await sha256File(glbPath);
  console.log(`GLB:       ${fmt(glbBytes)}  sha256 ${glbHash.slice(0, 16)}…`);

  const glb = inventarioGlb(await fs.readFile(glbPath));
  console.log(
    `Malla:     ${glb.stats.triangulos.toLocaleString("es-MX")} triángulos, ` +
      `${glb.stats.vertices.toLocaleString("es-MX")} vértices, ` +
      `${glb.stats.skins} skin(s), ${glb.stats.animaciones} animación(es)`,
  );

  let texturas = {};
  if (args.texturas) {
    console.log("Extrayendo texturas PBR del GLB…");
    texturas = await extraerTexturas(glb, outDir);
    for (const [nombreMapa, info] of Object.entries(texturas)) {
      console.log(
        `  ${nombreMapa}: ${info.archivo} (${info.dimensiones ?? "?"}, ${fmt(info.bytes)})`,
      );
    }
    if (!Object.keys(texturas).length) console.log("  (el GLB no contiene texturas referenciadas)");
  }

  let preview = null;
  let render = null;
  if (args.preview) {
    const urlPreview = proyecto?.biz_info?.display_image;
    if (urlPreview) {
      const destino = path.join(outDir, `preview.${extDeUrl(urlPreview)}`);
      const bytes = await descargar(urlPreview, destino, "preview");
      preview = {
        archivo: path.basename(destino),
        bytes,
        sha256: await sha256File(destino),
      };
      console.log(`Preview:   ${preview.archivo} (${fmt(bytes)})`);
    }
    const urlRender = proyecto?.cover_image?.[0] || proyecto?.cover_image_object?.[0]?.url;
    if (urlRender && urlRender !== urlPreview) {
      const destino = path.join(outDir, `render.${extDeUrl(urlRender)}`);
      const bytes = await descargar(urlRender, destino, "render");
      render = {
        archivo: path.basename(destino),
        bytes,
        sha256: await sha256File(destino),
      };
      console.log(`Render:    ${render.archivo} (${fmt(bytes)})`);
    }
  }

  let entrada = null;
  if (args.entrada) {
    const urlEntrada =
      operador.image_to_model?.generate_image?.[0] ||
      operador.image_to_model?.generate_image_object?.[0]?.url;
    if (urlEntrada) {
      const destino = path.join(outDir, `entrada.${extDeUrl(urlEntrada)}`);
      const bytes = await descargar(urlEntrada, destino, "entrada");
      entrada = {
        archivo: path.basename(destino),
        bytes,
        sha256: await sha256File(destino),
      };
      console.log(`Entrada:   ${entrada.archivo} (${fmt(bytes)})`);
    }
  }

  let animaciones = null;
  if (args.animaciones) {
    if (args.modo === "gpu") {
      console.log(
        "  aviso: el modo gpu no captura el rig; los clips descargados no se podrán aplicar a modelo-gpu.glb.",
      );
    }
    const retargets = operador.retarget ?? [];
    if (retargets.length) {
      console.log(`Descargando ${retargets.length} animación(es) de retargeting…`);
      animaciones = [];
      const dirAnim = path.join(outDir, "animaciones");
      const usados = new Set();
      for (const [i, r] of retargets.entries()) {
        if (!r.model_url) continue;
        const provisional = path.join(dirAnim, `movimiento_${i + 1}.glb`);
        try {
          const etiqueta = `movimiento_${i + 1}`;
          const bytes = await descargar(r.model_url, provisional, etiqueta);
          const inv = inventarioGlb(await fs.readFile(provisional));
          const clip = inv.stats.nombresAnimaciones.find(Boolean);
          const base = (clip || etiqueta)
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || etiqueta;
          let nombre = base;
          for (let n = 2; usados.has(nombre); n++) nombre = `${base}_${n}`;
          usados.add(nombre);
          const destino = path.join(dirAnim, `${nombre}.glb`);
          if (destino !== provisional) await fs.rename(provisional, destino);
          animaciones.push({
            archivo: path.relative(outDir, destino).split(path.sep).join("/"),
            bytes,
            sha256: await sha256File(destino),
            clip: clip ?? null,
            animaciones: inv.stats.animaciones,
            operador: r.operator_id ?? null,
            origen: r.motion_source ?? null,
          });
          console.log(`  ${nombre}.glb (${clip || "sin nombre"}, ${fmt(bytes)})`);
        } catch (e) {
          console.log(`  aviso: no se pudo descargar el movimiento ${i + 1}: ${e.message}`);
        }
      }
      if (!animaciones.length) animaciones = null;
    } else {
      console.log("El proyecto no tiene animaciones de retargeting.");
    }
  }

  const metadata = {
    proyecto: projectId,
    nombre,
    autor,
    metodo: args.modo,
    tipo: proyecto?.type ?? null,
    visibilidad: proyecto?.visibility ?? null,
    categoria: proyecto?.category ?? null,
    estilo: proyecto?.style ?? null,
    uso: proyecto?.use_case ?? null,
    etiquetas: proyecto?.tags ?? [],
    prompt,
    descripcion: proyecto?.biz_info?.description ?? null,
    estadisticas: {
      me_gusta: proyecto?.like_count ?? null,
      guardados: proyecto?.collect_count ?? null,
    },
    operador: {
      id: operador.operator_id ?? null,
      tipo: operador.type ?? null,
      versionModelo: operador.model_version ?? operador.image_to_model?.model_version ?? null,
      pbr: operador.is_pbr ?? null,
      texturizado: operador.is_textured ?? null,
      riggeado: args.modo === "gpu" ? false : (operador.is_rigged ?? null),
      riggeadoEnOrigen: operador.is_rigged ?? null,
      hd: operador.is_hd_textured ?? null,
    },
    fuente: {
      pagina: url,
      glb: fuenteGlb,
      firmaCaduca: caduca,
    },
    glb: {
      archivo: path.basename(glbPath),
      bytes: glbBytes,
      sha256: glbHash,
      version: glb.version,
      ...glb.stats,
    },
    texturas,
    preview,
    render,
    entrada,
    animaciones,
    ...(args.modo === "gpu"
      ? {
          nota:
            "Captura WebGL: malla estática en la pose renderizada, sin rig ni animaciones; " +
            "las texturas se leyeron de la GPU y pueden diferir del GLB original.",
        }
      : {}),
    extraidoEn: new Date().toISOString(),
    herramienta: `tripo-extractor ${VERSION}`,
  };

  await fs.writeFile(path.join(outDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  console.log("\nListo.");
  console.log(`  ${glbPath}`);
  console.log(`  ${path.join(outDir, "metadata.json")}`);
  if (Object.keys(texturas).length) console.log(`  ${path.join(outDir, "texturas")}`);
} finally {
  await browser.close();
}
