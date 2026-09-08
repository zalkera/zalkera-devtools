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
import {mkdir, readFile, rm, writeFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {tempDir} from "./testing/tempDir.ts";
import {folderVersionDigest, folderVersionSummary} from "./folderVersion.ts";
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
async function serverSideKept(zip: Buffer): Promise<{path: string; sha256: string}[]> {
    // ⚠ **`mkdtemp` 를 직접 안 부른다** — `tempDir()` 가 회수 목록에 올려 두 겹으로 지운다
    //   (`after` + `process.on("exit")`). 손으로 지우면 예외 경로에서 남는다.
    const out = await tempDir("zalkera-srv-");
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
        return found
            .map((f, i) => ({path: unwrapped[i]!, sha256: f.sha256}))
            .filter((f) => !serverExcluded(f.path));
    } finally {
        await rm(out, {recursive: true, force: true});
    }
}

/** 서버가 저장할 목록의 **지문**. */
async function serverSideDigest(zip: Buffer): Promise<string | null> {
    return sourceVersionDigest(await serverSideKept(zip));
}

async function withFolder(
    files: Record<string, string>,
    run: (dir: string) => Promise<void>,
): Promise<void> {
    const dir = await tempDir("zalkera-fv-");
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

/**
 * 🔴 **출처 표시는 판을 안 가른다**(규칙 v2). 그 파일은 **우리가 넣는 기록물**이라, 그것 때문에 같은 소스가
 * 다른 판이 되면 「어느 문으로 들어왔나」가 판을 정하게 된다 — 방향 판정이 그 위에서 반대로 확신했다.
 *
 * ⚠ **세는 것은 그대로다.** 포장기는 계속 넣고 서버도 계속 싣는다. 빠지는 것은 해시 입력뿐이라
 *   모집단 수(`fileCount`)는 그 파일을 **포함**한다 — 포장 갭 화면이 서버 수와 나란히 놓는 값이다.
 */
test("출처 표시는 지문을 안 바꾸고, 세는 수에는 든다", async () => {
    await withFolder(SITE, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.ok(
            (await import("./unzip.ts")).listZipEntries(packed.buffer).includes(".zalkera/provenance.json"),
            "포장기가 출처 표시를 안 넣었다 — 이 시험의 전제가 사라졌다",
        );
        const bound = await folderVersionSummary(dir, TENANT);
        const unbound = await folderVersionSummary(dir, null);
        assert.equal(bound.digest, await serverSideDigest(packed.buffer), "서버가 저장할 값과 갈렸다");
        assert.equal(bound.digest, unbound.digest, "출처 표시가 판을 갈랐다 — v2 가 없애려던 그것이다");
        // 양성 짝 — 세는 수는 하나 다르다(빠진 것은 해시 입력뿐이라는 증거).
        assert.equal(bound.fileCount, unbound.fileCount + 1, "세는 수에서까지 빠졌다");
        assert.equal(bound.fileCount, (await serverSideKept(packed.buffer)).length, "서버 모집단과 갈렸다");
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

/**
 * 🔴 **순서가 규칙의 일부다 — 언랩이 먼저고 배제가 나중이다.**
 *
 * 서버는 zip 을 통째로 풀어 놓고 `effectiveRoot` 로 래퍼를 판정한 **뒤에** 배제를 돌린다. 그래서
 * 래퍼 판정의 입력은 **배제 전 목록**이다. 뒤집으면 「폴더 하나 + 서버만 빼는 파일 하나」인 트리에서
 * 서버는 안 벗기고 우리는 벗겨 같은 소스가 갈린다.
 *
 * `terraform.tfstate` 가 그 자리다 — **우리는 담고 서버는 뺀다**(집합이 양방향으로 다르다).
 * 그래서 zip 의 최상위는 둘(`site/`·`tfstate`)이고 서버는 안 벗긴다. 순서를 뒤집으면 우리만 벗긴다.
 *
 * ⚠ 이 케이스는 **연결 안 된 폴더**(출처 표시 주입 없음)여야 성립한다. 표시를 넣으면 `.zalkera/` 가
 *   최상위에 하나 더 생겨 어느 순서로도 언랩이 안 돈다.
 */
test("래퍼 판정은 배제 전 목록으로 한다 — 순서를 뒤집으면 갈린다", async () => {
    const files = {"site/index.html": "<h1>hi</h1>", "terraform.tfstate": "{}"};
    await withFolder(files, async (dir) => {
        const packed = await packProject({projectDir: dir});
        const names = (await import("./unzip.ts")).listZipEntries(packed.buffer);
        assert.ok(names.includes("terraform.tfstate"), "포장기가 tfstate 를 뺐다 — 전제가 사라졌다");
        assert.ok(!names.some((n) => n.startsWith(".zalkera/")), "표시가 실렸다 — 전제가 사라졌다");

        const server = await serverSideDigest(packed.buffer);
        assert.equal(await folderVersionDigest(dir, null), server);

        // 순서를 뒤집으면 **다른 값**이 나와야 한다 — 그래야 이 케이스가 그 축을 짚는다.
        const raw = [
            {path: "site/index.html", sha256: await hashOf(dir, "site/index.html")},
            {path: "terraform.tfstate", sha256: await hashOf(dir, "terraform.tfstate")},
        ];
        const pre = raw.filter((e) => !serverExcluded(e.path));
        const unwrapped = unwrapSingleRoot(pre.map((e) => e.path));
        const wrongOrder = sourceVersionDigest(pre.map((e, i) => ({path: unwrapped[i]!, sha256: e.sha256})));
        assert.notEqual(wrongOrder, server, "두 순서가 같은 답을 냈다 — 이 케이스는 순서 축을 못 짚는다");
    });
});

async function hashOf(root: string, rel: string): Promise<string> {
    return createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
}

/**
 * 🟠 **서식 예외는 `.env` 로 시작하는 이름에만 준다** — 포장기(`isValueLessTemplate`)와 같은 술어다.
 *
 * 접미(`.example`·`.sample`·`.template`)만 보면 `.env` 와 무관한 큰 픽스처까지 걸려, **포장기는 담는데
 * 예측은 빼게 된다** — 발행 뒤 거짓 「다름」이다. 크기 문턱이 그 자리를 넓혔었다(재심의 실측).
 */
test("`.env` 아닌 큰 `*.sample` 은 포장기가 담고 예측도 담는다", async () => {
    const big = "x".repeat(400_000); // 서식 스캔 상한(256KB)보다 크다
    await withFolder({...SITE, "fixtures/seed.sample": big}, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.ok(
            (await import("./unzip.ts")).listZipEntries(packed.buffer).includes("fixtures/seed.sample"),
            "포장기가 뺐다 — 이 시험의 전제가 사라졌다",
        );
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

/** 양성 짝 — 값이 든 `.env` 서식은 **여전히** 양쪽에서 빠진다(위 수정이 그물을 넓히지 않았다). */
test("값이 든 `.env.sample` 은 포장기도 예측도 뺀다", async () => {
    const files = {...SITE, ".env.sample": "TOSS_SECRET_KEY=live_sk_abcdefghijklmnop\n"};
    await withFolder(files, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.ok(
            !(await import("./unzip.ts")).listZipEntries(packed.buffer).includes(".env.sample"),
            "포장기가 값든 서식을 담았다 — 전제가 사라졌다",
        );
        assert.equal(await folderVersionDigest(dir, TENANT), await serverSideDigest(packed.buffer));
    });
});

/**
 * 🔴 **파일 수는 「서버가 세는 것과 같은 모집단」이어야 한다.**
 *
 * `PackResult.fileCount` 는 **우리 배제만** 지난 zip 항목 수이고, 서버가 세는 수는 **서버 배제까지**
 * 지난 값이다. 두 값을 포장 갭 화면에 나란히 놓으면 시작 소스 팩(`.github/workflows/` 둘을 서버만 뺀다)
 * 에서 「로컬 42 / 서버 40」이 떠 **정상 차이를 결함처럼** 보이게 한다(심의 지적).
 */
test("접은 항목 수가 서버 모집단과 같다 — zip 항목 수가 아니다", async () => {
    await withFolder({...SITE, ".github/workflows/ci.yml": "on: push"}, async (dir) => {
        const packed = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.ok(
            (await import("./unzip.ts")).listZipEntries(packed.buffer).includes(".github/workflows/ci.yml"),
            "우리 포장기가 워크플로를 안 담았다 — 이 시험의 전제가 사라졌다",
        );
        const summary = await folderVersionSummary(dir, TENANT);
        assert.equal((await serverSideKept(packed.buffer)).length, summary.fileCount, "서버가 세는 수와 다르다");
        // 🔴 zip 항목 수와는 **달라야** 한다 — 같으면 이 축이 아무것도 안 지킨다.
        assert.notEqual(summary.fileCount, packed.fileCount, "zip 항목 수와 같다 — 모집단이 안 갈렸다");
    });
});

/** 콘솔 `<input type=file>` 형상 — 폴더의 **모든** 파일을 배제·주입 없이 담는다. */
async function consoleZipOf(dir: string): Promise<Buffer> {
    const {createZip} = await import("./zip.ts");
    const entries: {path: string; data: Buffer}[] = [];
    const walk = async (d: string, p: string): Promise<void> => {
        for (const it of await readdir(d, {withFileTypes: true})) {
            const rel = p === "" ? it.name : `${p}/${it.name}`;
            if (it.isDirectory()) await walk(join(d, it.name), rel);
            else if (it.isFile()) entries.push({path: rel, data: await readFile(join(d, it.name))});
        }
    };
    await walk(dir, "");
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return createZip(entries);
}

/**
 * 🔴 **지문은 「어느 문으로 들어왔나」에 독립이어야 한다**(규칙 v2).
 *
 * 이 축이 없어서 결함이 살아 있었다 — 같은 소스를 콘솔 zip 으로 올린 판과 devtools 로 올린 판이
 * **다른 지문**을 냈고(실측 `686b36a3…` vs `6fe064a3…`), 그 위에 올린 방향 판정이 두 문을 다 쓴
 * 테넌트에서 **반대 방향을 확신 있게** 말했다. 상용에도 그런 테넌트가 둘 있었다.
 */
test("같은 소스는 어느 문으로 들어와도 같은 판이다", async () => {
    await withFolder(SITE, async (dir) => {
        const viaDevtools = await packProject({projectDir: dir, provenanceTenant: TENANT});
        const viaConsole = await consoleZipOf(dir);
        const fromDevtools = await serverSideDigest(viaDevtools.buffer);
        const fromConsole = await serverSideDigest(viaConsole);
        assert.ok(
            (await import("./unzip.ts")).listZipEntries(viaDevtools.buffer).includes(".zalkera/provenance.json"),
            "devtools 문이 출처 표시를 안 넣었다 — 이 시험의 전제가 사라졌다",
        );
        assert.equal(fromDevtools, fromConsole, "문에 따라 판이 갈렸다");
        assert.equal(await folderVersionDigest(dir, TENANT), fromDevtools, "로컬 예측이 그 값과 갈렸다");
    });
});

/**
 * 🔴 **양성 짝 — 참으로 다른 내용은 여전히 다르다.** 콘솔 zip 이 `dist/` 를 실으면 그것은 **실제로 다른
 * 소스**다(서버가 그 파일을 싣고 STATIC 이면 그대로 서빙한다). 배제를 `dist` 까지 넓히면 여기서 죽는다 —
 * 그 방향으로 가면 「일치」가 거짓이 된다(오너 확정 경계).
 */
test("빌드 산출물이 든 zip 은 여전히 다른 판이다", async () => {
    await withFolder({...SITE, "dist/bundle.js": "console.log(1)"}, async (dir) => {
        const viaDevtools = await packProject({projectDir: dir, provenanceTenant: TENANT});
        assert.notEqual(
            await serverSideDigest(viaDevtools.buffer),
            await serverSideDigest(await consoleZipOf(dir)),
            "dist 가 든 zip 이 같은 판이 됐다 — 그러면 「일치」가 거짓이 된다",
        );
    });
});

/** `.zalkera/` 를 폴더째 빼지 않는다 — 그 안의 다른 파일은 배송 문서가 가리키는 실물이다. */
test("`.zalkera/pack.json` 은 판을 가른다", async () => {
    await withFolder({...SITE, ".zalkera/pack.json": '{"a":1}'}, async (dir) => {
        const a = await folderVersionDigest(dir, TENANT);
        await withFolder({...SITE, ".zalkera/pack.json": '{"a":2}'}, async (dir2) => {
            assert.notEqual(a, await folderVersionDigest(dir2, TENANT), "pack.json 이 지문 밖으로 나갔다");
        });
    });
});
