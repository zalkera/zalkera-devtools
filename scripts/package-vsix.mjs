#!/usr/bin/env node
// VSIX 를 **스테이징 디렉터리**에서 굽는다.
//
// ■ 왜 스테이징인가 (전부 실측으로 배운 것)
//   확장은 npm 워크스페이스 멤버라 `vsce` 가 **레포 루트를 패키지 루트로 잡는다**. 그러면
//   `packages/core`·`tsconfig.base.json` 까지 끌어와 `invalid relative path` 로 죽는다.
//   우회로 셋을 다 시도했고 전부 막혔다:
//     · `--no-dependencies`      → node_modules 를 통째로 제외한다. npm CLI 가 안 실린다
//     · `.vscodeignore` 부정 규칙 → 의존성 탐지가 무시 규칙보다 **먼저** 죽는다
//     · 워크스페이스 링크 삭제    → 루트 호이스팅본을 다시 따라간다
//   그래서 워크스페이스 **밖**에 독립 패키지를 세우고 거기서 굽는다.
//
// ■ npm CLI 를 왜 실물로 넣나
//   페이로드를 못 받을 때의 폴백이 `npm install` 인데, VS Code 는 npm 을 안 싣는다.
//   자식 프로세스로 실행하는 실물이라 번들에 못 넣는다(`packages/vscode/src/runtime.ts`).
//   레지스트리를 안 타고 루트에 이미 설치된 것을 복사한다 — 재현 가능하고 오프라인에서도 된다.
//
// 사용: node scripts/package-vsix.mjs   →  dist/<name>-<version>.vsix
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "packages", "vscode");
const stage = join(root, ".vsix-stage");
const out = join(root, "dist");

const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));

// ── 1. core 빌드 + 번들 (alias 로 산출물을 끌어온다 — 의존성 선언 0) ─────────
console.log("· core 빌드");
execFileSync("npm", ["run", "build", "-w", "@zalkera/devtools-core"], { cwd: root, stdio: "inherit" });
console.log("· 번들");
execFileSync("npm", ["run", "bundle"], { cwd: ext, stdio: "inherit" });
if (!existsSync(join(ext, "dist", "extension.cjs"))) throw new Error("번들 산출물이 없다 — 중단");

// ── 2. 스테이징 ─────────────────────────────────────────────────────────────
console.log("· 스테이징");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of ["dist", "media", "README.md", "LICENSE", ".vscodeignore"]) {
    const src = join(ext, entry);
    if (existsSync(src)) cpSync(src, join(stage, entry), { recursive: true });
}

// 워크스페이스 흔적을 지운 매니페스트. `dependencies` 는 npm 하나만 남긴다 —
// 스테이징엔 워크스페이스가 없으므로 vsce 탐지가 그것만 본다.
const staged = { ...manifest };
delete staged.devDependencies;
delete staged.scripts;
staged.dependencies = { npm: manifest.dependencies?.npm ?? "*" };
writeFileSync(join(stage, "package.json"), JSON.stringify(staged, null, 2) + "\n");

// ── 3. npm CLI 실물 ─────────────────────────────────────────────────────────
const npmSrc = join(root, "node_modules", "npm");
if (!existsSync(npmSrc)) throw new Error(`npm CLI 가 없다: ${npmSrc} — 먼저 npm install`);
console.log("· npm CLI 복사");
mkdirSync(join(stage, "node_modules"), { recursive: true });
cpSync(npmSrc, join(stage, "node_modules", "npm"), { recursive: true });

// 실행 진입점이 실제로 있는지 본다 — 없으면 폴백이 조용히 죽는다(runtime.ts 가 찾는 자리).
const npmCli = join(stage, "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(npmCli)) throw new Error("npm-cli.js 가 없다 — 폴백이 죽는다. 중단");

// ── 4. 굽기 ─────────────────────────────────────────────────────────────────
console.log("· vsce package");
mkdirSync(out, { recursive: true });
execFileSync("npx", ["vsce", "package", "--out", out], { cwd: stage, stdio: "inherit" });

// ── 5. 검수 — 담겼어야 할 것이 실제로 담겼는가 ────────────────────────────────
const vsix = readdirSync(out).filter((f) => f.endsWith(".vsix")).map((f) => join(out, f)).sort();
const made = vsix.at(-1);
if (!made) throw new Error("VSIX 가 안 나왔다 — 중단");
const listed = execFileSync("unzip", ["-Z1", made], { encoding: "utf8" }).split("\n");
const must = ["extension/dist/extension.cjs", "extension/package.json", "extension/node_modules/npm/bin/npm-cli.js"];
const missing = must.filter((m) => !listed.includes(m));
if (missing.length) throw new Error(`VSIX 에 빠진 것: ${missing.join(", ")}`);
console.log(`\n✅ ${made}\n   항목 ${listed.length - 1}개 · 필수 3종 확인`);
rmSync(stage, { recursive: true, force: true });
