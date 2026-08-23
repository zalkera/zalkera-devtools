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
// ■ 버전
//   확장은 고객 기계에 깔려 **강제 업데이트가 안 된다**. 같은 버전으로 다시 구우면 VS Code 가
//   갱신을 건너뛰어(제거 후 재설치나 --force 가 필요해진다) 시험 루프가 매번 번거로워진다.
//   그래서 굽기 전에 버전을 올린다.
//
//   ⚠ **올리는 것은 확장 버전이지 계약 버전이 아니다.** 백엔드의 `min-extension-version` 은
//   **실제로 계약을 깬 릴리스에서만** 올린다(습관적으로 올리면 고객 노트북이 이유 없이 멈춘다).
//
// 사용:
//   node scripts/package-vsix.mjs                 현재 버전 그대로
//   node scripts/package-vsix.mjs --bump patch    0.1.0 → 0.1.1
//   node scripts/package-vsix.mjs --bump minor    0.1.0 → 0.2.0
//   node scripts/package-vsix.mjs --bump major    0.1.0 → 1.0.0
//   → dist/<name>-<version>.vsix  (+ shared/ 로 사본)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "packages", "vscode");
const stage = join(root, ".vsix-stage");
const out = join(root, "dist");

const manifestPath = join(ext, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// ── 0. 버전 (요청 시) ───────────────────────────────────────────────────────
const bumpAt = process.argv.indexOf("--bump");
if (bumpAt !== -1) {
    const kind = process.argv[bumpAt + 1];
    const order = ["major", "minor", "patch"];
    const at = order.indexOf(kind);
    if (at === -1) throw new Error(`--bump 은 major|minor|patch 중 하나여야 한다 (받은 값: ${kind})`);
    const parts = String(manifest.version).split(".").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
        throw new Error(`버전이 semver 가 아니다: ${manifest.version} — 중단`);
    }
    const before = manifest.version;
    parts[at] += 1;
    for (let i = at + 1; i < 3; i += 1) parts[i] = 0;
    manifest.version = parts.join(".");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`· 버전 ${before} → ${manifest.version}`);
}

// ── 0.5 검사 게이트 ────────────────────────────────────────────────────────
// **굽기 전에 죽는다.** 종전에는 verify 없이 곧장 구워, 테스트가 깨진 채로 고객에게 갈 VSIX 를
// 만들 수 있었다(심의 실측). 번들은 esbuild 라 타입 검사도 안 하므로 여기가 유일한 그물이다.
//
// `--skip-verify` 는 **CI 전용**이다 — CI 는 바로 앞 단계에서 이미 verify 를 돌렸다.
// 손으로 구울 때는 쓰지 마라. 그러라고 둔 문이 아니다.
if (!process.argv.includes("--skip-verify")) {
    console.log("· verify (typecheck · test · labels)");
    execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });
}

// ── 1. core 빌드 + 번들 (alias 로 산출물을 끌어온다 — 의존성 선언 0) ─────────
console.log("· core 빌드");
execFileSync("npm", ["run", "build", "-w", "@zalkera/devtools-core"], { cwd: root, stdio: "inherit" });
console.log("· 번들");
execFileSync("npm", ["run", "bundle"], { cwd: ext, stdio: "inherit" });
if (!existsSync(join(ext, "dist", "extension.cjs"))) throw new Error("번들 산출물이 없다 — 중단");

// ── 1.5 아이콘 온전성 ──────────────────────────────────────────────────────
// 활동 표시줄 SVG 가 깨져도 vsce 는 통과시킨다(내용 검증을 안 한다). 실제로 편집 중
// `<svg>` 여는 태그가 잘린 채로 VSIX 가 구워졌다(2026-08-10). 아이콘이 조용히 사라진다.
{
    const svgPath = join(ext, "media", "zalkera.svg");
    const svg = readFileSync(svgPath, "utf8");
    const opens = (svg.match(/<svg[\s>]/g) ?? []).length;
    const closes = (svg.match(/<\/svg>/g) ?? []).length;
    if (opens !== 1 || closes !== 1) throw new Error(`활동 표시줄 SVG 가 온전하지 않다(open=${opens} close=${closes}): ${svgPath}`);
    if (!svg.includes("viewBox")) throw new Error("활동 표시줄 SVG 에 viewBox 가 없다 — 크기가 어긋난다");
    if (!svg.includes("currentColor")) throw new Error("활동 표시줄 SVG 가 currentColor 를 안 쓴다 — 테마 색이 안 먹는다");
}

