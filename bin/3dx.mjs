#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROVIDERS = {
  meshy: { label: "Meshy", dir: "meshy-extractor", host: /meshy\.ai/i },
  tripo: { label: "Tripo 3D", dir: "tripo-extractor", host: /tripo3d\.ai/i },
};
const BROWSERS = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/brave-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

const HELP = `
${pc.bold("3dx")} ${pc.dim("- save public Meshy & Tripo 3D models as GLB")}

${pc.bold("Usage")}
  3dx                     interactive mode
  3dx <url> [options]     extract a model
  3dx verify <file.glb>   inspect a GLB

${pc.bold("Options")}
  -o, --out <dir>         output folder           ${pc.dim("(default: ./models)")}
  -m, --mode <mode>       tripo only: payload | network | gpu
      --no-textures       skip PBR texture maps
      --no-preview        skip preview images
      --show-browser      show the browser window
      --browser <path>    Brave / Chrome / Edge executable
  -h, --help
`;

const bail = (v) => {
  if (p.isCancel(v)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return v;
};
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const num = (n) => Number(n).toLocaleString("en-US");

function parse(argv) {
  const a = { url: null, out: "models", mode: null, textures: true, preview: true, show: false, browser: null, verify: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "-h" || x === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (x === "verify") a.verify = argv[++i];
    else if (x === "-o" || x === "--out") a.out = argv[++i];
    else if (x === "-m" || x === "--mode") a.mode = argv[++i];
    else if (x === "--no-textures") a.textures = false;
    else if (x === "--no-preview") a.preview = false;
    else if (x === "--show-browser") a.show = true;
    else if (x === "--browser") a.browser = argv[++i];
    else if (!x.startsWith("-") && !a.url) a.url = x;
  }
  return a;
}

function detect(url) {
  for (const [k, v] of Object.entries(PROVIDERS)) if (v.host.test(url)) return k;
  return null;
}

function findBrowser(explicit) {
  const list = [explicit, process.env.MESHY_BROWSER, process.env.BROWSER_PATH, ...BROWSERS].filter(Boolean);
  return list.find((f) => fs.existsSync(f)) ?? null;
}

// The extractors log in Spanish; show friendly English stages instead.
const STAGES = [
  [/(\d+)%/, (m) => `Transferring GLB ${m[1]}%`],
  [/Abriendo/, () => "Opening public page"],
  [/Consultando|payload/i, () => "Reading model metadata"],
  [/Descifrando/, () => "Decrypting model"],
  [/Descargando el GLB|Esperando el GLB/, () => "Downloading GLB"],
  [/Captura|WebGL/, () => "Capturing WebGL buffers"],
  [/textura/i, () => "Saving textures"],
  [/Preview|Render|Entrada/, () => "Saving previews"],
];
const stage = (line) => STAGES.find(([re]) => re.test(line))?.[1](line.match(STAGES.find(([re]) => re.test(line))[0]));

// Runs a legacy extractor, streaming its latest log line into the spinner.
function run(provider, args, onLine) {
  return new Promise((resolve) => {
    const dir = path.join(ROOT, PROVIDERS[provider].dir);
    const child = spawn(process.execPath, [path.join(dir, "extraer.mjs"), ...args], { cwd: dir });
    let log = "";
    const feed = (d) => {
      log += d;
      const line = String(d)
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (line) onLine(line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => resolve({ code, log }));
  });
}

function summary(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
  const g = meta.glb ?? {};
  const tris = meta.triangulos ?? g.triangulos;
  const maps = Object.keys(meta.texturas ?? {}).length;
  const rows = [
    ["Model", meta.nombre],
    meta.autor && ["Author", meta.autor],
    tris != null && ["Mesh", `${num(tris)} triangles`],
    g.bytes && ["GLB", mb(g.bytes)],
    maps && ["Textures", `${maps} PBR maps`],
    ["Saved to", path.relative(process.cwd(), dir) || dir],
  ].filter(Boolean);
  return rows.map(([k, v]) => `${pc.dim(k.padEnd(9))} ${v}`).join("\n");
}

function verify(file) {
  const r = spawn(process.execPath, [path.join(ROOT, "tripo-extractor", "verificar.mjs"), path.resolve(file)], { stdio: "inherit" });
  r.on("close", (c) => process.exit(c ?? 0));
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.verify !== null) return verify(args.verify);

  const interactive = !args.url;
  p.intro(pc.bgCyan(pc.black(" 3dx ")) + pc.dim("  Meshy & Tripo 3D → GLB"));

  if (interactive) {
    args.url = bail(
      await p.text({
        message: "Paste a Meshy or Tripo model URL",
        placeholder: "https://www.meshy.ai/3d-models/...",
        validate: (v) => (!UUID.test(v ?? "") ? "That doesn't look like a model link (no ID found)" : undefined),
      }),
    );
  }
  const id = args.url.match(UUID)?.[0];
  if (!id) {
    p.cancel("No model ID found in that input.");
    process.exit(1);
  }

  let provider = detect(args.url);
  if (!provider) {
    provider = bail(
      await p.select({
        message: "Which service is this model from?",
        options: Object.entries(PROVIDERS).map(([value, v]) => ({ value, label: v.label })),
      }),
    );
  } else p.log.info(`Detected ${pc.cyan(PROVIDERS[provider].label)} model ${pc.dim(id)}`);

  if (interactive) {
    if (provider === "tripo") {
      args.mode = bail(
        await p.select({
          message: "Extraction mode",
          options: [
            { value: "payload", label: "Signed URL", hint: "fastest, keeps rig · recommended" },
            { value: "red", label: "Network intercept", hint: "grab what the viewer downloads" },
            { value: "gpu", label: "WebGL capture", hint: "static mesh, last resort" },
          ],
        }),
      );
    }
    const extras = bail(
      await p.multiselect({
        message: "Include",
        options: [
          { value: "textures", label: "PBR texture maps" },
          { value: "preview", label: "Preview images" },
        ],
        initialValues: ["textures", "preview"],
        required: false,
      }),
    );
    args.textures = extras.includes("textures");
    args.preview = extras.includes("preview");
  }
  if (args.mode === "network") args.mode = "red";

  const browser = findBrowser(args.browser);
  if (!browser) {
    p.cancel("No Brave, Chrome or Edge found. Install one or pass --browser <path>.");
    process.exit(1);
  }

  const out = path.resolve(args.out);
  const flags = [args.url, "--salida", out, "--navegador", browser];
  if (!args.textures) flags.push("--sin-texturas");
  if (!args.preview) flags.push("--sin-preview");
  if (args.show) flags.push("--visible");
  if (provider === "tripo" && args.mode) flags.push("--modo", args.mode);

  const s = p.spinner();
  s.start("Starting browser");
  const { code, log } = await run(provider, flags, (l) => { const m = stage(l); if (m) s.message(m); });
  const dir = path.join(out, id);
  if (code !== 0 || !fs.existsSync(path.join(dir, "metadata.json"))) {
    s.stop(pc.red("Extraction failed"), 1);
    p.log.error(log.trim().split("\n").slice(-6).join("\n"));
    p.outro(pc.dim("Try --show-browser, or --mode network / gpu for Tripo."));
    process.exit(1);
  }
  s.stop(pc.green("Model extracted"));
  p.note(summary(dir), "Done");
  p.outro(`Open ${pc.cyan(path.relative(process.cwd(), path.join(dir, "modelo.glb")))} in Blender, three.js, or any glTF viewer.`);
}

main().catch((e) => {
  p.cancel(e.message);
  process.exit(1);
});
