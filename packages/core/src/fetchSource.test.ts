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

function tarGz(entries: Array<{ name: string; body: string }>): Buffer {
    const blocks: Buffer[] = [];
    for (const { name, body } of entries) {
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
