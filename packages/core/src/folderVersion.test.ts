/**
 * **「이 폴더」 예측이 서버가 저장할 목록과 맞는가**(memo191).
 *
 * 🔴 이 시험이 없을 때 두 결함이 3축 심의까지 살아남았다:
 *   ⑴ 포장기가 `.zalkera/provenance.json` 을 **새로 만들어 넣는데** 예측이 그것을 안 셌다 →
 *      devtools 로 발행하면 **성공 직후부터 영구히 「다름」**.
 *   ⑵ 서버만 `.github/workflows/` 를 뺀다 → 그 둘을 싣는 **시작 소스 팩 20종**으로 시작한 폴더는
 *      **첫 화면부터 「다름」**.
 * 둘 다 규칙 시험·골든 벡터는 통과했다. **한 구현 안에서만** 접었기 때문이다.
 *
 * 그래서 여기서는 **진짜 포장기가 만든 zip 을 풀어** 서버가 볼 목록을 만들고, 그것과 예측을 견준다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {folderVersionDigest} from "./folderVersion.ts";
import {serverExcluded} from "./serverNormalization.ts";
import {sourceVersionDigest, unwrapSingleRoot} from "./sourceVersion.ts";
import {packProject} from "./zip.ts";
import {extractZip} from "./unzip.ts";

const TENANT = "acme";

async function put(root: string, rel: string, text: string): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, ".."), {recursive: true});
    await writeFile(full, text, "utf8");
}

/** 서버가 저장할 목록의 지문 — 실제 zip 을 풀어 서버 순서(언랩 → 배제)대로 접는다. */
async function serverSideDigest(zip: Buffer): Promise<string | null> {
    const out = await mkdtemp(join(tmpdir(), "zalkera-srv-"));
    try {
        await extractZip(zip, out);
        const found: {path: string; sha256: string}[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
            for (const item of await readdir(dir, {withFileTypes: true})) {
                const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
                if (item.isDirectory()) await walk(join(dir, item.name), rel);
                else if (item.isFile()) {
                    const bytes = await readFile(join(dir, item.name));
                    found.push({path: rel, sha256: createHash("sha256").update(bytes).digest("hex")});
                }
            }
        };
        await walk(out, "");
        // 서버 순서: 래퍼를 **배제 전 목록**으로 판정한 뒤 배제한다.
        const unwrapped = unwrapSingleRoot(found.map((f) => f.path));
        const kept = found
            .map((f, i) => ({path: unwrapped[i]!, sha256: f.sha256}))
            .filter((f) => !serverExcluded(f.path));
        return sourceVersionDigest(kept);
    } finally {
        await rm(out, {recursive: true, force: true});
    }
}

async function withFolder(
    files: Record<string, string>,
    run: (dir: string) => Promise<void>,
): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-fv-"));
    try {
        for (const [rel, text] of Object.entries(files)) await put(dir, rel, text);
        await run(dir);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

const SITE = {
    "index.html": "<h1>hello</h1>",
    "assets/app.css": "body{margin:0}",
    "package.json": '{"name":"site"}',
};

test("예측이 서버가 저장할 목록과 같다 — 평범한 사이트", async () => {
    await withFolder(SITE, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

/** 🔴 ⑴ — 포장기가 넣는 출처 표시. 안 세면 발행 성공 직후부터 영구히 「다름」이 된다. */
test("포장기가 주입하는 출처 표시를 예측이 센다", async () => {
    await withFolder(SITE, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.ok(
            (await import("./unzip.ts")).listZipEntries(packed.buffer).includes(".zalkera/provenance.json"),
            "포장기가 출처 표시를 안 넣었다 — 이 시험의 전제가 사라졌다",
        );
        // 표시를 안 센 예측(연결 안 된 폴더 취급)은 **달라야** 한다 — 그래야 이 축이 load-bearing 이다.
        assert.notEqual(await folderVersionDigest(dir, null), await serverSideDigest(packed.buffer));
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

/** 🔴 ⑵ — 시작 소스 팩 20종이 싣는 파일. 서버만 뺀다. */
test("서버만 빼는 `.github/workflows/` 를 예측도 뺀다 — 시작 팩이 그 형상이다", async () => {
    const withWorkflows = {
        ...SITE,
        ".github/workflows/ci.yml": "on: push",
        ".github/workflows/client-upgrade.yml": "on: schedule",
    };
    await withFolder(withWorkflows, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.ok(
            (await import("./unzip.ts")).listZipEntries(packed.buffer).some((n) => n.startsWith(".github/")),
            "포장기가 워크플로를 안 실었다 — 이 시험의 전제가 사라졌다",
        );
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

test("워크플로만 다른 두 폴더는 같은 판이다 — 서버가 안 저장하기 때문", async () => {
    let plain: string | null = null;
    await withFolder(SITE, async (dir) => {
        plain = await folderVersionDigest(dir, TENANT);
    });
    await withFolder({...SITE, ".github/workflows/ci.yml": "on: push"}, async (dir) => {
        assert.equal(await folderVersionDigest(dir, TENANT), plain);
    });
});

test("서버만 빼는 자격증명 확장자도 예측이 뺀다", async () => {
    const files = {...SITE, "infra/terraform.tfstate": "{}", "keys/app.jks": "x", "vpn/office.ovpn": "y"};
    await withFolder(files, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

test("내용이 바뀌면 예측도 바뀐다 — 배제가 전부를 삼키지 않는다", async () => {
    let before: string | null = null;
    await withFolder(SITE, async (dir) => {
        before = await folderVersionDigest(dir, TENANT);
    });
    await withFolder({...SITE, "index.html": "<h1>bye</h1>"}, async (dir) => {
        assert.notEqual(await folderVersionDigest(dir, TENANT), before);
    });
});

test("값이 든 서식은 포장기가 떨구고 예측도 떨군다", async () => {
    const files = {...SITE, ".env.example": "TOSS_SECRET_KEY=live_sk_abcdefghijklmnop\n"};
    await withFolder(files, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

test("빈 폴더는 모름이다", async () => {
    await withFolder({}, async (dir) => {
        assert.equal(await folderVersionDigest(dir, TENANT), null);
    });
});
