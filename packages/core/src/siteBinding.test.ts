import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSiteChoice,
  decideTenantScope,
  folderBinding,
  needsRelinkConsent,
} from "./siteBinding.ts";
import type { SourceMark } from "./localMark.ts";

const FETCHED: SourceMark = {
  format: 1,
  tenant: "alpha",
  revisionNo: 3,
  sha256: "abc",
  fetchedAt: "2026-08-21T00:00:00.000Z",
};

test("소속은 표식이 이긴다 — 링크는 덮인 적이 있는 자리다", () => {
  // 이 서열이 뒤집히면 어긋난 폴더에서 오염된 링크가 이겨 게이트가 눈을 감는다.
  assert.equal(folderBinding(FETCHED, "beta"), "alpha");
  assert.equal(folderBinding(null, "beta"), "beta");
  assert.equal(folderBinding(null, null), null);
  // 빈 문자열은 「안 적었다」다 — 소속으로 세면 없는 소속이 생긴다.
  assert.equal(folderBinding(null, ""), null);
});

test("쓰기 범위 — 폴더 없는 창은 전역", () => {
  assert.equal(
    decideTenantScope({ siteFolderOpen: false, binding: null, chosen: "alpha" }),
    "global",
  );
});

test("쓰기 범위 — 소속 없는 소스 폴더는 입양된다", () => {
  assert.equal(
    decideTenantScope({ siteFolderOpen: true, binding: null, chosen: "alpha" }),
    "workspace",
  );
});

test("쓰기 범위 — 소속과 같으면 워크스페이스(어긋난 링크의 복원 경로)", () => {
  assert.equal(
    decideTenantScope({ siteFolderOpen: true, binding: "alpha", chosen: "alpha" }),
    "workspace",
  );
});

test("쓰기 범위 — 소속이 다르면 **아무것도 적지 않는다**", () => {
  // ⚠ 이 행이 "global" 로 퇴행하면 교차 업로드가 되살아난다. 전역의 그 값은 이 창에서는 죽은
  //   값이지만, 표식도 링크도 없는 폴더를 여는 순간 그 창의 유효 사이트가 된다 — 그런 폴더에는
  //   게이트가 설 근거가 없어(표식 부재로는 안 막는다) 그대로 발행이 나간다.
  assert.equal(
    decideTenantScope({ siteFolderOpen: true, binding: "alpha", chosen: "beta" }),
    "none",
  );
});

test("제안 — 소속이 다르면 폴더 전환을 권한다. 확증 못 하면 받기다", () => {
  // 확증 없이 열어 주면, 경로가 재활용돼 다른 사이트를 담게 된 폴더를 「그 사이트 폴더」로
  // 내주게 된다 — 이 설계가 막으려는 바로 그 사고다.
  assert.deepEqual(
    decideSiteChoice({
      picked: "beta",
      binding: "alpha",
      siteFolderOpen: true,
      knownFolderConfirmed: false,
    }),
    { kind: "elsewhere", offer: "fetch" },
  );
  assert.deepEqual(
    decideSiteChoice({
      picked: "beta",
      binding: "alpha",
      siteFolderOpen: true,
      knownFolderConfirmed: true,
    }),
    { kind: "elsewhere", offer: "open" },
  );
});

test("제안 — 소속이 없으면 입양, 같으면 그냥 전환", () => {
  assert.deepEqual(
    decideSiteChoice({
      picked: "alpha",
      binding: null,
      siteFolderOpen: true,
      knownFolderConfirmed: false,
    }),
    { kind: "adopted" },
  );
  assert.deepEqual(
    decideSiteChoice({
      picked: "alpha",
      binding: "alpha",
      siteFolderOpen: true,
      knownFolderConfirmed: false,
    }),
    { kind: "switched" },
  );
  // 폴더가 없으면 덮을 소속도 없다 — 오늘의 동작 그대로.
  assert.deepEqual(
    decideSiteChoice({
      picked: "alpha",
      binding: null,
      siteFolderOpen: false,
      knownFolderConfirmed: false,
    }),
    { kind: "switched" },
  );
});

test("재연결 동의는 소속이 있고 다를 때만 받는다", () => {
  // 소속 없는 폴더에까지 모달을 띄우면, 처음 연결하는 흔한 일이 경고가 된다.
  assert.equal(needsRelinkConsent(null, "alpha"), false);
  assert.equal(needsRelinkConsent("alpha", "alpha"), false);
  assert.equal(needsRelinkConsent("alpha", "beta"), true);
});
