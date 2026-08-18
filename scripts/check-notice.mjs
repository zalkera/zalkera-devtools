#!/usr/bin/env node
/**
 * **알림에 닿는 모든 보간이 소독을 거쳤거나, 거치지 않기로 명시됐는가.**
 *
 * ■ 왜 있나
 *   VS Code 의 **비-모달** 알림은 `[글](command:…)`·`[글](file:…)` 를 클릭 가능한 링크로 렌더하고,
 *   그 링크를 `allowCommands: true` 로 연다. 알림 문자열 중 **서버가 정한 부분**은 곧 임의 VS Code
 *   명령의 실행 단추가 될 수 있다.
 *
 * ■ 첫 판이 왜 틀렸나 — 이 파일의 존재 이유
 *   첫 판은 **위험한 이름을 열거**했다(`SERVER_DERIVED = {tenant, presetName}`). 그러면 같은 서버값이
 *   **다른 이름**에 담기는 순간 소독도 검사도 안 된다. 재심의가 다섯 자리를 실증했다 —
 *   `code`·`current`·`expected`·`uploaded`·`errorCode`. 전부 `/api/me`·API 오류의 서버값인데
 *   검사기는 초록이었다.
 *
 *   `notice.ts` 가 배격한 *"막을 자리를 손으로 열거한다"* 를 **식별자 층위에서 되풀이한 것**이다.
 *   래퍼 한 겹(`${String(t)}`·`${t + ""}`·`${idy(t)}`)·간접 호출·변수 경유로도 전부 새어,
 *   실제로 잡는 것은 「그 두 이름의 맨 보간」뿐이었다.
 *
 *   **그래서 목록을 뒤집는다 — 허용을 열거하고 나머지를 전부 거부한다.**
 *
 * ■ 무엇을 허용하는가 (이 셋뿐)
 *   ⑴ 리터럴(숫자·문자열) — 서버가 정할 수 없다.
 *   ⑵ 소독기 호출 `plainNotice(...)` · `shown(...)` — 별칭은 **정의까지** 확인한다.
 *   ⑶ 표기 `ours(...)` — "서버가 정하지 않은 값"이라고 사람이 한 번 판단했다는 기록.
 *
 *   그 밖의 모든 표현식(맨 식별자·속성 접근·연산·임의 함수 호출)은 **반려**다. 값이 안전해도
 *   반려한다 — 안전하다면 `ours(...)` 를 붙여 그 판단을 코드에 남기면 된다.
 *
 * ■ 어디를 보는가
 *   · `packages/core/src/tenantScope.ts` — 사용자 문구 **정본**. 템플릿 전부.
 *   · `packages/vscode/src/extension.ts` — 알림 호출의 인자와 진행 알림 `title`.
 *     (`log()`(출력 채널)는 링크를 렌더하지 않으므로 관할 밖이다 — 거기까지 잡으면 오검이다.)
 *
 *   **문면이 아니라 구문으로 본다** — 정규식 주석 제거는 이 레포에서 양방향으로 뚫렸다(`ast.mjs`).
 *
 * ■ 걸리면
 *   서버에서 온 값이면 `plainNotice(...)`. 아니면 `ours(...)` 를 붙인다. 소독은 **표시 자리에서만**
 *   한다 — `x-tenant` 헤더로 가는 값(`api.ts` 의 `tenantCode()`)은 원문이어야 한다.
 */
import ts from "typescript";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, walk } from "./lib/ast.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 소독을 거쳤다고 인정하는 호출. 별칭은 아래 [assertDefinitionsAreReal] 이 정의까지 확인한다. */
const SANITIZERS = new Set(["plainNotice", "shown"]);
/** "서버가 정하지 않았다"는 사람의 판단 표기. 값을 바꾸지 않으므로 정의도 확인한다. */
const MARKER = "ours";
/** 별칭 → 그 정의가 반드시 불러야 하는 진짜 소독기. */
const ALIAS_MUST_CALL = new Map([["shown", "plainNotice"]]);

const NOTIFY = new Set(["showInformationMessage", "showWarningMessage", "showErrorMessage"]);

const findings = [];
let scanned = 0;
let spansSeen = 0;

/**
 * 문구 **정본** — 이 객체의 메서드가 만든 문장은 [scan] 이 `tenantScope.ts` 를 템플릿 단위로 이미
 * 전수 검사한다. 여기서 다시 파고들 필요가 없고, 파고들면 같은 값을 두 번 요구하는 오검이 된다.
 */
