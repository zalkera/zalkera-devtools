/**
 * **반쪽 해제를 남기지 않는다 — 배송 문서가 그렇게 보증한다.**
 *
 * `media/help.md` 는 「받은 파일이 폴더 밖을 가리킵니다」 오류를 **이름까지 대며** *"아무것도 풀지
 * 않고 멈춘 것이니 폴더는 그대로입니다"* 라고 적는다. 그 보증은 두 경로를 함께 덮는다 — 예제로
 * 시작(zip · `presets.test.ts`)과 **내 사이트 받기(tar.gz · 여기)**.
 *
 * 남으면 피해가 문면에 그치지 않는다: 같은 폴더로 재시도하면 「받을 폴더가 비어 있지 않습니다」에
 * 막혀, 사용자는 무엇이 남았는지 모른 채 손으로 지워야 한다.
 */
import { match, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import { DevtoolsError } from "./errors.ts";
import { fetchSiteSource } from "./fetchSource.ts";
import { tempDir } from "./testing/tempDir.ts";

/** ustar 헤더 한 장. `../` 같은 이름을 그대로 실으려면 손으로 만들어야 한다(GNU tar 가 벗겨낸다). */
function header(name: string, size: number): Buffer {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii"); // mode
    h.write("0000000\0", 108, 8, "ascii"); // uid
    h.write("0000000\0", 116, 8, "ascii"); // gid
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii"); // mtime
    h.write("        ", 148, 8, "ascii"); // 체크섬 자리는 공백으로 두고 합을 낸다
    h.write("0", 156, 1, "ascii"); // typeflag — 일반 파일
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return h;
}

/** 폴더 항목(typeflag 5) — 빈 폴더가 받기에서 살아남는지 재는 데 쓴다. */
function dirHeader(name: string): Buffer {
    const h = header(name.endsWith("/") ? name : `${name}/`, 0);
    h.write("5", 156, 1, "ascii");
    let sum = 0;
    h.write("        ", 148, 8, "ascii");
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return h;
}

function tarGz(entries: Array<{ name: string; body: string } | { dir: string }>): Buffer {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        if ("dir" in entry) {
            blocks.push(dirHeader(entry.dir));
            continue;
        }
        const { name, body } = entry;
        const data = Buffer.from(body, "utf8");
        blocks.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024)); // 끝 표시 두 장
    return gzipSync(Buffer.concat(blocks));
}

/** 서버 대역. 해시는 실제 값을 준다 — 무결성 게이트가 해제보다 앞에 있다. */
function api(payload: Buffer) {
    return {
        // ⚠ `status` 를 준다. 백엔드는 늘 보내고, 판정(`pickRevision`)이 그것을 본다 —
        //    없는 대역으로 재면 「무엇이든 받는다」를 재게 된다.
        listRevisions: async () => [{ revisionNo: 7, status: "READY", isActive: true }],
        sourceUrl: async () => ({
            url: "http://127.0.0.1:1/source.tar.gz",
            sha256: createHash("sha256").update(payload).digest("hex"),
        }),
    } as never;
}

function serve(payload: Buffer) {
    return (async () => new Response(payload, { status: 200 })) as never;
}

test("경로 이탈 tar.gz 는 폴더를 그대로 둔다 — help.md 의 보증", async () => {
    const target = await tempDir("zalkera-src-esc-");
    // **앞 항목이 먼저 쓰인다** — 롤백이 없으면 `good.txt` 가 남는다(그것이 옛 판본의 형상).
    const payload = tarGz([
        { name: "good.txt", body: "먼저 쓰이는 파일" },
        { name: "../evil.txt", body: "탈출" },
    ]);

    await rejects(
        () => fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload) }),
        /폴더 밖|이상한 경로/,
    );
    strictEqual((await readdir(target)).length, 0, "반쪽 해제가 남았다");
});

test("양성 통제군 — 정상 tar.gz 는 그대로 풀린다", async () => {
    const target = await tempDir("zalkera-src-ok-");
    const payload = tarGz([{ name: "package.json", body: '{"name":"ok"}' }]);

    const result = await fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload) });

    strictEqual(result.revisionNo, 7);
    ok(result.fileCount >= 1);
    ok((await readdir(target)).includes("package.json"), "정상 소스가 안 풀렸다면 롤백이 과하다");
});

