/**
 * **서식 파일 예외가 이름 하나로 뚫리지 않는가.**
 *
 * `.env.example` 은 **이름으로** 비밀 판정을 면제받는다 — 「값이 없어 허용」이 근거다.
 * 그런데 사람은 서식을 복사하지 않고 **그 자리에 채운다.** 채운 서식이 그대로 나가면
 * 이 레포가 스스로 좁혀 둔 보증("*우리가 발급한* 비밀은 반드시 덮는다")이 무너진다.
 *
 * 그래서 이름 예외에는 **내용 문턱**이 달려 있다. 이 시험이 그 문턱을 잰다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./testing/tempDir.ts";
import { isExcludedEntry, packProject, templateHoldsSecret } from "./zip.ts";
import { extractZip, listZipEntries } from "./unzip.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";

/** zip 을 **풀어서** 열쇠가 실렸는지 본다. 압축된 바이트열을 훑으면 새는데도 초록이 된다. */
async function leakedKey(zip: Buffer): Promise<string | null> {
    const out = await tempDir("zalkera-leak-");
    await extractZip(zip, out);
    const walk = (dir: string, base = ""): string[] =>
        readdirSync(dir).flatMap((n) =>
            statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), `${base}${n}/`) : [`${base}${n}`],
        );
    for (const name of walk(out)) {
        const bytes = readFileSync(join(out, name));
        for (const view of [bytes.toString("utf8"), bytes.toString("utf16le")]) {
            if (view.includes("oqsk_") || view.includes("PRIVATE KEY")) return name;
        }
    }
    return null;
}

test("이름 축 — 서식은 실리고 실제 환경 파일은 빠진다", () => {
    for (const keep of [".env.example", ".env.sample", ".env.template", ".ENV.EXAMPLE", ".env.local.example"]) {
        assert.equal(isExcludedEntry(keep), false, `서식이 빠졌다: ${keep}`);
    }
    // ⚠ 예외를 넓히면 여기가 무너진다. `.env.example.bak` 은 **서식이 아니다** — 편집기 백업은
    //   채워 넣은 뒤의 사본일 수 있다.
    for (const drop of [".env", ".env.local", ".env.production", ".env.development.local",
                        ".env.example.bak", ".envrc", ".env~", ".Env.Local", "production.env"]) {
        assert.equal(isExcludedEntry(drop), true, `환경 파일이 실렸다: ${drop}`);
    }
});

test("내용 축 — **주석 처리한 열쇠도 잡는다**", () => {
    // ⚠ 종전 판은 `#` 줄을 건너뛰었다. 변이시험으로 그 건너뛰기가 **아무것도 안 지키면서
    //   구멍만 낸다**는 것이 드러났다 — 사람이 자기 열쇠를 주석 처리해 두면 그대로 나간다.
    assert.equal(
        templateHoldsSecret("# ZALKERA_STOREFRONT_KEY=oqsk_MYREALKEY99\n"),
        "잘커라 스토어프론트 키",
    );
});

test("내용 축 — 형식만 적은 안내문은 안 걸린다(정본 팩이 통째로 빠지지 않는다)", () => {
    // 정본 팩의 서식이 `# … 스토어프론트 서버 시크릿 키(oqsk_…)` 라고 **설명한다.** 이것이
    // 걸리면 정상 팩이 통째로 빠지고, 사람은 왜 배포된 사이트가 다른지 알 수 없다.
    assert.equal(templateHoldsSecret("# 스토어프론트 서버 시크릿 키(oqsk_…) 를 넣으세요\nKEY=\n"), null);
    assert.equal(templateHoldsSecret("ZALKERA_API_BASE=http://localhost:8100\nKEY=\n"), null);
});

test("내용 축 — 값 자리의 살아 있는 열쇠는 이름을 대고 잡는다", () => {
    const found = [
        ["ZALKERA_STOREFRONT_KEY=oqsk_A1b2C3d4E5f6", "잘커라 스토어프론트 키"],
        ['ZALKERA_STOREFRONT_KEY="oqsk_A1b2C3d4E5f6"', "잘커라 스토어프론트 키"],
        ["AWS_ACCESS_KEY_ID=AKIA2E0A8F3B244C9986", "AWS 액세스키"],
        ["DB=postgres://real:S3cr3tPw@prod-db.acme.co/app", "URL 내장 자격증명"],
        ["K=-----BEGIN RSA PRIVATE KEY-----", "개인키 블록"],
    ] as const;
    for (const [line, what] of found) {
        assert.equal(templateHoldsSecret(line), what, `못 잡았다: ${line}`);
    }
});

test("내용 축 — **닿을 수 없는 호스트**의 자격증명은 비밀로 안 본다", () => {
    // ⚠ 이 시험이 없어서 실제로 걸렸다: `postgres://user:pass@localhost:5432/db` 는 Node·Docker
    //   Compose 서식의 **가장 흔한 한 줄**인데, 형상만 보는 규칙이 그것을 비밀로 판정해 정상
    //   서식 파일이 통째로 빠졌다(심의 실증). 남이 닿을 수 없는 자리의 열쇠는 나가도 못 쓴다.
    for (const line of [
        "POSTGRES_URL=postgres://user:pass@localhost:5432/db",
        "MONGO=mongodb://admin:admin@127.0.0.1:27017/app",
        "DB=postgres://user:pass@db:5432/app",           // compose 서비스 이름 — 점이 없다
        "DB=postgres://u:p@10.0.0.5/app",                 // 사설망
        "DB=postgres://u:p@nas.local/app",                // 예약 접미
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",        // AWS 문서의 자리표시자
    ]) {
        assert.equal(templateHoldsSecret(line), null, `정상 서식이 비밀로 판정됐다: ${line}`);
    }
});

