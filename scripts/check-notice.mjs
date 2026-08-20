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
 *   ⑵ 소독기 호출 `plainNotice(...)` · `shown(...)` · `count(...)` — 별칭은 **정의까지** 확인한다.
 *       `count` 는 **숫자**용이다. 타입이 `number` 라는 것은 런타임 보장이 아니라, 서버가 그 자리에
 *       문자열을 넣으면 `ours(...)` 는 아무것도 막지 못한다(심의 실증).
 *   ⑶ 표기 `ours(...)` — "서버가 정하지 않은 값"이라고 사람이 한 번 판단했다는 기록.
 *
 *   그 밖의 모든 표현식(맨 식별자·속성 접근·연산·임의 함수 호출)은 **반려**다. 값이 안전해도
 *   반려한다 — 안전하다면 `ours(...)` 를 붙여 그 판단을 코드에 남기면 된다.
 *
 * ■ 어디를 보는가 — **찾아낸다. 적어 두지 않는다.**
 *   앞 판은 파일 두 개를 손으로 적었다. 그것 역시 열거이고, **새로 생기는 파일이 통째로 관할 밖**이
 *   된다 — 이 파일이 스스로 배격한 형상을 파일 층위에서 되풀이한 것이다.
 *
 *   그래서 `packages/&#42;/src` 를 훑어 **알림 API 를 부르는 파일을 전부** 관할로 잡는다. 관할이 0이면
 *   초록이 아니라 중단이다(아래 [spansSeen]·[NOTICE_SOURCES] 검사).
 *
 *   · 알림을 부르는 모든 파일 — 그 호출의 인자와 진행 알림 `title`.
 *   · [NOTICE_SOURCES] — 알림 **문구를 만들어 돌려주는** 파일. 호출이 없어도 템플릿 전부를 본다.
 *     (`log()`(출력 채널)는 링크를 렌더하지 않으므로 관할 밖이다 — 거기까지 잡으면 오검이다.)
 *
 *   **문면이 아니라 구문으로 본다** — 정규식 주석 제거는 이 레포에서 양방향으로 뚫렸다(`ast.mjs`).
 *
 * ■ 걸리면
 *   서버에서 온 값이면 `plainNotice(...)`. 아니면 `ours(...)` 를 붙인다. 소독은 **표시 자리에서만**
 *   한다 — `x-tenant` 헤더로 가는 값(`api.ts` 의 `tenantCode()`)은 원문이어야 한다.
 */
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, walk } from "./lib/ast.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 소독을 거쳤다고 인정하는 호출. 별칭은 아래 [assertDefinitionsAreReal] 이 정의까지 확인한다. */
const SANITIZERS = new Set(["plainNotice", "shown", "count"]);
/** "서버가 정하지 않았다"는 사람의 판단 표기. 값을 바꾸지 않으므로 정의도 확인한다. */
const MARKER = "ours";
/** 별칭 → 그 정의가 반드시 불러야 하는 진짜 소독기. */
const ALIAS_MUST_CALL = new Map([["shown", "plainNotice"]]);
/** 소독기 중 **정의가 이 파일에 있어야** 하는 것. 이름만 흉내 낸 가짜를 막는다. */
const SANITIZER_HOME = new Map([["count", "packages/core/src/notice.ts"]]);
/** 표기 `ours` 의 정의가 사는 자리. [assertMarkerIsIdentity] 가 그것을 확인한다. */
const MARKER_HOME = "packages/core/src/notice.ts";

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
 * 정본이 **살 수 있는 모듈**. 이름만 보면 안 된다 — 어느 파일에서든 지역 `say` 나 `decideX` 를
 * 만들면 그 결과가 정본으로 인정된다(심의 실증: 셋 다 검사기를 통과시켰다).
 *
 *   `const say = {build: () => 서버객체};  showErrorMessage(\`${say.build().message}\`)`  → 통과했다
 *   `function decideBoom(s) { return s; }  showErrorMessage(\`${decideBoom(s).message}\`)` → 통과했다
 *
 * 그래서 **어디서 왔는지**를 본다: 정본 이름은 아래 모듈에서 `import` 된 것이어야 한다.
 * 상대경로는 [NOTICE_SOURCES] 자신이고, 패키지 이름은 그 파일들을 재수출하는 자리다.
 */
