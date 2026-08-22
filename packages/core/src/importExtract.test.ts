import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./testing/tempDir.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import { extractZip, listZipEntries } from "./unzip.ts";
import { removeAdded, snapshotEntries } from "./emptyDir.ts";
import { decideImportPlan } from "./importZip.ts";

/**
 * **디렉터리 항목까지 담은 zip.** 실물(탐색기·Finder·`zip -r`)이 이 모양이다.
 *
 * ⚠ 이 헬퍼가 없으면 시험이 실물과 갈린다 — `createZip` 은 디렉터리 항목을 안 내므로,
 *   파일만 담은 zip 으로는 「정상 zip 이 통째로 거절되는」 사고를 못 잡는다(심의 실증).
 */
function zipWithDirs(entries: Record<string, string>, dirs: string[]): Promise<Buffer> {
  const list: ZipEntry[] = [
    ...dirs.map((path) => ({path, data: Buffer.alloc(0)})),
    ...Object.entries(entries).map(([path, text]) => ({path, data: Buffer.from(text, "utf8")})),
  ];
  return createZip(list);
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const list: ZipEntry[] = Object.entries(entries).map(([path, text]) => ({
    path,
    data: Buffer.from(text, "utf8"),
  }));
  return createZip(list);
}

async function importInto(zip: Buffer, dir: string) {
  const plan = decideImportPlan(listZipEntries(zip));
  return {plan, ...(await extractZip(zip, dir, plan))};
}

test("중첩·제외가 실제 해제에도 그대로 적용된다", async () => {
  const dir = await tempDir("zalkera-import-");
  {
    const { fileCount } = await importInto(
      await zipOf({
        "site/package.json": '{"name":"x"}',
        "site/src/app/page.tsx": "export default () => null;",
        "site/.vscode/settings.json": '{"zalkera.tenant":"someone-else"}',
        "site/.env.local": "ZALKERA_STOREFRONT_KEY=oqsk_live_LEAK",
        "__MACOSX/site/._package.json": "junk",
      }),
      dir,
    );
    assert.equal(fileCount, 2, "푼 개수가 계획과 다르다");
    assert.ok(existsSync(join(dir, "package.json")), "중첩이 안 벗겨졌다");
    assert.ok(existsSync(join(dir, "src/app/page.tsx")));
    // ⚠ 보낸 쪽 링크가 들어오면 이 폴더가 **남의 사이트라고 주장**한다.
    assert.ok(!existsSync(join(dir, ".vscode")), ".vscode 가 들어왔다");
    assert.ok(!existsSync(join(dir, ".env.local")), "자격증명이 들어왔다");
    assert.ok(!existsSync(join(dir, "__MACOSX")), "OS 부스러기가 들어왔다");
  }
});

test("계획을 안 주면 옛 동작 그대로다 — 받기·들여오기가 이 경로다", async () => {
  const dir = await tempDir("zalkera-import-");
  {
    const { fileCount } = await extractZip(await zipOf({ "a.txt": "hi", "b/c.txt": "there" }), dir);
    assert.equal(fileCount, 2);
    assert.equal(readFileSync(join(dir, "b/c.txt"), "utf8"), "there");
  }
});

test("접두를 벗긴 뒤에도 뿌리 밖으로 못 나간다", async () => {
  // ⚠ 이 시험이 고정하는 것은 **순서**다. 벗기기가 안전 검사보다 뒤로 가면, 검사는 벗기기 전
  //   이름을 보고 통과시키는데 실제로 쓰는 경로는 다른 것이 된다.
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipOf({ "site/package.json": "{}", "site/../../escaped.txt": "nope" });
    // 오류문이 **벗긴 이름**(`../../escaped.txt`)을 말한다는 것이 순서가 맞다는 증거다 —
    // 벗기기가 검사보다 뒤였다면 `site/../../escaped.txt` 로 보고됐을 것이고, 그 이름은
    // `resolve` 상 뿌리 안이라 통과했을 것이다.
    await assert.rejects(() => importInto(zip, dir), /폴더 밖을 가리킵니다: \.\.\/\.\.\/escaped\.txt/);
    assert.ok(!existsSync(join(dir, "..", "..", "escaped.txt")), "뿌리 밖에 파일이 생겼다");
  }
});

