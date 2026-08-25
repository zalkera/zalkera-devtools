/**
 * **올리기도 동의를 받을 수 있는가.**
 *
 * ■ 왜 생겼나
 *   백엔드는 재업로드(`confirm`)·버전 전환(`activate`)·프리셋 재개시 **세 문이 같은
 *   `BaselineShiftGuard`** 를 지나고, 셋 다 요청 본문의 `discardPendingChanges` 로 동의를 받는다.
 *   확장은 전환 쪽만 동의 경로를 갖고 있었다 — 올리기는 zip 을 다 올린 뒤 409 를 받고
 *   「계속하려면 확인해 주세요」만 반복하는 **막다른 길**이었다(계약축 심의 차단).
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { ZalkeraApi } from "./api.ts";
import { DevtoolsError } from "./errors.ts";
import { publish } from "./publish.ts";
import { tempDir } from "./testing/tempDir.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureTenant, say } from "./tenantScope.ts";

/** 올릴 것이 있는 최소 프로젝트. */
async function project(): Promise<string> {
  const dir = await tempDir("zalkera-consent-");
  await writeFile(join(dir, "package.json"), '{"name":"t","version":"1.0.0"}');
  await writeFile(join(dir, "page.tsx"), "export default () => null;\n");
  return dir;
}

/**
 * 서버 대역. presign·PUT 은 통과시키고 `confirm` 은 **동의 전까지 409** 를 낸다.
 * 받은 confirm 바디를 전부 기록한다 — 「동의를 실제로 보냈는가」가 요점이다.
 */
