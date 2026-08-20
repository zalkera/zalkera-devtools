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
// ⚠ **정규식이 아니라 `sidebarPlan()` 을 불러 결과를 훑는다.** 소스를 문자열로 훑으면 항목을
//    객체 리터럴로 쓰는 순간 눈이 먼다 — 실측으로, 없는 명령을 리터럴로 넣어도 전 게이트가
//    초록이었다. 판정을 부르면 표기 방식과 무관하게 다 걸린다.
const { sidebarPlan } = await import(join(root, "packages/core/dist/sidebarPlan.js"));

const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c.title.replace(/^잘커라:\s*/, "")]));
const problems = [];
let checked = 0;

/** 상태마다 보이는 것이 다르다 — 한 상태만 보면 나머지 분기의 라벨이 무검사로 남는다. */
const STATES = [
    { signedIn: false, tenant: "", site: null, previewUrl: null, keyExpiresAt: null },
    { signedIn: true, tenant: "t", site: null, previewUrl: null, keyExpiresAt: null },
    { signedIn: true, tenant: "t", site: "/x", previewUrl: null, keyExpiresAt: null },
    { signedIn: true, tenant: "t", site: "/x", previewUrl: "http://localhost:3000", keyExpiresAt: "2026-01-01" },
];
/** 라벨이 상태를 담아도 되는 명령. 사이트 이름과 미리보기 주소 둘뿐이다. */
const DYNAMIC_ALLOWED = new Set(["zalkera.site.choose", "zalkera.preview.start"]);
const groupIds = new Set();
for (const state of STATES) {
    for (const group of sidebarPlan(state)) {
        if (group.label !== "") groupIds.add(group.id);
        for (const item of group.items) {
            if (item.kind !== "action") continue;
            checked += 1;
            if (!titles.has(item.command)) {
                problems.push(`팔레트에 없는 명령: ${item.command} — package.json contributes.commands 에 추가하라`);
                continue;
            }
            // 상태를 담는 **동적 라벨**은 명령 존재만 본다 — 판정이 스스로 그렇게 표시한다.
            //
            // ⚠ **면제는 구멍이다.** 아무 항목에나 `dynamic` 을 붙이면 라벨 검사를 통째로 비킬 수
            //   있으므로, 그 표시를 쓸 수 있는 명령을 **닫힌 목록**으로 둔다. 늘려야 하면 여기도
            //   같이 고쳐야 한다 — 그 마찰이 이 면제를 값싸게 쓰지 못하게 한다.
            if (item.dynamic) {
                if (!DYNAMIC_ALLOWED.has(item.command)) {
                    problems.push(
                        `동적 라벨 표시를 함부로 붙였다: ${item.command} — 허용 목록은 ${[...DYNAMIC_ALLOWED].join("·")}`,
                    );
                }
                continue;
            }
            if (item.label !== titles.get(item.command)) {
                problems.push(
                    `라벨이 갈렸다: 사이드바 "${item.label}" ↔ 팔레트 "${titles.get(item.command)}" (${item.command})`,
                );
            }
        }
    }
}
// **묶음 라벨도 본다.** 지금까지 어느 검사도 안 봤고, 그 구멍으로 낡은 이름이 배송 문서에 남았다.
const HELP = readFileSync(join(root, "packages/vscode/media/help.md"), "utf8");
const LABELS = new Set();
for (const state of STATES) for (const g of sidebarPlan(state)) if (g.label !== "") LABELS.add(g.label);
for (const [, quoted] of HELP.matchAll(/「([^」]{2,12})」\s*→/g)) {
    if (!LABELS.has(quoted)) {
        problems.push(`도움말이 없는 묶음을 가리킨다: 「${quoted}」 — 지금 묶음은 ${[...LABELS].join("·")}`);
    }
}

if (checked === 0) {
    console.error("✗ sidebarPlan 에서 실행 항목을 하나도 찾지 못했다 — 검사기가 눈이 먼 것이다.");
    process.exit(1);
}
if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
}
console.log(`✓ 사이드바 라벨 ${checked}개가 팔레트 제목과 일치한다`);