const CANON_MODULES = new Set(["@zalkera/devtools-core"]);
/**
 * 정본이 돌려주는 문장 조각. `decide*`·`say.*` 의 반환 모양이고, 그 내용물은 위와 같은 이유로
 * 이미 검사됐다.
 *
 * ⚠ **이 이름들만 보면 안 된다.** 종전 판은 `.message`·`.detail`·`.action` 이면 **무엇의**
 *   속성이든 통과시켰다. 그러면 `error.message`(서버 문장이 그대로 들어 있다)·`body.message`·
 *   `finding.message` 가 전부 무검사로 알림 본문에 실린다 — 이 검사기가 스스로 배격한
 *   *"이름을 열거한다"* 가 **속성 이름 층위에서** 되풀이된 것이다.
 *
 *   그래서 이름과 **출처를 함께** 본다: 그 속성이 붙은 객체가 `say.*(...)`·`decide*(...)` 의
 *   결과라야 한다([isCanonicalObject]).
 */
const CANON_FIELDS = new Set(["message", "detail", "action"]);
/** 정본 판정 함수의 이름 모양. **이름만으로는 부족하다** — [CANON_MODULES] 에서 온 것이어야 한다. */
const CANON_DECIDER = /^decide[A-Z]/;

/**
 * 이 파일 안에서 이름 → 그 이름이 받은 초기식들. 같은 이름이 여러 번 선언되면 **전부** 모은다 —
 * 하나라도 정본이 아니면 거부다(가장 보수적인 쪽).
 *
 * 파일을 넘는 추적은 하지 않는다. 넘겨받은 인자·다른 모듈에서 온 값은 정본으로 인정하지 않으며,
 * 그것이 안전하다면 부르는 쪽에서 `ours(...)`·`plainNotice(...)` 를 붙여 판단을 남기면 된다.
 */
function collectDeclarations(source) {
    const decls = new Map();
    const add = (name, expr) => {
        if (!decls.has(name)) decls.set(name, []);
        decls.get(name).push(expr);
    };
    walk(source, (node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
            add(node.name.getText(), node.initializer);
            return;
        }
        // ⚠ **재대입도 본다.** 선언 초기식만 모으면 `let m = say.build(); m = 서버객체;` 가 통과한다
        //    (심의 실증). 이름이 받은 값이 **하나라도** 정본이 아니면 그 이름은 정본이 아니다.
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left)
        ) {
            add(node.left.getText(), node.right);
        }
        // 선언만 있고 값이 없는 것(`let m;`)도 등록한다 — 등록이 없으면 아래에서 «못 찾음»이 되어
        // 어차피 거부지만, 뒤의 재대입만 보고 통과하는 일이 없게 자리를 만들어 둔다.
        if (ts.isVariableDeclaration(node) && !node.initializer && ts.isIdentifier(node.name)) {
            add(node.name.getText(), node.name);
        }
    });
    return decls;
}

/**
 * 이 파일이 [CANON_MODULES] 에서 **import 한** 이름들. 지역 선언은 여기 안 든다.
 *
 * 구조분해·별칭(`import {say as s}`)도 지역 이름 기준으로 담는다 — 별칭을 써도 출처는 그 모듈이다.
 */
function collectCanonicalImports(source) {
    const names = new Set();
    walk(source, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        const spec = node.moduleSpecifier;
        if (!ts.isStringLiteral(spec)) return;
        const fromCanon =
            CANON_MODULES.has(spec.text) ||
            NOTICE_SOURCES.some((rel) => spec.text.endsWith(rel.slice(rel.lastIndexOf("/"))));
        if (!fromCanon) return;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const e of bindings.elements) names.add(e.name.getText());
        }
    });
    return names;
}

