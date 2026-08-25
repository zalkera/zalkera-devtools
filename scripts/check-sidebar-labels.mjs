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
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "packages/vscode/package.json"), "utf8"));
// ⚠ **정규식이 아니라 `sidebarPlan()` 을 불러 결과를 훑는다.** 소스를 문자열로 훑으면 항목을
//    객체 리터럴로 쓰는 순간 눈이 먼다 — 실측으로, 없는 명령을 리터럴로 넣어도 전 게이트가
//    초록이었다. 판정을 부르면 표기 방식과 무관하게 다 걸린다.
// ⚠ **산출물이 낡으면 이 검사기는 옛 코드를 검사하고 초록을 낸다.** 소스를 고치고 안 구운 채
//    단독으로 돌리면 무력화가 안 잡힌다 — 정규식으로 소스를 읽던 종전 판에는 없던 사각이다.
//    `verify` 는 앞서 typecheck 가 굽지만, 검사기는 단독으로도 정직해야 한다.
const DIST = join(root, "packages/core/dist/sidebarPlan.js");
const SRC = join(root, "packages/core/src/sidebarPlan.ts");
if (!existsSync(DIST)) {
    console.error("✗ core 산출물이 없습니다 — `npm run build -w @zalkera/devtools-core` 를 먼저 돌리십시오.");
    process.exit(1);
}
if (statSync(SRC).mtimeMs > statSync(DIST).mtimeMs) {
    console.error("✗ core 산출물이 소스보다 낡았습니다 — 이 검사기는 낡은 것을 검사하게 됩니다.");
    console.error("  `npm run build -w @zalkera/devtools-core` 를 먼저 돌리십시오.");
    process.exit(1);
}
const { sidebarPlan } = await import(DIST);

const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c.title.replace(/^잘커라:\s*/, "")]));
const problems = [];
let checked = 0;

/** 상태마다 보이는 것이 다르다 — 한 상태만 보면 나머지 분기의 라벨이 무검사로 남는다. */
const STATES = [
    { signedIn: false, tenant: "", site: null, previewUrl: null, keyExpiresAt: null, folderTenant: null, folderPath: null },
    { signedIn: true, tenant: "t", site: null, previewUrl: null, keyExpiresAt: null, folderTenant: null, folderPath: null },
    { signedIn: true, tenant: "t", site: "/x", previewUrl: null, keyExpiresAt: null, folderTenant: "t", folderPath: "/x" },
    // ⚠ **소속 모르는 소스 폴더**(예고형 한 줄이 서는 칸). 이 칸이 빠져 있으면 그 분기의 라벨이
    //    검사 밖에 남는다 — 상태 목록의 존재 이유가 그것이다.
    { signedIn: true, tenant: "t", site: "/x", previewUrl: null, keyExpiresAt: null, folderTenant: null, folderPath: "/x" },
    { signedIn: true, tenant: "t", site: "/x", previewUrl: "http://localhost:3000", keyExpiresAt: "2026-01-01", folderTenant: "t", folderPath: "/x" },
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
// **도움말이 묶음을 가리키는 자리를 본다.**
//
// 두 형태만 본다 — `「X」 →`(길안내)와 `「X」 묶음`. 도움말은 오류 문장도 「」 로 인용하므로
// 모든 인용을 어휘와 대조하면 오탐투성이가 된다(실측: 정당한 인용 여럿이 걸렸다).
// **이 검사가 잡는 것은 그 두 형태뿐이다** — 평문으로 묶음 이름을 언급하는 자리는 못 본다.
const HELP = readFileSync(join(root, "packages/vscode/media/help.md"), "utf8");
const LABELS = new Set();
for (const state of STATES) for (const g of sidebarPlan(state)) if (g.label !== "") LABELS.add(g.label);
for (const [, quoted] of HELP.matchAll(/「([^」]{2,12})」\s*(?:→|묶음)/g)) {
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
