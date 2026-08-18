#!/usr/bin/env node
/**
 * **레포에 들어오면 안 되는 것이 들어왔는가.**
 *
 * ■ 왜 있나
 *   `git add -A` 한 번이 워크스페이스 심링크 두 개를 삼켰다. 그 안에 **개발자 홈의 절대경로**가
 *   담겨 공개 MIT 레포로 나갈 뻔했고, 새 클론에서는 그 링크가 끊어져 `npm run verify` 가
 *   종료코드 216 으로 죽었다 — **발행 게이트가 새 기계에서 안 도는 상태**였다.
 *
 *   `.gitignore` 는 `node_modules/` 였다. 뒤의 슬래시가 **디렉터리만** 매칭해서 심링크가 그대로
 *   빠져나갔다. 무시 규칙 하나를 고치는 것으로는 부족하다 — 무시 규칙은 앞으로도 틀릴 수 있고,
 *   틀린 것이 눈에 안 보이는 것이 이 사고의 본질이다. **결과를 검사한다.**
 *
 * ■ 무엇을 보나
 *   ⑴ 추적되는 **심링크가 하나라도** 있으면 반려한다. 이 레포에 심링크를 커밋할 이유가 없고,
 *      있다면 그것이 무엇을 가리키는지가 곧 배송물의 일부가 된다.
 *   ⑵ 추적 파일 중 `node_modules` 성분을 가진 경로가 있으면 반려한다.
 *
 * ■ 걸리면
 *   `git rm --cached <경로>` 로 추적에서 빼고, `.gitignore` 를 **슬래시 없이** 적는다.
 *
 *   재현: `git ls-files -s | awk '$1=="120000"'`
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let listing;
try {
    listing = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
    // git 이 없거나 레포가 아니면 **판정 불가**다. 통과로 읽지 않는다.
    console.error(`❌ 추적 목록 검사 — git 목록을 읽지 못했습니다(통과가 아닙니다): ${err.message}`);
    process.exit(2);
}

const rows = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
        // `<mode> <sha> <stage>\t<path>`
        const tab = line.indexOf("\t");
        return { mode: line.slice(0, 6), path: line.slice(tab + 1) };
    });

if (rows.length === 0) {
    console.error("❌ 추적 목록 검사 — 추적 파일이 0개입니다(통과가 아닙니다). 경로를 확인하십시오.");
    process.exit(2);
}

const symlinks = rows.filter((r) => r.mode === "120000");
const vendored = rows.filter((r) => r.path.split("/").includes("node_modules"));

const bad = [
    ...symlinks.map((r) => `${r.path} — 심링크가 추적됩니다(가리키는 경로가 그대로 배송물이 됩니다)`),
    ...vendored.filter((r) => r.mode !== "120000").map((r) => `${r.path} — node_modules 안의 파일이 추적됩니다`),
];

if (bad.length > 0) {
    console.error(`❌ 추적 목록 검사 — ${bad.length}건:`);
    for (const line of bad) console.error(`   · ${line}`);
    console.error("   → `git rm --cached <경로>` 로 빼고, `.gitignore` 는 **슬래시 없이** 적으십시오.");
    console.error("     (`node_modules/` 는 디렉터리만 매칭해 심링크가 빠져나갑니다.)");
    process.exit(1);
}

console.log(`✅ 추적 목록 검사 — 통과 (추적 ${rows.length}개 · 심링크 0 · vendored 0)`);