/** 이 스캔이 보고 있는 파일이 정본 모듈에서 들여온 이름들. [scan] 이 파일마다 갈아 끼운다. */
let currentImports = new Set();

/** 이 스캔이 보고 있는 파일의 선언 표. [scan] 이 파일마다 갈아 끼운다. */
let currentDecls = new Map();

/**
 * 이 표현식이 **문구 정본이 만든 객체**인가. 아니면 그 속성은 서버 값일 수 있다.
 *
 * `depth` 는 별칭이 별칭을 가리키는 고리(`const a = b; const b = a;`)에서 멈추기 위한 것이다 —
 * 그런 코드는 지금 없지만, 검사기가 스택오버플로로 죽으면 그것은 **통과가 아니라 무검사**다.
 */
function isCanonicalObject(e, depth = 0) {
    if (depth > 8) return false;
    if (ts.isParenthesizedExpression(e)) return isCanonicalObject(e.expression, depth + 1);
    if (ts.isAwaitExpression(e)) return isCanonicalObject(e.expression, depth + 1);
    if (ts.isCallExpression(e)) {
        // `say.*(...)` — 그 `say` 가 **정본 모듈에서 온 것**이라야 한다.
        if (
            ts.isPropertyAccessExpression(e.expression) &&
            e.expression.expression.getText() === CANON_FACTORY
        ) {
            return currentImports.has(CANON_FACTORY);
        }
        // `decideX(...)` — 이름 모양만으로는 부족하다. 같은 이유로 출처를 본다.
        if (!ts.isIdentifier(e.expression)) return false;
        const callee = e.expression.getText();
        return CANON_DECIDER.test(callee) && currentImports.has(callee);
    }
    if (ts.isIdentifier(e)) {
        const inits = currentDecls.get(e.getText());
        // 선언을 못 찾으면 거부다. 인자·임포트·재대입은 여기서 걸린다.
        if (!inits || inits.length === 0) return false;
        return inits.every((init) => isCanonicalObject(init, depth + 1));
    }
    return false;
}

