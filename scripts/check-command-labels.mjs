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