const CANON_FACTORY = "say";
/**
 * 정본이 돌려주는 문장 조각. `decide*`·`say.*` 의 반환 모양이고, 그 내용물은 위와 같은 이유로
 * 이미 검사됐다. **이름이 아니라 «정본이 만든 것」이라는 사실**로 허용한다.
 */
const CANON_FIELDS = new Set(["message", "detail", "action"]);

/** 이 표현식이 허용 목록에 드는가. **드는 것만 참** — 나머지는 전부 거부다. */
function isAllowed(e) {
    if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    // 정본이 만든 문장 — `tenantScope.ts` 전수 검사가 덮는다.
    if (ts.isPropertyAccessExpression(e) && CANON_FIELDS.has(e.name.getText())) return true;
    if (!ts.isCallExpression(e)) return false;
    if (
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.expression.getText() === CANON_FACTORY
    ) {
        return true; // `say.*(...)`
    }
    const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name.getText() : e.expression.getText();
    return SANITIZERS.has(callee) || callee === MARKER;
}

function describe(e) {
    const t = e.getText().replace(/\s+/g, " ");
    return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/**
 * 템플릿의 모든 `${…}` 를 본다. 인자가 템플릿이 아니면 그 표현식 자체를 본다.
 *
 * ⚠ **삼항·논리 갈래는 갈래마다 본다.** 한 덩어리로 보면 `조건 ? 안전한것 : 위험한것` 이 통째로
 *   반려돼, 고치는 사람이 **코드를 검사기에 맞추게** 된다 — 그것이 곧 다음 판의 면제다.
 *   괄호도 벗긴다(`(x)` 를 못 알아보면 같은 일이 생긴다).
 */
function inspect(node, rel, label) {
    const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    if (ts.isParenthesizedExpression(node)) return inspect(node.expression, rel, label);
    if (ts.isConditionalExpression(node)) {
        inspect(node.whenTrue, rel, label);
        inspect(node.whenFalse, rel, label);
        return;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
        inspect(node.left, rel, label);
        inspect(node.right, rel, label);
        return;
    }
    if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
            spansSeen += 1;
            if (isAllowed(span.expression)) continue;
            findings.push(`${rel}:${line + 1} — ${label} 의 \`${describe(span.expression)}\` 가 허용 목록 밖입니다`);
        }
        return;
    }
    spansSeen += 1;
    if (isAllowed(node)) return;
    findings.push(`${rel}:${line + 1} — ${label} 의 \`${describe(node)}\` 가 허용 목록 밖입니다`);
}

function scan(rel, { allTemplates }) {
    const path = join(root, rel);
    if (!existsSync(path)) {
        console.error(`❌ 알림 소독 검사 — ${rel} 이 없습니다(통과가 아닙니다).`);
        process.exit(2);
    }
    scanned += 1;
    const source = parse(path);

    walk(source, (node) => {
        // ⑴ 사용자 문구 정본: 템플릿 전부
        if (allTemplates && ts.isTemplateExpression(node)) inspect(node, rel, "템플릿");

        // ⑵ 진행 알림(`withProgress`)의 `title` — 알림 본문 자리에 그려진다.
        if (ts.isObjectLiteralExpression(node)) {
            const notify = node.properties.some(
                (pr) =>
                    ts.isPropertyAssignment(pr) &&
                    pr.name.getText() === "location" &&
                    /ProgressLocation\.Notification/.test(pr.initializer.getText()),
            );
            if (notify) {
                for (const pr of node.properties) {
                    if (ts.isPropertyAssignment(pr) && pr.name.getText() === "title") {
                        inspect(pr.initializer, rel, "진행 알림 title");
                    }
                }
            }
        }

        // ⑶ 알림 호출의 **첫 인자**(= 본문). 뒤 인자는 옵션 객체와 단추 라벨이라 본문이 아니다 —
        //    거기까지 잡으면 `{modal: true, detail: …}` 같은 정상 코드가 빨개진다(첫 판이 그랬다).
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            if (!NOTIFY.has(node.expression.name.getText())) return;
            const body = node.arguments[0];
            if (body) inspect(body, rel, "알림 본문");
        }
    });
}

/**
 * 소독기 별칭이 **정말 그 일을 하는지** 확인한다. 이름만 보고 통과시키면 정의 한 줄로 전부
 * 뚫린다(변이로 실측해 뚫었다). 파일에 그 이름이 없으면 확인을 건너뛴다 — 다른 파일이 쓸 수 있다.
 */