/** 이 표현식이 허용 목록에 드는가. **드는 것만 참** — 나머지는 전부 거부다. */
function isAllowed(e) {
    if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    // 정본이 만든 문장 — `tenantScope.ts` 전수 검사가 덮는다. **무엇의 속성인지까지** 본다.
    if (ts.isPropertyAccessExpression(e) && CANON_FIELDS.has(e.name.getText())) {
        return isCanonicalObject(e.expression);
    }
    if (!ts.isCallExpression(e)) return false;
    // `say.*(...)` — ⚠ **그 `say` 가 정본 모듈에서 온 것이라야 한다.** 이름만 보면 어느 파일에서든
    //    지역 `say` 를 만들어 통과시킬 수 있다. `isCanonicalObject` 는 그것을 보는데 이 갈래만
    //    안 봐서, `.message` 를 **떼기만 하면** 같은 섀도잉이 다시 통과했다(확인 심의 실증).
    if (
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.expression.getText() === CANON_FACTORY
    ) {
        return currentImports.has(CANON_FACTORY);
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
    currentDecls = collectDeclarations(source);
    currentImports = collectCanonicalImports(source);

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
        //    부르는 형태는 점 표기만이 아니다 — 문자열 인덱스도 같은 호출이다([notifyName]).
        if (ts.isCallExpression(node) && notifyName(node.expression) !== null) {
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
 * **정본 이름을 가리는 것**을 금지한다.
 *
 * 출처 검사(`isCanonicalObject`·`isAllowed`)는 **파일 단위**로 「그 이름이 정본 모듈에서
 * 수입됐는가」를 본다. 그래서 정본을 수입한 파일 **안에서 함수 스코프로 가리면** 통과한다:
 *
 *   `function f() { const say = {evil: v => String(v)}; show(\`${say.evil(x)}\`) }`  → 통과했다
 *
 * 스코프를 따라가는 대신 **가리는 것 자체를 막는다.** 판정이 도는 파일에서 정본 이름을 지역
 * 변수로 다시 선언할 이유가 없고, 막으면 출처 검사가 파일 단위여도 뚫리지 않는다.
 *
 * ■ **판정이 도는 파일에만 건다**
 *   `isAllowed` 는 알림을 부르는 파일과 [NOTICE_SOURCES] 에서만 돈다. 그 밖의 파일에 지역
 *   `count` 가 있어도 알림 판정에 닿지 않는다 — 거기까지 막으면 무해한 이름을 금지어로 만들고,
 *   그러면 사람이 검사기에 맞춰 코드를 비틀게 된다(그것이 곧 다음 판의 면제다).
 *
 * ■ **정본을 정의하는 파일은 뺀다**
 *   `notice.ts` 는 `plainNotice`·`count`·`ours` 를 **만든다.** 만드는 것은 가리는 것이 아니다.
 *
 * 현재 코드에 걸리는 자리는 0건이다 — **지금 닫아 두는 것**이지 오늘의 결함이 아니다.
 */
function assertNoCanonicalShadow(rel) {
    // 정본을 **정의**하는 파일. 여기서 그 이름이 나오는 것은 선언이지 섀도잉이 아니다.
    const homes = new Set([...SANITIZER_HOME.values(), MARKER_HOME, ...NOTICE_SOURCES]);
    if (homes.has(rel)) return;
    const source = parse(join(root, rel));
    const shadowed = new Set([CANON_FACTORY, ...SANITIZERS, MARKER]);
    walk(source, (node) => {
        const named =
            (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)) &&
            node.name &&
            ts.isIdentifier(node.name)
                ? node.name.getText()
                : null;
        if (named === null || !shadowed.has(named)) return;
        const {line} = source.getLineAndCharacterOfPosition(node.getStart());
        findings.push(
            `${rel}:${line + 1} — 정본 이름 \`${named}\` 을 지역에 다시 선언했습니다 — ` +
                "출처 검사가 파일 단위라 이렇게 가리면 뚫립니다(다른 이름을 쓰십시오)",
        );
    });
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
        if (notifyName(node) === null) return;
        // 구조분해로 이름을 빼내는 것은 그 자체가 별칭화다 — 부르는 자리가 검사기 눈에 안 보인다.
        if (ts.isBindingElement(node)) {
            const { line: at } = source.getLineAndCharacterOfPosition(node.getStart());
            findings.push(`${rel}:${at + 1} — 알림 API 를 구조분해로 빼냈습니다 — 검사기가 호출을 못 찾습니다`);
            return;
        }
        // 호출의 피호출자로 쓰인 것만 정상이다. 그 밖(대입·인자 전달)은 별칭화다.
        const parent = node.parent;
        if (parent && ts.isCallExpression(parent) && parent.expression === node) return;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        findings.push(
            `${rel}:${line + 1} — 알림 API 를 변수로 옮겼습니다(\`${describe(node)}\`) — 검사기가 호출을 못 찾습니다`,
        );
    });
}

/**
 * 알림 **문구를 만들어 돌려주는** 파일. 알림 API 를 부르지 않아 자동 탐색에 안 걸리므로 여기 적는다.
 * 이 파일들은 템플릿 전부를 본다 — 어느 문자열이 알림으로 갈지는 호출부가 정하기 때문이다.
 */
const NOTICE_SOURCES = ["packages/core/src/tenantScope.ts", "packages/core/src/errorNotice.ts"];

/**
 * 소스로 볼 확장자. ⚠ `.ts` 만 보면 `.mts`·`.cts`·`.tsx` 로 옮기는 순간 그 파일이 **관할 밖**이
 * 된다 — 이 검사기가 스스로 배격한 형상이 확장자 층위에서 재발한다.
 */
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

