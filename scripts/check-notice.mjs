#!/usr/bin/env node
/**
 * **알림에 나가는 서버 문자열이 소독을 거치는가.**
 *
 * ■ 왜 있나
 *   VS Code 의 **비-모달** 알림은 `[글](command:…)`·`[글](file:…)`·`[글](https:…)` 를 **클릭 가능한
 *   링크로 렌더**하고, 그 링크를 `allowCommands: true` 로 연다. 즉 알림에 들어가는 문자열 중
 *   **서버가 정한 부분**은 곧 임의 VS Code 명령의 실행 단추가 될 수 있다.
 *
 *   이 레포는 그것을 알고 `notice.ts`(`plainNotice`)를 만들어 `handshake.ts`·`api.ts` 두 경계에서
 *   서버 문장을 막는다. 그런데 **같은 서버가 주는 다른 필드들**(시작 소스 이름·사이트 코드)은
 *   비무장으로 알림에 들어갔다(심의 실증 — 링크 정규식이 실제로 물었다). `notice.ts` 는
 *   "그 밖으로 나가는 길이 없는지 **기계가 지킨다**"고 적었는데, **그 기계가 없었다.**
 *
 *   문면 규율만 두면 다음 필드에서 되풀이된다. 배포·회수가 불가능한 매체라 여기서 잠근다.
 *
 *   재현: `packages/core/src/tenantScope.ts` 의 `shown(tenant)` 를 `tenant` 로 되돌리고
 *        `node scripts/check-notice.mjs`
 *
 * ■ 무엇을 보는가
 *   ⑴ `say.*`(사용자 문구 정본)의 템플릿에 `tenant` 가 **생으로** 박히지 않는가 — 소독기를 거쳐야 한다.
 *   ⑵ 알림 호출(`showInformationMessage`·`showWarningMessage`·`showErrorMessage`)의 첫 인자
 *      템플릿에 **서버 파생 식별자**가 생으로 박히지 않는가.
 *
 *   **문면이 아니라 구문으로 본다** — 정규식 주석 제거는 이 레포에서 양방향으로 뚫렸다(`ast.mjs`).
 *
 * ■ 걸리면
 *   그 값을 `plainNotice(...)` 로 감싼다. 소독은 **표시 자리에서만** 한다 — `x-tenant` 헤더로 가는
 *   값(`api.ts` 의 `tenantCode()`)은 원문이어야 한다.
 */
import ts from "typescript";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { parse, walk } from "./lib/ast.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 서버가 값을 정하는 식별자. 알림에 **생으로** 들어가면 안 된다.
 *
 * ⚠ `message`·`serverMessage` 는 **일부러 뺐다.** 그 둘은 `api.ts:244`·`handshake.ts:135` 가 이미
 *   경계에서 `plainNotice` 를 태운 값이고, 여기서 또 잡으면 **정상 코드에 빨간불**이 된다.
 *   오검이 더 위험하다 — CI 가 무해한 줄에 빨개지면 다음 판에 붙는 것은 수정이 아니라 면제다
 *   (`ast.mjs` 가 이 레포에서 이미 겪은 형상으로 적어 둔 것이다).
 */
const SERVER_DERIVED = new Set(["tenant", "presetName"]);

/**
 * 소독을 거쳤다고 인정하는 호출.
 *
 * ⚠ **이름만 믿지 않는다.** `shown` 은 이 레포가 만든 얇은 별칭이라, 그 정의가 소독을 그만두면
 *   검사기는 **이름만 보고 계속 초록**을 찍는다(변이로 실측해 뚫었다). 그래서 별칭은 아래
 *   `assertAliasIsReal` 이 **정의까지 확인**한다. 확인 못 하면 통과가 아니라 rc=2 다.
 */
const SANITIZERS = new Set(["plainNotice", "shown"]);
/** 별칭 → 그 정의가 반드시 불러야 하는 진짜 소독기. */
const ALIAS_MUST_CALL = new Map([["shown", "plainNotice"]]);

const NOTIFY = new Set(["showInformationMessage", "showWarningMessage", "showErrorMessage"]);

const findings = [];
let scanned = 0;
let templatesSeen = 0;

/**
 * 템플릿 리터럴의 각 `${...}` 가 소독을 거쳤는지. **식별자가 그대로 박힌 것만** 잡는다 —
 * `${shown(tenant)}` 나 `${plainNotice(x)}` 는 통과, `${tenant}` 는 반려.
 * `preset.name` 처럼 속성 접근도 본다.
 */
function unsanitizedSpans(tpl) {
    const bad = [];
    for (const span of tpl.templateSpans ?? []) {
        const e = span.expression;
        if (ts.isCallExpression(e)) {
            const callee = ts.isPropertyAccessExpression(e.expression)
                ? e.expression.name.getText()
                : e.expression.getText();
            if (SANITIZERS.has(callee)) continue; // 소독됨
        }
        if (ts.isIdentifier(e) && SERVER_DERIVED.has(e.getText())) bad.push(e.getText());
        if (ts.isPropertyAccessExpression(e)) {
            const text = e.getText();
            if (/^preset\.name$|\.name$/.test(text) && text.startsWith("preset")) bad.push(text);
        }
    }
    return bad;
}