// ── 2. 스테이징 ─────────────────────────────────────────────────────────────
console.log("· 스테이징");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ⚠ 화이트리스트다 — **여기 없는 것은 조용히 빠진다.** 확장에 파일을 새로 넣었는데 마켓에서
//   안 보이면 먼저 이 목록을 보라. 빠진 것을 포장이 알아채게 하려면 아래 `must` 에도 넣어야 한다.
for (const entry of ["dist", "media", "README.md", "CHANGELOG.md", "LICENSE", ".vscodeignore"]) {
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

/** 폴더 하나의 바이트 합. 「얼마나 뺐나」를 눈대중으로 적지 않기 위한 것. */
function dirBytes(target) {
    const info = statSync(target);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const entry of readdirSync(target)) total += dirBytes(join(target, entry));
    return total;
}

/** 아래 파일 전부(경로). 확장자 규칙은 부르는 쪽이 정한다. */
function* walkFiles(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walkFiles(full);
        else yield full;
    }
}

// ── 3. npm CLI 실물 ─────────────────────────────────────────────────────────
const npmSrc = join(root, "node_modules", "npm");
if (!existsSync(npmSrc)) throw new Error(`npm CLI 가 없다: ${npmSrc} — 먼저 npm install`);
console.log("· npm CLI 복사");
mkdirSync(join(stage, "node_modules"), { recursive: true });
cpSync(npmSrc, join(stage, "node_modules", "npm"), { recursive: true });

