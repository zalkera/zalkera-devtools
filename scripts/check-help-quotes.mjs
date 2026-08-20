#!/usr/bin/env node
/**
 * **매뉴얼이 인용한 문면이 실제로 그 문면인가.**
 *
 * ■ 왜 있나
 *   `help.md` 는 「이 글이 뜨면 이렇게 하십시오」 식으로 **제품이 내는 문장을 그대로 인용**한다.
 *   그 인용이 어긋나면 사용자는 자기가 본 글을 매뉴얼에서 못 찾는다 — 매뉴얼이 있는데 없는 것과
 *   같아진다. 실측으로 세 자리가 어긋나 있었다(「폴더가 비어 있지 않습니다」는 실제로 「받을 폴더가
 *   …」, 「항목이 너무 많습니다」는 「받은 파일에 항목이 …」, 「다른 기계에서」는 「다른 곳에서」).
 *
 * ■ 왜 **앞부분 일치**인가
 *   부분문자열로 보면 「폴더가 비어 있지 않습니다」가 「**받을** 폴더가 비어 있지 않습니다」 안에서
 *   발견돼 **그대로 통과한다** — 이 레포가 이미 여러 번 뚫린 형상이다. 사용자가 보는 것은 문장의
 *   **처음부터**이므로 앞에서부터 맞아야 한다. 뒤쪽은 값이 붙는 자리라 자를 수 있게 둔다.
 *
 * ■ 무엇을 인용으로 보나
 *   ⑴ `**「…」**` 로 시작하는 줄 — 「자주 있는 것」의 표제. 여러 개면 `·` 로 나눈다.
 *   ⑵ `("…")` — 본문 안에서 알림 문장을 그대로 옮긴 자리.
 *   자리표시자(`N`·`…`)가 나오면 거기서 자른다 — 그 뒤는 값이다.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import { parse, walk } from "./lib/ast.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const help = join(root, "packages/vscode/media/help.md");
if (!existsSync(help)) {
    console.error("❌ 매뉴얼 인용 검사 — help.md 가 없습니다(통과가 아닙니다).");
    process.exit(2);
}

/** 배송 소스의 **문자열 시작 조각** 전부. 템플릿은 첫 조각만 — 그 뒤는 값이다. */
function literalHeads() {
    const heads = [];
    const walkDir = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walkDir(full);
            } else if (/\.[cm]?tsx?$/.test(entry) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
                walk(parse(full), (node) => {
                    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) heads.push(node.text);
                    else if (ts.isTemplateExpression(node)) heads.push(node.head.text);
                });
            }
        }
    };
    for (const pkg of readdirSync(join(root, "packages"))) {
        const src = join(root, "packages", pkg, "src");
        if (existsSync(src)) walkDir(src);
    }
    return heads;
}

const heads = literalHeads();
if (heads.length === 0) {
    console.error("❌ 매뉴얼 인용 검사 — 소스에서 문자열을 하나도 못 찾았습니다(통과가 아닙니다).");
    process.exit(2);
}

const text = readFileSync(help, "utf8");
const quotes = [];
for (const [index, line] of text.split("\n").entries()) {
    const heading = line.match(/^\*\*(「.+」)\*\*\s*$/);
    if (heading) {
        for (const one of heading[1].split("·")) {
            const inner = one.trim().replace(/^「|」$/g, "");
            if (inner) quotes.push({ line: index + 1, text: inner });
        }
    }
    for (const m of line.matchAll(/\("([^"]{12,})"\)/g)) quotes.push({ line: index + 1, text: m[1] });
}
if (quotes.length === 0) {
    console.error("❌ 매뉴얼 인용 검사 — 인용을 하나도 못 찾았습니다(통과가 아닙니다). 형식을 확인하십시오.");
    process.exit(2);
}

/** 자리표시자 앞까지만 남긴다 — 그 뒤는 실행 때 정해지는 값이다. */
const stem = (quote) => quote.split(/[N…]/)[0].trim();

const bad = quotes.filter((q) => {
    const want = stem(q.text);
    return want.length === 0 || !heads.some((head) => head.startsWith(want));
});

if (bad.length > 0) {
    console.error(`❌ 매뉴얼 인용 검사 — ${bad.length}건이 실제 문면과 다릅니다:`);
    for (const q of bad) {
        console.error(`   · help.md:${q.line} — 「${q.text}」 로 시작하는 문장이 소스에 없습니다`);
        const near = heads.find((h) => h.includes(stem(q.text).slice(0, 10)));
        if (near) console.error(`     실제: 「${near.slice(0, 60)}」`);
    }
    console.error("   → 매뉴얼을 소스 문면에 맞추십시오. 사용자는 자기가 본 글로 이 문서를 찾습니다.");
    process.exit(1);
}
console.log(`✅ 매뉴얼 인용 검사 — 통과 (인용 ${quotes.length}건이 배송 문면 ${heads.length}개와 앞에서부터 일치)`);
