/**
 * **문면이 아니라 구문으로 본다.**
 *
 * ■ 왜 있나
 *   이 레포의 검사기들은 정규식으로 소스를 봤고, 양방향으로 뚫렸다(둘 다 실측).
 *   · **은닉** — 정규식 리터럴 `/^https?:\/\//` 의 `\/` 가 주석 제거기에게는 이스케이프가 아니라서
 *     그 뒤 코드가 통째로 «주석»으로 지워졌다. 그 줄에 숨긴 위반은 검사기가 못 봤다.
 *   · **오검** — 정규식 안의 홑따옴표 하나가 «문자열 열림»으로 잡혀 그 뒤 주석이 안 지워지고,
 *     주석 속 예시가 위반으로 잡혔다. 오검이 더 위험하다 — CI 가 무해한 줄에 빨개지면 다음 판에
 *     붙는 것은 수정이 아니라 **면제**다.
 *
 *   파서는 주석·문자열·정규식·템플릿을 애초에 구별한다. `typescript` 는 이미 devDependency 다.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";

/**
 * 파일을 구문 트리로. **못 읽으면 던진다.**
 *
 * ⚠ `createSourceFile` 은 구문 오류에 **던지지 않는다**(실측). 반쪽 트리를 조용히 돌려주고, 그 트리에는
 *   깨진 지점 뒤의 노드가 없다 — 안 닫힌 백틱 뒤에 둔 `["npm","install"]` 이 **숨는다**(실측: 배열
 *   0개 발견). 그래서 진단을 직접 본다.
 *
 * ⚠ `parseDiagnostics` 는 공개 타입에 없는 내부 속성이다. **없으면 그것도 던진다** — 「깨졌는지 알 수
 *   없다」는 「안 깨졌다」가 아니다. TypeScript 를 올리다 이 속성이 사라지면 검사기가 조용히 눈을 감는
 *   대신 시끄럽게 멈춘다.
 */
export function parse(path) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const diagnostics = source.parseDiagnostics;
    if (!Array.isArray(diagnostics)) {
        throw new Error("parseDiagnostics 를 읽을 수 없다 — 구문이 성한지 확인할 방법이 없다(TypeScript 판을 확인하라)");
    }
    if (diagnostics.length > 0) {
        const first = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ");
        throw new Error(`구문 오류 ${diagnostics.length}건 — ${first}`);
    }
    return source;
}

/** 트리 전체를 훑는다. */
export function walk(node, visit) {
    visit(node);
    node.forEachChild((child) => walk(child, visit));
}

/**
 * 이 파일 안에서 **문자열로 확정되는** 값을 낸다. 아니면 `null`.
 *
 * 리터럴·치환 없는 템플릿·같은 파일의 `const x = "…"` 참조까지 본다. 여기까지가 파서 하나로
 * 정직하게 말할 수 있는 범위다 — 다른 파일에서 온 값은 **모른다**고 답한다.
 */
export function stringValue(node, consts) {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node) && consts?.has(node.text)) return consts.get(node.text);
    return null;
}

/** 파일 최상위의 `const 이름 = "글자"` 를 모은다. */
export function stringConsts(source) {
    const found = new Map();
    walk(source, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
        const value = stringValue(node.initializer, null);
        if (value !== null) found.set(node.name.text, value);
    });
    return found;
}

export { ts };
