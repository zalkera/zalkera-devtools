#!/usr/bin/env node
/**
 * **KDoc 이 자기가 설명하는 선언에 실제로 붙어 있는가.**
 *
 * ■ 왜 있나
 *   TypeScript 는 KDoc 블록이 **연달아 둘** 오면 **뒤엣것만** 선언에 붙인다. 앞엣것은 어디에도
 *   안 붙어 편집기 호버·`.d.ts`·문서 도구에서 통째로 사라진다. 그런데 소스를 눈으로 읽으면
 *   **멀쩡해 보인다** — 글자는 그 자리에 그대로 있기 때문이다.
 *
 *   이 형상은 「한 줄 요약 위에 긴 블록을 새로 얹으면서 요약을 안 합치는」 흔한 편집으로 생긴다.
 *   실측으로 34자리가 그렇게 떨어져 있었고, 그중에는 `fetchHandshake`·`getAccessToken`·
 *   `publishCommand`·`apiBase` 처럼 **이 레포에서 가장 많이 읽히는 함수**들이 있었다.
 *
 * ■ 무엇을 허용하나 — **하나뿐이다**
 *   **파일 머리말** — 파일의 첫 문장보다 앞에 선 블록. 모듈 전체를 설명하는 자리다.
 *
 *   ⚠ **면제를 늘리지 마라.** 둘째 갈래를 만들면 「이건 원래 안 붙는 것」이라는 말로 진짜 고아를
 *     덮게 된다. 절을 나누고 싶으면 `//` 로 적는다 — 이 레포의 구분선은 원래 그 형식이다.
 *     붙일 자리가 있으면 붙이고, 없으면 지운다.
 *
 * ■ 걸리면
 *   그 블록이 설명하는 선언을 찾아 **거기로 옮기거나**, 바로 아래 블록과 **합친다**.
 *
 *   재현: `npm run check:kdoc`
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["packages/core/src", "packages/vscode/src"];

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        if (name === "node_modules" || name === "dist") return [];
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        return name.endsWith(".ts") ? [full] : [];
    });
}

const files = ROOTS.flatMap((r) => walk(join(root, r)));
if (files.length === 0) {
    console.error("❌ KDoc 부착 검사 — 대상 파일이 0개입니다(통과가 아닙니다). 경로를 확인하십시오.");
    process.exit(2);
}

const problems = [];
let checked = 0;

for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    // 파일 안에 존재하는 모든 JSDoc 블록.
    const all = new Map();
    (function collect(node) {
        for (const doc of node.jsDoc ?? []) all.set(`${doc.pos}:${doc.end}`, doc);
        ts.forEachChild(node, collect);
    })(sf);
    // 그중 **실제로 선언에 붙은** 것.
    const attached = new Set();
    (function visit(node) {
        for (const doc of ts.getJSDocCommentsAndTags(node)) {
            if (ts.isJSDoc(doc)) attached.add(`${doc.pos}:${doc.end}`);
        }
        ts.forEachChild(node, visit);
    })(sf);

    // 파일 머리말의 경계 — 첫 문장이 시작하는 자리.
    const firstStatement = sf.statements[0]?.getStart(sf) ?? text.length;

    checked += all.size;
    for (const [key, doc] of all) {
        if (attached.has(key)) continue;
        const body = text.slice(doc.pos, doc.end);
        if (doc.end <= firstStatement) continue; // ⑴ 파일 머리말
        const line = sf.getLineAndCharacterOfPosition(doc.pos).line + 1;
        const head =
            body
                .split("\n")
                .map((s) => s.trim().replace(/^\/?\*+\/?/, "").trim())
                .find((s) => s) ?? "";
        problems.push(`${relative(root, file)}:${line} — ${head.slice(0, 76)}`);
    }
}

if (problems.length > 0) {
    console.error(`❌ KDoc 부착 검사 — 어떤 선언에도 안 붙는 블록 ${problems.length}건:`);
    for (const p of problems) console.error(`   · ${p}`);
    console.error("");
    console.error("  블록이 연달아 둘 오면 **뒤엣것만** 붙습니다. 설명하는 선언으로 옮기거나 아래 블록과 합치십시오.");
    process.exit(1);
}
console.log(`✅ KDoc 부착 검사 — 통과 (블록 ${checked}개가 전부 선언에 붙어 있다)`);
