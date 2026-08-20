#!/usr/bin/env node
/**
 * 사이드바 라벨 ↔ 명령 팔레트 제목 **일치 검사**.
 *
 * ■ 왜 있나
 *   같은 명령이 두 곳에 이름을 갖는다 — 사이드바 줄과 팔레트 항목. 이름이 갈리면 사용자는 **다른 기능인
 *   줄 안다.** 0.1.6 에서 실제로 갈렸고 0.1.8 에서 되돌렸다. 손으로 지키던 규율이라 또 갈릴 수 있어
 *   여기서 기계가 지킨다.
 *
 * ■ 무엇을 통과시키나
 *   - 정확히 같은 문자열(팔레트의 `잘커라: ` 접두는 뗀다 — 사이드바에는 이미 문맥이 있다)
 *   - 상태를 담는 **동적 라벨**(백틱 템플릿). `미리보기 열기 — http://…` 처럼 지금 상태를 보이는 줄은
 *     팔레트 제목과 같을 수 없다. 다만 그 명령이 팔레트에 **있기는 한지**는 확인한다.
 *
 * ■ 걸리면
 *   둘 중 하나를 고쳐 맞춘다. 사이드바 쪽을 바꾸는 편이 대개 맞다 — 팔레트 제목은 사용자의 검색어다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "packages/vscode/package.json"), "utf8"));
// ⚠ **라벨은 `sidebarPlan.ts`(core)에 있다.** 그리기는 `vscode/sidebar.ts` 가 하지만 무엇이
//    보일지는 core 가 정한다 — 확장 안 판정은 시험도 검사기도 못 닿아서 내렸다. 검사기도 따라간다.
const source = readFileSync(join(root, "packages/core/src/sidebarPlan.ts"), "utf8");

const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c.title.replace(/^잘커라:\s*/, "")]));
const problems = [];
let checked = 0;

// action("라벨", "명령", …) 또는 action(`동적 ${라벨}`, "명령", …)
for (const [, raw, command] of source.matchAll(/\bact\(\s*(`[^`]*`|"[^"]*"|[A-Za-z][A-Za-z0-9_]*)\s*,\s*"([^"]+)"/g)) {
    checked += 1;
    if (!titles.has(command)) {
        problems.push(`팔레트에 없는 명령: ${command} — package.json contributes.commands 에 추가하라`);
        continue;
    }
    if (!raw.startsWith('"')) continue; // 동적 라벨·변수 — 명령 존재만 본다
    const label = raw.slice(1, -1);
    if (label !== titles.get(command)) {
        problems.push(`라벨이 갈렸다: 사이드바 "${label}" ↔ 팔레트 "${titles.get(command)}" (${command})`);
    }
}

if (checked === 0) {
    // 정규식이 소스 형태 변화로 아무것도 못 잡으면 **조용히 통과**한다 — 그게 제일 나쁘다.
    console.error("✗ sidebarPlan 에서 act() 호출을 하나도 찾지 못했다 — 검사기가 눈이 먼 것이다.");
    process.exit(1);
}
if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
}
console.log(`✓ 사이드바 라벨 ${checked}개가 팔레트 제목과 일치한다`);
