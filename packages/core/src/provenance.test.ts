/**
 * 출처 표시 — **「모른다」가 「일치한다」로 접히면 안 된다.**
 *
 * 시작 팩에서 나온 소스는 **정의상** 출처가 없고 그것이 지금 주된 경로다. 접는 순간 이 게이트가
 * 「확인했다」고 말하면서 아무것도 안 본 상태가 된다 — 이 레포의 「못 잰 것은 통과가 아니다」와
 * 같은 자리다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildProvenance, judgeUpdate, parseProvenance } from "./provenance.ts";

test("① 네 판정이 서로 다르다 — 특히 모른다 != 일치한다", () => {
  const prov = parseProvenance(buildProvenance("credium"));
  assert.equal(judgeUpdate(prov, "credium"), "match");
  assert.equal(judgeUpdate(prov, "nasiajai"), "mismatch");
  assert.equal(judgeUpdate(null, "credium"), "unknown");
  assert.equal(judgeUpdate(null, null), "unbound");
  assert.equal(judgeUpdate(prov, null), "unbound", "폴더 소속이 없으면 비교 대상이 없다");
});

test("② 만든 것을 다시 읽으면 같다", () => {
  const p = parseProvenance(buildProvenance("credium"));
  assert.deepEqual(p, { format: 1, claim: "site-export", tenant: "credium" });
});

test("③ 모르는 것은 전부 null 로 강하한다 — 틀린 확신보다 모르는 편이 낫다", () => {
  const bads = [
    null,
    "",
    "{",
    "[]",
    "null",
    JSON.stringify({ format: 2, claim: "site-export", tenant: "c" }),
    JSON.stringify({ format: 1, claim: "other", tenant: "c" }),
    JSON.stringify({ format: 1, claim: "site-export" }),
    JSON.stringify({ format: 1, claim: "site-export", tenant: "" }),
    JSON.stringify({ format: 1, claim: "site-export", tenant: "-lead" }),
    JSON.stringify({ format: 1, claim: "site-export", tenant: "UPPER" }),
    JSON.stringify({ format: 1, claim: "site-export", tenant: "with space" }),
    JSON.stringify({ format: 1, claim: "site-export", tenant: "x".repeat(64) }),
    JSON.stringify({ format: 1, claim: "site-export", tenant: 7 }),
  ];
  for (const bad of bads) assert.equal(parseProvenance(bad), null, `강하했어야 한다: ${String(bad).slice(0, 40)}`);
});

test("④ 강하한 표시는 «모른다»가 된다 — 일치로도 불일치로도 가지 않는다", () => {
  const stale = parseProvenance(JSON.stringify({ format: 9, claim: "site-export", tenant: "credium" }));
  assert.equal(stale, null);
  assert.equal(judgeUpdate(stale, "credium"), "unknown");
});

test("⑤ 62자 경계 — 규격 안은 살고 밖은 죽는다(과잉 차단이 아니다)", () => {
  const ok = "a" + "b".repeat(62);
  assert.notEqual(parseProvenance(buildProvenance(ok)), null);
  assert.equal(parseProvenance(JSON.stringify({ format: 1, claim: "site-export", tenant: ok + "c" })), null);
});
