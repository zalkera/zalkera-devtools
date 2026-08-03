import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { MANAGED_KEYS, mergeEnv, stripCredentials, type PreviewEnv } from "./env.ts";

const values: PreviewEnv = {
    ZALKERA_API_BASE: "https://api.zalkera.com",
    ZALKERA_TENANT: "acme",
    ZALKERA_STOREFRONT_KEY: "oqsk_secret",
    ZALKERA_SITE_URL: "http://localhost:3000",
    NEXT_PUBLIC_ZALKERA_PREVIEW: "1",
};

test("고객이 넣은 값과 주석은 한 글자도 건드리지 않는다", () => {
    const existing = [
        "# 카카오 로그인",
        "NEXT_PUBLIC_KAKAO_CLIENT_ID=kakao-123",
        "",
        "ZALKERA_REVALIDATE_SECRET=keep-me",
    ].join("\n");

    const merged = mergeEnv(existing, values);

    ok(merged.includes("# 카카오 로그인"), "주석 보존");
    ok(merged.includes("NEXT_PUBLIC_KAKAO_CLIENT_ID=kakao-123"), "고객 값 보존");
    ok(merged.includes("ZALKERA_REVALIDATE_SECRET=keep-me"), "우리 접두여도 관리 대상이 아니면 보존");
    for (const key of MANAGED_KEYS) ok(merged.includes(`${key}=`), `${key} 주입`);
});

test("이미 있는 관리 대상 키는 그 자리에서 값만 바뀐다", () => {
    const existing = ["ZALKERA_TENANT=old-tenant", "OTHER=1", "ZALKERA_SITE_URL=http://localhost:9999"].join("\n");
    const merged = mergeEnv(existing, values).split("\n");

    strictEqual(merged[0], "ZALKERA_TENANT=acme", "첫 줄 자리 유지");
    strictEqual(merged[1], "OTHER=1", "사이 줄 불변");
    strictEqual(merged[2], "ZALKERA_SITE_URL=http://localhost:3000", "세 번째 줄 자리 유지");
    strictEqual(merged.filter((line) => line.startsWith("ZALKERA_TENANT=")).length, 1, "중복 생성 없음");
});

test("export 접두와 앞 공백이 있는 선언도 같은 키로 본다", () => {
    const merged = mergeEnv("  export ZALKERA_TENANT=old", values);
    strictEqual(merged.split("\n").filter((l) => l.includes("ZALKERA_TENANT")).length, 1, "중복 없이 교체");
    ok(merged.includes("ZALKERA_TENANT=acme"));
});

test("빈 파일에도 다섯 칸이 모두 선다", () => {
    const merged = mergeEnv("", values);
    for (const key of MANAGED_KEYS) ok(merged.includes(`${key}=`), key);
});

test("공백이 든 값은 따옴표로 감싸고 평범한 값은 그대로 둔다", () => {
    const merged = mergeEnv("", { ...values, ZALKERA_TENANT: "두 단어" });
    ok(merged.includes('ZALKERA_TENANT="두 단어"'), "공백 값 인용");
    ok(merged.includes("NEXT_PUBLIC_ZALKERA_PREVIEW=1"), "평범한 값은 인용 없음");
});

test("로그아웃은 키 줄을 지우고 나머지는 남긴다", () => {
    const stripped = stripCredentials(mergeEnv("KEEP=1", values));
    ok(!stripped.includes("ZALKERA_STOREFRONT_KEY"), "키 줄 제거");
    ok(stripped.includes("KEEP=1"), "고객 값 보존");
    ok(stripped.includes("ZALKERA_TENANT=acme"), "자격증명이 아닌 칸은 남는다");
});

test("빈 값으로 남기지 않는다 — 빈 키는 401 을 만든다", () => {
    const stripped = stripCredentials(mergeEnv("", values)).split("\n");
    deepStrictEqual(
        stripped.filter((line) => line.startsWith("ZALKERA_STOREFRONT_KEY")),
        [],
        "빈 값 줄조차 남지 않아야 한다",
    );
});
