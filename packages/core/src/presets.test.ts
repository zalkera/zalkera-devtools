import { ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createZip } from "./zip.ts";
import { startFromPreset } from "./presets.ts";

/**
 * **반쪽 해제를 남기지 않는다 — 배송 문서가 그렇게 보증한다.**
 *
 * `media/help.md` 는 「받은 파일이 폴더 밖을 가리킵니다」·「항목이 너무 많습니다」 두 오류를 **이름까지
 * 대며** *"아무것도 풀지 않고 멈춘 것이니 폴더는 그대로입니다"* 라고 적는다. 그 두 오류는 **이
 * 경로(예제로 시작·zip)에서도** 난다.
 *
 * 앞 판은 형제 `fetchSource.ts`(zip 이 아니라 tar.gz) 에만 롤백을 넣어, 같은 보증이 여기서는 여전히
 * 거짓이었다(재심의 실증: `leftover=["good.txt"]`). 문서 한 문장이 두 경로를 덮으므로 시험도 둘 다 있어야 한다.
 */
async function escapingZip(): Promise<Buffer> {
    return createZip([
        { path: "good.txt", data: Buffer.from("먼저 쓰이는 파일") },
        { path: "../evil.txt", data: Buffer.from("탈출") },
    ]);
}

/** 서버 대역. 무결성 게이트(`presets.ts:67`)가 앞에 있으므로 실제 sha256 을 준다. */
function api(zip: Buffer) {
    const sha256 = createHash("sha256").update(zip).digest("hex");
    return { presetSourceUrl: async () => ({ url: "http://127.0.0.1:1/preset.zip", sha256 }) } as never;
}

test("경로 이탈 zip 은 폴더를 그대로 둔다 — help.md 의 보증", async () => {
    const target = await mkdtemp(join(tmpdir(), "zalkera-preset-esc-"));
    const zip = await escapingZip();
    await rejects(
        () =>
            startFromPreset({
                api: api(zip),
                presetCode: "skeleton",
                targetDir: target,
                fetchImpl: (async () => new Response(zip, { status: 200 })) as never,
            }),
        /폴더 밖/,
    );
    // **앞 항목이 먼저 쓰인다** — 롤백이 없으면 `good.txt` 가 남는다(그것이 옛 판본의 형상).
    strictEqual((await readdir(target)).length, 0, "반쪽 해제가 남았다");
});

test("양성 통제군 — 정상 zip 은 그대로 풀린다", async () => {
    const target = await mkdtemp(join(tmpdir(), "zalkera-preset-ok-"));
    const zip = await createZip([{ path: "package.json", data: Buffer.from('{"name":"ok"}') }]);
    const result = await startFromPreset({
        api: api(zip),
        presetCode: "skeleton",
        targetDir: target,
        fetchImpl: (async () => new Response(zip, { status: 200 })) as never,
    });
    ok(result.fileCount >= 1);
    ok((await readdir(target)).includes("package.json"));
});

test("고객이 손으로 만든 것은 롤백이 지우지 않는다 — `.vscode` 는 「빈 폴더」가 초대한 것이다", async () => {
    // ⚠ 이 시험이 없어서 손해가 났다. 기존 롤백 시험은 **빈 임시 폴더**만 써서, 판정이 일부러
    //   통과시키는 `.vscode` 가 애초에 없었다 — 그래서 폴더를 통째로 지우는 롤백이 초록으로 살았다.
    //   배송 문서는 `.vscode` 를 "있어도 괜찮습니다"라고 초대하고 "폴더는 그대로입니다"라고 보증한다.
    const target = await mkdtemp(join(tmpdir(), "zalkera-keep-"));
    await mkdir(join(target, ".vscode"), { recursive: true });
    await writeFile(join(target, ".vscode", "launch.json"), '{"고객이 만든 것":true}');
    await writeFile(join(target, ".DS_Store"), "x");

    const zip = await escapingZip();
    await rejects(
        () =>
            startFromPreset({
                api: api(zip),
                presetCode: "skeleton",
                targetDir: target,
                fetchImpl: (async () => new Response(zip, { status: 200 })) as never,
            }),
        /폴더 밖/,
    );

    const left = await readdir(target);
    ok(left.includes(".vscode"), `고객의 .vscode 가 사라졌다: ${left.join(", ")}`);
    ok(left.includes(".DS_Store"), ".DS_Store 가 사라졌다");
    strictEqual(
        await readFile(join(target, ".vscode", "launch.json"), "utf8"),
        '{"고객이 만든 것":true}',
        "고객 파일 내용이 바뀌었다",
    );
    // 그리고 **우리가 쓴 것**은 남지 않아야 한다 — 반쪽 해제 보증은 그대로다.
    ok(!left.includes("good.txt"), `반쪽 해제가 남았다: ${left.join(", ")}`);
});