test("고객이 손으로 만든 것은 롤백이 지우지 않는다 — zip 쪽과 같은 규율", async () => {
    // 「빈 폴더」 판정이 `.vscode` 를 일부러 통과시키고 배송 문서가 그것을 초대한다.
    // 폴더를 통째로 지우는 롤백은 그 초대에 응한 고객의 파일을 지운다.
    const target = await tempDir("zalkera-src-keep-");
    await mkdir(join(target, ".vscode"), { recursive: true });
    await writeFile(join(target, ".vscode", "launch.json"), '{"고객이 만든 것":true}');

    const payload = tarGz([
        { name: "good.txt", body: "먼저 쓰이는 파일" },
        { name: "../evil.txt", body: "탈출" },
    ]);
    await rejects(
        () => fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload) }),
        /폴더 밖|이상한 경로/,
    );

    const left = await readdir(target);
    ok(left.includes(".vscode"), `고객의 .vscode 가 사라졌다: ${left.join(", ")}`);
    strictEqual(await readFile(join(target, ".vscode", "launch.json"), "utf8"), '{"고객이 만든 것":true}');
    ok(!left.includes("good.txt"), `반쪽 해제가 남았다: ${left.join(", ")}`);
});

test("판을 안 주면 core 판정을 쓴다 — 사본을 두면 한쪽만 고쳐진다", async () => {
  // 이 함수는 공개 API 다. 확장이 늘 `revisionNo` 를 넘겨 지금은 안 도는 길이지만, 그 길에
  // 옛 판정 사본이 있으면 CLI 가 생겼을 때 그리로 든다(심의 권고).
  const api = {
    listRevisions: async () => [
      { revisionNo: 9, status: "BUILDING", isActive: false },
      { revisionNo: 8, status: "READY", isActive: false },
    ],
    sourceUrl: async (revisionNo: number) => {
      throw new Error(`고른 판=${revisionNo}`);
    },
  };
  const err = await fetchSiteSource({
    api: api as never,
    targetDir: await tempDir("zalkera-pick-"),
  }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  // `revisions[0]` 로 때우면 BUILDING 인 9 를 고른다. READY 중 가장 큰 번호여야 한다.
  match(err?.message ?? "", /고른 판=8/);
});

test("받을 판이 하나도 없으면 「없다」의 이유를 가른다", async () => {
  const empty = {
    listRevisions: async () => [],
    sourceUrl: async () => ({ url: "x", sha256: "y" }),
  };
  const none = await fetchSiteSource({
    api: empty as never,
    targetDir: await tempDir("zalkera-none-"),
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );
  match(none?.hint ?? "", /예제 zip 다운로드/);

  const building = {
    listRevisions: async () => [{ revisionNo: 3, status: "BUILDING", isActive: false }],
    sourceUrl: async () => ({ url: "x", sha256: "y" }),
  };
  const notReady = await fetchSiteSource({
    api: building as never,
    targetDir: await tempDir("zalkera-nr-"),
  }).then(
    () => null,
    (e: unknown) => e as DevtoolsError,
  );
  match(notReady?.hint ?? "", /만들어지는 중이거나 실패/);
});

test("🔴 받기는 zip 받기·CLI 와 같은 것을 뺀다 — 서버가 보낸 `.git/config`·`.vscode`·`.env.local`·`.mcp.json` 은 디스크에 놓이지 않는다", async () => {
    const target = await tempDir("zalkera-src-drop-");
    await mkdir(join(target, ".vscode"), { recursive: true });
    await writeFile(join(target, ".vscode", "launch.json"), '{"고객이 만든 것":true}');
    const payload = tarGz([
        { name: "package.json", body: '{"name":"ok"}' },
        { name: ".env.example", body: "ZALKERA_STOREFRONT_KEY=\n" }, // 값이 빈 서식 — **실린다**(양성 짝)
        { name: ".git/config", body: "[core]\n\tfsmonitor = /tmp/evil.sh\n" },
        { name: ".git/hooks/pre-commit", body: "#!/bin/sh\nrm -rf ~\n" },
        { name: ".vscode/settings.json", body: '{"zalkera.tenant":"남의사이트"}' },
        { name: ".env.local", body: "ZALKERA_STOREFRONT_KEY=oqsk_stolen\n" },
        { name: ".mcp.json", body: '{"mcpServers":{"x":{"env":{"GITHUB_TOKEN":"ghp_x"}}}}' },
        { dir: "public/uploads" }, // 빈 폴더 — 살아남아야 한다(콘솔 zip 으로 올린 판)
        { dir: ".git" }, // 빼는 경로의 **폴더 항목** — 빈 `.git/` 도 만들지 않아야 한다(Fable 보안 변이 M23)
        { dir: ".git/hooks" },
    ]);
    const seen: string[] = [];
    const result = await fetchSiteSource({
        api: api(payload), targetDir: target, fetchImpl: serve(payload), onProgress: (m: string) => seen.push(m),
    } as never);

    strictEqual(result.fileCount, 2, "쓴 파일 수가 뺀 것을 포함해 세어졌다");
    const top = await readdir(target);
    ok(!top.includes(".git"), `.git 이 실현됐다: ${top.join(", ")}`);
    ok(!top.includes(".env.local"), ".env.local 이 실현됐다");
    ok(!top.includes(".mcp.json"), ".mcp.json 이 실현됐다");
    ok(top.includes(".env.example"), "값이 빈 서식까지 뺐다(양성 짝)");
    ok(top.includes("public"), "빈 폴더가 사라졌다");
    strictEqual((await readdir(join(target, "public"))).includes("uploads"), true, "빈 폴더 항목을 안 만들었다");
    // 고객의 `.vscode/launch.json` 은 그대로, 서버가 보낸 `settings.json` 은 없다.
    strictEqual(await readFile(join(target, ".vscode", "launch.json"), "utf8"), '{"고객이 만든 것":true}');
    ok(!(await readdir(join(target, ".vscode"))).includes("settings.json"), "서버의 .vscode/settings.json 이 놓였다");
    // 조용히 빼지 않는다 — 뺀 이름을 말한다. 폴더 항목은 세지 않는다(파일 5개).
    const said = seen.find((m) => /빼고 풀었습니다/.test(m));
    ok(said !== undefined && said.includes(".git/config"), `뺀 이름을 안 말했다: ${seen.join(" | ")}`);
    match(said!, /싣지 않는 5개는/, `폴더 항목까지 세었다: ${said}`);
});

test("받기 — 뺄 것이 없으면 「빼고 풀었습니다」를 말하지 않는다(양성 짝)", async () => {
    const target = await tempDir("zalkera-src-nodrop-");
    const payload = tarGz([{ name: "package.json", body: '{"name":"ok"}' }]);
    const seen: string[] = [];
    await fetchSiteSource({
        api: api(payload), targetDir: target, fetchImpl: serve(payload), onProgress: (m: string) => seen.push(m),
    } as never);
    ok(!seen.some((m) => /빼고 풀었습니다/.test(m)), `뺀 것이 없는데 말했다: ${seen.join(" | ")}`);
});

// ── 우리 표식뿐인 폴더 (2026-09-24 실사용 신고 · 교착) ─────────────────────────

test("표식(.zalkera/source.json)뿐인 폴더에는 받는다 — 「사이트에 연결」이 남긴 폴더가 막히지 않는다", async () => {
    const target = await tempDir("zalkera-src-mark-");
    await mkdir(join(target, ".zalkera"), { recursive: true });
    await writeFile(join(target, ".zalkera", "source.json"), '{"format":2,"origin":"linked","tenant":"b","linkedAt":"t"}');
    await mkdir(join(target, ".vscode"), { recursive: true });
    await writeFile(join(target, ".vscode", "settings.json"), '{"zalkera.tenant":"a"}');
    const payload = tarGz([
        { name: "package.json", body: '{"name":"ok"}' },
        { name: ".zalkera/pack.json", body: "{}" }, // 배송되는 .zalkera 항목
        { name: ".zalkera/provenance.json", body: "{}" }, // 정본에 안 실리는 항목 — 빠져야 한다
    ]);
    const result = await fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload) });
    strictEqual(result.revisionNo, 7);
    const left = (await readdir(target)).sort();
    ok(left.includes("package.json"), `안 풀렸다: ${left.join(", ")}`);
    ok(left.includes(".vscode"), "고객 편집기 폴더가 사라졌다");
    const inner = (await readdir(join(target, ".zalkera"))).sort();
    // 🔴 **옛 표식은 남지 않는다** — 남으면 다른 사이트(b)를 말하는 표식이 링크보다 먼저라 폴더가 b 소속으로
    //    읽히고, 판을 주장하는 표식이면 다음 발행이 거짓 「남이 올린 판」 동의를 띄운다. 새 표식은 부르는 쪽이
    //    받은 판으로 쓴다 — 그 쓰기가 실패해도 「표식 없음 → 링크가 소속」으로 떨어진다.
    ok(!inner.includes("source.json"), "옛 표식이 남았다 — 새 내용에 대해 옛 소속·옛 판을 말한다");
    ok(inner.includes("pack.json"), "배송 항목이 안 풀렸다");
    ok(!inner.includes("provenance.json"), "정본에 안 실리는 항목이 디스크에 놓였다");
});

