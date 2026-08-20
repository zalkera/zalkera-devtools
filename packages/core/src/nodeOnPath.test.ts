/**
 * **Turbopack 이 PATH 에서 `node` 를 못 찾으면 첫 화면이 500 이다.**
 *
 * 실물 재현(리눅스에서 PATH 의 `node` 만 가리고 잰 것):
 *   Turbopack  → HTTP 500 · `spawning node pooled process / No such file or directory`
 *   `--webpack` → HTTP 200 · CSS 정상
 * 오너의 윈도우 노트북에서 난 것과 같은 형상이다(그쪽 문면은 `program not found`).
 *
 * 재현: `node --test packages/core/dist/nodeOnPath.test.js` (또는 `npm test -w @zalkera/devtools-core`)
 */
import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { devEngineArgs, hasNodeOnPath } from "./nodeOnPath.ts";
import { tempDirSync } from "./testing/tempDir.ts";

const roots: string[] = [];
function dirWith(names: string[]): string {
  const root = tempDirSync("zalkera-nop-");
  roots.push(root);
  for (const n of names) {
    writeFileSync(join(root, n), "");
    chmodSync(join(root, n), 0o755);
  }
  return root;
}
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("PATH 에 node 가 있으면 Turbopack 을 그대로 쓴다", () => {
  const bin = dirWith(["node"]);
  assert.equal(hasNodeOnPath({ PATH: bin }, "linux"), true);
  assert.deepEqual(devEngineArgs({ PATH: bin }, "linux"), []);
});

test("PATH 에 node 가 없으면 webpack 으로 내린다 — 이 자리가 시연을 깨뜨렸다", () => {
  const bin = dirWith(["npm", "git"]);
  assert.equal(hasNodeOnPath({ PATH: bin }, "linux"), false);
  assert.deepEqual(devEngineArgs({ PATH: bin }, "linux"), ["--webpack"]);
});

test("Windows 는 node.exe 만 센다 — .cmd·.bat 은 Turbopack 이 못 찾는다", () => {
  // 러스트 `Command` 는 `CreateProcessW` 규칙을 타서 확장자 없는 이름에 `.exe` 만 붙인다.
  // `node.cmd` 를 「있다」로 세면 Turbopack 을 켜 놓고 같은 자리에서 다시 죽는다.
  const shim = dirWith(["node.cmd", "node.bat"]);
  assert.equal(
    hasNodeOnPath({ PATH: shim }, "win32"),
    false,
    "node.cmd 를 실행 파일로 셌다",
  );
  assert.deepEqual(devEngineArgs({ PATH: shim }, "win32"), ["--webpack"]);

  const real = dirWith(["node.exe"]);
  assert.equal(hasNodeOnPath({ PATH: real }, "win32"), true);
  assert.deepEqual(devEngineArgs({ PATH: real }, "win32"), []);
});

test("POSIX 에서는 node.exe 를 세지 않는다 — 과대탐지도 결함이다", () => {
  const bin = dirWith(["node.exe"]);
  assert.equal(hasNodeOnPath({ PATH: bin }, "linux"), false);
});

test("여러 칸 중 뒤쪽에 있어도 찾는다", () => {
  const empty = dirWith([]);
  const bin = dirWith(["node"]);
  assert.equal(
    hasNodeOnPath({ PATH: [empty, "", bin].join(delimiter) }, "linux"),
    true,
  );
});

test("PATH 가 비었거나 없으면 없는 것으로 본다 — fail-safe 방향", () => {
  // 못 찾는 쪽으로 틀리면 느려질 뿐이고, 찾은 쪽으로 틀리면 화면이 안 뜬다.
  assert.equal(hasNodeOnPath({}, "linux"), false);
  assert.equal(hasNodeOnPath({ PATH: "" }, "linux"), false);
  assert.deepEqual(devEngineArgs({}, "win32"), ["--webpack"]);
});

test("Windows 의 Path·path 표기도 읽는다", () => {
  const bin = dirWith(["node.exe"]);
  assert.equal(
    hasNodeOnPath({ Path: bin }, "win32"),
    true,
    "Path 표기를 못 읽었다",
  );
  assert.equal(
    hasNodeOnPath({ path: bin }, "win32"),
    true,
    "path 표기를 못 읽었다",
  );
});

test("디렉터리가 node 라는 이름이어도 실행 파일이 아니다", () => {
  const root = tempDirSync("zalkera-nop-dir-");
  roots.push(root);
  mkdirSync(join(root, "node"));
  assert.equal(
    hasNodeOnPath({ PATH: root }, "linux"),
    false,
    "디렉터리를 실행 파일로 셌다",
  );
});

test("깨진 심링크는 없는 것으로 본다", () => {
  const root = tempDirSync("zalkera-nop-bad-");
  roots.push(root);
  symlinkSync(join(root, "nowhere"), join(root, "node"));
  assert.equal(hasNodeOnPath({ PATH: root }, "linux"), false);
});
