#!/usr/bin/env node
/**
 * **명령 팔레트에 뜨는 글자가 실제로 어떻게 보이는가.**
 *
 * ■ 왜 있나
 *   VS Code 는 팔레트 항목을 `${category}: ${title}` 로 그린다. 그래서 `category: "잘커라"` 와
 *   `title: "잘커라: 로그인"` 을 **둘 다** 두면 **「잘커라: 잘커라: 로그인」**이 뜬다.
 *   실측으로 17종 중 15종이 그랬고, 나머지 2종만 `category` 없이 접두를 title 에 넣어 —
 *   즉 한 매니페스트가 두 관례를 섞어 쓰고 있었다.
 *
 *   이것은 **매니페스트라 새 릴리스 없이는 못 고친다.** 확장은 고객 기계에 깔리고 강제 업데이트가
 *   안 되므로, 잘못 나간 라벨은 그 고객이 스스로 갱신할 때까지 남는다.
 *
 * ■ 무엇을 요구하나
 *   ⑴ 모든 명령이 `category` 를 갖는다 — 하나만 빠져도 팔레트에서 그 줄만 다르게 보인다.
 *   ⑵ `title` 이 `category` 로 시작하지 않는다 — 그것이 중복의 형상이다.
 *
 * ■ 걸리면
 *   `title` 에서 접두를 떼라. 접두는 `category` 가 붙인다.
 *
 *   재현: `node -e 'for(const c of require("./packages/vscode/package.json").contributes.commands)
 *          console.log(c.category ? c.category+": "+c.title : c.title)'`
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "packages/vscode/package.json");

let commands;
try {
    commands = JSON.parse(readFileSync(manifestPath, "utf8"))?.contributes?.commands;
} catch (err) {
    console.error(`❌ 명령 라벨 검사 — 매니페스트를 읽지 못했습니다(통과가 아닙니다): ${err.message}`);
    process.exit(2);
}
if (!Array.isArray(commands) || commands.length === 0) {
    console.error("❌ 명령 라벨 검사 — 명령이 0개입니다(통과가 아닙니다). 경로·형식을 확인하십시오.");
    process.exit(2);
}

const bad = [];
for (const c of commands) {
    const title = typeof c?.title === "string" ? c.title : "";
    const category = typeof c?.category === "string" ? c.category : "";
    if (category === "") {
        bad.push(`${c?.command ?? "(이름 없음)"} — \`category\` 가 없습니다(그 줄만 접두 없이 뜹니다)`);
        continue;
    }
    if (title.startsWith(`${category}:`)) {
        bad.push(`${c.command} — 팔레트에 「${category}: ${title}」로 뜹니다(접두 중복)`);
    }
}

if (bad.length > 0) {
    console.error(`❌ 명령 라벨 검사 — ${bad.length}건:`);
    for (const line of bad) console.error(`   · ${line}`);
    console.error("   → `title` 에서 접두를 떼십시오. 접두는 `category` 가 붙입니다.");
    process.exit(1);
}

console.log(`✅ 명령 라벨 검사 — 통과 (명령 ${commands.length}종 · 접두 중복 0 · category 누락 0)`);

// ── 마켓 개요 탭의 명령 표가 팔레트와 같은 것을 말하는가 ─────────────────────
//
// ⚠ **README 는 고객이 «가장 먼저» 읽는 자리**다(마켓플레이스 개요 탭). 명령을 새로 내면
//    팔레트에는 나오지만 그 표는 손으로 적는 것이라 **조용히 뒤처진다** — 실측으로 23종 중
//    6종이 표에 없었다(zip 4종·작업 폴더 변경·이 폴더의 사이트로 돌아가기).
//
// ⚠ **부분일치로 대조하지 않는다.** 「중지」가 「미리보기 중지」에 들어 있다는 이유로 통과시키면
//    표가 무엇을 적든 지나간다. 칸은 `/` 로 나눈 **각 조각이 팔레트 제목과 글자 그대로 같아야**
//    한다 — 줄여 적고 싶으면 표가 아니라 설명 칸에 적는다.
const README = "packages/vscode/README.md";
let readme;
try {
    readme = readFileSync(join(root, README), "utf8");
} catch (err) {
    console.error(`❌ 명령 표 검사 — ${README} 를 읽지 못했습니다(통과가 아닙니다): ${err.message}`);
    process.exit(2);
}
const listed = new Set();
for (const m of readme.matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|/gm)) {
    // 한 칸이 `**로그인** / **로그아웃**` 처럼 조각마다 굵게 적혀 오므로 별표를 걷어 낸다.
    for (const part of m[1].split("/")) listed.add(part.replaceAll("*", "").trim());
}
const titles = new Set(commands.map((c) => c.title));
const missing = [...titles].filter((t) => !listed.has(t));
const ghost = [...listed].filter((r) => !titles.has(r));
if (missing.length > 0 || ghost.length > 0) {
    for (const t of missing) console.error(`❌ 명령 표에 없다: ${t} — ${README} 「명령 한눈에」에 줄을 더하라`);
    for (const r of ghost) console.error(`❌ 표에만 있는 이름: ${r} — 팔레트에 없는 명령을 광고하고 있다`);
    console.error("");
    console.error("  칸은 `/` 로 나눈 조각이 팔레트 제목과 글자 그대로 같아야 합니다.");
    process.exit(1);
}
console.log(`✅ 명령 표 검사 — 통과 (팔레트 ${titles.size}종이 개요 탭 표에 그대로 있다)`);
