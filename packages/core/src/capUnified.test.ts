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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
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

async function bufferRun(gz: Buffer, maxBytes: number): Promise<number> {
    return extractTarGz(gz, await mkdtemp(join(tmpdir(), "cap-b-")), { maxBytes });
}

async function streamRun(gz: Buffer, maxBytes: number): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "cap-s-"));
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

test("상한을 안 주면 기본값이 서고, 그 기본값은 두 경로가 같다", async () => {
    // 종전에는 버퍼 200MB · 스트리밍 무제한이었다. 작은 정상 입력이 둘 다 통과하는 것으로 확인한다.
    const gz = tarGz(SIZE);
    strictEqual(await bufferRun(gz, Number.POSITIVE_INFINITY), 1);
    strictEqual(await streamRun(gz, Number.POSITIVE_INFINITY), 1);
});
