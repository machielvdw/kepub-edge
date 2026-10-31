import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { makeEpub } from "./fixture.mjs"

// Run explicitly after building: npm run test:package. Requires Python 3 and tar.
test(
  "packed ESM and declarations work outside the workspace; output passes independent validation",
  {
    timeout: 60_000,
  },
  async () => {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const temp = await mkdtemp(join(tmpdir(), "kepub-package-"))
    try {
      const packed = JSON.parse(
        execFileSync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
          {
            cwd: root,
            env: { ...process.env, npm_config_cache: join(temp, "cache") },
            encoding: "utf8",
          }
        )
      )[0]
      assert.ok(packed.files.some((file) => file.path === "dist/index.js"))
      assert.ok(packed.files.some((file) => file.path === "dist/index.d.ts"))
      assert.ok(!packed.files.some((file) => file.path.startsWith("src/")))
      execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp])
      await mkdir(join(temp, "node_modules"), { recursive: true })
      await rename(join(temp, "package"), join(temp, "node_modules/kepub-edge"))
      await writeFile(
        join(temp, "fixture.epub"),
        makeEpub({
          navInSpine: true,
          withCover: true,
          transformChapter: (xhtml) =>
            xhtml
              .replace("xmlns=", "xmlns:x=")
              .replace(
                /(<\/?)(html|head|title|body|h1|p|em)(?=[\s>])/g,
                "$1x:$2"
              ),
        })
      )
      await writeFile(
        join(temp, "consumer.mjs"),
        `
      import { readFile, writeFile } from 'node:fs/promises';
      import { convertEpubToKepubBlob } from 'kepub-edge';
      const blob = await convertEpubToKepubBlob(new Uint8Array(await readFile('fixture.epub')));
      await writeFile('output.kepub.epub', new Uint8Array(await blob.arrayBuffer()));
    `
      )
      execFileSync(process.execPath, ["consumer.mjs"], { cwd: temp })
      execFileSync("python3", [
        join(root, "tests/validate-output.py"),
        join(temp, "output.kepub.epub"),
      ])
      await writeFile(
        join(temp, "consumer.mts"),
        `
      import { convertEpubToKepub, convertEpubToKepubBlob, KepubError, type KepubErrorCode } from 'kepub-edge';
      const stream: ReadableStream<Uint8Array> = await convertEpubToKepub(new Uint8Array());
      const blob: Blob = await convertEpubToKepubBlob(new Uint8Array(), 1024);
      const code: KepubErrorCode = new KepubError('invalid_epub', 'Example').code;
    `
      )
      const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"))
      await writeFile(
        join(temp, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            types: [],
          },
          files: ["consumer.mts"],
        })
      )
      execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
        cwd: temp,
        stdio: "pipe",
      })
      // No source .ts files or monorepo tsconfig are needed by the consumer.
      const declaration = await readFile(
        join(temp, "node_modules/kepub-edge/dist/index.d.ts"),
        "utf8"
      )
      assert.doesNotMatch(declaration, /from ["'][^"']+\.ts["']/)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
)
