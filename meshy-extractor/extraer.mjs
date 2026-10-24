#!/usr/bin/env node
/**
 * meshy-extractor
 *
 * Extrae el GLB de un modelo público de Meshy.
 *
 * Cómo funciona:
 *   1. Resuelve el ID de la tarea desde la URL de la página de Meshy.
 *   2. Consulta el endpoint público de la tarea y obtiene la URL del contenedor .meshy.
 *   3. Abre la página en un navegador Chromium (Brave/Chrome/Edge) para tener el origen correcto.
 *   4. Ejecuta el worker de descifrado del propio visor de Meshy dentro de la página.
 *   5. Recibe el GLB por trozos y lo escribe en disco.
 *
 * Uso:
 *   node extraer.mjs <url-o-id> [opciones]
 *
 * Opciones:
 *   --salida <dir>      Carpeta base de salida (por defecto ./salidas)
 *   --sin-texturas      No descargar los mapas PBR
 *   --sin-preview       No descargar la imagen de vista previa
 *   --visible           Mostrar el navegador (útil si el modo headless falla)
 *   --navegador <ruta>  Ruta al ejecutable de Brave/Chrome/Edge
 */

import { chromium } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_BROWSERS = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function parseArgs(argv) {
  const args = { base: "salidas", texturas: true, preview: true, visible: false, navegador: null, objetivo: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--salida") args.base = argv[++i];
    else if (a === "--sin-texturas") args.texturas = false;
    else if (a === "--sin-preview") args.preview = false;
    else if (a === "--visible") args.visible = true;
    else if (a === "--navegador") args.navegador = argv[++i];
    else if (!a.startsWith("--") && !args.objetivo) args.objetivo = a;
  }
  if (!args.objetivo) {
    console.error("Falta la URL o el ID del modelo.");
    console.error("Ejemplo: node extraer.mjs https://www.meshy.ai/es/3d-models/888fabf2-9177-490e-a78c-1d8ef8d1cdb3");
    process.exit(1);
  }
  return args;
}

function taskIdFrom(input) {
  const m = String(input).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error(`No encontré un ID de tarea en: ${input}`);
  return m[0];
}

async function findBrowser(explicit) {
  if (explicit) {
    await fs.access(explicit);
    return explicit;
  }
  if (process.env.MESHY_BROWSER) {
    await fs.access(process.env.MESHY_BROWSER);
    return process.env.MESHY_BROWSER;
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
    "No encontré Brave/Chrome/Edge. Indica la ruta con --navegador o la variable MESHY_BROWSER.",
  );
}

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function sha256(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return buf.length;
}

const args = parseArgs(process.argv);
const taskId = taskIdFrom(args.objetivo);
const browserPath = await findBrowser(args.navegador);
const outDir = path.resolve(args.base, taskId);
const tmpGlb = path.join(outDir, "modelo.glb");

await fs.mkdir(outDir, { recursive: true });
await fs.rm(tmpGlb, { force: true });

console.log(`Tarea:    ${taskId}`);
console.log(`Navegador: ${browserPath}`);
console.log(`Salida:   ${outDir}`);

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: !args.visible,
});

