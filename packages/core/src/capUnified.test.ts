/**
 * **같은 옵션이 경로에 따라 다르게 서면 그것은 상한이 아니다.**
 *
 * 버퍼 경로(`extractTarGz`)만 `Math.min(…, 200MB)` 로 되죄고 스트리밍 경로(`extractTarGzFile`)는
 * 넘긴 값을 날로 썼다. 그래서 **해제 250MB 짜리 정상 소스**가 버퍼 경로에서만 거부됐다 —
 * 그런데 사이트 소스 받기가 쓰는 것이 정확히 그 경로였다.
 *
 * 실물 크기 픽스처는 이 시험에 둘 수 없다(디스크·메모리). **상한을 낮춰** 같은 관계를 잰다 —
 * 「호출부가 건 값이 두 경로에서 같은 답을 낸다」가 지켜야 할 성질이고, 그것은 크기와 무관하다.
 */
import { rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { MAX_EXTRACT_BYTES } from "./limits.ts";
import { extractTarGz, extractTarGzFile } from "./untar.ts";

function header(name: string, size: number): Buffer {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h.write("0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return h;
}

/** 유한 픽스처. 가드를 재는 시험이 가드가 막으려는 손해(디스크 폭탄)를 내면 안 된다. */
function tarGz(bytes: number): Buffer {
    const data = Buffer.alloc(bytes, 0x41);
    return gzipSync(Buffer.concat([header("payload.bin", bytes), data, Buffer.alloc((512 - (bytes % 512)) % 512), Buffer.alloc(1024)]));
}

const SIZE = 256 * 1024;

/** ⚠ **지우고 끝낸다.** 임시 디렉터리가 tmpfs 인 환경이 흔하고, 이 파일 자신이 「가드를 재는
 *  시험이 가드가 막으려는 손해를 내면 안 된다」고 적는다. 실행마다 6개씩 새는 것을 심의가 셌다. */
const made: string[] = [];
after(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function scratch(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}

async function bufferRun(gz: Buffer, maxBytes: number): Promise<number> {
    return extractTarGz(gz, await scratch("cap-b-"), { maxBytes });
}

async function streamRun(gz: Buffer, maxBytes: number): Promise<number> {
    const dir = await scratch("cap-s-");
    const gzPath = join(dir, "in.tar.gz");
    await writeFile(gzPath, gz);
    return extractTarGzFile(gzPath, dir, join(dir, ".scratch"), { maxBytes });
}

test("상한 위 — 두 경로가 **함께** 통과한다", async () => {
    const gz = tarGz(SIZE);
    strictEqual(await bufferRun(gz, SIZE * 4), 1);
    strictEqual(await streamRun(gz, SIZE * 4), 1);
});

test("상한 아래 — 두 경로가 **함께** 거부한다", async () => {
    const gz = tarGz(SIZE);
    await rejects(() => bufferRun(gz, 1024));
    await rejects(() => streamRun(gz, 1024));
});

test("호출부가 준 상한을 **되죄지 않는다** — 페이로드는 자기 입력에서 유도한다", async () => {
    // 마감 심의 차단: 소스 천장(450MB)으로 모든 호출부를 되죄자, 실측 158MB 페이로드가 요구하는
    // 1264MB 가 450MB 로 깎여 **정상 페이로드 해제가 항상 실패**했다. 조용한 고장이었다 —
    // `tryFetchPayload` 가 `null` 로 수렴해 「가속기가 영영 안 켜지는」 모습으로만 나타난다.
    //
    // 천장을 넘는 실물 입력으로는 못 잰다(수백 MB 픽스처). `resolveCap` 의 **계약**을 직접 잰다.
    const { resolveCap } = await import("./untar.ts");
    const asks = 158 * 1024 * 1024 * 8;
    strictEqual(resolveCap(asks), asks, "호출부가 준 상한을 되죄면 안 된다");
    strictEqual(resolveCap(undefined), MAX_EXTRACT_BYTES, "안 주면 소스 기본값이 선다");
    strictEqual(resolveCap(1024), 1024, "좁게 주면 그대로 선다");
});