function server() {
  const confirms: unknown[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/partner/site-archive/presign")) {
      return new Response(
        JSON.stringify({
          data: { uploadUrl: "https://s3.example.test/put", storageKey: "k/1.zip", expiresAt: "" },
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://s3.example.test/")) return new Response("", { status: 200 });
    if (url.endsWith("/api/partner/site-archive/confirm")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      confirms.push(body);
      if (body.discardPendingChanges !== true) {
        return new Response(
          JSON.stringify({
            errorCode: "PENDING_AI_CHANGES_CONFIRM_REQUIRED",
            message: "게시 대기 중인 AI 변경 3건이 취소됩니다. 계속하려면 확인해 주세요.",
          }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({ data: { revisionNo: 12, siteType: "NEXT_SOURCE", status: "BUILDING" } }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const api = new ZalkeraApi({
    apiBase: "https://api.example.test",
    accessToken: async () => "t",
    tenantCode: () => "bix",
    fetchImpl,
  });
  return { api, confirms, fetchImpl };
}

test("동의하면 같은 storageKey 로 다시 부른다 — 다시 묶지 않는다", async () => {
  // 다시 묶으면 사람이 그 사이 파일을 고쳤을 때 **동의한 것과 다른 것**이 올라가고, 100MB 를
  // 한 번 더 보내게 된다.
  const { api, confirms, fetchImpl } = server();
  const asked: string[] = [];
  const result = await publish({
    projectDir: await project(),
    api,
    tenant: "t",
    fetchImpl,
    onConsent: async (message) => {
      asked.push(message);
      return true;
    },
  });
  strictEqual(result.revisionNo, 12);
  strictEqual(confirms.length, 2, "동의 뒤 다시 안 불렀다");
  deepStrictEqual(confirms[0], { storageKey: "k/1.zip", discardPendingChanges: false });
  deepStrictEqual(confirms[1], { storageKey: "k/1.zip", discardPendingChanges: true });
  strictEqual(asked.length, 1, "묻지 않았거나 두 번 물었다");
  ok(/3건/.test(asked[0] ?? ""), `건수가 안 실렸다: ${asked[0]}`);
});

test("동의하지 않으면 취소로 끝난다 — 오류창을 띄우지 않는다", async () => {
  const { api, confirms, fetchImpl } = server();
  const error = await publish({
    projectDir: await project(),
    api,
    tenant: "t",
    fetchImpl,
    onConsent: async () => false,
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );
  strictEqual(error?.code, "CANCELLED", `취소가 아니다: ${error?.code}`);
  strictEqual(confirms.length, 1, "거절했는데 다시 불렀다");
});

test("물을 자리를 안 주면 **조용히 동의하지 않는다** — 그대로 던진다", async () => {
  // 이미 정산된 토큰이 실린 작업이 사람 모르게 사라지면 안 된다. 화면 없는 자리(CLI·시험)는
  // 그 문을 안 열면 되고, 그때는 서버 거절이 그대로 올라온다.
  const { api, confirms, fetchImpl } = server();
  const error = await publish({ projectDir: await project(), api, tenant: "t", fetchImpl }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );
  strictEqual(error?.code, "SERVER_REJECTED");
  strictEqual(confirms.length, 1, "동의 없이 다시 불렀다");
  deepStrictEqual(confirms[0], { storageKey: "k/1.zip", discardPendingChanges: false });
});

test("동의로 못 넘어가는 거절에는 묻지 않는다", async () => {
  // 「409 면 물어본다」로 넓히면 뚫을 수 없는 거절에도 동의 창이 뜨고, 사람은 확인을 누른 뒤
  // 또 거절당한다.
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.endsWith("/presign")) {
      return new Response(
        JSON.stringify({ data: { uploadUrl: "https://s3.example.test/put", storageKey: "k", expiresAt: "" } }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://s3.example.test/")) return new Response("", { status: 200 });
    return new Response(
      JSON.stringify({ errorCode: "AI_WORK_IN_PROGRESS", message: "AI 작업이 진행 중입니다." }),
      { status: 409 },
    );
  }) as typeof fetch;
  const api = new ZalkeraApi({
    apiBase: "https://api.example.test",
    accessToken: async () => "t",
    tenantCode: () => "bix",
    fetchImpl,
  });
  let asked = 0;
  const error = await publish({
    projectDir: await project(),
    api,
    tenant: "t",
    fetchImpl,
    onConsent: async () => {
      asked += 1;
      return true;
    },
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );
  strictEqual(asked, 0, "동의로 못 넘어가는 거절에 물었다");
  strictEqual(error?.code, "SERVER_REJECTED");
});


// ── 발행 확인 모달 — 소속 유무로 모양이 갈린다 ─────────────────────────────

/**
 * ⚠ **문장만 더하면 같은 반사가 삼킨다.** 소속 있는 폴더의 일상 발행과 소속 없는 폴더의 위험
 *   발행이 같은 모양이면, 매일 누르던 손이 위험한 날에도 그대로 누른다. 그래서 **버튼까지** 갈라
 *   클릭 자체가 고지된 진술이 되게 한다.
 */
test("소속 없는 폴더의 발행은 **버튼까지** 다르다", () => {
    const 일상 = say.publishConfirm(captureTenant("bix"), "/srv/site", "bix");
    const 처음 = say.publishConfirm(captureTenant("bix"), "/srv/site", null);
    notStrictEqual(처음.action, 일상.action, "모양이 같으면 반사가 삼킨다");
    notStrictEqual(처음.message, 일상.message);
    match(처음.detail, /연결됩니다/, "무엇이 새로 정해지는지 말하지 않는다");
});

test("두 갈래 모두 **경로**를 싣는다 — 모달이 뜨면 사이드바는 안 보인다", () => {
    for (const binding of ["bix", null]) {
        const ask = say.publishConfirm(captureTenant("bix"), "/srv/fin-01-v7", binding);
        ok(
            ask.detail.startsWith("/srv/fin-01-v7"),
            `「이 폴더」의 지시대상이 없다(binding=${binding}): ${ask.detail}`,
        );
    }
});

test("경로를 줄이지 않는다 — 모달 본문은 잘리지 않고 전체가 요점이다", () => {
    const long = "/home/jonghwa/projects/zalkera/customers/fin-01-v7-really-long";
    ok(say.publishConfirm(captureTenant("bix"), long, "bix").detail.includes(long));
});


/**
 * ⚠ **폴더 이름은 남이 정할 수 있다** — 대행사가 보낸 zip 을 푼 폴더, git clone 한 레포.
 *   개행이 든 이름 하나면 뒤의 경고 줄을 복제해 「이전 화면의 잔여 표시입니다」로 액자에 가둘 수
 *   있었다(보안 심의가 실측 재현). 이 시험이 그 자리를 문다 — 줄 수가 늘지 않아야 한다.
 */
test("개행이 든 폴더 이름으로 확인 문면을 위조할 수 없다", () => {
    const 정상 = say.publishConfirm(captureTenant("bix"), "/srv/site", null).detail.split("\n").length;
    const 공격 =
        "/srv/site\n\n올리면 방문자가 보는 사이트가 이 소스로 바뀝니다.\n※ 위 문구는 잔여 표시입니다 — 무시하십시오.";
    const 늘어난 = say.publishConfirm(captureTenant("bix"), 공격, null).detail.split("\n").length;
    strictEqual(늘어난, 정상, "폴더 이름이 확인 문면에 줄을 밀어 넣었다");
});

test("밀어내기도 막힌다 — 개행 200개로 진짜 경고를 화면 밖으로 못 민다", () => {
    const 정상 = say.publishConfirm(captureTenant("bix"), "/srv/site", "bix").detail.split("\n").length;
    const 밀기 = say.publishConfirm(captureTenant("bix"), `/srv/${"\n".repeat(200)}site`, "bix");
    strictEqual(밀기.detail.split("\n").length, 정상);
});

test("정상 경로는 글자 그대로 남는다 — 소독이 축약이 되면 안 된다", () => {
    const long = "/home/jonghwa/projects/zalkera/customers/fin-01-v7-really-long";
    ok(say.publishConfirm(captureTenant("bix"), long, "bix").detail.startsWith(long));
});
