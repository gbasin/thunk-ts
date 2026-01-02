import { promises as fs } from "fs";
import path from "path";

async function copyFile(srcDir: string, distDir: string, fileName: string): Promise<void> {
  await fs.copyFile(path.join(srcDir, fileName), path.join(distDir, fileName));
}

async function runBuild(entry: string, outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    format: "esm",
  });
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Build failed for ${entry}: ${details}`);
  }
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dir, "..", "..");
  const srcDir = path.join(root, "src", "web");
  const distDir = path.join(root, "dist", "web");

  await fs.mkdir(distDir, { recursive: true });

  await runBuild(path.join(srcDir, "editor.ts"), distDir);
  await runBuild(path.join(srcDir, "list.ts"), distDir);

  await copyFile(srcDir, distDir, "index.html");
  await copyFile(srcDir, distDir, "list.html");
  await copyFile(srcDir, distDir, "styles.css");
}

await main();
