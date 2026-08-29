/**
 * **「올리는 중」 취소** — 무엇을 끊고 무엇을 끊지 않는가.
 *
 * ■ 이 설계의 전부는 **비대칭**이다
 *   `confirm` 이 판을 만든다. 나간 요청은 우리가 응답을 안 읽어도 서버가 그대로 처리하므로, 그것을
 *   끊고 「취소했습니다」라고 말하면 **서버는 판을 만들었는데 화면만 거짓**이 된다. 그래서 끊는 것은
 *   pack·presign·PUT 까지이고, `confirm` 은 **보내기 전에만** 묻고 한 번 나가면 완주시킨다.
 *
 * ■ 검사 지점이 「한 번」이 아니다
 *   `confirm` 은 동의·기반이동 갈래로 최대 세 번 나간다. 첫 발송 전만 보면 **동의 후 재발송이
 *   검사 없이** 나간다.
 *
 * ■ 409 는 취소를 존중할 **증명**이다
 *   409 가 왔다는 것은 판이 안 만들어졌다는 뜻이다. 그때 모달을 띄우면 **방금 그만두겠다고 한
 *   사람에게 「버리는 데 동의하십니까」**를 묻게 된다 — 답은 이미 나와 있다.
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
  const dir = await tempDir("zalkera-cancel-");
  await writeFile(join(dir, "package.json"), '{"name":"t","version":"1.0.0"}');
  await writeFile(join(dir, "page.tsx"), "export default () => null;\n");
  return dir;
}

/** `at` 단계에 닿는 순간 취소를 누른다 — 사람이 그 자리에서 버튼을 누른 것과 같다. */
function server(opts: { at?: "presign" | "put" | "confirm"; needsConsent?: boolean } = {}) {
  const stop = new AbortController();
  const seen: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/partner/site-archive/presign")) {
      seen.push("presign");
      if (opts.at === "presign") stop.abort();
      return new Response(
        JSON.stringify({ data: { uploadUrl: "https://s3.example.test/put", storageKey: "k/1.zip", expiresAt: "" } }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://s3.example.test/")) {
      seen.push("put");
      if (opts.at === "put") stop.abort();
      return new Response("", { status: 200 });
    }
    if (url.endsWith("/api/partner/site-archive/confirm")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push("confirm");
      if (opts.at === "confirm") stop.abort();
      if (opts.needsConsent && body.discardPendingChanges !== true) {
        return new Response(
          JSON.stringify({ errorCode: "DRAFT_DISCARD_CONFIRM_REQUIRED", message: "3건이 취소됩니다." }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({ data: { revisionNo: 12, siteType: "STATIC", status: "READY" } }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { stop, seen, fetchImpl };
}

const api = (fetchImpl: typeof fetch) =>
  new ZalkeraApi({
    apiBase: "https://api.example.test",
    accessToken: async () => "t",
    tenantCode: () => "bix",
    fetchImpl,
  });

async function run(s: ReturnType<typeof server>, extra: Record<string, unknown> = {}) {
  return publish({
    projectDir: await project(),
    api: api(s.fetchImpl),
    tenant: "bix",
    fetchImpl: s.fetchImpl,
    signal: s.stop.signal,
    ...extra,
  });
}

// ── 판이 만들어지기 전에는 끊는다 ───────────────────────────────────────────

test("presign 뒤에 그만두면 올리지 않는다", async () => {
  const s = server({ at: "presign" });
  let code = "";
  try {
    await run(s);
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  strictEqual(code, "CANCELLED");
  ok(!s.seen.includes("put"), `그만뒀는데 올렸다: ${s.seen.join("→")}`);
  ok(!s.seen.includes("confirm"), "판을 만들었다 — 취소가 무의미해진다");
});

test("전송 중에 그만두면 확인을 안 보낸다 — 여기가 되돌릴 수 있는 마지막 자리다", async () => {
  const s = server({ at: "put" });
  let code = "";
  try {
    await run(s);
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  strictEqual(code, "CANCELLED");
  ok(!s.seen.includes("confirm"), `판이 만들어졌다: ${s.seen.join("→")}`);
});

// ── 판을 만드는 문은 끊지 않는다 ────────────────────────────────────────────

test("확인이 나간 뒤에 눌렀으면 완주하고 「늦었다」를 싣는다", async () => {
  // ⚠ 여기서 끊고 「취소했습니다」라고 하면 **서버는 판을 만들었는데 화면만 거짓**이 된다.
  const s = server({ at: "confirm" });
  const result = await run(s);
  strictEqual(result.revisionNo, 12, "판은 만들어졌다");
  strictEqual(result.cancelledLate, true, "늦었다는 사실을 삼키면 부르는 쪽이 거짓을 말한다");
});

// ── 409 는 취소를 존중할 증명이다 ───────────────────────────────────────────

test("확인이 409 로 돌아오면 모달을 안 띄우고 그만둔다", async () => {
  // 판이 안 만들어졌다는 증명이다. 그런데 여기서 물으면 **방금 그만두겠다고 한 사람에게**
  // 「버리는 데 동의하십니까」를 묻는 꼴이 된다.
  const s = server({ at: "confirm", needsConsent: true });
  let asked = 0;
  let code = "";
  try {
    await run(s, { onConsent: async () => { asked += 1; return true; } });
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  strictEqual(code, "CANCELLED");
  strictEqual(asked, 0, "그만두겠다는 사람에게 동의를 물었다");
  strictEqual(s.seen.filter((x) => x === "confirm").length, 1, "재발송이 나갔다");
});

test("동의를 받은 뒤 그만두면 재발송이 안 나간다 — 검사는 매 발송 직전이다", async () => {
    // ⚠ `confirm` 은 동의·기반이동 갈래로 **최대 세 번** 나간다. 첫 발송 전만 보면 **동의 후
    //    재발송이 검사 없이** 나가고, 그러면 그만두겠다고 한 사람의 판이 만들어진다.
    const s = server({ needsConsent: true });
    let code = "";
    try {
        await run(s, {
            // 모달에서 동의는 했는데, 그 사이(또는 그 직후) 진행 자체를 그만뒀다.
            onConsent: async () => {
                s.stop.abort();
                return true;
            },
        });
    } catch (e) {
        code = (e as { code?: string }).code ?? "";
    }
    strictEqual(code, "CANCELLED");
    strictEqual(
        s.seen.filter((x) => x === "confirm").length,
        1,
        "재발송이 나갔다 — 그만둔 사람의 판이 만들어진다",
    );
});

test("취소가 없으면 종전 그대로다", async () => {
  const s = server();
  const result = await run(s);
  strictEqual(result.revisionNo, 12);
  ok(!("cancelledLate" in result), "취소 안 했는데 늦었다고 말했다");
});

// ── 실 소켓 ────────────────────────────────────────────────────────────────
//
// ⚠ **위 시험들의 모의 `fetchImpl` 은 `init.signal` 을 안 본다.** 그래서 「전송 중 취소」가
//    사실은 PUT 을 완주시킨 뒤 **그 뒤 검사점**에 걸려 초록이었다 — 취소 기계(`anySignal`·
//    `fetchWithCancel`) 자체는 한 줄도 안 물렸다. 심의 실측: 아래 네 변이가 전건 초록이었다.
//
//      ⑴ `anySignal` 이 사용자 신호를 버림 → 눌러도 100MB 가 다 나갈 때까지 안 멈춘다
//      ⑵ `fetchWithCancel` 을 생 `fetchImpl` 로 통과 → 생 `AbortError` 가 빨간창이 된다
//      ⑶ 타임아웃을 무조건 취소로 접음 → 15분 상한을 「취소했습니다」로 보고한다
//      ⑷ `addEventListener` 두 줄 삭제 → 합성 자체가 불능
//
//    ⑴⑵⑷ 는 **진짜 소켓이라야** 잡힌다(신호를 존중하는 fetch 가 있어야 차이가 난다). ⑶ 은
//    상한이 15분 상수라 소켓으로는 못 만들므로, PUT 이 `TimeoutError` 로 깨지는 자리를 따로 둔다.
//
// 재현: `npm test -w @zalkera/devtools-core`

/** 루프백 HTTP 서버. PUT 을 받는 **즉시** 취소를 눌러 응답을 붙든다 — 타이머가 없어 안 흔들린다. */
async function socketServer(opts: { holdMs?: number } = {}) {
  const { createServer } = await import("node:http");
  const stop = new AbortController();
  const seen: string[] = [];
  let sawCut = (): void => {};
  /** 서버가 **응답을 쓰기 전에** 연결이 죽는 것을 본 순간 참이 된다. */
  const cut = new Promise<boolean>((resolve) => {
    sawCut = () => resolve(true);
  });
  const send = (res: import("node:http").ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    req.resume();
    if (url.endsWith("/site-archive/presign")) {
      seen.push("presign");
      req.on("end", () =>
        send(res, {
          data: { uploadUrl: `${base}/put`, storageKey: "k/1.zip", expiresAt: "" },
        }),
      );
      return;
    }
    if (url.endsWith("/put")) {
      seen.push("put");
      // ⚠ **끊겼다는 증거를 서버가 든다.** 「취소로 접혔다」만 보면 안 된다 — 신호가 안 닿아
      //    전송이 완주해도 **PUT 뒤 검사점**이 받아서 똑같이 `CANCELLED` 가 나온다(실측: 이
      //    시험의 첫 판이 `anySignal` 변이를 놓쳤다). 소켓이 응답 전에 죽는 것이 유일한 증거다.
      res.on("close", () => {
        if (!res.writableEnded) sawCut();
      });
      // 클라이언트는 지금 **응답을 기다리는 중**이다 — 여기서 누르는 것이 「전송 중 취소」다.
      stop.abort();
      setTimeout(() => {
        if (!res.writableEnded) send(res, {});
      }, opts.holdMs ?? 5000).unref();
      return;
    }
    if (url.endsWith("/site-archive/confirm")) {
      seen.push("confirm");
      req.on("end", () => send(res, { data: { revisionNo: 12, siteType: "STATIC", status: "READY" } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    stop,
    seen,
    base,
    /** 마감 안에 끊김을 못 봤으면 거짓 — 매달린 채로 시험이 안 끝나게 한다. */
    async cutWithin(ms: number): Promise<boolean> {
      let t: NodeJS.Timeout;
      const deadline = new Promise<boolean>((r) => {
        t = setTimeout(() => r(false), ms);
      });
      return await Promise.race([cut, deadline]).finally(() => clearTimeout(t!));
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("실 소켓 — 전송 중에 그만두면 끊기고 확인이 안 나간다", async () => {
  const s = await socketServer();
  try {
    let code = "";
    let name = "";
    try {
      await publish({
        projectDir: await project(),
        api: new ZalkeraApi({
          apiBase: s.base,
          accessToken: async () => "t",
          tenantCode: () => "bix",
          fetchImpl: fetch,
        }),
        tenant: "bix",
        fetchImpl: fetch,
        signal: s.stop.signal,
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      name = (e as Error).name;
    }
    strictEqual(code, "CANCELLED", `취소로 안 접혔다(name=${name}) — 흐름 ${s.seen.join("→")}`);
    ok(s.seen.includes("put"), `PUT 에 닿지도 않았다: ${s.seen.join("→")}`);
    ok(!s.seen.includes("confirm"), `판이 만들어졌다: ${s.seen.join("→")}`);
    // ⚠ **이 줄이 취소 기계를 무는 유일한 자리다.** 위 셋은 신호가 한 줄도 안 닿아도 참이 된다.
    ok(await s.cutWithin(1000), "전송이 안 끊겼다 — 눌러도 바이트는 끝까지 나갔다(신호가 안 닿는다)");
  } finally {
    await s.close();
  }
});

test("상한으로 끊긴 것은 취소가 아니다 — 15분을 「그만뒀습니다」로 보고하지 않는다", async () => {
  // ⚠ 사람은 **아무것도 안 눌렀다.** 여기서 취소로 접으면 진짜 실패가 조용히 삼켜진다.
  const s = server();
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    if (String(input).startsWith("https://s3.example.test/")) {
      s.seen.push("put");
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return s.fetchImpl(input as URL, init);
  }) as typeof fetch;
  let code = "";
  let name = "";
  try {
    await publish({
      projectDir: await project(),
      api: api(fetchImpl),
      tenant: "bix",
      fetchImpl,
    });
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
    name = (e as Error).name;
  }
  strictEqual(name, "TimeoutError", "상한 실패의 정체가 바뀌었다");
  ok(code !== "CANCELLED", "상한으로 끊긴 것을 사람이 그만둔 것으로 보고했다");
  ok(!s.seen.includes("confirm"), "전송이 깨졌는데 판을 만들었다");
});
