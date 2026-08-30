/**
 * **올리기의 `confirm` 이 거절을 어떻게 받는가**, 그리고 **발행 확인 모달의 문면**.
 *
 * ■ 이 문은 동의를 안 묻는다
 *   요청 DTO 가 `storageKey` + `baseRevisionNo` 뿐이고(`SiteArchiveConfirmRequest`), 지나는
 *   가드(`BaselineShiftGuard`)는 전부 거절형이다 — 레포 연결·게시 진행 중·AI 작업 중·편집 중.
 *   동의로 넘어가는 층이 없다. 그래서 여기서 다시 물을 수 있는 것은 **기반 이동** 하나다.
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
  const dir = await tempDir("zalkera-confirm-");
  await writeFile(join(dir, "package.json"), '{"name":"t","version":"1.0.0"}');
  await writeFile(join(dir, "page.tsx"), "export default () => null;\n");
  return dir;
}

test("뚫을 수 없는 거절은 그대로 던진다 — 재시도 루프에 안 걸린다", async () => {
  // 「409 면 다시 부른다」로 넓히면 뚫을 수 없는 거절에서 같은 요청이 되풀이된다.
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
    onBaseMoved: async () => {
      asked += 1;
      return true;
    },
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );
  strictEqual(asked, 0, "다시 물을 수 없는 거절에 물었다");
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


/**
 * 🔴 **결과를 모르는 실패를 「안 만들어졌다」로 접지 않는다**(설계자 심의 0.17.0).
 *
 * `confirm` 이 나간 뒤 응답이 유실되면(`SERVER_UNREACHABLE` — 30초 상한·연결 유실) 그것은
 * **판이 만들어졌는지 모르는** 사건이다. 취소 중이라고 그것을 `CANCELLED` 로 접으면 화면이
 * 「새 버전은 만들어지지 않았습니다」라고 **단정**한다.
 *
 * 서버가 만들었었다면 표식은 옛 판인 채라 다음 발행이 **자기 유령 판**에 409 를 맞는다 —
 * 이 판이 사냥한 「제조된 거짓말」 그 얼굴이다. 취소 버튼은 confirm 이 **느릴 때** 눌리는 것이라
 * 이 창은 우연히 겹치는 창이 아니다.
 */
test("🔴 confirm 응답이 유실되면 취소 중이어도 **모른다고 말한다** — CANCELLED 로 접지 않는다", async () => {
  const controller = new AbortController();
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
      confirms.push(JSON.parse(String(init?.body ?? "{}")));
      // confirm 은 **나갔다**. 그 뒤에 사람이 취소를 누르고 연결이 끊긴다 — 서버가 무엇을 했는지
      // 우리는 모른다.
      controller.abort();
      throw new TypeError("fetch failed");
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const api = new ZalkeraApi({
    apiBase: "https://api.example.test",
    accessToken: async () => "t",
    tenantCode: () => "bix",
    fetchImpl,
  });
  const error = await publish({
    projectDir: await project(),
    api,
    tenant: "t",
    fetchImpl,
    signal: controller.signal,
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );

  strictEqual(confirms.length, 1, "confirm 이 안 나갔다 — 이 시험의 전제가 성립 안 함");
  notStrictEqual(error?.code, "CANCELLED", "결과를 모르는 실패를 취소라고 단정했다");
  strictEqual(error?.code, "SERVER_UNREACHABLE", `모호를 그대로 안 올렸다: ${error?.code}`);
});

/**
 * 반대편도 지킨다 — **판이 안 만들어졌다는 증명이 있는 거절**(409 계열)에서는 취소를 존중한다.
 * 그것까지 던지면 그만두겠다고 한 사람에게 서버 오류창이 뜬다.
 *
 * ⚠ 취소는 **실행 중에** 걸려야 한다. `await` 뒤에 `abort()` 를 부르면 이 시험은 콜백이 던진
 *   것으로 초록이 되어, 취소 의미를 하나도 안 잰다(초판이 그랬다).
 */
test("409 계열에서는 취소를 존중한다 — 판이 안 만들어졌다는 증명이 있다", async () => {
  const controller = new AbortController();
  let asked = 0;
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
      confirms.push(JSON.parse(String(init?.body ?? "{}")));
      // 서버가 **판을 만들기 전에** 409 로 막았고, 그 응답이 오는 사이 사람이 취소를 눌렀다.
      controller.abort();
      return new Response(
        JSON.stringify({
          errorCode: "UPLOAD_BASE_MOVED",
          message: "올리는 사이 버전 9 가 올라왔습니다 — 이 올리기에는 그 변경이 담겨 있지 않습니다.",
        }),
        { status: 409 },
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
  const error = await publish({
    projectDir: await project(),
    api,
    tenant: "t",
    fetchImpl,
    signal: controller.signal,
    baseRevisionNo: 5,
    onBaseMoved: async () => {
      asked += 1;
      return true;
    },
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );

  strictEqual(confirms.length, 1, "취소했는데 다시 보냈다");
  strictEqual(asked, 0, "그만두겠다고 한 사람에게 「그대로 올릴까요」를 물었다");
  strictEqual(error?.code, "CANCELLED", `증명된 거절인데 취소로 안 접었다: ${error?.code}`);
});
