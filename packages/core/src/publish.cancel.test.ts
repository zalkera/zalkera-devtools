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
          JSON.stringify({ errorCode: "PENDING_AI_CHANGES_CONFIRM_REQUIRED", message: "3건이 취소됩니다." }),
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