function assertDefinitionsAreReal(rel) {
    const source = parse(join(root, rel));
    for (const [alias, must] of ALIAS_MUST_CALL) {
        let ok = null;
        walk(source, (node) => {
            if (!ts.isVariableDeclaration(node) || node.name.getText() !== alias) return;
            ok = new RegExp(`\\b${must}\\s*\\(`).test(node.getText());
        });
        if (ok === false) {
            console.error(`❌ 알림 소독 검사 — ${rel} 의 \`${alias}\` 정의가 \`${must}\` 를 부르지 않습니다.`);
            console.error("   → 이름만 소독기인 별칭은 검사기를 통째로 무력화합니다.");
            process.exit(1);
        }
    }
}

/** 표기 `ours` 가 **값을 바꾸지 않는** 항등이어야 한다 — 소독기 흉내를 내면 안 된다. */
function assertMarkerIsIdentity() {
    const rel = "packages/core/src/notice.ts";
    const source = parse(join(root, rel));
    let found = false;
    walk(source, (node) => {
        if (!ts.isVariableDeclaration(node) || node.name.getText() !== MARKER) return;
        found = true;
        const body = node.getText().replace(/\s+/g, " ");
        // `<T>(value: T): T => value` 형태만 인정한다.
        if (!/=>\s*\w+\s*;?\s*$/.test(body)) {
            console.error(`❌ 알림 소독 검사 — ${rel} 의 \`${MARKER}\` 가 항등이 아닙니다: ${body}`);
            console.error("   → 이 표기는 값을 바꾸지 않고 **판단만** 기록해야 합니다.");
            process.exit(1);
        }
    });
    if (!found) {
        console.error(`❌ 알림 소독 검사 — ${rel} 에 \`${MARKER}\` 표기가 없습니다(통과가 아닙니다).`);
        process.exit(2);
    }
}

/**
 * 알림 API 를 **변수에 담아 부르는 것**을 금지한다. `const shw = vscode.window.showWarningMessage`
 * 처럼 한 겹만 두면 위 ⑶ 의 호출 인식(`vscode.window.show*`)이 통째로 빗나간다(변이로 실측해 뚫었다).
 *
 * 현재 코드에 그런 자리는 0건이다 — **지금 닫아 두는 것**이지 오늘의 결함이 아니다. 알림은 항상
 * `vscode.window.show*(...)` 로 직접 부른다.
 */
function assertNoIndirectNotify(rel) {
    const source = parse(join(root, rel));
    walk(source, (node) => {
        if (!ts.isPropertyAccessExpression(node)) return;
        if (!NOTIFY.has(node.name.getText())) return;
        // 호출의 피호출자로 쓰인 것만 정상이다. 그 밖(대입·인자 전달)은 별칭화다.
        const parent = node.parent;
        if (parent && ts.isCallExpression(parent) && parent.expression === node) return;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        findings.push(
            `${rel}:${line + 1} — 알림 API 를 변수로 옮겼습니다(\`${describe(node)}\`) — 검사기가 호출을 못 찾습니다`,
        );
    });
}

scan("packages/core/src/tenantScope.ts", { allTemplates: true });
assertDefinitionsAreReal("packages/core/src/tenantScope.ts");
scan("packages/vscode/src/extension.ts", { allTemplates: false });
assertNoIndirectNotify("packages/vscode/src/extension.ts");
assertMarkerIsIdentity();

// **관할이 비었는데 초록**은 이 레포의 반복 실패 형상이다. 세어서 보인다.
if (spansSeen === 0) {
    console.error("❌ 알림 소독 검사 — 보간을 하나도 못 봤습니다(통과가 아닙니다). 파서·경로를 확인하십시오.");
    process.exit(2);
}

if (findings.length > 0) {
    console.error(`❌ 알림 소독 검사 — ${findings.length}건:`);
    for (const f of findings) console.error(`   · ${f}`);
    console.error("   → 서버에서 온 값이면 `plainNotice(...)`, 아니면 `ours(...)` 를 붙이십시오.");
    console.error("     (헤더로 가는 값은 원문을 유지하십시오 — 소독은 표시 자리에서만 합니다.)");
    process.exit(1);
}
console.log(`✅ 알림 소독 검사 — 통과 (파일 ${scanned}개 · 보간 ${spansSeen}개가 전부 리터럴·소독기·표기)`);
