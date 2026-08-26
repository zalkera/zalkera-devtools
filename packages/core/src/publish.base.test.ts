/**
 * **동시 업로드 최소 방어의 클라이언트 쪽**(발주서 §B).
 *
 * ■ 이 방어가 겨냥하는 것
 *   A·B 가 같은 판을 받아 각자 편집하고 차례로 올리면, 나중 사람의 판에 앞 사람 변경이 안 담긴다.
 *   원장은 append-only 라 **아무것도 사라지지 않지만**, 롤백으로 갈 수 있는 곳은 둘 중 하나뿐이다 —
 *   **둘 다 담은 판은 만들어진 적이 없다.** 진짜 결함의 자리는 「B 의 귀」다: B 는 A 가 그 사이에
 *   올렸다는 사실을 **어디서도 듣지 못한다.** 이 트랜치는 그 귀를 만드는 것이고, 병합은 안 한다.
 *
 * ■ 급소 둘 — 둘 다 「조용히 무보호」다
 *   ⑴ **동의 재시도의 선언 유지.** 백엔드는 동의 게이트(`BaselineShiftGuard`)를 기반 대조보다
 *      **먼저** 지난다. 그래서 동의 409 를 받고 재호출할 때 선언을 빠뜨리면 **그 경로만** 무선언이
 *      된다 — 하필 편집이 있는 사이트에서만 방어가 없고, 화면 어디에도 그 사실이 안 보인다.
 *   ⑵ **override 재전송의 storageKey 재사용.** 사람이 동의한 것은 「지금 이 바이트를 그대로」다.
 *      다시 묶으면 **동의한 것과 다른 것**이 올라간다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { ZalkeraApi } from "./api.ts";
import { publish } from "./publish.ts";
import { tempDir } from "./testing/tempDir.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

async function project(): Promise<string> {
  const dir = await tempDir("zalkera-base-");
  await writeFile(join(dir, "package.json"), '{"name":"t","version":"1.0.0"}');
  await writeFile(join(dir, "page.tsx"), "export default () => null;\n");
  return dir;
}

/**
 * 서버 대역. `opts.tail` 이 있으면 **선언이 그것과 다를 때** `UPLOAD_BASE_MOVED` 409 를 낸다.
 * `opts.needsConsent` 면 동의 전까지 `PENDING_AI_CHANGES_CONFIRM_REQUIRED` 를 **먼저** 낸다
 * (백엔드 순서 그대로 — 그 순서가 급소 ⑴의 원인이다).
 */
