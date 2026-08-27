/**
 * **받은 바이트가 원장의 그 바이트인가 — 쓰기 전에 판정한다.**
 *
 * `fetchPresetZip` 은 「예제 zip 다운로드」가 지나는 유일한 문이다. 여기를 지나면 그 바이트는
 * 디스크에 파일로 남고, 그 파일은 그대로 「zip 으로 교체」의 재료가 된다 — 지금 폴더를 지우는
 * 명령이다. 그래서 이 문이 **fail-closed** 여야 한다: 대조할 수 없으면 진행하지 않는다.
 *
 * 해제 쪽 보증(반쪽 해제·고객 파일 보존)은 `importExtract.test.ts` 가 잰다 — 팩을 푸는 것은
 * 이제 「zip 으로 시작」이고, 보증은 그것이 도는 경로에서 재야 한다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import { ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createZip } from "./zip.ts";
import { fetchPresetZip } from "./presets.ts";


/** 서버 대역. sha256 을 부르는 쪽이 정할 수 있게 열어 둔다. */
function api(zip: Buffer, sha256?: string) {
    return {
        presetSourceUrl: async () => ({
            url: "http://127.0.0.1:1/preset.zip",
            version: "1.2.3",
            sha256: sha256 ?? createHash("sha256").update(zip).digest("hex"),
        }),
    } as never;
}

const serve = (zip: Buffer) => (async () => new Response(zip, { status: 200 })) as never;

test("서버가 해시를 안 주면 진행하지 않는다 — 검사가 있는 척이 없는 것보다 나쁘다", async () => {
    // ⚠ 종전 판은 `source.sha256 &&` 라 서버가 빈 값을 주면 검사가 **소멸**했는데, 주석은
    //   "중간자도 여기서 걸린다"고 강하게 적고 있었다(심의 지적).
    const zip = await createZip([{ path: "package.json", data: Buffer.from("{}") }]);
    await rejects(
        () => fetchPresetZip({ api: api(zip, ""), presetCode: "skeleton", fetchImpl: serve(zip) }),
        /무결성 해시를 주지 않아/,
    );
});

test("해시가 어긋나면 바이트를 안 돌려준다 — 부르는 쪽이 그것을 파일로 쓴다", async () => {
    const zip = await createZip([{ path: "package.json", data: Buffer.from("{}") }]);
    await rejects(
        () => fetchPresetZip({ api: api(zip, "00".repeat(32)), presetCode: "skeleton", fetchImpl: serve(zip) }),
        /원본과 다릅니다/,
    );
});

test("양성 통제군 — 맞으면 **서버가 준 바이트 그대로** 돌려준다", async () => {
    // ⚠ 다시 포장하면 위 두 시험이 지킨 sha256 이 무의미해진다. 「그대로」가 계약이다.
    const zip = await createZip([{ path: "package.json", data: Buffer.from('{"name":"ok"}') }]);
    const got = await fetchPresetZip({ api: api(zip), presetCode: "skeleton", fetchImpl: serve(zip) });

    ok(got.bytes.equals(zip), "받은 바이트가 서버가 준 것과 다르다");
    strictEqual(got.sha256, createHash("sha256").update(zip).digest("hex"));
    strictEqual(got.version, "1.2.3");
    strictEqual(got.presetCode, "skeleton");
});