try {
  const context = await browser.newContext({
    locale: "es-MX",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [navegador] ${msg.text().slice(0, 200)}`);
  });

  console.log("Abriendo la página pública…");
  await page.goto(`https://www.meshy.ai/es/3d-models/${taskId}?share_type=3d-models`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });

  console.log("Consultando metadatos públicos…");
  const meta = await page.evaluate(async (id) => {
    const res = await fetch(`/meshyd-api/web/public/v2/tasks/${id}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }, taskId);

  const tarea = meta?.result;
  if (!tarea) throw new Error(`Respuesta inesperada de la API: ${JSON.stringify(meta).slice(0, 300)}`);

  const artefactos = tarea.result ?? {};
  const modelUrl = artefactos?.texture?.modelUrl || artefactos?.modelUrl;
  if (!modelUrl) throw new Error("La tarea no expone un contenedor .meshy descargable.");

  const nombre = tarea.name || taskId;
  const triangulos = tarea.triangleCount ?? null;
  const vertices = tarea.vertexCount ?? null;

  console.log(`Modelo:   ${nombre}`);
  console.log(`Malla:    ${triangulos?.toLocaleString("es-MX") ?? "?"} triángulos, ${vertices?.toLocaleString("es-MX") ?? "?"} vértices`);

  // El worker escribe el GLB por trozos para no depender de descargas del navegador.
  await page.exposeFunction("__meshyChunk", async (b64) => {
    await fs.appendFile(tmpGlb, Buffer.from(b64, "base64"));
  });
  await page.exposeFunction("__meshyProgress", (done, total) => {
    process.stdout.write(`\r  descifrando y transfiriendo: ${((done / total) * 100).toFixed(0)}% (${fmt(done)})   `);
  });

  console.log("Descifrando el contenedor .meshy con el worker del visor…");
  const info = await page.evaluate(async (url) => {
    const KEY = "Meshy_Crypto_Key";

    // Firma que espera el worker: FNV-1a mezclado sobre hostname:timestamp.
    const firma = (texto) => {
      let r = BigInt("14695981039346656037");
      const n = BigInt("1099511628211");
      const mask = BigInt("0xFFFFFFFFFFFFFFFF");
      for (let i = 0; i < KEY.length; i++) {
        r ^= BigInt(KEY.charCodeAt(i));
        r = (r * n) & mask;
      }
      for (let i = 0; i < texto.length; i++) {
        r ^= BigInt(texto.charCodeAt(i));
        r = (r * n) & mask;
      }
      r ^= r >> BigInt(33);
      r = (r * BigInt("0xff51afd7ed558ccd")) & mask;
      r ^= r >> BigInt(33);
      r = (r * BigInt("0xc4ceb9fe1a85ec53")) & mask;
      r ^= r >> BigInt(33);
      return r.toString(16).padStart(16, "0");
    };

    const worker = new Worker("/resource/decrypt/loader-worker.min.js");

    await new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.type === "loaded") {
          const hostname = location.hostname;
          const ts = Date.now();
          worker.postMessage({
            type: "authorize",
            hostname,
            timestamp: ts,
            signature: firma(`${hostname}:${ts}`),
          });
        } else if (d.type === "ready") {
          resolve();
        } else if (d.type === "auth_error") {
          reject(new Error(`autorización: ${d.error || "rechazada"}`));
        }
      };
      worker.onerror = (e) => reject(new Error(`worker: ${e.message || e}`));
    });

    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch .meshy: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();

    const out = await new Promise((resolve, reject) => {
      const id = 1;
      worker.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.type === "process" && d.id === id) {
          if (d.success) resolve(d.data);
          else reject(new Error(`descifrado: ${d.error || "falló"}`));
        }
      };
      worker.postMessage({ id, type: "process", data: buf, mode: "default" }, [buf]);
    });

    const u8 = out instanceof Uint8Array ? out : new Uint8Array(out);
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== "glTF") throw new Error(`El resultado no es un GLB (magic: ${magic})`);

    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; offset < u8.length; offset += CHUNK) {
      const slice = u8.subarray(offset, Math.min(offset + CHUNK, u8.length));
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1]);
        fr.onerror = () => reject(fr.error || new Error("FileReader"));
        fr.readAsDataURL(new Blob([slice]));
      });
      await window.__meshyChunk(b64);
      await window.__meshyProgress(Math.min(offset + CHUNK, u8.length), u8.length);
    }

    return { size: u8.length, magic };
  }, modelUrl);

  process.stdout.write("\n");

  const stat = await fs.stat(tmpGlb);
  if (stat.size !== info.size) throw new Error(`Tamaño inconsistente: ${stat.size} != ${info.size}`);

  console.log(`GLB escrito: ${fmt(stat.size)}`);
  const hash = await sha256(tmpGlb);
  console.log(`SHA-256:     ${hash}`);

  const texturas = {};
  if (args.texturas) {
    const urls = artefactos?.texture?.textureUrls?.[0];
    const mapas = {
      color: urls?.colorMapUrl,
      normal: urls?.normalMapUrl,
      roughness: urls?.roughnessMapUrl,
      metallic: urls?.metallicMapUrl,
    };
    for (const [nombreMapa, url] of Object.entries(mapas)) {
      if (!url) continue;
      const ext = (new URL(url).pathname.match(/\.(png|jpe?g|webp)$/i)?.[1] || "png").toLowerCase();
      const destino = path.join(outDir, "texturas", `${nombreMapa}.${ext}`);
      const bytes = await download(url, destino);
      texturas[nombreMapa] = { archivo: path.relative(outDir, destino), bytes };
      console.log(`Textura ${nombreMapa}: ${fmt(bytes)}`);
    }
  }

  let preview = null;
  if (args.preview && artefactos.previewUrl) {
    const destino = path.join(outDir, "preview.png");
    const bytes = await download(artefactos.previewUrl, destino);
    preview = { archivo: "preview.png", bytes };
    console.log(`Preview: ${fmt(bytes)}`);
  }

  const metadata = {
    tarea: taskId,
    nombre,
    autor: meta.author?.nickname ?? tarea.author?.nickname ?? null,
    licencia: tarea.license ?? null,
    creado: tarea.createdAt ?? null,
    actualizado: tarea.updatedAt ?? null,
    triangulos,
    vertices,
    aabb: tarea.aabb ?? null,
    contenedorMeshy: modelUrl,
    glb: { archivo: "modelo.glb", bytes: stat.size, sha256: hash, magic: info.magic },
    texturas,
    preview,
    extraidoEn: new Date().toISOString(),
    herramienta: "meshy-extractor 1.0.0",
  };
  await fs.writeFile(path.join(outDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  console.log("\nListo.");
  console.log(`  ${path.join(outDir, "modelo.glb")}`);
  console.log(`  ${path.join(outDir, "metadata.json")}`);
} finally {
  await browser.close();
}
