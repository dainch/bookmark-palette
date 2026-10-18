import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, target: "chrome120", logLevel: "info", legalComments: "none" };

await build({ ...common, entryPoints: [join(root, "src/background.ts")], outfile: join(dist, "background.js"), format: "esm" });
await build({ ...common, entryPoints: [join(root, "src/content.ts")], outfile: join(dist, "content.js"), format: "iife" });
await build({ ...common, entryPoints: [join(root, "src/options.ts")], outfile: join(dist, "options.js"), format: "iife" });
await build({ ...common, entryPoints: [join(root, "src/palette.ts")], outfile: join(dist, "palette.js"), format: "iife" });
await build({ ...common, entryPoints: [join(root, "src/suggest.ts")], outfile: join(dist, "suggest.js"), format: "iife" });

for (const file of ["manifest.json", "options.html", "options.css", "palette.html", "suggest.html", "suggest.css"]) {
  cpSync(join(root, "src", file), join(dist, file));
}
console.log("build done ->", dist);
