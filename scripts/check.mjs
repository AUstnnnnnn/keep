import { access, readFile } from "node:fs/promises";

const required = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  "src/app.js",
  "src/styles.css",
  ".github/workflows/pages.yml"
];

await Promise.all(required.map((file) => access(file)));

const html = await readFile("index.html", "utf8");
const app = await readFile("src/app.js", "utf8");

if (!html.includes('id="app"')) throw new Error("Missing app mount");
if (!app.includes("KeepStore")) throw new Error("Missing storage module");
if (!app.includes("api.themoviedb.org")) throw new Error("Missing TMDB integration");
if (!app.includes("api.jikan.moe")) throw new Error("Missing Jikan integration");

console.log("Static checks passed");