test("디렉터리 항목이 든 실물 zip 이 통째로 거절되지 않는다", async () => {
  // ⚠ 이것이 이 기능의 **1순위 입력**이다 — 고객·개발사가 폴더를 통째로 압축해 보낸다.
  //   계획이 파일만 판정하면 `node_modules/` 디렉터리 항목이 해제기 안쪽 가드까지 가서
  //   「받은 파일에 node_modules 가 들어 있습니다」로 폭사한다.
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipWithDirs(
      {
        "site/package.json": '{"name":"x"}',
        "site/src/page.tsx": "export default null;",
        "site/node_modules/pkg/index.js": "module.exports={}",
      },
      ["site/", "site/src/", "site/node_modules/", "site/node_modules/pkg/"],
    );
    const plan = decideImportPlan(listZipEntries(zip));
    const { fileCount } = await extractZip(zip, dir, plan);
    assert.equal(fileCount, 2, "정상 zip 이 온전히 풀리지 않았다");
    assert.ok(existsSync(join(dir, "package.json")));
    assert.ok(existsSync(join(dir, "src/page.tsx")));
    // 제외 대상은 **빈 껍데기조차** 남기지 않는다 — 「들여오지도 않는다」가 참이어야 한다.
    assert.ok(!existsSync(join(dir, "node_modules")), "제외 폴더가 빈 껍데기로 생겼다");
  }
});

test("제외 디렉터리 항목은 빈 폴더로도 안 생긴다", async () => {
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipWithDirs({ "package.json": "{}" }, [".git/", ".vscode/", "dist/", ".ssh/"]);
    const plan = decideImportPlan(listZipEntries(zip));
    await extractZip(zip, dir, plan);
    for (const junk of [".git", ".vscode", "dist", ".ssh"]) {
      assert.ok(!existsSync(join(dir, junk)), `${junk} 가 빈 껍데기로 생겼다`);
    }
  }
});

test("해제가 도중에 멈추면 **아무것도 남기지 않는다** — 문서가 그렇게 약속한다", async () => {
  // ⚠ help.md 가 「…아무것도 풀지 않고 멈춘 것이니 폴더는 그대로입니다」라고 단정한다.
  //   `extractZip` 은 항목을 훑으며 그때그때 쓰므로, 롤백이 없으면 그 문장이 거짓이 된다.
  //   재시도도 「비어 있지 않습니다」로 막혀 손으로 지우기 전에는 못 빠져나온다.
  //   적대적 zip 이 보안 정지를 유발하고도 디스크에 흔적을 남기는 자리이기도 하다.
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipOf({
      "site/package.json": "{}",
      "site/src/a.ts": "export default 1;",
      "site/../../escaped.txt": "nope",
    });
    const plan = decideImportPlan(listZipEntries(zip));
    const before = await snapshotEntries(dir);
    await assert.rejects(async () => {
      try {
        await extractZip(zip, dir, plan);
      } catch (cause) {
        await removeAdded(dir, before);
        throw cause;
      }
    });
    assert.deepEqual(readdirSync(dir), [], `반쪽 해제가 남았다: ${readdirSync(dir).join(",")}`);
  }
});

test("롤백이 **고객이 손으로 만든 것**은 안 지운다 — 「빈 폴더」가 일부러 초대한 것이다", async () => {
  // ⚠ 「빈 폴더」 판정(`meaningfulEntries`)은 `.vscode`·`.DS_Store` 를 「비어 있음」으로 본다 —
  //   배송 문서가 "편집기가 만든 `.vscode` 폴더는 있어도 괜찮습니다"라고 **초대**하기 때문이다.
  //   그래서 롤백이 폴더를 통째로 지우면, 초대해 놓고 지우는 셈이 된다.
  //
  //   팩이든 남이 준 zip 이든 폴더로 들어오는 문은 이제 여기 하나다 — 그래서 이 보증도 여기서 잰다.
  const dir = await tempDir("zalkera-import-");
  {
    await mkdir(join(dir, ".vscode"), {recursive: true});
    await writeFile(join(dir, ".vscode", "launch.json"), '{"customer":true}', "utf8");
    await writeFile(join(dir, ".DS_Store"), "mac", "utf8");

    const zip = await zipOf({
      "site/package.json": "{}",
      "site/../../escaped.txt": "nope",
    });
    const plan = decideImportPlan(listZipEntries(zip));
    const before = await snapshotEntries(dir);
    await assert.rejects(async () => {
      try {
        await extractZip(zip, dir, plan);
      } catch (cause) {
        await removeAdded(dir, before);
        throw cause;
      }
    });
    assert.deepEqual(readdirSync(dir).sort(), [".DS_Store", ".vscode"], "고객 파일이 함께 지워졌다");
    assert.equal(readFileSync(join(dir, ".vscode", "launch.json"), "utf8"), '{"customer":true}');
  }
});