// 실행 진입점이 실제로 있는지 본다 — 없으면 폴백이 조용히 죽는다(runtime.ts 가 찾는 자리).
const npmCli = join(stage, "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(npmCli)) throw new Error("npm-cli.js 가 없다 — 폴백이 죽는다. 중단");

// ── 3b. 읽을거리를 뺀다 ──────────────────────────────────────────────────────
//
// ⚠ **실행되는 것은 하나도 빼지 않는다.** 여기서 지우는 넷은 `npm help` 만 읽는다(`lib/commands/
//    help.js` 가 `man/man[0-9]/*` 와 `docs/output/…` 을 연다). 확장의 폴백은 `npm install` 만
//    부르므로 그 경로를 안 지난다.
//
//    `node-gyp` 는 **안 뺀다.** 2.1MB 로 가장 크지만 그것은 문서가 아니라 네이티브 빌드 폴백이다.
//    그리고 애초에 뺄 수 없다 — npm 의 `bundleDependencies` 에 들어 있어 빼면 `vsce package` 가
//    rc=1 로 선다. 실측: 이 파일에 `prune(join(npmStage, "node_modules", "node-gyp"))` 를 한 줄
//    더해 `node scripts/package-vsix.mjs --skip-verify` 를 돌리면 굽기에서 죽는다.
//    (npm 자체는 의존 없는 프로젝트라면 node-gyp 없이도 `install --dry-run` 이 돈다 — 그러니
//     「npm 이 못 돈다」가 아니라 「포장이 안 된다」가 이유다.)
console.log("· npm 읽을거리 제거");
const npmStage = join(stage, "node_modules", "npm");
let prunedBytes = 0;
const prune = (target) => {
    if (!existsSync(target)) return;
    prunedBytes += dirBytes(target);
    rmSync(target, { recursive: true, force: true });
};
prune(join(npmStage, "docs"));
prune(join(npmStage, "man"));
for (const file of walkFiles(npmStage)) {
    if (/\.(?:md|markdown|png|jpe?g|gif|svg)$/i.test(file)) prune(file);
}
console.log(`  ${Math.round(prunedBytes / 1024)}KB 뺌`);

// **뺀 뒤에 실제로 도는지 본다.** 크기만 재고 넘기면, 폴백이 죽는 것은 그 폴백이 필요한
// 사람에게서만 드러난다 — 우리는 영영 못 본다.
const smoke = mkdtempSync(join(tmpdir(), "zalkera-npmsmoke-"));
writeFileSync(join(smoke, "package.json"), JSON.stringify({ name: "smoke", version: "1.0.0" }) + "\n");
try {
    execFileSync(process.execPath, [npmCli, "install", "--dry-run", "--no-audit", "--no-fund", "--offline"], {
        cwd: smoke,
        stdio: "pipe",
    });
} catch (error) {
    throw new Error(`뺀 뒤 npm 이 안 돈다 — 폴백이 죽는다. 중단\n${error}`);
} finally {
    rmSync(smoke, { recursive: true, force: true });
}
console.log("  npm install 경로 확인");

// ── 4. 굽기 ─────────────────────────────────────────────────────────────────
console.log("· vsce package");
mkdirSync(out, { recursive: true });
execFileSync("npx", ["vsce", "package", "--out", out], { cwd: stage, stdio: "inherit" });

// ── 5. 검수 — 담겼어야 할 것이 실제로 담겼는가 ────────────────────────────────
// 목록에서 "마지막 것"을 고르면 안 된다 — 문자열 정렬은 0.1.10 을 0.1.9 앞에 둔다.
// 방금 구운 파일 이름을 **매니페스트에서 직접 조립**해 그것만 검수한다.
const made = join(out, `${manifest.name}-${manifest.version}.vsix`);
if (!existsSync(made)) throw new Error(`VSIX 가 안 나왔다: ${made} — 중단`);
const listed = execFileSync("unzip", ["-Z1", made], { encoding: "utf8" }).split("\n");
const must = [
    "extension/dist/extension.cjs",
    "extension/package.json",
    "extension/node_modules/npm/bin/npm-cli.js",
    // 「도움말」이 여는 실물. 빠져도 포장은 성공하고, 사용자가 누를 때에야 열리지 않는다.
    "extension/media/help.md",
    // 마켓 페이지의 개요·변경 내역 탭. **vsce 가 이름을 소문자로 바꿔 담는다**(`README.md` →
    // `readme.md`). 그래서 원본 이름으로 찾으면 못 찾는다 — 담긴 이름으로 적는다.
    // 재현: `unzip -Z1 dist/*.vsix | grep -E '^extension/[^/]+$'`
    "extension/readme.md",
    "extension/changelog.md",
];
const missing = must.filter((m) => !listed.includes(m));
if (missing.length) throw new Error(`VSIX 에 빠진 것: ${missing.join(", ")}`);

// 전달용 사본. `shared/` 는 .gitignore(*.vsix)로 커밋되지 않는다 — 손으로 건네는 자리다.
const shared = join(root, "shared");
mkdirSync(shared, { recursive: true });
for (const old of readdirSync(shared).filter((f) => f.endsWith(".vsix"))) rmSync(join(shared, old));
cpSync(made, join(shared, `${manifest.name}-${manifest.version}.vsix`));

console.log(`\n✅ ${made}\n   항목 ${listed.length - 1}개 · 필수 ${must.length}종 확인`);
console.log(`   사본: shared/${manifest.name}-${manifest.version}.vsix`);
console.log(`\n   설치(임시·검증 대기 중일 때): code --install-extension shared/${manifest.name}-${manifest.version}.vsix --force`);
// ⚠ **파일로 깐 확장은 마켓 갱신을 안 받는다.** VS Code 가 마켓 신원 없이 기록하므로 갱신 확인
//    대상에서 빠진다 — 이 줄만 보고 깐 사람은 다음 판이 나와도 계속 옛 판을 쓴다. 그래서 마켓
//    경로를 함께 찍는다(발행이 끝난 뒤에는 이쪽이 정본이다).
console.log(`   설치(정본): code --install-extension ${manifest.publisher}.${manifest.name}`);
// ⚠ **게시도 `vsce` 를 맨손으로 부르면 죽는다** — 이 파일 머리말이 포장에 대해 적은 것과 **같은
//    이유다.** `vsce publish` 는 기본적으로 **다시 포장하므로**, 워크스페이스 멤버 폴더에서 부르면
//    루트를 패키지 루트로 잡아 `invalid relative path: extension/../../tsconfig.base.json` 로 죽는다.
//    포장은 스크립트로 하고 게시는 손으로 하는 사람이 정확히 그 벽에 부딪힌다(실측 · 두 번).
//    `--packagePath` 는 포장 단계를 통째로 건너뛰고 준 파일만 올린다.
console.log(
    `   게시(오너): npx vsce publish --packagePath shared/${manifest.name}-${manifest.version}.vsix`,
);
rmSync(stage, { recursive: true, force: true });