/**
 * ⚠ **관할을 파일마다 다르게 준다.**
 *   · `tenantScope.ts` 는 사용자 문구 **정본**이라 템플릿 전부를 본다.
 *   · `extension.ts` 는 알림 호출의 인자만 본다 — `log()`(출력 채널)는 링크를 렌더하지 않으므로
 *     거기까지 잡으면 오검이다(첫 판이 실제로 그렇게 물었다).
 */
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
        if (allTemplates && ts.isTemplateExpression(node)) {
            templatesSeen += 1;
            for (const name of unsanitizedSpans(node)) {
                const { line } = source.getLineAndCharacterOfPosition(node.getStart());
                findings.push(`${rel}:${line + 1} — 템플릿에 \`${name}\` 이 소독 없이 들어갑니다`);
            }
        }
        // ⑴-b 진행 알림(`withProgress`)의 `title` 도 알림 본문 자리에 그려진다.
        //     첫 판은 `showXxxMessage` 만 봐서 이 자리를 통째로 놓쳤다(변이로 실측).
        if (ts.isObjectLiteralExpression(node)) {
            const isNotifyProgress = node.properties.some(
                (pr) =>
                    ts.isPropertyAssignment(pr) &&
                    pr.name.getText() === "location" &&
                    /ProgressLocation\.Notification/.test(pr.initializer.getText()),
            );
            if (isNotifyProgress) {
                for (const pr of node.properties) {
                    if (!ts.isPropertyAssignment(pr) || pr.name.getText() !== "title") continue;
                    const { line } = source.getLineAndCharacterOfPosition(pr.getStart());
                    if (ts.isTemplateExpression(pr.initializer)) {
                        templatesSeen += 1;
                        for (const name of unsanitizedSpans(pr.initializer)) {
                            findings.push(`${rel}:${line + 1} — 진행 알림 title 에 \`${name}\` 이 소독 없이 들어갑니다`);
                        }
                    } else if (ts.isIdentifier(pr.initializer) && SERVER_DERIVED.has(pr.initializer.getText())) {
                        findings.push(`${rel}:${line + 1} — 진행 알림 title 에 \`${pr.initializer.getText()}\` 이 소독 없이 들어갑니다`);
                    }
                }
            }
        }
        // ⑵ 알림 호출의 인자 — 템플릿이든 **맨 식별자든** 본다.
        //    첫 판은 템플릿만 봐서 `showErrorMessage(message, …)` 같은 맨 식별자를 통째로 놓쳤다.
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            if (!NOTIFY.has(node.expression.name.getText())) return;
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            for (const arg of node.arguments) {
                if (ts.isTemplateExpression(arg)) {
                    templatesSeen += 1;
                    for (const name of unsanitizedSpans(arg)) {
                        findings.push(`${rel}:${line + 1} — 알림 인자 템플릿에 \`${name}\` 이 소독 없이 들어갑니다`);
                    }
                } else if (ts.isIdentifier(arg) && SERVER_DERIVED.has(arg.getText())) {
                    findings.push(`${rel}:${line + 1} — 알림 인자에 \`${arg.getText()}\` 이 소독 없이 들어갑니다`);
                } else if (ts.isPropertyAccessExpression(arg) && /^preset\.name$/.test(arg.getText())) {
                    findings.push(`${rel}:${line + 1} — 알림 인자에 \`${arg.getText()}\` 이 소독 없이 들어갑니다`);
                }
            }
        }
    });
}

/**
 * 별칭이 **정말 소독기를 부르는지** 확인한다. 이름만 보고 통과시키면 정의 한 줄로 전부 뚫린다.
 * 별칭이 그 파일에 없으면 그것도 통과가 아니다 — 관할이 비었는데 초록인 형상이다.
 */
function assertAliasIsReal(rel) {
    const path = join(root, rel);
    const source = parse(path);
    for (const [alias, must] of ALIAS_MUST_CALL) {
        let ok = null;
        walk(source, (node) => {
            if (!ts.isVariableDeclaration(node) || node.name.getText() !== alias) return;
            ok = new RegExp(`\\b${must}\\s*\\(`).test(node.getText());
        });
        if (ok === null) continue; // 이 파일에 그 별칭이 없다 — 다른 파일이 쓸 수 있다
        if (!ok) {
            console.error(`❌ 알림 소독 검사 — ${rel} 의 \`${alias}\` 정의가 \`${must}\` 를 부르지 않습니다.`);
            console.error("   → 이름만 소독기인 별칭은 검사기를 통째로 무력화합니다.");
            process.exit(1);
        }
    }
}

scan("packages/core/src/tenantScope.ts", { allTemplates: true });
assertAliasIsReal("packages/core/src/tenantScope.ts");
scan("packages/vscode/src/extension.ts", { allTemplates: false });

// **관할이 비었는데 초록**은 이 레포의 반복 실패 형상이다. 세어서 보인다.
if (templatesSeen === 0) {
    console.error("❌ 알림 소독 검사 — 템플릿을 하나도 못 봤습니다(통과가 아닙니다). 파서·경로를 확인하십시오.");
    process.exit(2);
}

if (findings.length > 0) {
    console.error(`❌ 알림 소독 검사 — ${findings.length}건:`);
    for (const f of findings) console.error(`   · ${f}`);
    console.error("   → 표시 직전에 `plainNotice(...)` 로 감싸십시오. 헤더로 가는 값은 원문을 유지하십시오.");
    process.exit(1);
}
console.log(`✅ 알림 소독 검사 — 통과 (파일 ${scanned}개 · 템플릿 ${templatesSeen}개에서 생 서버값 없음)`);