test("목록이 디렉터리 항목도 돌려준다 — 계획이 그것까지 판정해야 규칙이 한 곳에 있다", async () => {
  // ⚠ 목록이 파일만 주면 계획은 디렉터리를 못 보고, `node_modules/` 항목이 해제기 안쪽
  //   가드까지 가서 **정상 zip 이 통째로 거절된다.** 그 사고를 이 한 줄이 막는다.
  const zip = await zipWithDirs({ "package.json": "{}" }, ["src/", "node_modules/"]);
  const names = listZipEntries(zip);
  assert.ok(names.includes("src/"), `디렉터리 항목이 목록에 없다: ${names.join(",")}`);
  assert.ok(names.includes("node_modules/"), `제외 대상 디렉터리가 목록에 없다: ${names.join(",")}`);
});

/**
 * **실물 zip 이 취하는 모양을 전수로 돈다.**
 *
 * ⚠ 이 표가 있는 이유: 「실물 zip 으로 확인했다」가 두 판 연속 부족했다. 한 모양만 짚어
 *   고치면 옆 모양이 깨진다 — 감싸기 깊이 × 디렉터리 항목 유무 × macOS 부스러기 유무가
 *   서로 독립이라, 한 축만 보면 나머지 축의 조합이 그대로 남는다.
 *   여기서 세는 것은 **표식이 뿌리에 올라오는가** 하나다. 그것이 「사이트로 인식되는가」다.
 */
const WRAPS = [[], ["site"], ["outer", "site"]];
const WITH_DIRS = [false, true];
const WITH_MACOSX = [false, true];
/**
 * 겹 자리의 부스러기. **독립 축이라 표에 있어야 한다** — 이 축이 표 밖에 있을 때 겹의
 * `.DS_Store` 하나가 접두를 끊는 결함이 났고, 표는 초록이었다.
 */
const WITH_JUNK = [false, true];

for (const wrap of WRAPS) {
  for (const dirs of WITH_DIRS) {
    for (const macosx of WITH_MACOSX) {
     for (const junk of WITH_JUNK) {
      const label =
        `감싸기 ${wrap.length}겹 · 디렉터리항목 ${dirs ? "있음" : "없음"} · ` +
        `__MACOSX ${macosx ? "있음" : "없음"} · 겹 부스러기 ${junk ? "있음" : "없음"}`;
      test(`실물 형상 — ${label}`, async () => {
        const under = wrap.length === 0 ? "" : `${wrap.join("/")}/`;
        const files: Record<string, string> = {
          [`${under}package.json`]: '{"name":"x"}',
          [`${under}src/app/page.tsx`]: "export default null;",
          [`${under}node_modules/pkg/index.js`]: "module.exports={}",
          [`${under}.env.local`]: "ZALKERA_STOREFRONT_KEY=oqsk_live_LEAK",
        };
        if (macosx) files["__MACOSX/._x"] = "junk";
        // 겹 **바깥** 자리의 부스러기 — 맥에서 폴더를 한 번 열면 생기고, 받은 zip 을 풀어
        // 상위 폴더를 다시 압축하는 두 겹 생성 경로에서 정확히 이 자리에 놓인다.
        if (junk && wrap.length > 0) files[`${wrap[0]}/.DS_Store`] = "junk";
        const dirEntries: string[] = [];
        if (dirs) {
          for (let i = 1; i <= wrap.length; i += 1) dirEntries.push(`${wrap.slice(0, i).join("/")}/`);
          dirEntries.push(`${under}src/`, `${under}src/app/`, `${under}node_modules/`, `${under}node_modules/pkg/`);
        }
        const zip = await zipWithDirs(files, dirEntries);
        const dir = await tempDir("zalkera-shape-");
        const plan = decideImportPlan(listZipEntries(zip));
        await extractZip(zip, dir, plan);

        assert.ok(existsSync(join(dir, "package.json")), `표식이 뿌리에 없다 — ${label}`);
        assert.ok(existsSync(join(dir, "src/app/page.tsx")), `소스가 안 풀렸다 — ${label}`);
        assert.ok(!existsSync(join(dir, "node_modules")), `제외 폴더가 생겼다 — ${label}`);
        assert.ok(!existsSync(join(dir, ".env.local")), `자격증명이 들어왔다 — ${label}`);
        assert.ok(!existsSync(join(dir, "__MACOSX")), `OS 부스러기가 들어왔다 — ${label}`);
        assert.ok(!existsSync(join(dir, ".DS_Store")), `겹 부스러기가 들어왔다 — ${label}`);
      });
     }
    }
  }
}