test("표식뿐인 폴더에서 해제가 실패하면 «표식만» 남는다 — 다음 시도가 다시 막히지 않는다", async () => {
    const target = await tempDir("zalkera-src-mark-fail-");
    await mkdir(join(target, ".zalkera"), { recursive: true });
    await writeFile(join(target, ".zalkera", "source.json"), "{}");
    const payload = tarGz([
        { name: ".zalkera/pack.json", body: "{}" }, // 먼저 쓰인다 — 안쪽 되감기가 없으면 남는다
        { name: "good.txt", body: "먼저 쓰이는 파일" },
        { name: "../evil.txt", body: "탈출" },
    ]);
    await rejects(
        () => fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload) }),
        /폴더 밖|이상한 경로/,
    );
    strictEqual((await readdir(target)).join(), ".zalkera", "반쪽 해제가 남았다");
    strictEqual((await readdir(join(target, ".zalkera"))).join(), "source.json", "tar 가 쓴 .zalkera/pack.json 이 남았다");
    const { isReceivable } = await import("./emptyDir.ts");
    ok(await isReceivable(target), "되감은 폴더가 다시 「비어 있지 않음」이다 — 교착이 실패 한 번으로 되살아난다");
});

test("소스가 든 폴더면 «무엇이 있는지»와 다음 동사 «둘»을 말한다 — 네트워크 전에", async () => {
    const target = await tempDir("zalkera-src-full-");
    await writeFile(join(target, "package.json"), "{}");
    await mkdir(join(target, "src"));
    let called = 0;
    const counting = { listRevisions: async () => { called++; return []; }, sourceUrl: async () => { called++; throw new Error("x"); } } as never;
    await rejects(
        () => fetchSiteSource({ api: counting, revisionNo: 7, targetDir: target }),
        (e: unknown) => {
            ok(e instanceof DevtoolsError);
            match(e.message, /비어 있지 않습니다\(있는 것: (package\.json · src|src · package\.json)\)/);
            match(e.hint ?? "", /「사이트에 연결」/);
            match(e.hint ?? "", /「서버 판으로 교체」/);
            return true;
        },
    );
    strictEqual(called, 0, "폴더 판정 전에 네트워크를 탔다");
});

