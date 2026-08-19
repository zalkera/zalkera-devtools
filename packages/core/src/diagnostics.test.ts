import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { diagnose, diagnoseClientUsage, protectedPathWarning } from "./diagnostics.ts";

test("F2 — 브라우저 컴포넌트의 백엔드 직결 fetch 를 잡는다", () => {
    const found = diagnose(
        "src/app/page.tsx",
        ['"use client";', "", "export default function P() {", "  fetch(`${process.env.ZALKERA_API_BASE}/api/public/x`);", "}"].join("\n"),
    );
    strictEqual(found.length, 1);
    strictEqual(found[0]?.rule, "zalkera/no-browser-direct-fetch");
    strictEqual(found[0]?.line, 3, "줄 번호가 맞아야 편집기가 그 자리를 짚는다");
});

test("F2 — 서버 컴포넌트의 같은 호출은 잡지 않는다(오탐이 곧 무시로 이어진다)", () => {
    const server = diagnose("src/app/page.tsx", "export default async function P() {\n  await fetch(`${process.env.ZALKERA_API_BASE}/x`);\n}");
    deepStrictEqual(server, []);
});

test("F2 — NEXT_PUBLIC 시크릿과 소스에 박힌 키를 잡는다", () => {
    const found = diagnose("src/lib/x.ts", 'const a = process.env.NEXT_PUBLIC_STOREFRONT_KEY;\nconst b = "oqsk_AbCdEf12345";');
    strictEqual(found.length, 2);
    ok(found.some((f) => f.rule === "zalkera/no-public-secret"));
    ok(found.some((f) => f.rule === "zalkera/no-literal-key"));
});

test("F2 — 프리뷰 플래그는 시크릿이 아니다(설계가 그 이름을 쓰라고 정했다)", () => {
    deepStrictEqual(diagnose("src/lib/preview.ts", "const p = process.env.NEXT_PUBLIC_ZALKERA_PREVIEW;"), []);
});

test("F2 — client export 대조는 **대조할 목록이 있을 때만** 말한다", () => {
    const code = 'import { getSiteConfig, notARealThing } from "@zalkera/client";';
    strictEqual(diagnoseClientUsage(code, []).length, 0, "목록이 없으면 침묵한다");

    const found = diagnoseClientUsage(code, ["getSiteConfig", "getProduct"]);
    strictEqual(found.length, 1);
    ok(found[0]?.message.includes("notARealThing"));
});

test("F1 — 되돌리기 어려운 자리만 경고한다", () => {
    ok(protectedPathWarning(".env.local")?.includes("자격증명"));
    ok(protectedPathWarning("node_modules/next/index.js")?.includes("다른 프로젝트"));
    ok(protectedPathWarning(".next/build-manifest.json")?.includes("덮어써집니다"));
    strictEqual(protectedPathWarning("src/app/page.tsx"), null, "평범한 소스는 조용해야 한다");
    strictEqual(protectedPathWarning("src/lib/env.ts"), null, "이름이 비슷하다고 경고하지 않는다");
});

/**
 * **저장할 때마다 도는 판정이 줄 길이에 선형이어야 한다.**
 *
 * 종전 형태는 `\s*` 둘 사이에 선택 문자만 있어서, 공백이 길고 뒤의 이름이 없을 때 공백을 두
 * 반복에 나누는 경우의 수만큼 되돌아왔다. `refreshDiagnostics` 는 문서를 **열 때와 저장할 때마다**
 * 확장 호스트 스레드에서 동기로 돌고, 그 스레드는 다른 확장과 공유한다 — 받은 소스 팩에 그런 줄
 * 하나가 있으면 편집기가 선다.
 *
 * 재현: `npm run test -w @zalkera/devtools-core`
 */
test("공백이 긴 줄에서도 선형이다 — 창을 뜨면 여기서 터진다", () => {
    const started = Date.now();
    for (const n of [8_000, 16_000, 32_000, 64_000]) {
        diagnose("a.tsx", `"use client"\nfetch(${" ".repeat(n)}Z\n`);
    }
    const elapsed = Date.now() - started;
    ok(elapsed < 1_500, `${elapsed}ms — 모호한 반복이 되돌아오고 있다(종전 64,000자만 3,262ms)`);
});

test("양성 통제군 — 잡던 형상은 그대로 잡는다", () => {
    const shapes = [
        'fetch(process.env.NEXT_PUBLIC_ZALKERA_API_BASE + "/x")',
        "fetch(`${process.env.ZALKERA_API_BASE}/x`)",
        'axios(  "  ZALKERA_API_BASE")',
        "fetch(ZALKERA_API_BASE)",
    ];
    for (const shape of shapes) {
        const found = diagnose("a.tsx", `"use client"\n${shape}\n`);
        ok(
            found.some((d) => d.rule === "zalkera/no-browser-direct-fetch"),
            `놓쳤다: ${shape}`,
        );
    }
});

test("음성 통제군 — 평범한 fetch 는 안 잡는다", () => {
    for (const shape of ['fetch("/api/products")', "fetch(url)", "await fetch(`/api/${id}`)"]) {
        const found = diagnose("a.tsx", `"use client"\n${shape}\n`);
        ok(
            !found.some((d) => d.rule === "zalkera/no-browser-direct-fetch"),
            `거짓 양성: ${shape}`,
        );
    }
});