/**
 * **이름을 바이트 그대로 넣고 EFS 플래그를 세우지 않는 zip.** 알집·구형 윈도 탐색기 형상이다.
 * `createZip` 은 늘 UTF-8 플래그를 세우므로 이 형상을 못 만든다 — 그래서 손으로 조립한다.
 */
function storedZipRaw(entries: [Buffer, Buffer][], flags = 0): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const local = Buffer.concat(locals);
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

test("UTF-8 이 아닌 파일 이름은 **읽지 않고 멈춘다** — 조용히 틀리지 않는다", async () => {
  // ⚠ EFS 플래그가 없으면 이름의 인코딩은 **진짜로 모호**하다. CP949 를 받아 주면 GB2312 이름이
  //   엉뚱한 한자로 조용히 읽힌다(실측: 中 → 櫓). 소스가 서버로 올라가 파일명이 곧 주소가 되고
  //   그 아래는 전부 UTF-8 을 전제하므로, 경계에서 안 막으면 틀린 이름이 그대로 흘러간다.
  //   거절은 보이고 되돌릴 수 있지만, 오독은 「이미지가 404 인데 원인이 화면에 없는」 상태다.
  const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
  const shapes: [string, number[]][] = [
    ["CP949 한글", [0xb0, 0xa1]],
    ["GB2312 한자", [0xd6, 0xd0]],
    ["Latin-1 악센트", [0xe9]],
    ["Shift_JIS 가나", [0x82, 0xa0]],
  ];
  for (const [label, bytes] of shapes) {
    const zip = storedZipRaw([
      [ascii("site/package.json"), Buffer.from('{"name":"x"}')],
      [Buffer.concat([ascii("site/public/"), Buffer.from(bytes), ascii(".jpg")]), Buffer.from("A")],
    ]);
    assert.throws(() => listZipEntries(zip), /이름을 읽지 못했습니다/, `${label}: 조용히 통과했다`);
  }

  // ⚠ **플래그 없는 비-ASCII 이름은 유효한 UTF-8 이어도 거절한다.** 유효성만 보면 창이 남는다 —
  //   CP949 두 바이트열 중 상당수가 UTF-8 로도 유효하고 실제 한글 음절이 되는 것이 많다
  //   (심의 실측: 「체크.png」→ `üũ.png`). 형식이 정한 표시(EFS)를 요구해야 그 창이 닫힌다.
  const flagless = storedZipRaw([
    [ascii("site/package.json"), Buffer.from('{"name":"x"}')],
    [Buffer.from("site/public/가.jpg", "utf8"), Buffer.from("A")],
  ]);
  assert.throws(() => listZipEntries(flagless), /이름을 읽지 못했습니다/, "플래그 없는 이름이 통과했다");

  // 표시를 세운 UTF-8 한글은 그대로 읽힌다 — 우리가 만드는 zip 이 이 형상이다.
  const utf8Zip = storedZipRaw(
    [
      [ascii("site/package.json"), Buffer.from('{"name":"x"}')],
      [Buffer.from("site/public/가.jpg", "utf8"), Buffer.from("A")],
    ],
    0x800,
  );
  const names = listZipEntries(utf8Zip);
  assert.ok(names.includes("site/public/가.jpg"), `UTF-8 한글이 막혔다: ${names.join(",")}`);

  const dir = await tempDir("zalkera-utf8-");
  const plan = decideImportPlan(names);
  const { fileCount } = await extractZip(utf8Zip, dir, plan);
  assert.equal(fileCount, 2);
  assert.ok(existsSync(join(dir, "public/가.jpg")));
});

