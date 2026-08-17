#!/usr/bin/env node
/**
 * **업데이트 안내가 억제를 거치는가** — 배선을 **구문으로** 본다.
 *
 * ■ 왜 있나
 *   억제 판정([shouldShowUpgradeNotice])은 코어에 있고 전수로 시험한다. 그런데 **그 판정을 안 부르고
 *   그냥 띄우는 것**은 시험이 못 잡는다 — 코어 시험은 배선을 안 본다. 그 실수는 조용하지 않다:
 *   `ensureHandshake` 는 명령마다 불리므로 창을 열 때마다 같은 알림이 뜬다.
 *
 * ■ 왜 문면이 아니라 구문인가
 *   종전 판은 `indexOf` 와 중괄호 세기로 블록을 잘랐다. 셋 다 실측으로 깨졌다 —
 *   주석 속 짝 없는 `}` 로 **오검**, 주석 속 인용문이 앵커를 훔쳐 **오검**, 그리고 진짜 위반은
 *   문자 거리(200자)만 벌리면 **통과**. `if (true || shouldShow…)` 도 통과했다.
 *   파서는 주석·문자열을 애초에 구별하고, «어느 블록에 속하는가»를 거리로 재지 않는다.
 *
 * ■ 걸리면
 *   `UPGRADE_RECOMMENDED` 처리를 억제 안쪽으로 되돌리고, 띄운 사실을 남긴다.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, ts, walk } from "./lib/ast.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "packages/vscode/src/extension.ts");
const source = parse(file);
const problems = [];
const text = (node) => (node ? node.getText(source) : "");

/** `handshake.verdict === "X"` 를 조건에 담은 `if` 를 찾는다. */
function findVerdictBlock(verdict) {
    let found = null;
    walk(source, (node) => {
        if (found || !ts.isIfStatement(node)) return;
        if (!text(node.expression).includes(`"${verdict}"`)) return;
        found = node;
    });
    return found;
}

function callsInside(node, predicate) {
    let hit = false;
    walk(node, (child) => {
        if (!hit && ts.isCallExpression(child) && predicate(child)) hit = true;
    });
    return hit;
}

const recommended = findVerdictBlock("UPGRADE_RECOMMENDED");
if (!recommended) {
    problems.push("extension.ts 에 `UPGRADE_RECOMMENDED` 처리가 없다 — 권고를 아무도 안 전한다");
} else {
    // ⚠ 알림은 **억제 판정 그 자체**를 조건으로 하는 `if` 안에 있어야 한다.
    //   `if (true || shouldShowUpgradeNotice(...))` 는 판정을 부르지만 안 듣는다(실측: 종전 판이 통과).
    // ⚠ **`&&` 는 받고 `||` 는 막는다.** `&&` 는 조건을 좁히기만 하므로 억제가 그대로 산다.
    //   `||` 는 넓힌다 — `if (true || shouldShow…)` 는 판정을 «부르지만 안 듣는» 형태다.
    //   조건을 «호출 하나»로만 못 박으면 `if (config.enabled && shouldShow…)` 같은 정당한 편집이
    //   반려된다. 검사기가 오검을 내면 다음 판에 붙는 것은 수정이 아니라 **면제**다.
    const listensTo = (node) => {
        if (ts.isParenthesizedExpression(node)) return listensTo(node.expression);
        if (ts.isCallExpression(node)) return text(node.expression) === "shouldShowUpgradeNotice";
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            return listensTo(node.left) || listensTo(node.right);
        }
        return false;
    };
    let guarded = null;
    walk(recommended, (node) => {
        if (guarded || !ts.isIfStatement(node)) return;
        if (listensTo(node.expression)) guarded = node;
    });
    if (!guarded) {
        problems.push("권고 알림이 억제를 안 거친다(또는 조건이 판정 하나가 아니다) — 명령마다 같은 알림이 뜬다");
    } else {
        if (!callsInside(guarded, (c) => text(c.expression).endsWith(".update"))) {
            problems.push("띄운 사실을 남기지 않는다 — 억제가 늘 «처음»이라 매번 뜬다");
        }
        if (!callsInside(guarded, (c) => text(c.expression).endsWith("executeCommand") &&
                text(c.arguments[0]) === '"workbench.extensions.search"')) {
            problems.push("「업데이트」가 확장 뷰로 데려가지 않는다 — 안내만 하고 갈 곳을 안 준다");
        }
        if (!callsInside(guarded, (c) => text(c.expression).endsWith("showInformationMessage"))) {
            problems.push("억제 안에서 알림을 안 띄운다 — 판정만 하고 아무 말도 안 한다");
        }
    }
    // 서버 문장을 알림 본문으로 쓰지 않는다 — 그 자리는 링크를 렌더하고 링크는 명령을 실행한다.
    walk(source, (node) => {
        if (!ts.isCallExpression(node)) return;
        const callee = text(node.expression);
        if (!/show(Information|Warning|Error)Message$/.test(callee)) return;
        if (/handshake\.message|config\.message/.test(text(node.arguments[0]))) {
            const {line} = source.getLineAndCharacterOfPosition(node.getStart(source));
            problems.push(`extension.ts:${line + 1}: 서버가 준 문장을 알림 본문으로 쓴다 — 문장은 확장이 소유하라`);
        }
    });
}

// `UPGRADE_REQUIRED` 는 코어가 던져서 막는다. 확장이 그것을 알림으로 «내려» 놓으면 막지 못한다.
const required = findVerdictBlock("UPGRADE_REQUIRED");
if (required && callsInside(required, (c) => /show(Information|Warning|Error)Message$/.test(text(c.expression)))) {
    problems.push("`UPGRADE_REQUIRED` 를 알림으로 처리한다 — 그것은 막아야 하는 판정이다");
}

if (problems.length) {
    console.error("❌ 업데이트 안내 배선 — 갈렸습니다:");
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
}
console.log("✅ 업데이트 안내 배선 — 통과 (억제·기록·이동·문장 소유 4축)");
