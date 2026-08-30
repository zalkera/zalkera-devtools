import assert, { ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { ZalkeraApi, needsDiscardConsent, isDraftInProgress, reflectionOf, revisionWhen, switchCandidates } from "./api.ts";
import { DevtoolsError } from "./errors.ts";

function api(handler: (url: string, init: RequestInit) => Response): ZalkeraApi {
    return new ZalkeraApi({
        apiBase: "https://api.zalkera.com",
        accessToken: async () => "token-abc",
        tenantCode: () => "acme",
        fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            handler(String(input), init ?? {})) as unknown as typeof fetch,
    });
}

test("파트너 호출은 Bearer 와 X-Tenant 를 함께 싣는다", async () => {
    let seen: RequestInit = {};
    let seenUrl = "";
    const client = api((url, init) => {
        seenUrl = url;
        seen = init;
        return Response.json({ status: 201, data: { id: 1, key: "oqsk_x", revokedPrevious: 0 } });
    });

    await client.issuePreviewKey("노트북");

    strictEqual(seenUrl, "https://api.zalkera.com/api/partner/storefront-keys/preview");
    const headers = seen.headers as Record<string, string>;
    strictEqual(headers["authorization"], "Bearer token-abc");
    strictEqual(headers["x-tenant"], "acme");
    strictEqual(seen.body, JSON.stringify({ label: "노트북" }));
});

test("/api/me 는 테넌트 헤더를 요구하지 않는다(닭과 달걀)", async () => {
    let headers: Record<string, string> = {};
    const client = api((_url, init) => {
        headers = init.headers as Record<string, string>;
        return Response.json({ status: 200, data: { tenants: [{ code: "acme", name: "에이크미" }] } });
    });

    const tenants = await client.listMyTenants();

    strictEqual(tenants[0]?.code, "acme");
    ok(!("x-tenant" in headers), "테넌트를 고르기 전에 부르는 경로다");
});

test("401 은 재로그인, 403 은 권한 안내로 옮긴다", async () => {
    await rejects(
        () => api(() => new Response("{}", { status: 401 })).listRevisions(),
        (error: unknown) => error instanceof DevtoolsError && error.code === "NOT_AUTHENTICATED",
    );

    await rejects(
        () => api(() => Response.json({ message: "권한이 없습니다." }, { status: 403 })).issuePreviewKey(),
        (error: unknown) =>
            error instanceof DevtoolsError &&
            error.code === "FORBIDDEN" &&
            // 순수 STAFF 계정이 미리보기 키를 못 받는 것이 이 403 의 진짜 원인이다 — 그 사실을 사람에게 말한다.
            (error.hint ?? "").includes("관리자 권한"),
    );
});

test("연결 자체가 실패하면 프록시·주소를 짚어 준다", async () => {
    const client = new ZalkeraApi({
        apiBase: "https://api.zalkera.com",
        accessToken: async () => "t",
        tenantCode: () => "acme",
        fetchImpl: (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch,
    });

    await rejects(
        () => client.listRevisions(),
        (error: unknown) =>
            error instanceof DevtoolsError &&
            error.code === "SERVER_UNREACHABLE" &&
            (error.hint ?? "").includes("프록시"),
    );
});

test("경로가 있는 베이스 주소도 잘리지 않는다", async () => {
    let seenUrl = "";
    const client = new ZalkeraApi({
        apiBase: "https://gateway.example.com/zalkera",
        accessToken: async () => "t",
        tenantCode: () => "acme",
        fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
            seenUrl = String(input);
            return Response.json({ status: 200, data: [] });
        }) as unknown as typeof fetch,
    });

    await client.listRevisions();
    ok(seenUrl.startsWith("https://gateway.example.com/"), `베이스 보존 실패: ${seenUrl}`);
});

// ── 응답 파싱 ────────────────────────────────────────────────────────────────
// 200 이어도 본문이 우리 형식이라는 보장이 없다. 캡티브 포털·사내망 프록시는 HTML 을 준다.
// 종전에는 raw `SyntaxError`/`TypeError` 가 고객 대화상자로 그대로 나갔다.

