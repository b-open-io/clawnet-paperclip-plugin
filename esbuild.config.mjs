import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// Build constants separately since manifest uses bundle:false and needs constants.js on disk
const constantsCtx = await esbuild.context({
  entryPoints: ["src/constants.ts"],
  outdir: "dist",
  bundle: false,
  format: "esm",
  platform: "node",
  sourcemap: true,
});

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([constantsCtx.watch(), workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for constants, worker, manifest, and ui");
} else {
  await Promise.all([constantsCtx.rebuild(), workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([constantsCtx.dispose(), workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
