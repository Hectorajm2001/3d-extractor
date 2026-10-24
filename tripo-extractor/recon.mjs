#!/usr/bin/env node
/**
 * Reconocimiento: abre la página de Tripo y registra todo el tráfico
 * relevante (API, GLB, texturas) para descubrir cómo sirve el visor el modelo.
 *
 * Uso: node recon.mjs <url> [--visible]
 */

import { chromium } from "playwright-core";
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

const url = process.argv[2];
if (!url) {
  console.error("Uso: node recon.mjs <url> [--visible]");
  process.exit(1);
}
const visible = process.argv.includes("--visible");

async function findBrowser() {
  for (const c of DEFAULT_BROWSERS) {
    try {
      await fs.access(c);
      return c;
    } catch {}
  }
  throw new Error("No encontré navegador.");
}

const browserPath = await findBrowser();
const out = path.resolve("recon");
await fs.mkdir(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: !visible,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ],
});

const registros = [];
const interesantes = [];

try {
  const ctx = await browser.newContext({
    locale: "es-MX",
    viewport: { width: 1400, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);

  page.on("console", (m) => {
    if (m.type() === "error") registros.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => registros.push(`pageerror: ${String(e).slice(0, 300)}`));

  page.on("response", async (res) => {
    const u = res.url();
    const ct = res.headers()["content-type"] || "";
    const tipo = res.request().resourceType();
    if (ct.includes("json") || /\.(glb|gltf|bin|ktx2|webp|png|jpe?g)(\?|$)/i.test(u) || /api|graphql|\/v\d\//i.test(u)) {
      const item = { status: res.status(), tipo, ct: ct.split(";")[0], url: u };
      if (ct.includes("json")) {
        try {
          item.cuerpo = await res.text();
          if (item.cuerpo.length > 20000) item.cuerpo = item.cuerpo.slice(0, 20000) + "…";
        } catch {}
      }
      interesantes.push(item);
    }
  });
  page.on("requestfailed", (r) =>
    registros.push(`requestfailed: ${r.url().slice(0, 200)} ${r.failure()?.errorText}`),
  );

  console.log(`Abriendo ${url} …`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  console.log("Esperando a que cargue el visor…");
  await page.waitForTimeout(25_000);

  const estado = await page.evaluate(() => ({
    titulo: document.title,
    html: document.documentElement.outerHTML.length,
    canvases: [...document.querySelectorAll("canvas")].map((c) => [c.width, c.height]),
    gltf: typeof window.gltf,
    claves: Object.keys(window).filter((k) => /tripo|model|task|project/i.test(k)).slice(0, 50),
    texto: document.body.innerText.slice(0, 1500),
  }));

  await fs.writeFile(path.join(out, "pagina.html"), await page.content(), "utf8");
  await fs.writeFile(
    path.join(out, "interesantes.json"),
    JSON.stringify(interesantes, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(out, "registros.txt"), registros.join("\n"), "utf8");
  await page.screenshot({ path: path.join(out, "pantalla.png"), fullPage: false });

  console.log(JSON.stringify(estado, null, 2));
  console.log(`\nRespuestas interesantes: ${interesantes.length}`);
  for (const i of interesantes) {
    console.log(`  [${i.status}] ${i.tipo} ${i.ct} ${i.url.slice(0, 220)}`);
  }
} finally {
  await browser.close();
}
