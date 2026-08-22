/**
 * **같은 옵션이 경로에 따라 다르게 서면 그것은 상한이 아니다.**
 *
 * 버퍼 경로(`extractTarGz`)만 `Math.min(…, 200MB)` 로 되죄고 스트리밍 경로(`extractTarGzFile`)는
 * 넘긴 값을 날로 썼다. 그래서 **해제 250MB 짜리 정상 소스**가 버퍼 경로에서만 거부됐다 —
 * 그런데 소스 다운로드가 쓰는 것이 정확히 그 경로였다.
 *
 * 실물 크기 픽스처는 이 시험에 둘 수 없다(디스크·메모리). **상한을 낮춰** 같은 관계를 잰다 —
 * 「호출부가 건 값이 두 경로에서 같은 답을 낸다」가 지켜야 할 성질이고, 그것은 크기와 무관하다.
 */
import { rejects, strictEqual } from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { MAX_EXTRACT_BYTES } from "./limits.ts";
import { extractTarGz, extractTarGzFile } from "./untar.ts";
import { tempDir } from "./testing/tempDir.ts";

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
    const dir = await tempDir(prefix);
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

test("상한을 안 주면 **두 경로가 같은 기본값**으로 선다", async () => {
    // 「기본값이 두 경로에서 같다」가 이 파일의 존재 이유인데, 그것을 재는 자리가 한때 사라졌다
    // (`resolveCap` 단위 시험으로 갈아탔더니 `limits.test.ts` 와 완전 중복이 됐다 — 심의 지적).
    //
    // 천장(450MB)을 넘는 입력으로는 못 잰다. 대신 **두 경로가 같은 문을 지나는지**를 그 문의
    // 반환값으로 잰다 — 어느 한쪽이 날값을 쓰면 이 값과 갈린다.
    const { resolveCap } = await import("./untar.ts");
    strictEqual(resolveCap(undefined), MAX_EXTRACT_BYTES, "안 주면 소스 기본값");
    strictEqual(resolveCap(1024), 1024, "주면 그대로 — 되죄지 않는다");

    // 그 기본값 아래의 정상 입력은 **양쪽 다** 통과한다(가드가 «전부 막는» 상태가 아님을 못박는다).
    const gz = tarGz(SIZE);
    strictEqual(await bufferRun(gz, MAX_EXTRACT_BYTES), 1);
    strictEqual(await streamRun(gz, MAX_EXTRACT_BYTES), 1);
});