test("겹 자리의 부스러기가 접두 계산을 끊지 않는다", async () => {
  // ⚠ 맥에서 폴더를 한 번 열면 `.DS_Store` 가 생긴다. 받은 zip 을 풀고 상위 폴더를 다시
  //   압축하는 것이 두 겹 zip 의 전형적 생성 경로라, 이 형상이 흔하다.
  for (const junk of [".DS_Store", ".env.local"]) {
    const plan = decideImportPlan([
      "outer/",
      `outer/${junk}`,
      "outer/site/",
      "outer/site/package.json",
      "outer/site/src/a.ts",
    ]);
    assert.equal(plan.strip, "outer/site/", `${junk} 가 접두를 끊었다`);
    assert.ok(plan.keep.includes("package.json"), `${junk}: 표식이 뿌리에 안 올라왔다`);
  }
});

test("표식은 파일이어야 한다 — 같은 이름의 디렉터리 항목에 속지 않는다", async () => {
  // 디렉터리 항목 `package.json/` 하나로 「사이트」가 되면, 아무 폴더나 소스로 둔갑한다.
  assert.throws(
    () => decideImportPlan(["package.json/", "src/", "src/a.ts"]),
    /사이트 소스가 아닙니다/,
  );
});

test("맥이 만든 NFD 한글 이름은 NFC 로 모아 푼다", async () => {
  // ⚠ 맥은 파일명을 분해형(NFD)으로 적는다 — 「가」가 `ᄀ`+`ᅡ` 두 글자다. 그 이름은 표시도
  //   있고 유효 UTF-8 이라 그냥 통과하는데, 소스가 조합형(NFC)으로 그 파일을 가리키면
  //   **다른 문자열**이라 안 맞는다. 「이미지가 404 인데 원인이 화면에 없는」 그 증상이다.
  const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
  const nfd = "여름사진.jpg".normalize("NFD");
  assert.notEqual(nfd, "여름사진.jpg", "시험 입력이 NFD 가 아니다 — 아무것도 안 재고 있다");

  const zip = storedZipRaw(
    [
      [ascii("site/package.json"), Buffer.from('{"name":"x"}')],
      [Buffer.from(`site/public/${nfd}`, "utf8"), Buffer.from("A")],
    ],
    0x800,
  );
  const names = listZipEntries(zip);
  assert.ok(
    names.includes("site/public/여름사진.jpg"),
    `NFC 로 안 모였다: ${names.map((n) => JSON.stringify(n)).join(",")}`,
  );

  const dir = await tempDir("zalkera-nfd-");
  const plan = decideImportPlan(names);
  await extractZip(zip, dir, plan);
  // 소스가 조합형으로 가리키는 그 이름으로 실제 파일이 있어야 한다.
  assert.ok(existsSync(join(dir, "public/여름사진.jpg")), "조합형 이름으로 안 풀렸다");
});

