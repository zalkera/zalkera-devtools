#!/usr/bin/env node
/**
 * **CLI 를 npm 탈볼로 굽는다** — 형제 `package-vsix.mjs` 와 같은 규율이다.
 *
 * ■ 왜 스크립트인가 — `npm pack` 을 직접 부르면 안 되는 이유
 *
 *   `npm pack` 은 **지금 `dist/` 에 있는 것을 그대로 담는다.** 그것이 무엇인지 묻지 않는다:
 *   ⑴ `tsc` 가 남긴 조각들(`*.js` 여럿 + `.d.ts` + `.map`)이면 `@zalkera/devtools-core` 를
 *      **런타임에 해석하려 든다** — 그 패키지는 발행하지 않으므로 고객 기계에서 `ERR_MODULE_NOT_FOUND` 다.
 *   ⑵ 낡은 번들이면 이번 변경이 **안 담긴 채로** 나간다.
 *   그래서 여기서 굽고, 구운 것을 **검수한다.**
 *
 * ■ 검수가 재는 것
 *
 *   ⑴ 탈볼에 담긴 것이 예상 목록 그대로인가(빠진 것·**새로 들어온 것** 둘 다 본다)
 *   ⑵ 번들이 자립하는가 — `@zalkera/devtools-core` 를 런타임에 찾지 않는가
 *   ⑶ shebang 이 **1행에 하나**인가 — 둘이면 Node 가 2행에서 `SyntaxError` 로 죽는다(실측:
 *      원본에 이미 있는데 배너로 하나 더 붙였다). 굽기는 성공하고 **설치해 봐야** 드러난다.
 *   ⑷ 판이 확장과 같은가 — 서버의 최소판 게이트가 하나다(`check-version-lockstep.mjs`)
 *
 * ■ 발행은 **오너만** 한다
 *   npm 자격증명이 필요하다. 이 스크립트는 굽고 멈춘다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli");
const out = join(root, "dist");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const manifest = read(join(cli, "package.json"));
const ext = read(join(root, "packages", "vscode", "package.json"));

// ── 0. 판 축 ────────────────────────────────────────────────────────────────
// ⚠ 여기서도 잰다. `check-version-lockstep.mjs` 가 `verify` 에서 이미 재지만, 이 스크립트는
//   `--skip-verify` 로도 불릴 수 있고 그때 갈린 판이 그대로 npm 에 올라간다.
if (manifest.version !== ext.version) {
    throw new Error(`판 축이 갈렸다 — CLI ${manifest.version} · 확장 ${ext.version}`);
}
if (manifest.private) throw new Error("`private: true` 면 npm 이 발행을 거절한다 — 중단");

// ── 1. 게이트 ───────────────────────────────────────────────────────────────
// ⚠ **`--skip-verify` 는 CI 전용이다** — CI 는 바로 앞 단계에서 이미 verify 를 돌렸다.
//   손으로 구울 때는 쓰지 마라(형제 `package-vsix.mjs` 가 같은 문에 같은 말을 적어 뒀다).
//   그리고 **건넜다는 사실을 배너가 말한다** — 두 경로의 출력이 같으면 어느 쪽으로 구웠는지
//   나중에 아무도 모른다.
const skipped = process.argv.includes("--skip-verify");
if (!skipped) {
    console.log("· npm run verify");
    execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });
}

// ── 2. 굽기 ─────────────────────────────────────────────────────────────────
// ⚠ **먼저 지운다.** 안 지우면 `tsc` 가 남긴 조각(`*.d.ts`·`*.map`·모듈별 `.js`)이 번들 옆에
//   남아 탈볼에 함께 실린다 — `files: ["dist"]` 는 폴더를 통째로 담는다.
console.log("· 번들");
rmSync(join(cli, "dist"), { recursive: true, force: true });
execFileSync("npm", ["run", "build", "-w", "@zalkera/devtools-core"], { cwd: root, stdio: "inherit" });
execFileSync("npm", ["run", "bundle", "-w", manifest.name], { cwd: root, stdio: "inherit" });

console.log("· npm pack");
mkdirSync(out, { recursive: true });
execFileSync("npm", ["pack", "--pack-destination", out], { cwd: cli, stdio: "inherit" });

// ── 3. 검수 ─────────────────────────────────────────────────────────────────
// 이름을 매니페스트에서 조립한다 — 목록에서 「마지막 것」을 고르면 문자열 정렬이 0.1.10 을
// 0.1.9 앞에 둔다(형제 스크립트가 같은 함정을 적어 뒀다).
//
// ⚠ **스코프 패키지의 파일 이름은 패키지 이름과 다르다.** npm 은 `@` 를 떼고 `/` 를 `-` 로 바꿔
//   `@zalkera/cli` → `zalkera-cli-<판>.tgz` 로 낸다. 이름을 그대로 쓰면 방금 구운 파일을
//   「안 나왔다」고 보고한다(실측).
const tarballName = `${manifest.name.replace(/^@/, "").replace(/\//g, "-")}-${manifest.version}.tgz`;
const made = join(out, tarballName);
if (!existsSync(made)) throw new Error(`탈볼이 안 나왔다: ${made} — 중단`);

const listed = execFileSync("tar", ["tzf", made], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
// ⚠ **빠진 것만 재지 않는다.** 새로 들어온 것도 본다 — `files` 를 넓히거나 `dist` 를 안 지우면
//   시험·소스맵·`.d.ts` 가 조용히 실린다. 형제 `check-dist-purity.mjs` 와 같은 규율이다.
const expected = ["package/LICENSE", "package/README.md", "package/dist/main.js", "package/package.json"];
const missing = expected.filter((m) => !listed.includes(m));
const extra = listed.filter((m) => !expected.includes(m));
if (missing.length) throw new Error(`탈볼에 빠진 것: ${missing.join(", ")}`);
if (extra.length) {
    throw new Error(
        `탈볼에 예상 밖의 것이 실렸다: ${extra.join(", ")}\n` +
            "  `dist` 를 안 지웠거나 `files` 가 넓어졌다. 의도한 것이면 이 스크립트의 목록도 고치십시오.",
    );
}

const bundle = readFileSync(join(cli, "dist", "main.js"), "utf8");
// ⑵ 자립 — 발행 안 하는 패키지를 런타임에 찾으면 고객 기계에서 ERR_MODULE_NOT_FOUND 다.
if (/from\s*["']@zalkera\/devtools-core["']/.test(bundle)) {
    throw new Error("번들이 `@zalkera/devtools-core` 를 런타임에 찾는다 — 그 패키지는 발행하지 않는다");
}
// ⑶ shebang — 1행에 하나. 둘이면 설치해 봐야 드러난다.
const lines = bundle.split("\n");
if (lines[0] !== "#!/usr/bin/env node") throw new Error(`1행이 shebang 이 아니다: ${lines[0]?.slice(0, 40)}`);
if (lines.slice(1).some((l) => l.startsWith("#!"))) throw new Error("shebang 이 둘이다 — Node 가 2행에서 죽는다");

// ⑸ **구운 것을 실제로 돌린다.** 위 넷은 전부 정적이라, 이 판이 고친 결함과 **같은 얼굴**의
//    회귀(모듈 최상위에서 던지는 코드)가 넷을 전부 통과한다 — 굽기는 성공하고 사람이 설치해
//    실행할 때에야 죽는다(심의 실측). 형제 `package-vsix.mjs` 도 같은 이유로 실행 축을 둔다.
//
// ⚠ **탈볼을 풀어서 돈다** — `packages/cli/dist` 를 직접 돌리면 `files` 가 빠뜨린 것을 못 잡는다.
console.log("· 구운 것 실행");
const probe = mkdtempSync(join(tmpdir(), "zalkera-pack-"));
try {
    execFileSync("tar", ["xzf", made, "-C", probe], { stdio: "inherit" });
    const entry = join(probe, "package", "dist", "main.js");
    const shown = execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" }).trim();
    if (shown !== manifest.version) {
        throw new Error(`구운 것이 답한 판이 다르다 — 매니페스트 ${manifest.version} · 실행 ${shown}`);
    }
} finally {
    rmSync(probe, { recursive: true, force: true });
}

// 전달용 사본. `shared/` 는 손으로 건네는 자리다.
const shared = join(root, "shared");
mkdirSync(shared, { recursive: true });
// ⚠ **우리 이름의 옛 판만 지운다.** 종전에는 `*.tgz` 를 전부 지워, 옆에 구워 둔 **이름 방어
//   스텁**(`pack:guards`)까지 사라졌다 — 오너가 발행하려던 파일이 조용히 없어진다.
const stem = `${manifest.name.replace(/^@/, "").replace(/\//g, "-")}-`;
for (const old of readdirSync(shared).filter((f) => f.startsWith(stem) && f.endsWith(".tgz"))) {
    rmSync(join(shared, old));
}
cpSync(made, join(shared, tarballName));

console.log(`\n✅ ${made}`);
console.log(`   항목 ${listed.length}개 · 자립 확인 · shebang 1개 · 실행 확인 · 판 ${manifest.version}`);
if (skipped) console.log("   ⚠ `--skip-verify` 로 구웠다 — 시험·검사기를 안 지났다. 발행 전에 `npm run verify` 를 돌리십시오.");
console.log(`   사본: shared/${tarballName}`);
console.log("");
console.log(`   설치해 보기: npm i -g ./shared/${tarballName}`);
console.log(`   발행(오너):  npm publish ./shared/${tarballName}`);