test("200 이지만 JSON 이 아니면 — 사람 말로 끊는다", async () => {
    const client = api(() => new Response("<html>로그인이 필요합니다</html>", {status: 200}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => {
            ok(error instanceof DevtoolsError, "DevtoolsError 가 아니면 raw SyntaxError 가 나간 것이다");
            strictEqual(error.code, "SERVER_UNREACHABLE");
            ok(!/SyntaxError|JSON/i.test(error.humanMessage), "파서 용어가 사용자에게 나갔다");
            return true;
        },
    );
});

test("200 이고 JSON 이지만 data 가 없으면 — 여기서 끊는다", async () => {
    // 통과시키면 `undefined` 가 호출부까지 흘러가 원인에서 먼 곳에서 raw TypeError 가 된다.
    const client = api(() => Response.json({status: 200}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            strictEqual(error.code, "SERVER_UNREACHABLE");
            return true;
        },
    );
});

test("본문이 JSON null 이어도 끊는다", async () => {
    const client = api(() => new Response("null", {status: 200, headers: {"content-type": "application/json"}}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => error instanceof DevtoolsError && error.code === "SERVER_UNREACHABLE",
    );
});

test("양성 통제군 — 정상 봉투는 그대로 통과한다", async () => {
    // 위 셋은 "언제나 던지는" 파서로도 통과한다. 정상 응답이 살아 있는 것을 따로 못 박는다.
    const client = api(() => Response.json({status: 200, data: []}));
    const revisions = await client.listRevisions();
    ok(Array.isArray(revisions));
});

test("오류 응답의 errorCode 도 소독을 지난다", async () => {
    // `message` 만 막고 `errorCode` 를 열어 두면 같은 서버가 같은 알림으로 링크를 밀어 넣는다.
    const evil = "X](command:workbench.action.terminal.new)";
    const client = api(() => Response.json({message: "거절", errorCode: evil}, {status: 400}));
    await rejects(
        () => client.listRevisions(),
        (error: unknown) => {
            ok(error instanceof DevtoolsError);
            ok(!/\]\(command:/.test(error.humanMessage), "errorCode 가 링크로 살아 있다");
            return true;
        },
    );
});

test("동의로 넘어갈 수 있는 거절만 그렇다고 말한다", async () => {
  // 「409 면 물어본다」로 넓히면 뚫을 수 없는 거절(게시 진행 중·AI 작업 중·레포 연결 테넌트)에도
  // 동의 창이 뜬다. 사용자는 「버리고 바꾸기」를 눌렀는데 또 거절당한다.
  const reject = (errorCode: string) =>
    new Response(JSON.stringify({ errorCode, message: "거절" }), { status: 409 });
  for (const [code, expected] of [
    ["DRAFT_DISCARD_CONFIRM_REQUIRED", true],
    ["AI_WORK_IN_PROGRESS", false],
    ["PUBLISH_IN_PROGRESS", false],
    ["REPO_ALREADY_CONNECTED", false],
    // ⚠ **발행 전 편집은 동의로 못 넘어간다.** 서버에 이 거절을 넘기는 인자 자체가 없다
    //    (`SiteBaselineShiftErrorCode.DRAFT_IN_PROGRESS` — 동의 플래그를 일부러 안 뒀다).
    //    여기가 `true` 가 되면 「버리고 계속」을 눌러도 같은 409 가 돌아온다.
    ["DRAFT_IN_PROGRESS", false],
    ["", false],
  ] as [string, boolean][]) {
    const api = new ZalkeraApi({
      apiBase: "https://example.test",
      accessToken: async () => "t",
      tenantCode: () => "bix",
      fetchImpl: async () => reject(code),
    });
    const error = await api.activateRevision(7).then(
      () => null,
      (e: unknown) => e,
    );
    ok(error instanceof DevtoolsError, `${code}: DevtoolsError 가 아니다`);
    strictEqual(needsDiscardConsent(error), expected, `${code} 판정이 틀렸다`);
  }
});

test("동의 판정은 오류 코드만 본다 — 메시지 문면으로 흉내 낼 수 없다", () => {
  const impostor = new DevtoolsError(
    "SERVER_REJECTED",
    "DRAFT_DISCARD_CONFIRM_REQUIRED 게시 대기 중인 AI 변경 3건이 취소됩니다.",
  );
  strictEqual(needsDiscardConsent(impostor), false);
  strictEqual(needsDiscardConsent(new Error("아무거나")), false);
  strictEqual(needsDiscardConsent(undefined), false);
});

test("발행 전 편집 거절만 그렇다고 말한다", async () => {
  const reject = (errorCode: string) =>
    new Response(JSON.stringify({ errorCode, message: "거절" }), { status: 409 });
  for (const [code, expected] of [
    ["DRAFT_IN_PROGRESS", true],
    ["DRAFT_DISCARD_CONFIRM_REQUIRED", false],
    ["AI_WORK_IN_PROGRESS", false],
    ["PUBLISH_IN_PROGRESS", false],
    ["", false],
  ] as [string, boolean][]) {
    const api = new ZalkeraApi({
      apiBase: "https://example.test",
      accessToken: async () => "t",
      tenantCode: () => "bix",
      fetchImpl: async () => reject(code),
    });
    const error = await api.activateRevision(7).then(
      () => null,
      (e: unknown) => e,
    );
    ok(error instanceof DevtoolsError, `${code}: DevtoolsError 가 아니다`);
    strictEqual(isDraftInProgress(error), expected, `${code} 판정이 틀렸다`);
  }
});

test("두 판정은 **동시에 참일 수 없다** — 물을 것인가 알릴 것인가가 갈린다", async () => {
  // 한 오류가 둘 다 참이면 호출부의 분기 순서가 화면을 정한다. 그건 판정이 아니라 우연이다.
  const reject = (errorCode: string) =>
    new Response(JSON.stringify({ errorCode, message: "거절" }), { status: 409 });
  for (const code of [
    "DRAFT_IN_PROGRESS",
    "DRAFT_DISCARD_CONFIRM_REQUIRED",
    "AI_WORK_IN_PROGRESS",
    "PUBLISH_IN_PROGRESS",
    "",
  ]) {
    const api = new ZalkeraApi({
      apiBase: "https://example.test",
      accessToken: async () => "t",
      tenantCode: () => "bix",
      fetchImpl: async () => reject(code),
    });
    const error = await api.activateRevision(7).then(
      () => null,
      (e: unknown) => e,
    );
    ok(
      !(needsDiscardConsent(error) && isDraftInProgress(error)),
      `${code}: 두 판정이 함께 참이다`,
    );
  }
});

test("발행 전 편집 판정도 오류 코드만 본다 — 문면으로 흉내 낼 수 없다", () => {
  const impostor = new DevtoolsError(
    "SERVER_REJECTED",
    "DRAFT_IN_PROGRESS 편집 중인 내용이 있습니다.",
  );
  strictEqual(isDraftInProgress(impostor), false);
  strictEqual(isDraftInProgress(new Error("아무거나")), false);
  strictEqual(isDraftInProgress(undefined), false);
});

test("시각이 없거나 이상하면 「시각 모름」 — 1970-01-01 은 거짓말이다", () => {
  // 백엔드가 `Instant?` 로 보낸다. `new Date(null)` 은 조용히 1970-01-01 을 그린다(계약축 심의).
  for (const bad of [null, undefined, "", "   ", "어제", "2026-13-45", 0, {}, []]) {
    strictEqual(revisionWhen(bad), "시각 모름", `통과했다: ${JSON.stringify(bad)}`);
  }
});

test("정상 시각은 그대로 그린다", () => {
  const shown = revisionWhen("2026-08-20T01:23:45Z");
  ok(shown !== "시각 모름", shown);
  ok(/2026/.test(shown), shown);
});

// ── 동의로 뚫리는 거절 ──────────────────────────────────────────────────────

const rejected = (code: string) =>
  new DevtoolsError("SERVER_REJECTED", "거절", undefined, undefined, code);

/**
 * ⚠ **이름으로 잡지 않는다.** 같은 409 이웃에 `DRAFT_PRECONDITION_FAILED`·`DRAFT_BASE_MOVED`·
 *   `DRAFT_CONCURRENT_EDIT` 가 있고 셋 다 동의로 못 뚫는다. `*_CONFIRM_REQUIRED` 접미로 잡으면
 *   **뚫을 수 없는 거절에 동의 창을 띄운다** — 가짜 코드 한 칸이 그 회귀를 문다.
 */
test("동의 인자가 실제로 통과시키는 코드만 참이다", () => {
  const 진리표: [string, boolean][] = [
    ["DRAFT_DISCARD_CONFIRM_REQUIRED", true],
    ["DRAFT_IN_PROGRESS", false],
    ["DRAFT_BASE_MOVED", false],
    ["DRAFT_PRECONDITION_FAILED", false],
    ["DRAFT_CONCURRENT_EDIT", false],
    // 접미만 같은 가짜 — 패턴 매칭으로 넓히면 여기서 빨개진다.
    ["FAKE_CONFIRM_REQUIRED", false],
  ];
  for (const [code, 참] of 진리표) {
    assert.strictEqual(needsDiscardConsent(rejected(code)), 참, `코드가 틀렸다: ${code}`);
  }
  assert.strictEqual(needsDiscardConsent(new Error("plain")), false);
});

// ── 되돌리기 대상은 후보에서 뺀다 ──────────────────────────────────────────

const rev = (revisionNo: number, isActive: boolean, status = "READY") => ({
  revisionNo,
  isActive,
  status,
});

/**
 * ⚠ **이 칸이 콘솔이 먼저 밟은 함정이다.** 활성 포인터가 없는 테넌트에서 백엔드는 드래프트의
 *   기준 판을 「지금 켜진 판」으로 본다 — `isActive` 만 보면 그 판이 후보로 떠서, 고르는 순간
 *   전환이 아니라 **폐기**가 된다.
 */
test("활성 포인터가 없어도 되돌리기 대상은 후보가 아니다", () => {
  const list = [rev(9, false), rev(7, false), rev(5, false)];
  assert.deepStrictEqual(
    switchCandidates(list, 7).map((r) => r.revisionNo),
    [9, 5],
    "드래프트 기준 판이 후보에 남았다",
  );
});

test("활성 행도 여전히 뺀다 — 둘의 합집합이다", () => {
  const list = [rev(9, true), rev(7, false), rev(5, false)];
  assert.deepStrictEqual(switchCandidates(list, 7).map((r) => r.revisionNo), [5]);
});

test("대상을 못 읽었으면 막지 않는다 — 종전 동작 그대로", () => {
  const list = [rev(9, true), rev(7, false)];
  assert.deepStrictEqual(switchCandidates(list, null).map((r) => r.revisionNo), [7]);
});

test("켤 수 없는 판은 여전히 후보가 아니다", () => {
  const list = [rev(9, false, "BUILDING"), rev(7, false, "FAILED"), rev(5, false)];
  assert.deepStrictEqual(switchCandidates(list, null).map((r) => r.revisionNo), [5]);
});

/**
 * ⚠ **두 술어의 진리표에 서로의 코드를 넣는다.** 안 넣으면 `startsWith("DRAFT")` 류로 넓히는
 *   변이가 전건 초록으로 산다 — 그러면 되돌리기 동의 코드가 안내 분기에 **조용히 삼켜져**
 *   0.14.0 이 연 동의 문이 죽는다(T5b 뒤늦은 심의가 변이로 실증).
 */
test("두 술어는 서로의 코드를 안 문다 — 겹치면 한쪽이 죽는다", () => {
  const 안내 = "DRAFT_IN_PROGRESS";
  const 동의 = "DRAFT_DISCARD_CONFIRM_REQUIRED";
  assert.strictEqual(isDraftInProgress(rejected(안내)), true);
  assert.strictEqual(isDraftInProgress(rejected(동의)), false, "안내가 동의 코드를 삼킨다");
  assert.strictEqual(needsDiscardConsent(rejected(동의)), true);
  assert.strictEqual(needsDiscardConsent(rejected(안내)), false, "동의가 안내 코드를 삼킨다");
});

// ── 반영 확인(백엔드 명세 A) ────────────────────────────────────────────────
//
// 이 판정의 급소는 **끝나는 것**이다. 「아직 반영 전」에 머무르는 상태가 하나라도 잘못 있으면 화면은
// **오지 않을 소식을 영영 기다린다**. 그래서 종료 조건 둘(unknown·superseded)을 먼저 못박는다.

type Rev = Parameters<typeof reflectionOf>[0][number];
const OBS_AT = "2026-08-25T09:00:00Z";
const obsRev = (over: Partial<Rev> = {}): Rev => ({ revisionNo: 1, isActive: false, ...over });

test("관측이 하나도 없으면 unknown — 감시를 끝낸다", () => {
    // 구 백엔드·박스 미보고·git 레인. 여기서 pending 을 내면 영원히 안 끝나는 대기가 된다.
    strictEqual(reflectionOf([obsRev({ revisionNo: 2, isActive: true })], 2), "unknown");
});

test("활성이 이미 다른 판이면 superseded — 기다리던 사건은 안 일어난다", () => {
    strictEqual(
        reflectionOf(
            [
                obsRev({ revisionNo: 3, isActive: true, isServing: false, servingObservedAt: OBS_AT }),
                obsRev({ revisionNo: 2, isServing: true, servingObservedAt: OBS_AT }),
            ],
            2,
        ),
        "superseded",
    );
});

test("그 판이 떠 있으면 reflected", () => {
    strictEqual(
        reflectionOf([obsRev({ revisionNo: 2, isActive: true, isServing: true, servingObservedAt: OBS_AT })], 2),
        "reflected",
    );
});

test("관측은 있는데 아직 그 판이 아니면 pending", () => {
    strictEqual(
        reflectionOf(
            [
                obsRev({ revisionNo: 2, isActive: true, isServing: false, servingObservedAt: OBS_AT }),
                obsRev({ revisionNo: 1, isServing: true, servingObservedAt: OBS_AT }),
            ],
            2,
        ),
        "pending",
    );
});

test("전환 중(null)은 반영이 아니다 — 아무것도 안 떠 있는 순간이다", () => {
    // `!== false` 로 느슨하게 하면 여기서 「반영됐습니다」가 뜬다. 그 순간 사이트는 비어 있다.
    strictEqual(
        reflectionOf([obsRev({ revisionNo: 2, isActive: true, isServing: null, servingObservedAt: OBS_AT })], 2),
        "pending",
    );
});

test("활성이 아직 없어도(첫 게시 직후) 관측만 있으면 기다린다", () => {
    strictEqual(reflectionOf([obsRev({ revisionNo: 2, isServing: false, servingObservedAt: OBS_AT })], 2), "pending");
});

/**
 * 🔴 **발행 본문은 `label` 뿐이다.** 서버 요청 DTO 가 `SiteDraftPublishRequest(label)` 하나이고,
 * 이 문이 지나는 가드에는 동의 층이 없다 — `DRAFT_DISCARD_CONFIRM_REQUIRED` 를 던지는 자리는
 * 「켜진 판으로 되돌리기」(`SiteRevisionActivationService`) 하나다.
 *
 * 없는 레버를 실으면 부르는 쪽이 그것으로 재시도한다. 백엔드도 같은 이유로 MCP 스키마에서 그
 * 인자를 걷고 시험으로 못박았다(`PublishConsentTest`) — 이쪽은 그 와이어를 재는 자리다.
 */
test("🔴 발행 본문은 label 뿐이다 — 없는 동의 레버를 싣지 않는다", async () => {
    let body: Record<string, unknown> = {};
    const client = api((_url, init) => {
        body = JSON.parse(String(init.body ?? "{}"));
        return Response.json({data: {revisionNo: 10, siteType: "NEXT_SOURCE", status: "BUILDING", capabilityNote: ""}});
    });

    await client.publishDraft("봄맞이");
    assert.deepEqual(Object.keys(body), ["label"], `발행 본문에 없는 필드가 실렸다: ${JSON.stringify(body)}`);

    await client.publishDraft();
    assert.deepEqual(Object.keys(body), [], `라벨 없는 발행에 필드가 실렸다: ${JSON.stringify(body)}`);
});

/**
 * 🔴 **되돌리기·버리기의 동의는 그대로 실린다** — 발행 쪽을 걷으면서 대칭인 이쪽까지 잘리면
 * 사람이 「버립니다」라고 답해도 서버가 계속 같은 동의를 다시 묻는다.
 *
 * `draftLifecycle.test.ts` 의 그물은 **대역 API** 를 보므로 실물 클라이언트의 본문 조립을 못 본다 —
 * 그 인자를 와이어에서 `false` 로 잘라도 전 게이트가 초록이었다(심의 실측). 여기가 그 자리다.
 */
test("🔴 판 전환 본문은 동의 인자를 그대로 싣는다 — 발행 쪽을 걷으며 같이 자르지 않는다", async () => {
    let body: Record<string, unknown> = {};
    const client = api((_url, init) => {
        body = JSON.parse(String(init.body ?? "{}"));
        return Response.json({data: {revisionNo: 9, siteType: "NEXT_SOURCE", status: "READY", capabilityNote: ""}});
    });

    await client.activateRevision(9, true);
    assert.deepEqual(body, {discardPendingChanges: true}, `동의가 와이어에서 사라졌다: ${JSON.stringify(body)}`);

    await client.activateRevision(9);
    assert.deepEqual(body, {discardPendingChanges: false}, "기본값이 참으로 새면 안 묻고 버린다");
});