test("이름 목록이 지나치게 크면 **디코드 전에** 거절한다", async () => {
  // ⚠ 이름 길이는 중앙 디렉터리에 적혀 있으니 **읽기 전에** 알 수 있다. 다 읽고 나서 재면
  //   그 훑기 자체가 이미 비용이고(심의 실측: 이름 130MB 에서 판독만 0.6~0.7초), 배송 문서의
  //   「읽기 전에 멈춥니다」도 거짓이 된다. 항목 수·깊이 상한은 이 축을 못 막는다 —
  //   둘 다 지키면서 긴 이름으로만 채울 수 있다.
  const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
  // ⚠ 이름 **한 개**를 길게 하면 파일시스템의 이름 길이 제한(ENAMETOOLONG)에 먼저 걸려
  //   엉뚱한 오류를 재게 된다. 깊이 상한(64) 안에서 **경로를 나눠** 총량만 키운다.
  const seg = "s".repeat(120);
  const dir3 = `${seg}/${seg}/${seg}/`;
  const entries: [Buffer, Buffer][] = [[ascii("package.json"), Buffer.from("{}")]];
  for (let i = 0; i < 25_000; i += 1) entries.push([ascii(`${dir3}f${i}`), Buffer.from("x")]);
  const bytes = entries.reduce((sum, [name]) => sum + name.length, 0);
  assert.ok(bytes > 8 * 1024 * 1024, `시험 입력이 상한을 안 넘는다(${bytes}) — 아무것도 안 재고 있다`);

  const zip = storedZipRaw(entries);
  // 두 판독 경로가 **같은 말**을 해야 한다 — 하나만 막으면 다른 문으로 들어온다.
  assert.throws(() => listZipEntries(zip), /목록이 지나치게 큽니다/);
  const dir = await tempDir("zalkera-cap-");
  await assert.rejects(() => extractZip(zip, dir), /목록이 지나치게 큽니다/);

  // 정상 소스는 막지 않는다 — 실물 최대 트리의 이름 총량이 2.0MB 다(심의 실측).
  const ok = storedZipRaw([
    [ascii("package.json"), Buffer.from("{}")],
    [ascii("src/app/page.tsx"), Buffer.from("x")],
  ]);
  assert.deepEqual(listZipEntries(ok), ["package.json", "src/app/page.tsx"]);
});

test("상한은 **이름을 읽기 전에** 선다 — 순서가 주석에만 있으면 조용히 되돌아간다", async () => {
  // ⚠ 이 델타의 존재 이유가 그 순서다. 검사를 디코드 뒤로 옮겨도 다른 시험은 전부 초록이라
  //   (심의 실증), 나중 편집이 소리 없이 되돌리면 배송 문서의 「읽기 전에 멈춥니다」가 다시
  //   거짓이 되면서 아무도 안 막는다.
  //
  //   기법: 상한을 넘기는 자리에 **EFS 표시 + 깨진 UTF-8** 이름을 둔다.
  //   상한이 먼저면 「목록이 지나치게 큽니다」, 디코드가 먼저면 「이름을 읽지 못했습니다」.
  const ascii = (text: string): Buffer => Buffer.from(text, "latin1");
  const seg = "s".repeat(120);
  const dir3 = `${seg}/${seg}/${seg}/`;
  const broken = Buffer.concat([ascii(dir3), Buffer.from([0xff, 0xfe]), ascii(".txt")]);

  // ⚠ **깨진 이름이 상한을 «넘기는 바로 그» 항목이어야 한다.** 뒤에 두면 상한이 그 전에 이미
  //   넘어서 어느 순서든 상한 오류가 나고, 시험이 판별을 못 한다(자체 변이로 확인).
  const CAP = 8 * 1024 * 1024;
  const entries: [Buffer, Buffer][] = [[ascii("package.json"), Buffer.from("{}")]];
  let used = "package.json".length;
  for (let i = 0; used + broken.length <= CAP; i += 1) {
    const name = ascii(`${dir3}f${i}`);
    entries.push([name, Buffer.from("x")]);
    used += name.length;
  }
  entries.push([broken, Buffer.from("x")]);
  assert.ok(used <= CAP && used + broken.length > CAP, `깨진 이름이 경계에 안 놓였다(${used})`);
  assert.throws(
    () => listZipEntries(storedZipRaw(entries, 0x800)),
    /목록이 지나치게 큽니다/,
    "상한이 디코드보다 뒤로 갔다 — 이름을 다 읽은 뒤에 끊고 있다",
  );

  // 대조군: 같은 깨진 이름이 **상한 안**에 있으면 디코드 오류가 난다.
  //   이것이 없으면 위 단언이 「깨진 이름이 애초에 오류를 못 낸다」로도 통과한다.
  assert.throws(
    () => listZipEntries(storedZipRaw([[ascii("package.json"), Buffer.from("{}")], [broken, Buffer.from("x")]], 0x800)),
    /이름을 읽지 못했습니다/,
    "대조군이 성립하지 않는다 — 이 시험은 아무것도 안 재고 있다",
  );
});