test("포장 — 채운 서식은 빠지고 **이름과 이유를 말한다**", async () => {
    // ⚠ 조용히 빼지 않는다. 사용자는 배포된 사이트가 왜 다른지 알 방법이 없다.
    const dir = await tempDir("zalkera-tmpl-");
    {
        await writeFile(join(dir, "package.json"), "{}");
        await writeFile(join(dir, ".env.example"), "API=http://localhost:8100\nKEY=oqsk_LEAKED9876543\n");
        const said: string[] = [];
        const packed = await packProject({projectDir: dir, onProgress: (m) => said.push(m)});

        const names = listZipEntries(packed.buffer).filter((n) => !n.endsWith("/"));
        assert.ok(!names.includes(".env.example"), `채운 서식이 실렸다: ${names.join(", ")}`);
        // ⚠ **풀어서 본다.** `buffer.toString("latin1").includes(...)` 로 재면 deflate 된 항목의
        //   원문이 바이트열에 안 남아 **새는데도 초록**이 된다(심의 실증 · compress_type=8).
        assert.equal(await leakedKey(packed.buffer), null, "풀어 보니 열쇠가 실렸다");
        assert.ok(
            said.some((m) => m.includes(".env.example") && m.includes("스토어프론트")),
            `무엇을 왜 뺐는지 말하지 않았다: ${said.join(" / ")}`,
        );
    }
});

test("포장 — 값 없는 서식은 그대로 실린다(양성 통제군)", async () => {
    // 이것이 없으면 위 시험은 「서식을 늘 빼는」 구현으로도 초록이다.
    const dir = await tempDir("zalkera-tmpl-ok-");
    {
        await writeFile(join(dir, "package.json"), "{}");
        await writeFile(join(dir, ".env.example"), "# 채워 넣으세요\nZALKERA_STOREFRONT_KEY=\n");
        const packed = await packProject({projectDir: dir});
        assert.ok(listZipEntries(packed.buffer).includes(".env.example"), "정상 서식이 빠졌다");
    }
});

test("포장 — 이름 예외를 비켜 가는 일곱 갈래가 전부 막힌다", async () => {
    // ⚠ 각 줄이 실제로 유출됐던 자리다(심의 실증). 하나씩 재현해 **풀어서** 확인한다.
    const shapes: ReadonlyArray<readonly [string, (dir: string) => Promise<void>]> = [
        // 폴더는 이름 판정을 통과하고, 그 안의 파일은 이름도 내용도 안 걸렸다 — 양쪽 그물 밖.
        ["`.env.example` 폴더", async (dir) => {
            await mkdir(join(dir, ".env.example"));
            await writeFile(join(dir, ".env.example", "notes.txt"), "KEY=oqsk_REALLEAK99999");
        }],
        // UTF-16 은 ASCII 사이에 `00` 이 끼어 어떤 정규식에도 안 걸렸다.
        ["UTF-16LE(BOM)", async (dir) => {
            await writeFile(join(dir, ".env.example"),
                Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("KEY=oqsk_UTF16LEAK123\n", "utf16le")]));
        }],
        ["UTF-16BE(BOM)", async (dir) => {
            const body = Buffer.from("KEY=oqsk_BE_LEAK4567\n", "utf16le");
            body.swap16();
            await writeFile(join(dir, ".env.example"), Buffer.concat([Buffer.from([0xfe, 0xff]), body]));
        }],
        ["BOM 없는 UTF-16", async (dir) => {
            await writeFile(join(dir, ".env.example"), Buffer.from("KEY=oqsk_NOBOM7890123\n", "utf16le"));
        }],
        // 스캔 상한 뒤에 두면 못 본 채 **전체가** 실렸다.
        ["스캔 상한 초과", async (dir) => {
            await writeFile(join(dir, ".env.example"), `${"A".repeat(300_000)}\nKEY=oqsk_PAST256K\n`);
        }],
        // `KEY="` 다음 줄에는 `=` 가 없어 값으로 안 읽혔다 — PEM 붙여넣기의 흔한 모양.
        ["여러 줄 PEM", async (dir) => {
            await writeFile(join(dir, ".env.example"), 'KEY="\n-----BEGIN RSA PRIVATE KEY-----\nabc\n');
        }],
        // 주석으로 가려도 나갔다.
        ["주석으로 가린 열쇠", async (dir) => {
            await writeFile(join(dir, ".env.example"), "# KEY=oqsk_COMMENTED12345\n");
        }],
    ];
    for (const [label, build] of shapes) {
        const dir = await tempDir("zalkera-bypass-");
        await writeFile(join(dir, "package.json"), "{}");
        await build(dir);
        const packed = await packProject({projectDir: dir});
        assert.equal(await leakedKey(packed.buffer), null, `${label} 로 열쇠가 나갔다`);
    }
});
