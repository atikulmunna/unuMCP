// Compile a workspace package's TypeScript (src/) to JavaScript (dist/) with
// the same SWC transform the API's dev runner applies on the fly, so the
// production server runs plain JavaScript.
//
//   node ../../scripts/swc-build.mjs esm   # a workspace package ("type": "module")
//   node ../../scripts/swc-build.mjs cjs   # the API (CommonJS)
//
// Run from the package's directory. Tests are not compiled.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

const format = process.argv[2];
if (format !== "esm" && format !== "cjs") throw new Error("usage: swc-build.mjs <esm|cjs>");

const require = createRequire(import.meta.url);
const swc = require("@swc/core");
const src = join(process.cwd(), "src");
const out = join(process.cwd(), "dist");

/** Every .ts file under `dir`, skipping type declarations. */
async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
    .map((e) => join(e.parentPath, e.name));
}

const options = (file) => ({
  filename: file,
  sourceMaps: false,
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    // Nest's dependency injection reads the constructor types SWC records here.
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: "es2022",
    baseUrl: dirname(file),
  },
  // ESM needs explicit file extensions; `resolveFully` writes them into imports.
  module: format === "esm" ? { type: "es6", resolveFully: true } : { type: "commonjs" },
});

await rm(out, { recursive: true, force: true });
const files = await sources(src);
for (const file of files) {
  const { code } = await swc.transformFile(file, options(file));
  const target = join(out, relative(src, file)).replace(/\.ts$/, ".js");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code);
}
console.log(`compiled ${files.length} file(s) to ${relative(process.cwd(), out)} (${format})`);
