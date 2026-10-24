#!/usr/bin/env node
/**
 * Verifica e inspecciona un GLB: cabecera, triángulos, vértices, skins,
 * animaciones, morph targets, materiales y texturas.
 *
 * Uso: node verificar.mjs <archivo.glb>
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("Uso: node verificar.mjs <archivo.glb>");
  process.exit(1);
}

const buf = await fs.readFile(file);
if (buf.toString("ascii", 0, 4) !== "glTF") throw new Error("El archivo no empieza con la firma glTF.");

const version = buf.readUInt32LE(4);
const declared = buf.readUInt32LE(8);

let offset = 12;
let doc = null;
let binLength = 0;
while (offset < buf.length) {
  const length = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const chunk = buf.subarray(offset + 8, offset + 8 + length);
  if (type === 0x4e4f534a) doc = JSON.parse(chunk.toString("utf8"));
  else if (type === 0x004e4942) binLength = length;
  offset += 8 + length + ((4 - (length % 4)) % 4);
}

const acc = doc.accessors ?? [];
let triangles = 0;
let vertices = 0;
let morphs = 0;
for (const mesh of doc.meshes ?? []) {
  for (const prim of mesh.primitives ?? []) {
    if (prim.indices != null) triangles += Math.floor(acc[prim.indices].count / 3);
    if (prim.attributes?.POSITION != null) vertices += acc[prim.attributes.POSITION].count;
    morphs += (prim.targets ?? []).length;
  }
}

const hash = crypto.createHash("sha256").update(buf).digest("hex");
const images = (doc.images ?? []).map((i) => i.mimeType ?? "?");
const extensions = doc.extensionsUsed ?? [];

console.log(`Archivo:      ${path.resolve(file)}`);
console.log(`Tamaño:       ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`SHA-256:      ${hash}`);
console.log(`Cabecera:     glTF v${version}, longitud declarada ${declared} (${declared === buf.length ? "coincide" : "NO coincide"})`);
console.log(`Generador:    ${doc.asset?.generator ?? "?"}`);
console.log(`Mallas:       ${(doc.meshes ?? []).length}`);
console.log(`Triángulos:   ${triangles.toLocaleString("es-MX")}`);
console.log(`Vértices:     ${vertices.toLocaleString("es-MX")}`);
console.log(`Skins:        ${(doc.skins ?? []).length}`);
console.log(`Animaciones:  ${(doc.animations ?? []).length}`);
console.log(`Morphs:       ${morphs}`);
console.log(`Materiales:   ${(doc.materials ?? []).length}`);
console.log(`Texturas:     ${(doc.textures ?? []).length} (${images.join(", ") || "sin imágenes"})`);
console.log(`Extensiones:  ${extensions.length ? extensions.join(", ") : "ninguna"}`);

if (declared !== buf.length) process.exitCode = 2;