test("지난 CLI 장부가 든 폴더에 받으면 장부를 지우고 말한다 — 낡은 장부가 다음 pull 을 막지 않게", async () => {
    const target = await tempDir("zalkera-src-ledger-");
    await mkdir(join(target, ".zalkera"), { recursive: true });
    await writeFile(join(target, ".zalkera", "sync.json"), "{}");
    const payload = tarGz([{ name: "package.json", body: "{}" }]);
    const seen: string[] = [];
    await fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload), onProgress: (m) => seen.push(m) });
    ok(!(await readdir(join(target, ".zalkera"))).includes("sync.json"), "낡은 장부가 남았다");
    ok(seen.some((m) => /sync\.json/.test(m)), `조용히 지웠다: ${seen.join(" | ")}`);
    // 양성 짝 — 장부가 없던 폴더에서는 그 말을 안 한다
    const clean = await tempDir("zalkera-src-noledger-");
    const quiet: string[] = [];
    await fetchSiteSource({ api: api(payload), targetDir: clean, fetchImpl: serve(payload), onProgress: (m) => quiet.push(m) });
    ok(!quiet.some((m) => /sync\.json/.test(m)), `없는 장부를 지웠다고 말했다: ${quiet.join(" | ")}`);
});

test("소스가 없는 폴더면 「서버 판으로 교체」·「사이트에 연결」을 권하지 않는다 — 그 둘은 거기서 앞으로 못 간다", async () => {
    // `.git` 만 있는 폴더(빈 폴더에 git init) · 사람 파일만 있는 폴더 — 둘 다 소스(package.json)가 없다.
    for (const make of [
        async (d: string) => mkdir(join(d, ".git")),
        async (d: string) => writeFile(join(d, "README.md"), "x"),
    ]) {
        const target = await tempDir("zalkera-src-nosrc-");
        await make(target);
        await rejects(
            () => fetchSiteSource({ api: api(tarGz([])), revisionNo: 7, targetDir: target }),
            (e: unknown) => {
                ok(e instanceof DevtoolsError);
                match(e.message, /비어 있지 않습니다\(있는 것: /);
                ok(!/서버 판으로 교체|사이트에 연결/.test(e.hint ?? ""), `막다른 동사를 권했다: ${e.hint}`);
                match(e.hint ?? "", /빈 폴더를 새로 만들어/);
                return true;
            },
        );
    }
});

test("받은 판을 주장하던 옛 표식도 받기 뒤에 남지 않는다 — 손으로 비운 받은 폴더", async () => {
    const target = await tempDir("zalkera-src-oldfetched-");
    await mkdir(join(target, ".zalkera"), { recursive: true });
    await writeFile(
        join(target, ".zalkera", "source.json"),
        JSON.stringify({ format: 1, tenant: "a", revisionNo: 3, sha256: "x".repeat(64), fetchedAt: "t" }),
    );
    const payload = tarGz([{ name: "package.json", body: "{}" }]);
    await fetchSiteSource({ api: api(payload), targetDir: target, fetchImpl: serve(payload) });
    ok(!(await readdir(join(target, ".zalkera"))).includes("source.json"), "판 3 을 주장하는 옛 표식이 남았다");
});