function server(opts: {
  tail?: number;
  needsConsent?: boolean;
  /** 동의 요구를 **동적으로** 켠다 — 모달을 읽는 사이 작업이 생기는 거울상 재현용. */
  needsConsentWhen?: () => boolean;
  /** 무선언으로 내려놔도 계속 막는다 — 「같은 문이 두 번」 재현용. */
  alwaysBaseMoved?: boolean;
} = {}) {
  const confirms: Record<string, unknown>[] = [];
  const keys: string[] = [];
  /** 서버가 폐기한 아카이브 키. 재시도 가능한 거절(`UPLOAD_BASE_MOVED`)에서는 안 들어간다. */
  const gone = new Set<string>();
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/partner/site-archive/presign")) {
      const key = `k/${keys.length + 1}.zip`;
      keys.push(key);
      return new Response(
        JSON.stringify({ data: { uploadUrl: "https://s3.example.test/put", storageKey: key, expiresAt: "" } }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://s3.example.test/")) return new Response("", { status: 200 });
    if (url.endsWith("/api/partner/site-archive/confirm")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      confirms.push(body);
      // ⚠ **서버는 confirm 마다 아카이브를 폐기한다** — 재시도 가능한 거절만 예외다. 대역이 그것을
      //    모형화하지 않으면 「같은 키로 재전송」 시험이 **상용에서 죽는 경로를 초록으로** 통과시킨다
      //    (실제로 그랬다 — 성능 축이 서버 코드에서 찾았다).
      if (gone.has(String(body.storageKey))) {
        return new Response(JSON.stringify({ errorCode: "ARCHIVE_NOT_FOUND", message: "아카이브가 없습니다." }), { status: 404 });
      }
      const wantsConsent = opts.needsConsent === true || opts.needsConsentWhen?.() === true;
      if (wantsConsent && body.discardPendingChanges !== true) {
        return new Response(
          JSON.stringify({
            errorCode: "PENDING_AI_CHANGES_CONFIRM_REQUIRED",
            message: "게시 대기 중인 AI 변경 3건이 취소됩니다. 계속하려면 확인해 주세요.",
          }),
          { status: 409 },
        );
      }
      if (opts.alwaysBaseMoved || (opts.tail != null && body.baseRevisionNo != null && body.baseRevisionNo !== opts.tail)) {
        return new Response(
          JSON.stringify({
            errorCode: "UPLOAD_BASE_MOVED",
            message: `올리는 사이 버전 ${opts.tail} 이 올라왔습니다 — 이 올리기에는 그 변경이 담겨 있지 않습니다.`,
          }),
          { status: 409 },
        );
      }
      gone.add(String(body.storageKey)); // 성공 → 폐기
      return new Response(
        JSON.stringify({ data: { revisionNo: 12, siteType: "NEXT_SOURCE", status: "BUILDING" } }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { confirms, keys, gone, fetchImpl };
}

const api = (fetchImpl: typeof fetch) =>
  new ZalkeraApi({
    apiBase: "https://api.example.test",
    accessToken: async () => "t",
    tenantCode: () => "bix",
    fetchImpl,
  });

// ── 선언 자체 ───────────────────────────────────────────────────────────────

test("선언이 없으면 필드를 아예 안 보낸다 — 「주장하지 않는다」가 와이어에 그대로 남는다", async () => {
  const s = server();
  await publish({ projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl });
  const [first] = s.confirms;
  ok(first != null, "confirm 이 한 번도 안 나갔다");
  ok(!("baseRevisionNo" in first), `무선언인데 필드가 실렸다: ${JSON.stringify(first)}`);
});

test("선언이 있으면 그대로 실린다", async () => {
  const s = server({ tail: 7 });
  await publish({
    projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl, baseRevisionNo: 7,
  });
  strictEqual(s.confirms.at(0)?.baseRevisionNo, 7);
});

// ── 급소 ⑴ — 동의 재시도에서 선언이 살아남는가 ──────────────────────────────

test("동의 재시도에도 선언을 싣는다 — 안 그러면 그 경로만 조용히 무보호다", async () => {
  const s = server({ tail: 7, needsConsent: true });
  await publish({
    projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl,
    baseRevisionNo: 7,
    onConsent: async () => true,
  });
  strictEqual(s.confirms.length, 2, "동의 전 1회 + 동의 후 1회");
  strictEqual(s.confirms.at(1)?.discardPendingChanges, true);
  strictEqual(s.confirms.at(1)?.baseRevisionNo, 7, "동의 경로가 무선언이 되면 편집 있는 사이트만 방어가 없다");
});

// ── 급소 ⑵ — override 가 막다른 길을 여는가, 그리고 같은 바이트인가 ──────────

test("그대로 올리기에 동의하면 같은 storageKey 로 무선언 재전송한다", async () => {
  const s = server({ tail: 9 });
  let asked = "";
  await publish({
    projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl,
    baseRevisionNo: 5,
    onBaseMoved: async (m) => { asked = m; return true; },
  });
  strictEqual(s.confirms.length, 2);
  const [before, after] = s.confirms;
  ok(before != null && after != null);
  strictEqual(before.baseRevisionNo, 5);
  ok(!("baseRevisionNo" in after), "재전송이 같은 선언을 실으면 같은 409 를 다시 맞는다 — 영원히 못 나간다");
  strictEqual(s.keys.length, 1, "다시 묶으면 사람이 동의한 것과 **다른 바이트**가 올라간다");
  strictEqual(before.storageKey, after.storageKey);
  ok(asked.includes("버전 9"), `서버 문장이 그대로 와야 최신 번호를 말할 수 있다: ${asked}`);
});

test("거절하면 취소로 끝난다 — 조용히 올라가지 않는다", async () => {
  const s = server({ tail: 9 });
  let code = "";
  try {
    await publish({
      projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl,
      baseRevisionNo: 5,
      onBaseMoved: async () => false,
    });
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  strictEqual(code, "CANCELLED");
  strictEqual(s.confirms.length, 1, "거절했는데 재전송이 나가면 동의가 장식이다");
});

test("물을 자리가 없으면 그대로 던진다 — 조용히 동의하지 않는다", async () => {
  // 화면 없는 자리(시험·CLI)는 이 문을 안 연다. 그때 조용히 넘기면 방어가 아예 없는 것과 같다.
  const s = server({ tail: 9 });
  let code = "";
  try {
    await publish({
      projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl, baseRevisionNo: 5,
    });
  } catch (e) {
    code = (e as { serverCode?: string }).serverCode ?? "";
  }
  strictEqual(code, "UPLOAD_BASE_MOVED");
  strictEqual(s.confirms.length, 1);
});

// ── 두 문이 **차례로** 걸린다 — 이 자리가 영구 막다른길이었다 ─────────────────
//
// 백엔드는 동의 게이트를 기반 대조보다 **먼저** 지난다. 승격 사이트 + 게시 대기 작업 + 그 사이 남이
// 올림이면 **동의를 받은 뒤에** 기반 409 가 온다. 갈래를 평평하게 두면 그 두 번째 409 는 아무 데도
// 안 걸리고, 그 시도는 S3 put·tx 전에 막혀 **아무 상태도 안 바꾸므로** 다음 올리기도 똑같이 막힌다.
test("동의를 받은 뒤 기반이 막아도 빠져나갈 수 있다", async () => {
  const s = server({ tail: 9, needsConsent: true });
  let consentAsked = 0;
  let baseAsked = 0;
  await publish({
    projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl,
    baseRevisionNo: 5,
    onConsent: async () => { consentAsked += 1; return true; },
    onBaseMoved: async () => { baseAsked += 1; return true; },
  });
  strictEqual(consentAsked, 1);
  strictEqual(baseAsked, 1, "두 번째 409 가 아무 데도 안 걸리면 화면은 빠져나갈 단추 없는 빨간창이다");
  strictEqual(s.confirms.length, 3);
  const last = s.confirms.at(2);
  ok(last != null);
  strictEqual(last.discardPendingChanges, true, "기반 갈래가 동의를 지우면 곧바로 같은 동의 409 를 다시 맞는다");
  ok(!("baseRevisionNo" in last), "선언을 그대로 실으면 같은 기반 409 를 다시 맞는다");
  strictEqual(s.keys.length, 1, "세 번을 부르는 동안 zip 은 한 번만 묶인다");
});

test("반대 순서도 빠져나갈 수 있다 — 기반 뒤에 동의", async () => {
  // 모달을 읽는 사이 에이전트가 게시 대기 작업을 만들면 이 순서가 된다(거울상).
  let staged = false;
  const s = server({ tail: 9, needsConsentWhen: () => staged });
  await publish({
    projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl,
    baseRevisionNo: 5,
    onBaseMoved: async () => { staged = true; return true; },
    onConsent: async () => true,
  });
  strictEqual(s.confirms.length, 3);
  strictEqual(s.confirms.at(2)?.discardPendingChanges, true);
});

test("같은 문이 두 번 걸리면 그대로 던진다 — 조르지 않는다", async () => {
  // 사람의 답이 안 통한 것이다. 되풀이해 묻는 것은 확인이 아니라 조르기이고, 끝나지 않는다.
  const s = server({ tail: 9, alwaysBaseMoved: true });
  let asked = 0;
  let code = "";
  try {
    await publish({
      projectDir: await project(), api: api(s.fetchImpl), tenant: "bix", fetchImpl: s.fetchImpl,
      baseRevisionNo: 5,
      onBaseMoved: async () => { asked += 1; return true; },
    });
  } catch (e) {
    code = (e as { serverCode?: string }).serverCode ?? "";
  }
  strictEqual(asked, 1, "같은 문을 두 번 묻지 않는다");
  strictEqual(code, "UPLOAD_BASE_MOVED");
  strictEqual(s.confirms.length, 2);
});