/** `packages/&#42;/src` 아래 소스 전부(시험 제외). 관할을 손으로 적지 않기 위한 목록. */
function sourceFiles() {
    const out = [];
    const walkDir = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walkDir(full);
            } else if (SOURCE_EXT.test(entry) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
                out.push(full.slice(root.length + 1));
            }
        }
    };
    for (const pkg of readdirSync(join(root, "packages"))) {
        const src = join(root, "packages", pkg, "src");
        if (existsSync(src)) walkDir(src);
    }
    return out.sort();
}

/**
 * 알림 API 를 부르는 파일을 **구문으로** 고른다.
 *
 * ⚠ 문면(`includes("showErrorMessage")`)으로 고르면 주석·문자열에 그 이름이 있는 파일이 딸려 오고,
 *   반대로 이름을 쪼개 쓰면(`"show" + "ErrorMessage"`) 빠진다. 여기서 고르는 일이 곧 관할이라,
 *   고르는 방법이 뚫리면 검사 전체가 뚫린다.
 */
function callsNotify(rel) {
    let found = false;
    walk(parse(join(root, rel)), (node) => {
        if (notifyName(node) !== null) found = true;
        if (ts.isPropertyAccessExpression(node) && node.name.getText() === "withProgress") found = true;
    });
    return found;
}

/**
 * 이 노드가 알림 API 를 **가리키는가**. 점 표기만 보면 세 갈래로 빠져나간다:
 *   · `vscode.window["showErrorMessage"]`  — 문자열 인덱스
 *   · `const {showErrorMessage} = vscode.window` — 구조분해
 *   · 위 둘을 변수에 담아 부르기 — [assertNoIndirectNotify] 가 잡는다
 * 현재 코드에는 하나도 없다 — **지금 닫아 두는 것**이지 오늘의 결함이 아니다.
 */
function notifyName(node) {
    if (ts.isPropertyAccessExpression(node) && NOTIFY.has(node.name.getText())) return node.name.getText();
    if (ts.isElementAccessExpression(node)) {
        const arg = node.argumentExpression;
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && NOTIFY.has(arg.text)) {
            return arg.text;
        }
    }
    if (ts.isBindingElement(node)) {
        const name = (node.propertyName ?? node.name).getText();
        if (NOTIFY.has(name)) return name;
    }
    return null;
}

const all = sourceFiles();
const notifiers = all.filter(callsNotify);

// **관할이 비었는데 초록**을 막는 첫 그물. 탐색이 깨지면(경로 변경·파서 오류) 여기서 죽는다.
if (all.length === 0) {
    console.error("❌ 알림 소독 검사 — 소스를 하나도 못 찾았습니다(통과가 아닙니다).");
    process.exit(2);
}
if (notifiers.length === 0) {
    console.error("❌ 알림 소독 검사 — 알림을 부르는 파일이 0개입니다(통과가 아닙니다). 탐색을 확인하십시오.");
    process.exit(2);
}

for (const rel of NOTICE_SOURCES) {
    if (!existsSync(join(root, rel))) {
        console.error(`❌ 알림 소독 검사 — ${rel} 이 없습니다(통과가 아닙니다).`);
        process.exit(2);
    }
    scan(rel, { allTemplates: true });
    assertDefinitionsAreReal(rel);
}
for (const rel of notifiers) {
    if (!NOTICE_SOURCES.includes(rel)) scan(rel, { allTemplates: false });
    assertNoIndirectNotify(rel);
}
// 별칭화는 **부르지 않는 파일에서도** 일어난다(거기서 만들어 넘기면 된다). 전 소스에 건다.
for (const rel of all) {
    if (!notifiers.includes(rel)) assertNoIndirectNotify(rel);
}
// 섀도잉은 **판정이 도는 파일**에서만 위험하다 — 그 밖에서는 알림 판정에 닿지 않는다.
for (const rel of new Set([...notifiers, ...NOTICE_SOURCES])) assertNoCanonicalShadow(rel);
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
