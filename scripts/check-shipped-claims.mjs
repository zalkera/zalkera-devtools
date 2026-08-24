#!/usr/bin/env node
/**
 * **배송 문서가 폐기된 주장을 다시 싣지 않는가.**
 *
 * ■ 왜 있나
 *   「새 버전 배포」가 배포가 아니라고 가르치던 문면을 걷어낸 판에서, 확장 안의 문구만 고치고
 *   **사람이 먼저·더 많이 읽는 자리**를 놓쳤다. 마켓플레이스 개요 탭(`README.md`)과 고객에게
 *   굽는 PDF 원본(`doc/MANUAL.md`)이 종전 모델을 그대로 가르치고 있었고, `media/help.md` 는
 *   한 절만 고쳐 같은 파일 안에서 앞뒤가 어긋났다. 세 문서를 보는 검사기가 하나도 없었다.
 *
 * ■ 무엇을 보장하나 — **그리고 무엇은 못 하나**
 *   여기 적힌 **그 문장들이 돌아오는 것**만 막는다. 회귀 래칫이지 일반 보장이 아니다.
 *   같은 뜻을 다르게 쓰면 못 잡는다 — 이 검사는 사람이 문서를 읽는 일을 대신하지 않는다.
 *   그 한계를 알고도 두는 이유는, 이 축이 **두 판 연속으로 같은 자리에서 어긋났기** 때문이다.
 *
 *   변경 기록(`CHANGELOG.md`)은 대상이 아니다 — 거기서는 폐기된 문장을 **인용하는 것이 옳다**.
 *
 * ■ 걸리면
 *   그 문장을 지운다. 되살릴 이유가 생겼다면 백엔드가 정말 바뀐 것이므로, 이 목록이 아니라
 *   `SiteOnboardingPipeline` 의 활성 전환부터 확인한다.
 *
 *   재현: `node scripts/check-shipped-claims.mjs`
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 사람이 확장 밖에서 읽는 문서. 마켓 개요·고객 PDF·동봉 매뉴얼. */
const SHIPPED = ["packages/vscode/README.md", "doc/MANUAL.md", "packages/vscode/media/help.md"];

/** 폐기된 주장. 전부 「올리기 ≠ 배포」를 가르치던 문장이다. */
const RETIRED = [
    "사이트는 아직 안 바뀝니다",
    "올린다고 바로 공개되지 않습니다",
    "올리기와 켜기는",
    "판만 만듭니다",
    "방문자가 보는 사이트는 그대로",
    "올리기만 합니다",
    "두 단계로 나눈 이유",
    "지금 전환",
    "아직 바뀌지 않았습니다",
    // ⚠ 받기가 **열어 둔 빈 폴더**로 갈 수 있게 된 뒤로 거짓이 된 약속들. 「지금 폴더」가 아니라
    //    「소스가 들어 있는 폴더」가 안 바뀌는 것이다.
    "지금 폴더를 안 건드립니다",
    "지금 폴더는 바뀌지 않습니다",
    "빈 새 폴더로만",
];

const problems = [];
for (const rel of SHIPPED) {
    const path = join(root, rel);
    // **없으면 통과가 아니다.** 파일을 옮기고 목록을 안 고치면 검사가 조용히 눈을 감는다.
    if (!existsSync(path)) {
        console.error(`❌ 배송 문면 검사 — ${rel} 이 없습니다(통과가 아닙니다). 목록을 고치십시오.`);
        process.exit(2);
    }
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
        for (const phrase of RETIRED) {
            if (line.includes(phrase)) problems.push(`${rel}:${index + 1} — 「${phrase}」`);
        }
    }
}

if (problems.length > 0) {
    console.error(`❌ 배송 문면 검사 — 폐기된 주장 ${problems.length}건:`);
    for (const p of problems) console.error(`   · ${p}`);
    console.error("   → 「새 버전 배포」는 배포입니다. 그 문장을 지우십시오.");
    process.exit(1);
}
console.log(`✅ 배송 문면 검사 — 통과 (문서 ${SHIPPED.length}개 · 폐기 주장 ${RETIRED.length}종 없음)`);
